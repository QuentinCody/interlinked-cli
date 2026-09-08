import { nonNull } from "../non-null.js";
import { describe, expect, it } from "vitest";
import { InterlinkedVizReporter } from "./reporter-vitest.js";
import type { TestEvent } from "./test-events.js";

/** Build a reporter whose events land in an array instead of on disk, plus the raw
 * (path, ev) call args so tests can check own-property presence, not just JSON output. */
function harness(feedPath = "/proj/.interlinked/test-events.jsonl", root = "/proj") {
	const events: TestEvent[] = [];
	const calls: Array<[string, TestEvent]> = [];
	let clock = 1_000;
	const reporter = new InterlinkedVizReporter({
		root,
		feedPath,
		write: (path, ev) => {
			calls.push([path, ev]);
			events.push(ev);
			return true;
		},
		now: () => new Date(clock),
	});
	return { events, calls, reporter, tick: (ms: number) => (clock += ms) };
}

describe("mutation-kill w61: reporter-vitest.ts", () => {
	// mutant 0a4281a481266d35: opts.feedPath ?? default -> opts.feedPath && default
	it("uses the explicitly provided feedPath verbatim (not the default) when writing", () => {
		const { calls, reporter } = harness("/custom/feed.jsonl", "/proj");
		reporter.onTestRunStart();
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0]?.[0]).toBe("/custom/feed.jsonl");
	});

	// mutant c257da9e7f7f2ef8: tally field initializer { passed:0, failed:0, skipped:0 } -> {}
	it("starts the tally at zero counts so a single pass yields passed:1 exactly (not NaN)", () => {
		const { events, reporter } = harness();
		// Deliberately do NOT call onTestRunStart — that resets tally via a
		// different object literal; this isolates the class-field initializer.
		reporter.onTestCaseResult({ result: () => ({ state: "passed" }) });
		reporter.onTestRunEnd();
		const runEnd = events.find((e) => e.kind === "run_end");
		expect(runEnd?.passed).toBe(1);
		expect(runEnd?.failed).toBe(0);
		expect(runEnd?.skipped).toBe(0);
	});

	// mutant c38ebdebaf8a6ef8: "vitest" -> ""
	it("labels the run_start event 'vitest'", () => {
		const { events, reporter } = harness();
		reporter.onTestRunStart();
		const start = events.find((e) => e.kind === "run_start");
		expect(start?.label).toBe("vitest");
	});

	// mutant b0f44ee700be29b0: testCase?.result?.() -> testCase?.result()
	it("does not throw when a test case has no result() accessor", () => {
		const { reporter } = harness();
		expect(() => reporter.onTestCaseResult({ name: "no-result" })).not.toThrow();
	});

	// mutant e79bd2ede786a388: `if (name) ev.name = name` condition -> true
	it("omits the name key entirely when no name is available", () => {
		const { calls, reporter } = harness();
		reporter.onTestCaseResult({ result: () => ({ state: "passed" }) });
		const testCall = calls.find(([, ev]) => ev.kind === "test");
		expect(testCall).toBeDefined();
		expect(Object.hasOwn(nonNull(testCall)[1], "name")).toBe(false);
	});

	// mutant 571b23d74d6eeabe: `if (file) ev.file = file` condition -> true
	it("omits the file key entirely when no module id is available", () => {
		const { calls, reporter } = harness();
		reporter.onTestCaseResult({ result: () => ({ state: "passed" }) });
		const testCall = calls.find(([, ev]) => ev.kind === "test");
		expect(testCall).toBeDefined();
		expect(Object.hasOwn(nonNull(testCall)[1], "file")).toBe(false);
	});

	// mutant 8b38d7e5240958ef: testCase?.module?.moduleId -> testCase?.module.moduleId
	it("does not throw resolving file when module is absent but result is present", () => {
		const { reporter } = harness();
		expect(() =>
			reporter.onTestCaseResult({ result: () => ({ state: "passed" }) /* no module */ }),
		).not.toThrow();
	});

	// mutant 2974100487cfcc9a: testCase?.diagnostic?.() -> testCase?.diagnostic()
	it("does not throw when a test case has no diagnostic() accessor", () => {
		const { reporter } = harness();
		expect(() =>
			reporter.onTestCaseResult({
				result: () => ({ state: "passed" }),
				// no diagnostic field at all
			}),
		).not.toThrow();
	});

	// mutant b56afb778b61deb7: diagnostic?.()?.duration -> diagnostic?.().duration
	it("does not throw when diagnostic() itself returns undefined", () => {
		const { reporter } = harness();
		expect(() =>
			reporter.onTestCaseResult({
				result: () => ({ state: "passed" }),
				diagnostic: () => undefined,
			}),
		).not.toThrow();
	});

	// mutant 11d9ce3c79a67334: `typeof ms === "number" && Number.isFinite(ms)` -> true
	it("omits ms when the duration is NaN", () => {
		const { calls, reporter } = harness();
		reporter.onTestCaseResult({
			result: () => ({ state: "passed" }),
			diagnostic: () => ({ duration: Number.NaN }),
		});
		const testCall = calls.find(([, ev]) => ev.kind === "test");
		expect(testCall?.[1]?.ms).toBeUndefined();
	});

	// mutant dffc6af59643f546: `&&` -> `||` in the same finite-duration guard
	it("omits ms when the duration is Infinity (a number, but not finite)", () => {
		const { calls, reporter } = harness();
		reporter.onTestCaseResult({
			result: () => ({ state: "passed" }),
			diagnostic: () => ({ duration: Number.POSITIVE_INFINITY }),
		});
		const testCall = calls.find(([, ev]) => ev.kind === "test");
		expect(testCall?.[1]?.ms).toBeUndefined();
	});

	// mutant e6383c9216015641: `if (error) ev.error = error` condition -> true
	it("omits the error key entirely when the test case has no errors", () => {
		const { calls, reporter } = harness();
		reporter.onTestCaseResult({ result: () => ({ state: "failed" }) });
		const testCall = calls.find(([, ev]) => ev.kind === "test");
		expect(testCall).toBeDefined();
		expect(Object.hasOwn(nonNull(testCall)[1], "error")).toBe(false);
	});

	// mutant c8456a95dc5bfcc5: `status === "fail"` -> `status !== "fail"` inside count()
	it("tallies a failing test case as failed, not skipped", () => {
		const { events, reporter } = harness();
		reporter.onTestCaseResult({ result: () => ({ state: "failed" }) });
		reporter.onTestRunEnd();
		const runEnd = events.find((e) => e.kind === "run_end");
		expect(runEnd?.failed).toBe(1);
		expect(runEnd?.skipped).toBe(0);
	});

	// mutant 2be1ec0eed1a0440: "skip" -> "" in STATE_TO_STATUS (skipped or pending entry)
	it("maps both 'skipped' and 'pending' raw states onto status 'skip' and tallies them", () => {
		const { events, reporter } = harness();
		reporter.onTestCaseResult({ result: () => ({ state: "skipped" }) });
		reporter.onTestCaseResult({ result: () => ({ state: "pending" }) });
		reporter.onTestRunEnd();
		const testEvents = events.filter((e) => e.kind === "test");
		expect(testEvents).toHaveLength(2);
		expect(testEvents[0]?.status).toBe("skip");
		expect(testEvents[1]?.status).toBe("skip");
		const runEnd = events.find((e) => e.kind === "run_end");
		expect(runEnd?.skipped).toBe(2);
	});

	// mutant 0d0eca96ca56e28f: errors?.[0]?.message -> errors?.[0].message
	it("does not throw and reports no error when the errors array is empty", () => {
		const { calls, reporter } = harness();
		expect(() =>
			reporter.onTestCaseResult({ result: () => ({ state: "failed", errors: [] }) }),
		).not.toThrow();
		const testCall = calls.find(([, ev]) => ev.kind === "test");
		expect(testCall?.[1]?.error).toBeUndefined();
	});
});
