// ===========================================
// Cross-session attribution for workspace effects
// ===========================================
//
// The Stop residue diff in `workspace-effects.ts` is time-scoped, not
// actor-scoped — on a shared tree it would charge session A for session B's
// writes (observed 2026-08-21: a concurrent session's untracked mutation-kill
// test was folded into this session's touched-file rescan and flagged at Stop).
//
// This module is the daemon-wide attribution registry: the last reconciled
// PostToolUse effect per path, across ALL sessions the daemon serves.
// Exact path ownership is the attribution proof: a reconciled actor owns the
// latest observed write to that path until another reconciliation replaces it.
// The stored hash remains useful evidence and preserves the durable format,
// but a later unobserved re-edit does not charge that actor's path to a peer.
//
// The registry is deliberately NOT cleared when a session ends — it is
// cross-session evidence, and the writing session usually stops before the
// charged session observes the residue. It is bounded by insertion-order
// pruning instead, and (being in-memory) resets on daemon restart, which
// matches the backstop semantics of the residue check itself.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkspaceFileEffect } from "./workspace-effects.js";

interface ReconciledEffectRecord {
	sessionId: string;
	/** Stable spawned-thread id. null = known root; absent = legacy actor unknown. */
	subagentId?: string | null;
	sha256: string | null;
}

const reconciledEffectByPath = new Map<string, ReconciledEffectRecord>();
export const RECONCILED_PATH_CEILING = 4096;

// ---- durable registry (2026-08-23) ----
// The in-memory map dies with the daemon, and this repo restarts its daemon
// after every harness change — each restart un-attributed every earlier write,
// and concurrent sessions' wave-test files leaked back into innocent sessions'
// Stop rescans. The registry is now write-through to one JSON file under
// .interlinked/ and lazily loaded after a restart. Load/save fail soft: a
// missing or corrupt file only means the backstop is as conservative as the
// old in-memory behavior.
/** Repo-relative store path (posix form; snapshot code excludes it so the
 *  registry's own write never shows up as a workspace effect). */
export const EFFECT_ATTRIBUTION_STORE_REL = ".interlinked/effect-attribution.json";
const ATTRIBUTION_STORE_REL = join(".interlinked", "effect-attribution.json");
let loadedFromDisk = false;
let storeRoot: string | null = null;
let loadFailureNoted = false;

/** Point the registry at a repo root (first caller wins); enables persistence.
 *  Wired from the workspace-effects reconcile/residue paths, which both know
 *  the root — no separate daemon-startup hook needed. */
export function initEffectAttributionStore(root: string): void {
	if (storeRoot === root) return;
	storeRoot = root;
	loadedFromDisk = false;
}

/** Parse the on-disk attribution store into a plain record, or null when the
 *  file is absent or its shape is unusable. Never throws — callers already
 *  wrap the whole load in try/catch for the read/parse failure case. */
function parseAttributionStoreFile(file: string): Record<string, unknown> | null {
	if (!existsSync(file)) return null;
	const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	return parsed as Record<string, unknown>;
}

/** Normalize one raw disk entry into a `ReconciledEffectRecord`, or null when
 *  the entry's shape can't be trusted. */
function normalizeLoadedRecord(rec: unknown): ReconciledEffectRecord | null {
	if (typeof rec !== "object" || rec === null) return null;
	const sessionId = (rec as { sessionId?: unknown }).sessionId;
	const subagentId = (rec as { subagentId?: unknown }).subagentId;
	const sha256 = (rec as { sha256?: unknown }).sha256;
	if (typeof sessionId !== "string") return null;
	const record: ReconciledEffectRecord = {
		sessionId,
		sha256: typeof sha256 === "string" ? sha256 : null,
	};
	if (subagentId === null) record.subagentId = null;
	else if (typeof subagentId === "string" && subagentId.length > 0) {
		record.subagentId = subagentId;
	}
	return record;
}

/** Apply every usable entry from a parsed disk record into the live map.
 *  Live rows (already present) outrank disk — never overwritten. */
function applyLoadedEntries(parsed: Record<string, unknown>): void {
	for (const [path, rec] of Object.entries(parsed)) {
		if (reconciledEffectByPath.has(path)) continue; // live rows outrank disk
		const record = normalizeLoadedRecord(rec);
		if (record === null) continue;
		reconciledEffectByPath.set(path, record);
	}
}

