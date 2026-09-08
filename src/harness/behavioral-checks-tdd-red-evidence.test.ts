import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
// Tests for how a red TDD cycle is judged and described.
//
// The behaviours pinned here both come from a real wedge (2026-07-26): a
// whole-suite failure fanned out across unrelated files, and a red from
// hundreds of steps earlier kept blocking commits against a green suite.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	isSoftenedRed,
	isStaleRed,
	isSuiteSourcedRed,
	type RedCycleView,
	redCycleMessage,
	STALE_RED_AGE_STEPS,
} from "./behavioral-checks-tdd-red-evidence.js";
import { ALL_TESTS_SENTINEL } from "./server-tdd-cycle.js";
import type { SessionTrajectory } from "./types.js";

/** Minimal session carrying only the fields these functions read. */
function session(opts: {
	step: number;
	runs?: Array<[string, { status: "pass" | "fail"; at_step: number }]>;
}): SessionTrajectory {
	// SAFETY: the functions under test read only `tool_call_count` and
	// `test_runs`; building a full SessionTrajectory would add ~40 irrelevant
	// fields and obscure what each case actually varies.
	return ({ ...completeSessionFixture(), ...{
		tool_call_count: opts.step,
		test_runs: new Map(opts.runs ?? []),
	} });
}

const live: RedCycleView = {
	state: "red",
	red_at: 100,
	red_command: "npx vitest run src/a.test.ts",
	test_file: "/r/a.test.ts",
};

describe("isStaleRed", () => {
	it("is false for a red observed recently", () => {
		expect(isStaleRed(session({ step: 100 + STALE_RED_AGE_STEPS }), live)).toBe(false);
	});

	it("is true once the red is older than the window", () => {
		expect(isStaleRed(session({ step: 100 + STALE_RED_AGE_STEPS + 1 }), live)).toBe(true);
	});

	// Fail safe: an unknown age must keep blocking rather than silently soften.
	it("is false when the red has no recorded step", () => {
		expect(isStaleRed(session({ step: 9999 }), { ...live, red_at: undefined })).toBe(false);
	});
});

describe("isSuiteSourcedRed", () => {
	it("is true when the red's step matches a failing whole-suite run", () => {
		const s = session({ step: 120, runs: [[ALL_TESTS_SENTINEL, { status: "fail", at_step: 100 }]] });
		expect(isSuiteSourcedRed(s, { ...live, test_file: null })).toBe(true);
	});

	it("is false when a targeted failure for this file occurred in the same run", () => {
		const s = session({
			step: 120,
			runs: [
				[ALL_TESTS_SENTINEL, { status: "fail", at_step: 100 }],
				["/r/a.test.ts", { status: "fail", at_step: 100 }],
			],
		});
		expect(isSuiteSourcedRed(s, live)).toBe(false);
	});

	it("ignores a historical targeted pass when a newer suite run set the red", () => {
		const s = session({
			step: 980,
			runs: [
				[ALL_TESTS_SENTINEL, { status: "fail", at_step: 974 }],
				["/r/a.test.ts", { status: "pass", at_step: 736 }],
			],
		});
		expect(isSuiteSourcedRed(s, { ...live, red_at: 974 })).toBe(true);
	});

	it("matches a same-step targeted failure across relative and absolute paths", () => {
		const relativeTest = "src/a.test.ts";
		const s = session({
			step: 980,
			runs: [
				[ALL_TESTS_SENTINEL, { status: "fail", at_step: 974 }],
				[resolve(relativeTest), { status: "fail", at_step: 974 }],
			],
		});
		expect(
			isSuiteSourcedRed(s, { ...live, red_at: 974, test_file: relativeTest }),
		).toBe(false);
	});

	it("is false when the suite passed", () => {
		const s = session({ step: 120, runs: [[ALL_TESTS_SENTINEL, { status: "pass", at_step: 100 }]] });
		expect(isSuiteSourcedRed(s, live)).toBe(false);
	});
});

describe("isSoftenedRed", () => {
	it("softens on either cause", () => {
		const stale = session({ step: 100 + STALE_RED_AGE_STEPS + 5 });
		expect(isSoftenedRed(stale, live)).toBe(true);
		const suite = session({ step: 101, runs: [[ALL_TESTS_SENTINEL, { status: "fail", at_step: 100 }]] });
		expect(isSoftenedRed(suite, { ...live, test_file: null })).toBe(true);
	});

	it("does not soften a fresh, file-attributed red", () => {
		expect(isSoftenedRed(session({ step: 101 }), live)).toBe(false);
	});
});

describe("redCycleMessage", () => {
	it("names the failing run and step on a live red", () => {
		const msg = redCycleMessage(session({ step: 101 }), "/r/a.ts", live);
		expect(msg).toContain("Tests are FAILING for a.ts");
		expect(msg).toContain("step 100");
		expect(msg).toContain("npx vitest run src/a.test.ts");
	});

	it("says REGRESSING for a regression", () => {
		const msg = redCycleMessage(session({ step: 101 }), "/r/a.ts", { ...live, state: "regression" });
		expect(msg).toContain("REGRESSING");
	});

	it("explains the age and asks for a re-run when stale", () => {
		const msg = redCycleMessage(session({ step: 200 }), "/r/a.ts", live);
		expect(msg).toContain("100 tool calls ago");
		expect(msg).toContain("no longer evidence about the current tree");
	});

	it("explains non-attribution when the red came from the suite", () => {
		const s = session({ step: 101, runs: [[ALL_TESTS_SENTINEL, { status: "fail", at_step: 100 }]] });
		const msg = redCycleMessage(s, "/r/a.ts", { ...live, test_file: null });
		expect(msg).toContain("not attributed to this file");
	});

	it("omits evidence rather than printing undefined when the step is unknown", () => {
		const msg = redCycleMessage(session({ step: 5 }), "/r/a.ts", {
			...live,
			red_at: undefined,
			red_command: undefined,
		});
		expect(msg).not.toContain("undefined");
		expect(msg).not.toContain("last failing run");
	});
});
