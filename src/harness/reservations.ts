// ===========================================
// Reservation Manager — Auto file reservation via harness
// ===========================================
// On PreToolUse file writes: check local cache, optimistically reserve,
// confirm with remote server async. If the server rejects the optimistic
// grant, the local cache rolls back and a conflict event fires.
//
// Internal architecture: the cache mutations are expressed as a small
// table of named transitions (`TRANSITIONS` below). Every state change —
// local grants, remote upserts, releases, expiry — runs through
// `applyTransition`, so the in-memory state and the replayed event log
// can never disagree by construction. This is the Bitar single-source-of-
// truth pattern adapted for TS: one declaration per transition; both the
// `apply` direction (state mutation) and the `produce` direction (event
// emission) are derived from the same entry. See `bitar-decider.md`.

import type { CohortManager } from "./cohort.js";
import { harnessNow } from "./replay/harness-clock.js";
import {
	applyTransition,
	canonicalAgent,
	type ReservationCache,
	type ReservationEventSink,
	type ReservationLogEvent,
	type ReservationTxn,
	replayTransitions,
	type ServerApiClient,
	type ServerReservation,
	sameOwner,
} from "./reservations-state-machine.js";
import type { ReservationConflict, ReservationEntry } from "./types.js";

export type {
	ReservationCache,
	ReservationEventSink,
	ReservationLogEvent,
	ReservationTxn,
	ServerApiClient,
	ServerReservation,
};
// Re-exported so the public surface of this module is unchanged: the
// state-machine + identity helpers moved to a sibling for the line cap,
// but importers (and tests) still pull them from "./reservations.js".
export {
	applyTransition,
	canonicalAgent,
	replayTransitions,
	sameOwner,
};

interface ReservationConflictAtPath {
	filePath: string;
	conflict: ReservationConflict;
}

export interface ReservationBatchOptions {
	filePaths: string[];
	agentName: string;
	cohort: CohortManager;
	/** Return true when this conflict should abort the whole acquisition. */
	shouldBlock: (filePath: string, conflict: ReservationConflict) => boolean;
}

/** How long to hold a reservation after the last edit before auto-releasing (30s) */
const AUTO_RELEASE_MS = 30_000;

/** Default reservation TTL sent to the server (5 minutes) */
const RESERVATION_TTL_S = 300;


// ===========================================
// ReservationManager — class wrapping cache, timers, server bridge
// ===========================================

export class ReservationManager {
	private cache: ReservationCache = new Map();
	private releaseTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private apiClient: ServerApiClient | null;
	private refreshInterval: ReturnType<typeof setInterval> | null = null;
	private eventSink: ReservationEventSink | null = null;

	constructor(
		apiClient?: ServerApiClient,
		refreshMs = 30_000,
		eventSink?: ReservationEventSink,
	) {
		this.apiClient = apiClient || null;
		this.eventSink = eventSink || null;

		if (this.apiClient) {
			// Initial load from server
			this.refreshFromServer().catch(() => {
				/* best-effort: a failed refresh just means stale-until-next-tick */
			});
			// Periodic refresh
			this.refreshInterval = setInterval(() => {
				this.refreshFromServer().catch(() => {
					/* best-effort: a failed refresh just means stale-until-next-tick */
				});
			}, refreshMs);
		}
	}

	/**
	 * Check if a file can be written by this agent.
	 * If no conflict, optimistically reserves it locally and fires an async
	 * server confirmation. **Server rejection rolls back the local grant**
	 * and emits a `conflict` event with `conflict_reason: "server-rejected"`
	 * so the cohort sees the eventual conflict. Pre-Lopopolo this was a
	 * silent `.catch(() => {})` — the silent-double-allocation bug class.
	 *
	 * Returns null if allowed (locally), or a conflict descriptor if blocked
	 * by an existing cache entry. Server-side rejection is reported via the
	 * eventSink, not the return value, because callers run synchronously
	 * (PreToolUse evaluator) and the server roundtrip happens in the
	 * background.
	 */
	checkAndReserve(
		filePath: string,
		agentName: string,
		cohort: CohortManager,
	): ReservationConflict | null {
		return (
			this.checkAndReserveBatch({
				filePaths: [filePath],
				agentName,
				cohort,
				shouldBlock: () => true,
			})?.conflict ?? null
		);
	}

