import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withCheckRoot } from "./check-root.js";
import { withForegroundCheckScan } from "./check-scan-policy.js";
import { getProjectCheckEvidence, withProjectCheckEvidence } from "./project-check-evidence.js";
import { checkFallbackOnlyAssertion } from "./test-discrimination-fallback.js";
import { findSiblingTestFiles, siblingNonDefaultTargets } from "./test-discrimination-fallback-siblings.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(process.cwd(), "scratch", "fallback-foreground-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function put(path: string, content: string): string {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
	return file;
}
function foreground<T>(run: () => T) {
	return withForegroundCheckScan(() => withCheckRoot(root, run));
}
const fallback = 'it("records a result", () => { expect(parseValue()).toEqual([]); });';
const positive = 'it("records a result", () => { expect(parseValue()).toEqual([1]); });';

describe("foreground fallback sibling evidence", () => {
	it("N1 sees a positive sibling after the runtime file budget without changing runtime limits", () => {
		const main = put("foo.test.ts", fallback);
		for (let index = 0; index < 20; index++) put(`foo.mutation-kill-w${index}.test.ts`, "");
		put("__tests__/foo.integration.test.ts", positive);
		expect(findSiblingTestFiles(main)).toHaveLength(12);
		expect(checkFallbackOnlyAssertion(fallback, main)).toHaveLength(1);
		const run = foreground(() => ({ files: findSiblingTestFiles(main), findings: checkFallbackOnlyAssertion(fallback, main) }));
		expect(run.result.files).toHaveLength(21);
		expect(run.result.findings).toEqual([]);
		expect(run.notMeasured).toEqual([]);
		expect(findSiblingTestFiles(main)).toHaveLength(12);
		expect(checkFallbackOnlyAssertion(fallback, main)).toHaveLength(1);
	});

	it("N2 finishes foreground suffix normalization beyond six rounds", () => {
		const main = put("foo.test.ts", fallback);
		const sibling = put(`foo${".integration".repeat(8)}.test.ts`, positive);
		expect(findSiblingTestFiles(main)).toEqual([]);
		expect(foreground(() => findSiblingTestFiles(main)).result).toEqual([sibling]);
		expect(foreground(() => checkFallbackOnlyAssertion(fallback, main)).result).toEqual([]);
		expect(findSiblingTestFiles(main)).toEqual([]);
	});

	it("P1 retains readable targets alongside an unreadable sibling gap", () => {
		const main = put("foo.test.ts", fallback);
		put("foo.integration.test.ts", "known target");
		mkdirSync(join(root, "foo.defaults.test.ts"));
		const run = foreground(() => siblingNonDefaultTargets(main, content => new Set([content])));
		expect(run.result).toEqual(new Set(["known target"]));
		expect(run.notMeasured.some(reason => reason.includes("foo.defaults.test.ts"))).toBe(true);
	});

	it("P2 discloses an unlistable candidate directory while retaining known siblings", () => {
		const main = put("foo.test.ts", fallback);
		put("foo.integration.test.ts", "known target");
		put("__tests__", "not a directory");
		const run = foreground(() => siblingNonDefaultTargets(main, content => new Set([content])));
		expect(run.result).toEqual(new Set(["known target"]));
		expect(run.notMeasured.some(reason => reason.includes("__tests__"))).toBe(true);
	});

	it("P3 keeps per-sibling classification failures separate from other known targets", () => {
		const main = put("foo.test.ts", fallback);
		put("foo.integration.test.ts", "known");
		put("foo.defaults.test.ts", "invalid");
		const run = foreground(() => siblingNonDefaultTargets(main, content => {
			if (content === "invalid") throw new Error("classification unavailable control");
			return new Set([content]);
		}));
		expect(run.result).toEqual(new Set(["known"]));
		expect(run.notMeasured.some(reason => reason.includes("classification unavailable control"))).toBe(true);
	});

	it("N3 reads captured project evidence instead of a changed disk sibling", () => {
		const main = put("foo.test.ts", fallback);
		const sibling = put("foo.integration.test.ts", positive);
		const run = withProjectCheckEvidence(root, [main, sibling], () => {
			getProjectCheckEvidence()?.readFile(sibling);
			writeFileSync(sibling, fallback);
			return withCheckRoot(root, () => checkFallbackOnlyAssertion(fallback, main));
		});
		expect(run).toEqual({ result: [], notMeasured: [] });
	});

	it("P4 retains a known unselected dependency as unavailable project evidence", () => {
		const main = put("foo.test.ts", fallback);
		put("foo.integration.test.ts", positive);
		const run = withProjectCheckEvidence(root, [main], () => withCheckRoot(root, () => checkFallbackOnlyAssertion(fallback, main)));
		expect(run.notMeasured.some(reason => reason.includes("outside selected project evidence"))).toBe(true);
	});

	it("N5 retains a captured positive sibling even after its live directory entry disappears", () => {
		const main = put("foo.test.ts", fallback);
		const sibling = put("foo.integration.test.ts", positive);
		const run = withProjectCheckEvidence(root, [main, sibling], () => {
			getProjectCheckEvidence()?.readFile(sibling);
			unlinkSync(sibling);
			return withCheckRoot(root, () => ({ files: findSiblingTestFiles(main), findings: checkFallbackOnlyAssertion(fallback, main) }));
		});
		expect(run).toEqual({ result: { files: [sibling], findings: [] }, notMeasured: [] });
	});

	it("P5 reports a selected sibling deleted before its bytes were captured", () => {
		const main = put("foo.test.ts", fallback);
		const sibling = put("foo.integration.test.ts", positive);
		const run = withProjectCheckEvidence(root, [main, sibling], () => {
			unlinkSync(sibling);
			return withCheckRoot(root, () => checkFallbackOnlyAssertion(fallback, main));
		});
		expect(run.notMeasured.some(reason => reason.includes(sibling))).toBe(true);
	});

	it("N4 resolves relative inputs at the selected root and treats an absent optional directory as known absence", () => {
		put("foo.test.ts", fallback);
		const sibling = put("foo.integration.test.ts", positive);
		const run = foreground(() => findSiblingTestFiles("foo.test.ts"));
		expect(run).toEqual({ result: [sibling], notMeasured: [] });
	});
});
