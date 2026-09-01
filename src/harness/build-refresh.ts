// ===========================================
// Build-refresh watcher — daemons hand over to newer builds
// ===========================================
// Every guarded repo runs a long-lived daemon from the SHARED dist/ of the
// linked CLI checkout. `interlinked reload` rebuilds + restarts the CURRENT
// repo's daemon, but sibling repos kept serving the old build until someone
// manually restarted them (operator-reported 2026-07-13: mcp-client-bio ran
// a pre-pull daemon spawned from a stale hook generation). This watcher
// closes that loop: each daemon stats its own dist artifact once a minute
// and, when a newer *settled* build appears during a *quiet* window, hands
// over by spawning `interlinked harness restart` — the same battle-tested
// stop→start sequence a human would run, so socket/pidfile ownership rules
// stay in exactly one place. The restart SIGTERMs this process; the normal
// graceful-shutdown path retires it.
//
// Src-run daemons (tsx/bun dev) no-op — there is no build artifact to watch;
// dev iterates via `interlinked reload`. Escape hatch (parallel to
// INTERLINKED_NO_SELF_HEAL): INTERLINKED_NO_AUTO_RESTART=1.

import { spawn as nodeSpawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runningBuildStaleness, stalenessWarning } from "./build-staleness.js";
import {
	type DaemonLedgerEvent,
	type HandoverOutcome,
	recordDaemonEvent,
	readRecentDaemonEvents,
} from "./daemon-ledger.js";
import {
	HANDOVER_ATTEMPT_ENV,
	HANDOVER_CHURN_WINDOW_MS,
	churnBackstopEvent,
	handoverChurnExceeded,
	newHandoverAttemptId,
	unresolvedAttemptExistsFor,
} from "./handover-churn.js";

const DEFAULT_INTERVAL_MS = 60_000;
/** A fresher artifact must be at least this old — tsup may still be writing. */
const SETTLE_MS = 5_000;
/** No hook event this recent — don't yank the daemon mid-burst. */
const QUIET_MS = 10_000;
/**
 * Hard staleness deadline. Past this, hand over even mid-burst.
 *
 * The quiet window alone STARVES: a busy multi-agent session fires hook events
 * continuously, so `now - lastActivity >= QUIET_MS` may never be true at a
 * 60s sample. Measured on this repo 2026-07-31 — the daemon ledger showed 38
 * `rss-ceiling` handovers against 2 `build-refresh` handovers (the most recent
 * two days stale), while the running daemon served a 2-hour-old build. That
 * build predated the baseline-integrity gate's current rules, so a cap-loosening
 * edit to `.interlinked/metric-caps.json` was ALLOWED; the same edit blocked
 * immediately after a restart. A stale daemon does not fail loudly — it
 * silently under-enforces, which is the one failure mode a guard must not have.
 *
 * Handing over mid-burst costs a brief window where tool calls fail CLOSED
 * (blocked, never allowed), which is strictly safer than gates that quietly do
 * not fire. So staleness escalates past the quiet window rather than yielding
 * to it.
 */
const MAX_STALENESS_MS = 10 * 60_000;

interface OwnArtifact {
	/** Absolute path of the running daemon's own build artifact. */
	artifactPath: string;
	/** Absolute path of the sibling CLI entry (`dist/index.js`). */
	cliEntryPath: string;
}

/** Resolve the running module's build artifact + CLI entry from its URL.
 *  Null when running from source (no `/dist/` segment) or unparseable —
 *  callers treat null as "nothing to watch". */
export function resolveOwnArtifact(moduleUrl: string): OwnArtifact | null {
	let here: string;
	try {
		here = fileURLToPath(moduleUrl);
	} catch {
		return null;
	}
	const marker = `${sep}dist${sep}`;
	const idx = here.indexOf(marker);
	if (idx === -1) return null;
	return { artifactPath: here, cliEntryPath: join(here.slice(0, idx), "dist", "index.js") };
}

