// ===========================================
// Supervisor spawn backoff — the self-heal must get slower, not louder
// ===========================================
// The startup mutex fixed the SIMULTANEOUS half of the 2026-08-15 restart storm:
// N hooks firing in one second now collapse to one binder. It did nothing about
// the SEQUENTIAL half. Every blocked tool call still asked the supervisor to
// spawn, so a daemon that could not stay up — a broken `dist`, an OOM loop, a
// missing server path — was respawned once per blocked call, forever, and each
// spawn cost a full node boot plus an index load on a machine already short of
// memory. A supervisor that retries a failing start at the caller's rate is not
// a supervisor; it is an amplifier.
//
// So the spawn rate decays. The first attempt is immediate (a healthy daemon
// that just died should come back at once — that is the whole point of
// self-heal), and each further attempt without a working daemon doubles the
// wait: 5s, 10s, 20s, 40s, 60s, 60s… A single successful RPC proves the daemon
// is serving and resets the ladder, so a normal session never feels this.
//
// State lives in ONE small file because the hook process exits between calls
// and therefore cannot hold a counter in memory.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Hidden — transient supervisor state, not a durable data artifact. Exported
 *  as public API: `.interlinked/INDEX.md` and any operator cleaning up daemon
 *  state need the name from the source of truth, not a second copy. */
export const SUPERVISOR_BACKOFF_FILE = ".supervisor-backoff.json";

/** Wait after the FIRST failed self-heal. Short enough that a real crash-and-
 *  recover stays invisible to the agent, long enough that a boot has a chance
 *  to reach `listening` before the next caller asks again. */
export const SUPERVISOR_BACKOFF_MIN_MS = 5_000;

/** Ceiling on the doubling. A minute between spawns of a daemon that will not
 *  start is already generous; longer would delay recovery once the operator
 *  fixes the underlying cause (usually a rebuild). */
export const SUPERVISOR_BACKOFF_MAX_MS = 60_000;

/** Bound on the exponent BEFORE `2 **`, so a corrupt counter can never produce
 *  Infinity — the cap is then applied to a finite number, not derived from one. */
const MAX_DOUBLINGS = 16;

interface SupervisorBackoffState {
	/** Consecutive self-heal spawns with no successful RPC since. */
	attempts: number;
	/** Epoch ms of the most recent spawn. */
	last_spawn_at: number;
}

export function supervisorBackoffPath(repoRoot: string): string {
	return join(repoRoot, ".interlinked", SUPERVISOR_BACKOFF_FILE);
}

/** Current state, or null when absent/garbage. Never throws — this runs on the
 *  hook path, where an unreadable counter must not become a crash. */
export function readSupervisorBackoff(repoRoot: string): SupervisorBackoffState | null {
	try {
		const raw: unknown = JSON.parse(readFileSync(supervisorBackoffPath(repoRoot), "utf-8"));
		if (typeof raw !== "object" || raw === null) return null;
		// SAFETY: object-ness is checked above and both fields are type- and
		// finiteness-tested below, so no caller sees an unvalidated field.
		const state = raw as Partial<SupervisorBackoffState>;
		if (typeof state.attempts !== "number" || typeof state.last_spawn_at !== "number") return null;
		if (!Number.isFinite(state.attempts) || !Number.isFinite(state.last_spawn_at)) return null;
		return { attempts: state.attempts, last_spawn_at: state.last_spawn_at };
	} catch {
		return null;
	}
}

/**
 * Required wait before the NEXT spawn, given how many have already failed.
 *
 * `attempts` 0 → 0 (spawn now). Then 5s, 10s, 20s, 40s, capped at 60s.
 */
export function supervisorBackoffDelayMs(attempts: number): number {
	if (attempts <= 0) return 0;
	const steps = Math.min(Math.floor(attempts) - 1, MAX_DOUBLINGS);
	return Math.min(SUPERVISOR_BACKOFF_MIN_MS * 2 ** steps, SUPERVISOR_BACKOFF_MAX_MS);
}

/**
 * May the supervisor spawn a daemon right now?
 *
 * True with no recorded state (first heal after a healthy stretch) and once the
 * decaying interval has elapsed. A `last_spawn_at` in the FUTURE — a clock step
 * or a hand-edited file — is treated as "wait", the conservative direction: a
 * missed heal costs one more blocked call, an unthrottled heal is the storm.
 */
export function supervisorSpawnAllowed(repoRoot: string, nowMs: number = Date.now()): boolean {
	const state = readSupervisorBackoff(repoRoot);
	if (state === null) return true;
	return nowMs - state.last_spawn_at >= supervisorBackoffDelayMs(state.attempts);
}

/** Record a spawn: bump the attempt counter and stamp the time. `dryRun` makes
 *  this a no-op, so a simulated event never moves the real supervisor's ladder
 *  (the `harness test --write` lesson: a read-only probe must not mutate state). */
export function recordSupervisorSpawn(
	repoRoot: string,
	nowMs: number = Date.now(),
	opts: { dryRun?: boolean } = {},
): void {
	if (opts.dryRun === true) return;
	const prior = readSupervisorBackoff(repoRoot);
	const next: SupervisorBackoffState = {
		attempts: (prior?.attempts ?? 0) + 1,
		last_spawn_at: nowMs,
	};
	try {
		mkdirSync(join(repoRoot, ".interlinked"), { recursive: true });
		writeFileSync(supervisorBackoffPath(repoRoot), JSON.stringify(next));
	} catch {
		/* intentional: an unwritable counter degrades to no throttle, never to a crash */
	}
}

/** Clear the ladder. Called when an RPC SUCCEEDS — the daemon is serving, so
 *  every prior failed attempt is history. Never throws; a missing file is the
 *  expected steady state. */
export function resetSupervisorBackoff(repoRoot: string): void {
	try {
		unlinkSync(supervisorBackoffPath(repoRoot));
	} catch {
		/* intentional: already absent (the common case) or unwritable */
	}
}
