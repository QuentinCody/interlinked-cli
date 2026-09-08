import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
// Tests for the slow-test Stop nudge (measurement integrity — bug #13,
// scratch/fleet-r3/repair-followups.txt: a legitimate-but-slow test timed out
// Stryker's mutation dry run and poisoned kill-measurement for its whole
// file). The detector is pure given its injected `readEvents` function; the
// formatter is a pure string builder. Same style as
// mutation-kill-evidence-stop-check.test.ts: no real git process, no real
// filesystem for the detector/formatter cases — one end-to-end wiring case
// uses a real tmp-dir feed file (allowlisted real-fs-in-tests pattern) to
// prove the production default (`readRealTestEvents`) actually wires up.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedRecentTestEvents, type TestEvent, testEventsPath } from "../lib/viz/test-events.js";
import {
	checkSlowTests,
	detectSlowTests,
	formatSlowTestsWarning,
	type SlowTestHit,
} from "./slow-test-stop-check.js";
import type { ServerRuntime } from "./server/runtime-context.js";
import { makeServerRuntime } from "./server/__tests__/fixtures.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

const CWD = "/repo";
const SESSION_START = "2026-08-14T10:00:00.000Z";

/** A `kind:"test"` feed event, `atMs` milliseconds after SESSION_START. */
function testEvent(args: {
	file: string;
	name: string;
	ms: number;
	atMs?: number;
	status?: "pass" | "fail" | "skip" | "todo";
}): TestEvent {
	const atMs = args.atMs ?? 1_000;
	return {
		ts: new Date(Date.parse(SESSION_START) + atMs).toISOString(),
		kind: "test",
		run_id: "run-1",
		status: args.status ?? "pass",
		file: args.file,
		name: args.name,
		ms: args.ms,
	};
}

// ─── detector: positive (must fire) ────────────────────────────────────────