interface HandOverInput {
	nowMs: number;
currentMtimeMs: number;
	startedMtimeMs: number;
	/** Last hook-event timestamp (0 = never — trivially quiet). */
	lastActivityAtMs: number;
	settleMs: number;
	quietMs: number;
	/** Staleness past which the quiet window is overridden. Defaults to
	 *  {@link MAX_STALENESS_MS}; tests pass their own. */
	maxStalenessMs?: number;
}

/** Pure hand-over predicate: the artifact is newer than the one this daemon
 *  started from, the rebuild has settled, and EITHER the repo is between bursts
 *  or the running build has been stale long enough that waiting for quiet is
 *  the worse risk (see {@link MAX_STALENESS_MS}). */
export function shouldHandOver(input: HandOverInput): boolean {
	if (input.currentMtimeMs <= input.startedMtimeMs) return false;
	const artifactAgeMs = input.nowMs - input.currentMtimeMs;
	if (artifactAgeMs < input.settleMs) return false;
	// Escalation: a long-stale daemon hands over regardless of activity, because
	// continuous hook traffic would otherwise hold the quiet window shut forever.
	if (artifactAgeMs >= (input.maxStalenessMs ?? MAX_STALENESS_MS)) return true;
	if (input.nowMs - input.lastActivityAtMs < input.quietMs) return false;
	return true;
}

/** Injectable I/O so the watcher is unit-testable without spawning daemons. */
interface BuildRefreshDeps {
	statMtimeMs: (path: string) => number | null;
	spawn: typeof nodeSpawn;
}

interface BuildRefreshOptions {
	moduleUrl: string;
	/** Repo root the daemon guards — the restart runs with this cwd. */
	cwd: string;
	/** Live view of the daemon's last hook-event timestamp. */
	lastActivityMs: () => number;
	log: (line: string) => void;
	intervalMs?: number;
	env?: NodeJS.ProcessEnv;
	deps?: Partial<BuildRefreshDeps>;
}

