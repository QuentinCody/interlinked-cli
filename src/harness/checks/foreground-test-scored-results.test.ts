import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAssertionFreeTest, checkTautologicalAssertion } from "../taste-checks-test-assertions.js";
import { withForegroundCheckScan } from "./check-scan-policy.js";
import { checkVacuousLoopAssertion } from "./test-vacuous-loop.js";
import { checkCommentedOutAssertion } from "./test-commented-assertion.js";
import { checkFallbackOnlyAssertion } from "./test-discrimination-fallback.js";
import { checkIntrovertedTest } from "./introverted-test.js";
import { withCheckRoot } from "./check-root.js";
import { withProjectCheckEvidence } from "./project-check-evidence.js";
import * as fallbackSiblings from "./test-discrimination-fallback-siblings.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(process.cwd(), "scratch", "test-scored-results-")); });
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});
const repeat = (source: (index: number) => string) => Array.from({ length: 20 }, (_, index) => source(index)).join("\n");
const cases = [
	{ id: "assertion_free_test", detector: checkAssertionFreeTest,
		source: repeat(index => `it("case ${index}", () => { work(); });`),
		benign: 'it("contract", () => { expect(work()).toBe(3); });' },
	{ id: "tautological_assertion", detector: checkTautologicalAssertion,
		source: repeat(index => `it("case ${index}", () => { expect(result${index}).toBe(result${index}); });`),
		benign: 'it("contract", () => { expect(actual).toBe(expected); });' },
	{ id: "vacuous_loop_assertion", detector: checkVacuousLoopAssertion,
		source: repeat(index => `it("case ${index}", () => { for (const row of getRows()) { expect(row.ok).toBe(true); } });`),
		benign: 'it("contract", () => { const rows = getRows(); expect(rows).toHaveLength(1); for (const row of rows) { expect(row.ok).toBe(true); } });' },
	{ id: "commented_out_assertion", detector: checkCommentedOutAssertion,
		source: repeat(index => `it("case ${index}", () => {\n // expect(result).toBe(${index});\n});`),
		benign: 'it("contract", () => { const example = "// expect(x).toBe(1)"; expect(result).toBe(3); });' },
	{ id: "fallback_only_assertion", detector: checkFallbackOnlyAssertion,
		source: repeat(index => `it("case ${index}", () => { expect(getItems()).toEqual([]); });`),
		benign: 'it("contract", () => { expect(getItems()).toEqual(["item"]); });' },
	{ id: "introverted_test", detector: checkIntrovertedTest,
		source: 'import { evaluate } from "./widget";\n' + repeat(index => `it("case ${index}", () => { expect(3).toBe(3); });`),
		benign: 'import { evaluate } from "./widget";\nit("contract", () => { expect(evaluate()).toBe(3); });' },
] as const;

describe.each(cases)("$id foreground result population", entry => {
	it("P1 retains all twenty recognized locations and its tail while restoring the runtime prefix", () => {
		const file = join(root, "widget.test.ts");
		const runtime = entry.detector(entry.source, file);
		expect(runtime).toHaveLength(10);
		const foreground = withForegroundCheckScan(() => entry.detector(entry.source, file));
		expect(foreground).toHaveLength(20);
		expect(foreground.slice(0, 10)).toEqual(runtime);
		expect(new Set(foreground.map(match => match.line)).size).toBe(20);
		expect(foreground.at(-1)?.line).toBeGreaterThan(runtime.at(-1)?.line ?? 0);
		expect(entry.detector(entry.source, file)).toEqual(runtime);
	});

	it("N1 preserves a legitimate exception in both execution contexts", () => {
		const file = join(root, "widget.test.ts");
		expect(entry.detector(entry.benign, file)).toEqual([]);
		expect(withForegroundCheckScan(() => entry.detector(entry.benign, file))).toEqual([]);
	});

	it("N2 preserves the test-file eligibility boundary", () => {
		const file = join(root, "widget.ts");
		expect(entry.detector(entry.source, file)).toEqual([]);
		expect(withForegroundCheckScan(() => entry.detector(entry.source, file))).toEqual([]);
	});
});

it("N3 restores every runtime result guard after a foreground callback throws", () => {
	expect(() => withForegroundCheckScan(() => { throw new Error("foreground scope control"); })).toThrow("foreground scope control");
	for (const entry of cases) expect(entry.detector(entry.source, join(root, "widget.test.ts"))).toHaveLength(10);
});

it("N4 preserves actual non-default sibling discovery in both execution contexts", () => {
	writeFileSync(join(root, "widget.mutation-kill.test.ts"), 'it("nondefault", () => { expect(getItems()).toEqual(["item"]); });');
	const entry = cases.find(item => item.id === "fallback_only_assertion")!;
	const file = join(root, "widget.test.ts");
	expect(entry.detector(entry.source, file)).toEqual([]);
	expect(withForegroundCheckScan(() => entry.detector(entry.source, file))).toEqual([]);
});

it("P2 retains an unexpected sibling lookup failure as structured unavailable evidence", () => {
	const file = join(root, "widget.test.ts");
	const source = 'it("contract", () => { expect(getItems()).toEqual([]); });';
	writeFileSync(file, source);
	vi.spyOn(fallbackSiblings, "siblingNonDefaultTargets").mockImplementation(() => { throw new Error("controlled sibling lookup failure"); });
	const gaps: { check: string; file: string; reason: string }[] = [];
	const run = withProjectCheckEvidence(root, [file], () => withForegroundCheckScan(() => withCheckRoot(root,
		() => checkFallbackOnlyAssertion(source, file))), gap => gaps.push(gap));
	expect(run.result).toHaveLength(1);
	expect(run.notMeasured.join("\n")).toContain("controlled sibling lookup failure");
	expect(gaps).toContainEqual({ check: "fallback_only_assertion", file,
		reason: expect.stringContaining("controlled sibling lookup failure") });
});
