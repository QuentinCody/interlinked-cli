// Unit C5: adopted automatic execution is bounded by policy — quiet period,
// one job per project, one automatic start per interval, an explicit budget —
// and defaults to OFF. The decision is pure; the daemon-side runner only
// schedules timers and spawns the CLI detached (plan §9.3, PE-25).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseE2ePolicy } from "./policy.js";
import { AutoRunner, DEFAULT_SCHEDULING, decideAutoRun, effectiveScheduling, resolveCliEntry, type SchedulingPolicy } from "./scheduler.js";

const ON: SchedulingPolicy = { autoRun: true, quietMs: 5_000, minIntervalMs: 60_000, budgetMs: 120_000 };
const POLICY = { version: 1, projects: [{ id: "p", root: ".", protectedInputs: ["src/**"], mode: "advisory", suites: [{ id: "s", adapter: "managed-contracts" }], scenarios: [{ id: "x", suite: "s", affects: ["src/**"], contractIds: ["c"], required: false }] }] };

describe("decideAutoRun — positive (starts exactly when the bounds allow)", () => {
    it("P1: after the quiet period, with no run in progress and no recent automatic start, it starts", () => {
        expect(decideAutoRun(ON, { lastRelevantEventMs: 10_000, lastStartMs: null, running: false }, 15_000)).toMatchObject({ start: true, waitMs: 0 });
    });
    it("P2: inside the quiet period it waits exactly the remainder; inside the minimum interval it waits until the interval elapses", () => {
        expect(decideAutoRun(ON, { lastRelevantEventMs: 10_000, lastStartMs: null, running: false }, 12_000)).toMatchObject({ start: false, waitMs: 3_000 });
        expect(decideAutoRun(ON, { lastRelevantEventMs: 10_000, lastStartMs: 20_000, running: false }, 30_000)).toMatchObject({ start: false, waitMs: 50_000 });
    });
    it("P3: policy defaults are OFF and bounded; effectiveScheduling fills unspecified fields", () => {
        expect(DEFAULT_SCHEDULING.autoRun).toBe(false);
        expect(effectiveScheduling(parseE2ePolicy(JSON.stringify({ ...POLICY, scheduling: { autoRun: true, quietMs: 2_000 } })))).toEqual({ ...DEFAULT_SCHEDULING, autoRun: true, quietMs: 2_000 });
        expect(effectiveScheduling(parseE2ePolicy(JSON.stringify(POLICY)))).toEqual(DEFAULT_SCHEDULING);
    });
});
describe("decideAutoRun — negative (never starts outside the bounds)", () => {
    it("N1: disabled, running, or nothing relevant observed means no start and no timer", () => {
        expect(decideAutoRun({ ...ON, autoRun: false }, { lastRelevantEventMs: 0, lastStartMs: null, running: false }, 99_999)).toMatchObject({ start: false, waitMs: 0 });
        expect(decideAutoRun(ON, { lastRelevantEventMs: 0, lastStartMs: null, running: true }, 99_999)).toMatchObject({ start: false, waitMs: 0, reason: expect.stringMatching(/in progress/) });
        expect(decideAutoRun(ON, { lastRelevantEventMs: null, lastStartMs: null, running: false }, 99_999)).toMatchObject({ start: false, waitMs: 0 });
    });
    it("N2: the policy parser refuses out-of-bound or unknown scheduling fields", () => {
        const attempt = (scheduling: unknown) => () => parseE2ePolicy(JSON.stringify({ ...POLICY, scheduling }));
        expect(attempt({ quietMs: 10 })).toThrow(/quietMs/);
        expect(attempt({ minIntervalMs: 999_999_999 })).toThrow(/minIntervalMs/);
        expect(attempt({ budgetMs: 1 })).toThrow(/budgetMs/);
        expect(attempt({ autoRun: "yes" })).toThrow(/autoRun/);
        expect(attempt({ retries: 3 })).toThrow(/unknown key/);
    });
});
describe("resolveCliEntry — the detached child must be the CLI wherever the bundler put this module", () => {
    it("P1: from the source tree it resolves src/index.ts under tsx (the dist layout is pinned by the real-daemon e2e test)", () => {
        const entry = resolveCliEntry();
        expect(entry?.file.endsWith("/src/index.ts")).toBe(true);
        expect(entry?.argv.slice(0, 2)).toEqual(["--import", "tsx"]);
    });
});
describe("AutoRunner — daemon side (fake timers, injected spawn)", () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
    afterEach(() => { vi.useRealTimers(); });
    it("P1: several notifications inside the quiet period coalesce into ONE spawn after the quiet period, with the policy budget", async () => {
        const spawned: Array<{ root: string; budgetMs: number }> = [];
        let finish = () => {};
        const runner = new AutoRunner({ spawn: (root, budgetMs) => { spawned.push({ root, budgetMs }); return new Promise<void>(resolve => { finish = resolve; }); } });
        runner.notify("/repo", ON); vi.advanceTimersByTime(2_000); runner.notify("/repo", ON); vi.advanceTimersByTime(2_000); runner.notify("/repo", ON);
        expect(spawned).toEqual([]);
        vi.advanceTimersByTime(5_000);
        expect(spawned).toEqual([{ root: "/repo", budgetMs: 120_000 }]);
        // While it runs, further notifications retain work but never start a second job for the same project (PE-25 / one job per project).
        runner.notify("/repo", ON); vi.advanceTimersByTime(10_000);
        expect(spawned).toHaveLength(1);
        finish(); await vi.advanceTimersByTimeAsync(0);
        // After completion the retained work starts again only once the minimum interval has elapsed.
        vi.advanceTimersByTime(30_000);
        expect(spawned).toHaveLength(1);
        vi.advanceTimersByTime(30_000);
        expect(spawned).toHaveLength(2);
    });
    it("N2: disarm cancels a queued start; a fresh ON notification re-arms; a job running at disarm time finishes but never re-arms (review C4)", async () => {
        const spawned: string[] = [];
        let finish = () => {};
        const runner = new AutoRunner({ spawn: root => { spawned.push(root); return new Promise<void>(resolve => { finish = resolve; }); } });
        runner.notify("/repo", ON); vi.advanceTimersByTime(2_000); runner.disarm("/repo"); vi.advanceTimersByTime(60_000);
        expect(spawned).toEqual([]);
        runner.notify("/repo", ON); vi.advanceTimersByTime(5_000);
        expect(spawned).toEqual(["/repo"]);
        runner.notify("/repo", ON); runner.disarm("/repo"); finish(); await vi.advanceTimersByTimeAsync(0); vi.advanceTimersByTime(120_000);
        expect(spawned).toEqual(["/repo"]);
    });
    it("N1: a disabled policy never spawns, and two projects are scheduled independently", () => {
        const spawned: string[] = [];
        const runner = new AutoRunner({ spawn: root => { spawned.push(root); return Promise.resolve(); } });
        runner.notify("/off", { ...ON, autoRun: false }); vi.advanceTimersByTime(100_000);
        expect(spawned).toEqual([]);
        runner.notify("/a", ON); runner.notify("/b", ON); vi.advanceTimersByTime(5_000);
        expect(spawned.sort()).toEqual(["/a", "/b"]);
    });
});