function defaultStatMtimeMs(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

/** Fire the detached restart, threading the attempt id to the successor via
 *  {@link HANDOVER_ATTEMPT_ENV} (spawn env inheritance carries it through
 *  restart → start → daemon, where the startup guard stamps the `listening`
 *  row). Returns whether a child was actually launched. */
function spawnSuccessor(
	spawn: typeof nodeSpawn,
	own: OwnArtifact,
	cwd: string,
	attemptId: string,
): boolean {
	try {
		const child = spawn(process.execPath, [own.cliEntryPath, "harness", "restart"], {
			cwd,
			detached: true,
			stdio: "ignore",
			env: { ...process.env, [HANDOVER_ATTEMPT_ENV]: attemptId },
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

/** One typed attempt row. `spawned` is the only outcome the churn backstop
 *  counts as unresolved (until a `listening` row acknowledges the id). */
function attemptRow(args: {
	nowMs: number;
	reason: string;
	outcome: HandoverOutcome;
	attemptId: string;
	detail?: string;
}): DaemonLedgerEvent {
	return {
		at: args.nowMs,
		pid: process.pid,
		event: "handover",
		reason: args.reason,
		outcome: args.outcome,
		attempt_id: args.attemptId,
		...(args.detail !== undefined ? { detail: args.detail } : {}),
	};
}

/**
 * Start the build-refresh watcher. Also emits the startup staleness warning
 * (src newer than dist) that previously lived inline in server.ts — the two
 * signals share one home so freshness logic isn't split across files.
 * Returns a disposer; the timer is unref'd so it never pins the process.
 */
export function startBuildRefreshWatcher(opts: BuildRefreshOptions): () => void {
	const warn = stalenessWarning(runningBuildStaleness(opts.moduleUrl));
	if (warn) opts.log(warn);

	const env = opts.env ?? process.env;
	if (env.INTERLINKED_NO_AUTO_RESTART === "1") return () => {};
	const own = resolveOwnArtifact(opts.moduleUrl);
	if (own === null) return () => {};

	const deps: BuildRefreshDeps = {
		statMtimeMs: defaultStatMtimeMs,
		spawn: nodeSpawn,
		...opts.deps,
	};
	const startedMtimeMs = deps.statMtimeMs(own.artifactPath);
	if (startedMtimeMs === null) return () => {};

	const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
	let lastAttemptMs = 0;
	const timer = setInterval(() => {
		const nowMs = Date.now();
		// A hand-over is pending — give the restart two intervals to land
		// before concluding it failed and retrying.
		if (lastAttemptMs !== 0 && nowMs - lastAttemptMs < intervalMs * 2) return;
		const currentMtimeMs = deps.statMtimeMs(own.artifactPath);
		if (currentMtimeMs === null) return;
		const decide: HandOverInput = {
			nowMs,
			currentMtimeMs,
			startedMtimeMs,
			lastActivityAtMs: opts.lastActivityMs(),
			settleMs: SETTLE_MS,
			quietMs: QUIET_MS,
		};
		if (!shouldHandOver(decide)) return;
		lastAttemptMs = nowMs;
		// Backstop before committing to another handover: bound how many
		// unresolved attempts (any reason) this repo can accumulate — see
		// ./handover-churn.ts. A tripped backstop skips even the intent row
		// below; there is no successor coming, so there is nothing to explain
		// as "pending".
		if (handoverChurnExceeded(readRecentDaemonEvents(opts.cwd), nowMs)) {
			opts.log(
				"[build-refresh] handover churn backstop tripped — too many unresolved attempts in the last " +
					`${Math.round(HANDOVER_CHURN_WINDOW_MS / 60_000)} minutes; refusing to spawn another successor ` +
					"until one reaches listening or the window ages out. Run `interlinked harness restart` manually if needed.",
			);
			recordDaemonEvent(opts.cwd, churnBackstopEvent(process.pid, nowMs, "build-refresh handover suppressed"));
			return;
		}
		const detail = `artifact ${new Date(currentMtimeMs).toISOString()}`;
		// Coalesce: one unresolved attempt per build artifact. A second daemon
		// (or a second tick) noticing the SAME rebuild while a successor is
		// mid-boot must not spawn another — the 2026-08-22 storm was exactly
		// stacked successors killing each other pre-listening.
		if (unresolvedAttemptExistsFor(readRecentDaemonEvents(opts.cwd), nowMs, detail)) {
			opts.log(
				`[build-refresh] handover for ${detail} already in flight — coalescing (no second successor).`,
			);
			return;
		}
		opts.log(
			`[build-refresh] newer build detected (artifact ${new Date(currentMtimeMs).toISOString()} > running ${new Date(startedMtimeMs).toISOString()}) — handing over via \`interlinked harness restart\``,
		);
		// Typed attempt rows (attempt-ID protocol). `requested` before the spawn
		// is the non-counting INTENT: the restart retires this process with a
		// plain SIGTERM, so the exit row alone reads "signal" — indistinguishable
		// from a crash-restart without an adjacent row. One session lost hours to
		// exactly that ambiguity (2026-07-28), because ANY rebuild of the shared
		// dist — including `interlinked reload` run in a SIBLING repo — schedules
		// this handover in every guarded repo within a minute. Only the `spawned`
		// row COUNTS against the churn backstop, and the successor's `listening`
		// row acknowledges the attempt id regardless of row ordering.
		const attemptId = newHandoverAttemptId();
		recordDaemonEvent(
			opts.cwd,
			attemptRow({ nowMs, reason: "build-refresh", outcome: "requested", attemptId, detail }),
		);
		const launched = spawnSuccessor(deps.spawn, own, opts.cwd, attemptId);
		recordDaemonEvent(
			opts.cwd,
			attemptRow({
				nowMs,
				reason: "build-refresh",
				outcome: launched ? "launcher_spawned" : "spawn_failed",
				attemptId,
				detail,
			}),
		);
	}, intervalMs);
	timer.unref();
	return () => clearInterval(timer);
}