	/**
	 * Preflight and acquire a write's full target set as one synchronous local
	 * transaction. A blocking conflict aborts before any target is granted or
	 * sent to the server. Non-blocking conflicts are skipped while every free
	 * target is granted, preserving warning-only sibling-lease behavior.
	 */
	checkAndReserveBatch(options: ReservationBatchOptions): ReservationConflictAtPath | null {
		const filePaths = [...new Set(options.filePaths)];
		const conflicts: ReservationConflictAtPath[] = [];
		for (const filePath of filePaths) {
			const conflict = this.findConflict(filePath, options.agentName, options.cohort);
			if (!conflict) continue;
			conflicts.push({ filePath, conflict });
			this.emitConflict(filePath, options.agentName, conflict);
		}

		for (const conflictAtPath of conflicts) {
			if (options.shouldBlock(conflictAtPath.filePath, conflictAtPath.conflict)) {
				return conflictAtPath;
			}
		}

		const conflictedPaths = new Set(conflicts.map((entry) => entry.filePath));
		for (const filePath of filePaths) {
			if (!conflictedPaths.has(filePath)) {
				this.grant(filePath, options.agentName, options.cohort);
			}
		}
		return null;
	}

	private findConflict(
		filePath: string,
		agentName: string,
		cohort: CohortManager,
	): ReservationConflict | null {
		for (const [pattern, entry] of this.cache) {
			if (sameOwner(entry.agent_name, agentName)) continue; // Own reservation (any name variant)
			if (this.pathMatchesPattern(filePath, pattern)) {
				// Check if expired — prune via the SSoT transition.
				if (entry.expires_at && new Date(entry.expires_at).getTime() < harnessNow()) {
					applyTransition(this.cache, { kind: "expire", file: pattern });
					continue;
				}
				const isLocal = cohort.hasAgent(entry.agent_name);
				const conflict: ReservationConflict = {
					agent_name: entry.agent_name,
					cohort: isLocal ? "local" : "remote",
					expires_at: entry.expires_at,
				};
				return conflict;
			}
		}
		return null;
	}

	private emitConflict(
		filePath: string,
		agentName: string,
		conflict: ReservationConflict,
	): void {
		this.emit({
			ts: new Date().toISOString(),
			action: "conflict",
			file: filePath,
			agent_name: agentName,
			holder: conflict.agent_name,
			cohort: conflict.cohort,
			expires_at: conflict.expires_at,
			conflict_reason: "preexisting",
		});
	}

	private cancelOwnedReleaseTimer(filePath: string, agentName: string): void {
		const existing = this.cache.get(filePath);
		if (!existing || !sameOwner(existing.agent_name, agentName)) return;
		const timerKey = `${existing.agent_name}:${filePath}`;
		const timer = this.releaseTimers.get(timerKey);
		if (timer) clearTimeout(timer);
		this.releaseTimers.delete(timerKey);
	}

	private grant(filePath: string, agentName: string, cohort: CohortManager): void {
		this.cancelOwnedReleaseTimer(filePath, agentName);
		const now = new Date();
		const expires = new Date(now.getTime() + RESERVATION_TTL_S * 1000);
		applyTransition(this.cache, {
			kind: "grant_local",
			file: filePath,
			agent: agentName,
			reservedAt: now.toISOString(),
			expiresAt: expires.toISOString(),
		});

		// Track in cohort
		cohort.addFileReservation(agentName, filePath);

		this.emit({
			ts: now.toISOString(),
			action: "grant",
			file: filePath,
			agent_name: agentName,
			cohort: "local",
			expires_at: expires.toISOString(),
		});

		// Confirm with server asynchronously. Rejection is a real signal —
		// roll back the local grant so the cohort sees the truth on the next
		// acquire instead of silently double-allocating. Server-unreachable
		// (network failure) is distinguishable from server-rejected (409 / 4xx
		// "someone else holds it") only via the API client; for the moment we
		// treat all errors as rejection because the conservative behavior is
		// to release the optimistic grant and let the next acquire re-try.
		if (this.apiClient) {
			this.apiClient.reserveFile(filePath, agentName, RESERVATION_TTL_S).catch(() => {
				this.rollbackOptimisticGrant(filePath, agentName, cohort);
			});
		}
	}