/** Note a load/persist failure once to stderr. Fail-soft: never a gate. */
function noteAttributionStoreFailure(kind: "unreadable" | "write failed", err: unknown): void {
	if (loadFailureNoted) return;
	loadFailureNoted = true;
	console.error(`[interlinked] effect-attribution store ${kind}: ${String(err)}`);
}

function loadRegistryOnce(): void {
	if (loadedFromDisk || storeRoot === null) return;
	loadedFromDisk = true;
	try {
		const file = join(storeRoot, ATTRIBUTION_STORE_REL);
		const parsed = parseAttributionStoreFile(file);
		if (parsed === null) return;
		applyLoadedEntries(parsed);
	} catch (err) {
		// Corrupt/unreadable store: registry falls back to in-memory-only
		// semantics. Note once to stderr; never a gate.
		noteAttributionStoreFailure("unreadable", err);
	}
}

function persistRegistry(): void {
	if (storeRoot === null) return;
	try {
		const file = join(storeRoot, ATTRIBUTION_STORE_REL);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(Object.fromEntries(reconciledEffectByPath)), "utf-8");
	} catch (err) {
		// fail soft — persistence is best-effort evidence, never a gate
		if (!loadFailureNoted) {
			loadFailureNoted = true;
			console.error(`[interlinked] effect-attribution store write failed: ${String(err)}`);
		}
	}
}

/** Record one session's reconciled PostToolUse effects for later attribution. */
export function recordReconciledEffects(
	sessionId: string,
	effects: readonly WorkspaceFileEffect[],
	subagentId?: string,
): void {
	loadRegistryOnce();
	for (const effect of effects) {
		// Delete-then-set keeps the map in recency order, so pruning removes the
		// stalest attribution first.
		reconciledEffectByPath.delete(effect.path);
		const record: ReconciledEffectRecord = {
			sessionId,
			subagentId: subagentId || null,
			sha256: effect.after_sha256,
		};
		reconciledEffectByPath.set(effect.path, record);
	}
	while (reconciledEffectByPath.size > RECONCILED_PATH_CEILING) {
		const oldest = reconciledEffectByPath.keys().next().value;
		if (oldest === undefined) break;
		reconciledEffectByPath.delete(oldest);
	}
	persistRegistry();
}

/** True when another session's reconciled write explains this observed effect.
 *  Two tiers of proof (2026-08-23, widened from hash-equality only):
 *  - hash match (null-hash equality covers deletions) — exact;
 *  - path ownership — the other session reconciled a write to this exact path
 *    and this session never did. A concurrent writer that edits its own file
 *    again after reconciling made the stale hash mismatch, which was the
 *    remaining leak path into innocent sessions' Stop rescans. */
function isAttributedToOtherActor(
	sessionId: string,
	subagentId: string | undefined,
	effect: WorkspaceFileEffect,
): boolean {
	loadRegistryOnce();
	const record = reconciledEffectByPath.get(effect.path);
	if (!record) return false;
	if (record.sessionId !== sessionId) return true;
	// Pre-actor-identity rows omit subagentId. They prove session ownership only,
	// so remain conservative for every actor in that same session.
	if (record.subagentId === undefined) return false;
	return record.subagentId !== (subagentId || null);
}

/** Split residue effects into this actor's own vs. ones proven to belong to a
 *  different actor. */
export function partitionResidueByAttribution(
	sessionId: string,
	effects: readonly WorkspaceFileEffect[],
	subagentId?: string,
): { own: WorkspaceFileEffect[]; attributedElsewhere: number } {
	const own: WorkspaceFileEffect[] = [];
	let attributedElsewhere = 0;
	for (const effect of effects) {
		if (isAttributedToOtherActor(sessionId, subagentId, effect)) attributedElsewhere++;
		else own.push(effect);
	}
	return { own, attributedElsewhere };
}

/** Test seam: drop all recorded attributions. */
export function resetReconciledEffectRegistry(): void {
	reconciledEffectByPath.clear();
	storeRoot = null;
	loadedFromDisk = false;
	loadFailureNoted = false;
}
