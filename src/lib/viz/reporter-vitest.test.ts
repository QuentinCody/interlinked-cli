import { describe, expect, it } from "vitest";
import { InterlinkedVizReporter, relativeToRoot, statusForState } from "./reporter-vitest.js";
import type { TestEvent } from "./test-events.js";

describe("statusForState", () => {
	it("maps every vitest state onto the feed domain", () => {
		expect(statusForState("passed")).toBe("pass");
		expect(statusForState("failed")).toBe("fail");
		expect(statusForState("skipped")).toBe("skip");
		expect(statusForState("todo")).toBe("todo");
	});

	it("returns null for unknown or absent states", () => {
		expect(statusForState("queued")).toBeNull();
		expect(statusForState(undefined)).toBeNull();
	});
});

describe("relativeToRoot", () => {
	it("relativizes a path inside the root", () => {
		expect(relativeToRoot("/proj", "/proj/src/a.test.ts")).toBe("src/a.test.ts");
	});

	it("passes an outside path through unchanged", () => {
		expect(relativeToRoot("/proj", "/other/a.test.ts")).toBe("/other/a.test.ts");
	});

	it("returns undefined with no module id", () => {
		expect(relativeToRoot("/proj", undefined)).toBeUndefined();
	});
});

/** Build a reporter whose events land in an array instead of on disk. */
function harness() {
	const events: TestEvent[] = [];
	let clock = 1_000;
	const reporter = new InterlinkedVizReporter({
		root: "/proj",
		feedPath: "/proj/.interlinked/test-events.jsonl",
		write: (_path, ev) => {
			events.push(ev);
			return true;
		},
		now: () => new Date(clock),
	});
	return { events, reporter, tick: (ms: number) => (clock += ms) };
}

const caseOf = (name: string, state: string, over: Record<string, unknown> = {}) => ({
	fullName: name,
	module: { moduleId: "/proj/src/a.test.ts" },
	result: () => ({ state, ...over }),
	diagnostic: () => ({ duration: 12.6 }),
});

describe("InterlinkedVizReporter", () => {
    it.each([{}, { vite: {} }, { vite: { config: {} } }, { vite: { config: { configFile: false as const } } }])("keeps the lane unknown when no config was observed", (context) => {
        const { reporter, events } = harness();
        reporter.onInit(context);
        reporter.onTestRunStart();
        expect(events[0]).toMatchObject({ kind: "run_start", lane: "unknown" });
    });
    it.each(["unit", "integration", "e2e", "base"])("labels the %s lane from Vitest's resolved Vite config", (lane) => {
        const { reporter, events } = harness();
        const configFile = lane === "base" ? "/proj/vitest.config.ts" : `/proj/vitest.${lane}.config.ts`;
        reporter.onInit({ vite: { config: { configFile } } });
        reporter.onTestRunStart();
        reporter.onTestRunEnd();
        expect(events.map((event) => event.lane)).toEqual([lane, lane]);
    });
	it("emits run_start, per-case events, and a run_end tally in order", () => {
		const { events, reporter, tick } = harness();
		reporter.onTestRunStart();
		reporter.onTestModuleStart({ moduleId: "/proj/src/a.test.ts" });
		reporter.onTestCaseResult(caseOf("a > works", "passed"));
		reporter.onTestCaseResult(caseOf("a > broken", "failed", { errors: [{ message: "boom\nat x" }] }));
		reporter.onTestCaseResult(caseOf("a > later", "skipped"));
		tick(500);
		reporter.onTestRunEnd();

		expect(events.map((e) => e.kind)).toEqual([
			"run_start",
			"file_start",
			"test",
			"test",
			"test",
			"run_end",
		]);
		expect(events[2]).toMatchObject({ name: "a > works", status: "pass", file: "src/a.test.ts", ms: 13 });
		expect(events[3]).toMatchObject({ status: "fail", error: "boom" });
		expect(events[5]).toMatchObject({ passed: 1, failed: 1, skipped: 1, ms: 500 });
	});

	it("shares one run_id across a run and issues a fresh one on the next", () => {
		const { events, reporter } = harness();
		reporter.onTestRunStart();
		reporter.onTestCaseResult(caseOf("a", "passed"));
		const first = events[0]?.run_id;
		expect(events.every((e) => e.run_id === first)).toBe(true);
		expect(first).toBeTruthy();
	});

	it("resets the tally between runs", () => {
		const { events, reporter } = harness();
		reporter.onTestRunStart();
		reporter.onTestCaseResult(caseOf("a", "failed"));
		reporter.onTestRunEnd();
		reporter.onTestRunStart();
		reporter.onTestCaseResult(caseOf("b", "passed"));
		reporter.onTestRunEnd();
		expect(events.at(-1)).toMatchObject({ passed: 1, failed: 0 });
	});

	it("ignores a case with no resolvable result state", () => {
		const { events, reporter } = harness();
		reporter.onTestRunStart();
		reporter.onTestCaseResult({ fullName: "pending", result: () => undefined });
		reporter.onTestCaseResult(undefined);
		expect(events.filter((e) => e.kind === "test")).toEqual([]);
	});

	it("emits file_start without a file when the module id is missing", () => {
		const { events, reporter } = harness();
		reporter.onTestModuleStart(undefined);
		expect(events[0]).toEqual({ ts: expect.any(String), run_id: expect.any(String), lane: "unknown", kind: "file_start" });
	});

	it("survives a throwing sink rather than failing the host suite", () => {
		const reporter = new InterlinkedVizReporter({
			write: () => {
				throw new Error("disk full");
			},
		});
		expect(() => reporter.onTestRunStart()).not.toThrow();
	});
});