	/**
	 * Reverse a local optimistic grant after the server-side confirmation
	 * fails. Idempotent — if the entry has already been replaced (e.g., the
	 * agent released it before the server replied), this is a no-op aside
	 * from the conflict event.
	 *
	 * The conflict event uses `conflict_reason: "server-rejected"` so log
	 * consumers (including the future `interlinked recurrence` aggregator)
	 * can distinguish optimistic-rollbacks from cache-hit conflicts.
	 */
	private rollbackOptimisticGrant(
		filePath: string,
		agentName: string,
		cohort: CohortManager,
	): void {
		const entry = this.cache.get(filePath);
		// Only roll back if the entry is still ours; otherwise something
		// else (release, expiry, remote upsert via refresh) has already moved
		// the state and our rollback would be a phantom mutation.
		if (entry && sameOwner(entry.agent_name, agentName) && entry.cohort === "local") {
			const owner = entry.agent_name;
			applyTransition(this.cache, { kind: "release", file: filePath, agent: owner });
			cohort.removeFileReservation(owner, filePath);
			const timerKey = `${owner}:${filePath}`;
			const timer = this.releaseTimers.get(timerKey);
			if (timer) {
				clearTimeout(timer);
				this.releaseTimers.delete(timerKey);
			}
		}
		this.emit({
			ts: new Date().toISOString(),
			action: "conflict",
			file: filePath,
			agent_name: agentName,
			conflict_reason: "server-rejected",
		});
	}

	private emit(event: ReservationLogEvent): void {
		if (!this.eventSink) return;
		try {
			this.eventSink(event);
		} catch (_err) {
			/* intentional: sink failure must not break the lock primitive */
		}
	}

	/**
	 * Schedule auto-release of a file reservation after idle timeout.
	 * Called on PostToolUse for file operations.
	 * Resets the timer if the same agent edits the same file again.
	 */
	scheduleRelease(filePath: string, agentName: string, cohort: CohortManager): void {
		const entry = this.cache.get(filePath);
		if (!entry || !sameOwner(entry.agent_name, agentName)) return;
		// Key the timer + release on the *stored* owner, not the caller's name
		// variant, so a session-claude-<id> PostToolUse can't strand a
		// session-<id> grant past the idle timeout.
		const owner = entry.agent_name;

		// Clear existing timer for this file
		const timerKey = `${owner}:${filePath}`;
		const existing = this.releaseTimers.get(timerKey);
		if (existing) clearTimeout(existing);

		// Set new release timer
		const timer = setTimeout(() => {
			this.release(filePath, owner, cohort);
			this.releaseTimers.delete(timerKey);
		}, AUTO_RELEASE_MS);

		this.releaseTimers.set(timerKey, timer);
	}

	/** Immediately release a specific file reservation */
	release(filePath: string, agentName: string, cohort: CohortManager): void {
		const entry = this.cache.get(filePath);
		if (!entry || !sameOwner(entry.agent_name, agentName)) return;
		// Operate on the *stored* owner name, not the caller's variant, so the
		// SSoT release transition and the server/cohort bookkeeping all target
		// the exact identity the grant used.
		const owner = entry.agent_name;

		applyTransition(this.cache, { kind: "release", file: filePath, agent: owner });
		cohort.removeFileReservation(owner, filePath);
		this.emit({
			ts: new Date().toISOString(),
			action: "release",
			file: filePath,
			agent_name: owner,
			cohort: entry.cohort,
		});

		// Clear any pending timer
		const timerKey = `${owner}:${filePath}`;
		const timer = this.releaseTimers.get(timerKey);
		if (timer) {
			clearTimeout(timer);
			this.releaseTimers.delete(timerKey);
		}

		// Release on server async
		if (this.apiClient) {
			this.apiClient.releaseFile(filePath, owner).catch(() => {
				/* best-effort: server-side release is reconciled by TTL + refresh */
			});
		}
	}

