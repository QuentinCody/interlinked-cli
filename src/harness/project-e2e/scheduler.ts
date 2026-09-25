// ===========================================
// Scheduling — bounded automatic execution, default OFF
// ===========================================
// Plan 31 §9.3 (Unit C5). The policy's `scheduling` block turns adopted
// automatic execution on and bounds it: a quiet period after the latest
// relevant batch, at most one heavy job per project, at most one automatic
// start per interval, an explicit budget. `decideAutoRun` is pure. The
// daemon-side `AutoRunner` only keeps timers and spawns the CLI detached —
// it never runs a suite in the daemon process. Retained work is retried on
// the next bound, never on every tool call (no retry-until-green; PE-25).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { E2ePolicy } from "./policy.js";

export interface SchedulingPolicy { autoRun: boolean; quietMs: number; minIntervalMs: number; budgetMs: number; }
export const DEFAULT_SCHEDULING: SchedulingPolicy = { autoRun: false, quietMs: 5_000, minIntervalMs: 60_000, budgetMs: 120_000 };
export interface AutoRunState { lastRelevantEventMs: number | null; lastStartMs: number | null; running: boolean; }
export interface AutoRunDecision { start: boolean; /** Milliseconds until the decision could change; 0 when nothing is scheduled. */ waitMs: number; reason: string; }

export function effectiveScheduling(policy: E2ePolicy): SchedulingPolicy {
    return { ...DEFAULT_SCHEDULING, ...(policy.scheduling ?? {}) };
}
/** Pure: the same inputs always yield the same decision. */
export function decideAutoRun(policy: SchedulingPolicy, state: AutoRunState, nowMs: number): AutoRunDecision {
    if (!policy.autoRun) return { start: false, waitMs: 0, reason: "automatic execution is off (policy scheduling.autoRun)" };
    if (state.running) return { start: false, waitMs: 0, reason: "a supervised run is in progress for this project; work retained" };
    if (state.lastRelevantEventMs === null) return { start: false, waitMs: 0, reason: "no relevant change observed" };
    const quietRemaining = state.lastRelevantEventMs + policy.quietMs - nowMs;
    if (quietRemaining > 0) return { start: false, waitMs: quietRemaining, reason: `quiet period: ${quietRemaining} ms remaining` };
    const intervalRemaining = state.lastStartMs === null ? 0 : state.lastStartMs + policy.minIntervalMs - nowMs;
    if (intervalRemaining > 0) return { start: false, waitMs: intervalRemaining, reason: `minimum interval: ${intervalRemaining} ms remaining` };
    return { start: true, waitMs: 0, reason: "quiet period elapsed and no automatic start within the interval" };
}

export interface AutoRunnerDeps { spawn: (root: string, budgetMs: number) => Promise<void>; now?: () => number; }
interface ProjectLane { state: AutoRunState; policy: SchedulingPolicy; timer: NodeJS.Timeout | null; }
/** One lane per project root; each lane holds at most one timer and at most one running job. */
export class AutoRunner {
    private readonly lanes = new Map<string, ProjectLane>();
    constructor(private readonly deps: AutoRunnerDeps) {}
    /** A relevant change (or a retained request) was observed for `root` under `policy`. */
    notify(root: string, policy: SchedulingPolicy): void {
        const lane = this.lanes.get(root) ?? { state: { lastRelevantEventMs: null, lastStartMs: null, running: false }, policy, timer: null };
        lane.policy = policy;
        lane.state.lastRelevantEventMs = this.now();
        this.lanes.set(root, lane);
        this.arm(root, lane);
    }
    /** The policy no longer authorizes automatic execution for `root` (off, removed, invalid — review C4): cancel any queued start and drop retained work; a job already running finishes but never re-arms. */
    disarm(root: string): void {
        const lane = this.lanes.get(root);
        if (!lane) return;
        if (lane.timer) { clearTimeout(lane.timer); lane.timer = null; }
        lane.policy = { ...lane.policy, autoRun: false };
        lane.state.lastRelevantEventMs = null;
    }
    private now(): number { return (this.deps.now ?? Date.now)(); }
    private arm(root: string, lane: ProjectLane): void {
        if (lane.timer) { clearTimeout(lane.timer); lane.timer = null; }
        const decision = decideAutoRun(lane.policy, lane.state, this.now());
        if (decision.start) { this.start(root, lane); return; }
        if (decision.waitMs > 0) { lane.timer = setTimeout(() => { lane.timer = null; this.arm(root, lane); }, decision.waitMs); lane.timer.unref?.(); }
    }
    private start(root: string, lane: ProjectLane): void {
        lane.state.running = true;
        lane.state.lastStartMs = this.now();
        const startedAt = lane.state.lastRelevantEventMs;
        this.deps.spawn(root, lane.policy.budgetMs).catch(() => undefined).then(() => {
            lane.state.running = false;
            // Work that arrived during the run is retained: re-arm so it starts at the next bound, not immediately.
            if (lane.state.lastRelevantEventMs !== startedAt) this.arm(root, lane);
        });
    }
}

/** A directory is the CLI root only if it holds the daemon entry too — `dist/` (harness/server.js) or `src/` (harness/server.ts). */
function isCliRoot(directory: string): boolean {
    return existsSync(join(directory, "harness", "server.js")) || existsSync(join(directory, "harness", "server.ts"));
}
/**
 * The CLI entry the daemon spawns. The bundler may place this module in `dist/harness/server.js` OR in a `dist/chunk-*.js`
 * shared with `dist/index.js` (it did once `run.ts` imported it — review round 1 found the detached child silently never
 * spawning), so every candidate is verified by its sibling daemon entry, never by position alone.
 */
export function resolveCliEntry(): { file: string; argv: string[] } | null {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const relative of [".", "..", "../.."]) {
        const root = resolve(here, relative);
        if (!isCliRoot(root)) continue;
        const built = join(root, "index.js");
        if (existsSync(built)) return { file: built, argv: [built] };
        const source = join(root, "index.ts");
        if (existsSync(source)) return { file: source, argv: ["--import", "tsx", source] };
    }
    return null;
}
/** Detached supervised run through the CLI itself (never in the daemon process); resolves when the child exits. */
export function spawnDetachedE2eRun(root: string, budgetMs: number): Promise<void> {
    const entry = resolveCliEntry();
    if (!entry) return Promise.resolve();
    return new Promise(resolve => {
        const child = spawn(process.execPath, [...entry.argv, "tests", "e2e", "run", "--cwd", root, "--timeout", String(budgetMs), "--json"], { cwd: root, detached: true, stdio: "ignore", env: { ...process.env, INTERLINKED_AUTO_RUN: "1" } });
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
        child.unref();
    });
}