describe("detectSlowTests — positive (must fire)", () => {
	it("fires on a test over the absolute ~1s floor", () => {
		const events: TestEvent[] = [
			testEvent({ file: "a.test.ts", name: "slow one", ms: 1_500, atMs: 1_000 }),
			testEvent({ file: "a.test.ts", name: "fast one", ms: 5, atMs: 2_000 }),
		];
		const hits = detectSlowTests({
			cwd: CWD,
			sessionStartedAt: SESSION_START,
			readEvents: () => events,
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.name).toBe("slow one");
		expect(hits[0]?.reason).toBe("absolute");
	});

	it("fires on a test far above its file's median even under the absolute floor", () => {
		const events: TestEvent[] = [
			testEvent({ file: "b.test.ts", name: "typical 1", ms: 10, atMs: 1_000 }),
			testEvent({ file: "b.test.ts", name: "typical 2", ms: 10, atMs: 2_000 }),
			testEvent({ file: "b.test.ts", name: "typical 3", ms: 10, atMs: 3_000 }),
			testEvent({ file: "b.test.ts", name: "outlier", ms: 400, atMs: 4_000 }),
		];
		const hits = detectSlowTests({
			cwd: CWD,
			sessionStartedAt: SESSION_START,
			readEvents: () => events,
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.name).toBe("outlier");
		expect(hits[0]?.reason).toBe("relative");
		expect(hits[0]?.fileMedianMs).toBe(10);
	});

	it("collapses a retried case to its WORST observed duration", () => {
		const events: TestEvent[] = [
			testEvent({ file: "c.test.ts", name: "flaky-then-slow", ms: 1_200, atMs: 1_000 }),
			testEvent({ file: "c.test.ts", name: "flaky-then-slow", ms: 200, atMs: 2_000 }),
		];
		const hits = detectSlowTests({
			cwd: CWD,
			sessionStartedAt: SESSION_START,
			readEvents: () => events,
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.ms).toBe(1_200);
	});

	it("returns the hits slowest-first", () => {
		const events: TestEvent[] = [
			testEvent({ file: "h.test.ts", name: "middle", ms: 3_000, atMs: 1_000 }),
			testEvent({ file: "h.test.ts", name: "slowest", ms: 9_000, atMs: 2_000 }),
			testEvent({ file: "h.test.ts", name: "least slow", ms: 1_500, atMs: 3_000 }),
		];
		const hits = detectSlowTests({
			cwd: CWD,
			sessionStartedAt: SESSION_START,
			readEvents: () => events,
		});
		expect(hits.map((h) => h.name)).toEqual(["slowest", "middle", "least slow"]);
	});

	it("fires on an integration test over ITS higher 10s absolute floor", () => {
		const events: TestEvent[] = [
			testEvent({ file: "e.integration.test.ts", name: "very slow e2e", ms: 12_000, atMs: 1_000 }),
		];
		const hits = detectSlowTests({
			cwd: CWD,
			sessionStartedAt: SESSION_START,
			readEvents: () => events,
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.reason).toBe("absolute");
	});
});

// ─── detector: negative (must NOT fire) ────────────────────────────────────

describe("detectSlowTests — negative (must not fire)", () => {
	it("stays silent when there is no duration data at all (empty feed)", () => {
		expect(
			detectSlowTests({ cwd: CWD, sessionStartedAt: SESSION_START, readEvents: () => [] }),
		).toEqual([]);
	});

	it("stays silent on a 3s integration test (exempt from the ~1s unit floor)", () => {
		const events: TestEvent[] = [
			testEvent({ file: "spawn-heavy.integration.test.ts", name: "real biome run", ms: 3_000, atMs: 1_000 }),
		];
		expect(
			detectSlowTests({ cwd: CWD, sessionStartedAt: SESSION_START, readEvents: () => events }),
		).toEqual([]);
	});

	it("stays silent when every test is fast and close to its file's median", () => {
		const events: TestEvent[] = [
			testEvent({ file: "d.test.ts", name: "one", ms: 12, atMs: 1_000 }),
			testEvent({ file: "d.test.ts", name: "two", ms: 15, atMs: 2_000 }),
			testEvent({ file: "d.test.ts", name: "three", ms: 9, atMs: 3_000 }),
		];
		expect(
			detectSlowTests({ cwd: CWD, sessionStartedAt: SESSION_START, readEvents: () => events }),
		).toEqual([]);
	});

	it("ignores a slow test whose timestamp predates this session (another session's run)", () => {
		const events: TestEvent[] = [
			testEvent({ file: "e.test.ts", name: "old slow one", ms: 5_000, atMs: -60_000 }),
		];
		expect(
			detectSlowTests({ cwd: CWD, sessionStartedAt: SESSION_START, readEvents: () => events }),
		).toEqual([]);
	});

	it("ignores non-test event kinds even when they carry a ms field (run_end totals)", () => {
		const events: TestEvent[] = [
			{
				ts: SESSION_START,
				kind: "run_end",
				run_id: "run-1",
				ms: 999_999,
				passed: 1,
				failed: 0,
				skipped: 0,
			},
		];
		expect(
			detectSlowTests({ cwd: CWD, sessionStartedAt: SESSION_START, readEvents: () => events }),
		).toEqual([]);
	});

	it("stays silent when the session start timestamp can't be parsed", () => {
		const events: TestEvent[] = [
			testEvent({ file: "f.test.ts", name: "x", ms: 5_000, atMs: 1_000 }),
		];
		expect(
			detectSlowTests({ cwd: CWD, sessionStartedAt: "not-a-date", readEvents: () => events }),
		).toEqual([]);
	});

	it("stays silent when the real feed exists but cannot be read", () => {
		const dir = mkdtempSync(join(tmpdir(), "interlinked-slow-test-unreadable-"));
		try {
			// A directory where the feed file belongs: existsSync passes, so the
			// detector reaches the tail read, which then fails.
			mkdirSync(testEventsPath(dir), { recursive: true });
			expect(() => seedRecentTestEvents(testEventsPath(dir), 10)).toThrow(/EISDIR/);
			expect(
				detectSlowTests({ cwd: dir, sessionStartedAt: SESSION_START }),
			).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not read the real feed by default when the cwd has no test-events.jsonl", () => {
		// No readEvents override — exercises the production default
		// (readRealTestEvents), which existsSync-gates against a real,
		// guaranteed-absent path.
		const hits = detectSlowTests({
			cwd: "/nonexistent-interlinked-fixture-root",
			sessionStartedAt: SESSION_START,
		});
		expect(hits).toEqual([]);
	});
});

// ─── formatter ──────────────────────────────────────────────────────────────

describe("formatSlowTestsWarning", () => {
	it("returns null on no hits", () => {
		expect(formatSlowTestsWarning({ hits: [] })).toBeNull();
	});

	it("names the slowest test and its duration", () => {
		const hits: SlowTestHit[] = [
			{ file: "a.test.ts", name: "slow one", ms: 4_200, fileMedianMs: 40, reason: "absolute" },
		];
		const msg = formatSlowTestsWarning({ hits });
		expect(msg).toContain("[interlinked:slow-test]");
		expect(msg).toContain("a.test.ts");
		expect(msg).toContain("slow one");
		expect(msg).toContain("4200ms");
	});

	it("names the fix and the data source, and states it never blocks", () => {
		const hits: SlowTestHit[] = [
			{ file: "a.test.ts", name: "slow one", ms: 4_200, fileMedianMs: 40, reason: "absolute" },
		];
		const msg = formatSlowTestsWarning({ hits });
		expect(msg).toContain("Stryker");
		expect(msg).toContain("vi.useFakeTimers");
		expect(msg).toContain("test-events.jsonl");
		expect(msg).toContain("never blocks");
	});

	it("annotates the relative tier with its multiple of the file median", () => {
		const hits: SlowTestHit[] = [
			{ file: "b.test.ts", name: "outlier", ms: 400, fileMedianMs: 10, reason: "relative" },
		];
		const msg = formatSlowTestsWarning({ hits });
		expect(msg).toContain("40x");
	});

	it("caps the listed tests and appends an '...and N more' suffix", () => {
		const hits: SlowTestHit[] = Array.from({ length: 7 }, (_, i) => ({
			file: "g.test.ts",
			name: `case ${i}`,
			ms: 2_000 - i,
			fileMedianMs: 5,
			reason: "absolute" as const,
		}));
		const msg = formatSlowTestsWarning({ hits });
		expect(msg).toContain("...and 2 more");
	});
});

// ─── wiring ─────────────────────────────────────────────────────────────────

function makeCtx(): ServerRuntime & { logged: string[] } {
	const logged: string[] = [];
	return {
		...makeServerRuntime({ cwd: CWD, log: (msg) => { logged.push(msg); } }),
		logged,
	};
}

function makeEvent(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "Stop",
		session_id: "s1",
		agent_source: "claude",
		timestamp: SESSION_START,
		cwd: CWD,
		...over,
	};
}

function makeSession(startedAt: string): SessionTrajectory {
	return ({ ...completeSessionFixture(), ...{ started_at: startedAt } });
}

describe("checkSlowTests", () => {
	it("returns null and logs nothing when no slow test is detected (no data)", () => {
		const ctx = makeCtx();
		const result = checkSlowTests(ctx, makeEvent(), makeSession(SESSION_START));
		expect(result).toBeNull();
		expect(ctx.logged).toEqual([]);
	});

	it("fires end-to-end against a real .interlinked/test-events.jsonl feed file", () => {
		const dir = mkdtempSync(join(tmpdir(), "interlinked-slow-test-"));
		try {
			mkdirSync(join(dir, ".interlinked"), { recursive: true });
			const line = JSON.stringify({
				ts: new Date(Date.parse(SESSION_START) + 1_000).toISOString(),
				kind: "test",
				run_id: "run-1",
				file: "real.test.ts",
				name: "the slow one",
				status: "pass",
				ms: 3_000,
			});
			writeFileSync(join(dir, ".interlinked", "test-events.jsonl"), `${line}\n`);

			const ctx = makeCtx();
			const result = checkSlowTests(
				ctx,
				makeEvent({ cwd: dir }),
				makeSession(SESSION_START),
			);
			expect(result).toContain("real.test.ts");
			expect(result).toContain("the slow one");
			expect(ctx.logged.some((l) => l.includes("slow-tests (1)"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