	/** Release ALL reservations for an agent (on session end or disconnect) */
	releaseAllForAgent(agentName: string, cohort: CohortManager): void {
		const toRelease: string[] = [];
		for (const [path, entry] of this.cache) {
			if (sameOwner(entry.agent_name, agentName)) {
				toRelease.push(path);
			}
		}
		for (const path of toRelease) {
			this.release(path, agentName, cohort);
		}
		cohort.clearReservations(agentName);
		if (toRelease.length > 0) {
			this.emit({
				ts: new Date().toISOString(),
				action: "release_all",
				file: `[${toRelease.length} files]`,
				agent_name: agentName,
			});
		}
	}

	/** Get all active reservations */
	getAll(): ReservationEntry[] {
		// Prune expired entries via the SSoT transition.
		const now = harnessNow();
		for (const [path, entry] of this.cache) {
			if (entry.expires_at && new Date(entry.expires_at).getTime() < now) {
				applyTransition(this.cache, { kind: "expire", file: path });
			}
		}
		return [...this.cache.values()];
	}

	/** Get reservations for a specific agent */
	getForAgent(agentName: string): ReservationEntry[] {
		return this.getAll().filter((e) => sameOwner(e.agent_name, agentName));
	}

	/** Refresh the local cache from the server */
	async refreshFromServer(): Promise<void> {
		if (!this.apiClient) return;

		try {
			const serverReservations = await this.apiClient.listReservations();

			// Build set of server-side reservation paths for eviction check
			const serverPaths = new Set(serverReservations.map((sr) => sr.path_pattern));

			// Evict remote reservations that are no longer on the server
			// (e.g., another agent released a file before TTL expired) via
			// the SSoT transition.
			for (const [path, entry] of this.cache) {
				if (entry.cohort === "remote" && !serverPaths.has(path)) {
					applyTransition(this.cache, { kind: "evict_remote", file: path });
				}
			}

			// Upsert server reservations (server is authoritative for remote agents)
			for (const sr of serverReservations) {
				const existing = this.cache.get(sr.path_pattern);
				// Only update if this is a remote reservation or we don't have it locally
				if (!existing || existing.cohort === "remote") {
					applyTransition(this.cache, {
						kind: "grant_remote",
						file: sr.path_pattern,
						agent: sr.agent_name,
						reservedAt: new Date().toISOString(),
						expiresAt:
							sr.expires_at ||
							new Date(harnessNow() + RESERVATION_TTL_S * 1000).toISOString(),
					});
				}
			}
		} catch (e) {
			void e;
		}
	}

	/** Stop background refresh */
	shutdown(): void {
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = null;
		}
		// Clear all release timers
		for (const timer of this.releaseTimers.values()) {
			clearTimeout(timer);
		}
		this.releaseTimers.clear();
	}

	/** Simple path-to-pattern matching (exact match or glob) */
	private pathMatchesPattern(filePath: string, pattern: string): boolean {
		// Exact match
		if (filePath === pattern) return true;

		// Simple glob: "src/auth/**" matches "src/auth/login.ts"
		if (pattern.endsWith("/**")) {
			const prefix = pattern.slice(0, -3);
			return filePath.startsWith(`${prefix}/`) || filePath === prefix;
		}

		// Simple glob: "**/*.ts" matches any .ts file; "**/Makefile" matches a
		// Makefile in any directory. MUST be checked BEFORE the single-'*' arm:
		// "**/..." also starts with '*', and the '*' arm would mishandle it
		// (testing endsWith("*/...") — the literal '*' never matches a real path),
		// silently making every "**/" reservation a no-op.
		if (pattern.startsWith("**/")) {
			const suffix = pattern.slice(3);
			if (suffix.startsWith("*")) {
				return filePath.endsWith(suffix.slice(1));
			}
			return filePath.endsWith(`/${suffix}`) || filePath === suffix;
		}

		// Simple glob: "*.env" matches ".env", "staging.env"
		if (pattern.startsWith("*")) {
			return filePath.endsWith(pattern.slice(1));
		}

		return false;
	}
}
