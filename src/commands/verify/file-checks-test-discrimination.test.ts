// ===========================================
// file-checks test-discrimination batch unit tests
// ===========================================
// Direct tests for the batch runner that fans the nine coverage-campaign
// test-quality detectors into `CodeQualityResults`. Each bucket is exercised
// with one fixture the detector must flag, and every bucket must stay empty
// for a non-test file.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { FileCheckContext } from "./file-checks-shared.js";
import { runTestDiscriminationChecks } from "./file-checks-test-discrimination.js";
import { emptyResults } from "./tool-results-types.js";

const TEST_DISCRIMINATION_KEYS = [
	"duplicateThrowMessageAssertion",
	"fallbackOnlyAssertion",
	"spyCallUnpinnedArgs",
	"wildcardInObservable",
	"fixedPortInTest",
	"inTreeTempFixture",
	"catchWithoutAssertionGuard",
	"duplicateExpectedLiteralPosNeg",
	"vacuousLoopAssertion",
	"mockReturnEcho",
	"duplicateTestBody",
	"spyWithoutRestore",
	"exportExistenceSmokeTest",
	"commentedOutAssertion",
] as const;

function ctx(content: string, file = "/tmp/sample.test.ts"): FileCheckContext {
	return { file, content, relPath: "sample.test.ts", cwd: "/tmp", r: emptyResults(), piiOpts: {} };
}

describe("runTestDiscriminationChecks — positive (must fire)", () => {
	it("routes the new detectors and gives import smoke tests one owner", () => {
		const c = ctx('import { api } from "./api.js";\nit("export", () => { expect(typeof api).toBe("function"); });\nit("spy", () => { vi.spyOn(console, "log");\n// expect(result).toBe(3);\n});');
		runTestDiscriminationChecks(c);
		expect(c.r.exportExistenceSmokeTest.map((issue) => [issue.check, issue.line])).toEqual([["export_existence_smoke_test", 2]]);
		expect(c.r.spyWithoutRestore.map((issue) => [issue.check, issue.line])).toEqual([["spy_without_restore", 3]]);
		expect(c.r.commentedOutAssertion.map((issue) => [issue.check, issue.line])).toEqual([["commented_out_assertion", 4]]);
		expect(c.r.wildcardInObservable).toEqual([]);
	});
	it("P1: routes a fixed-port bind into fixedPortInTest with the check id", () => {
		const c = ctx('import { createServer } from "node:http";\nit("binds", () => { createServer().listen(8787, "127.0.0.1"); });\n');
		runTestDiscriminationChecks(c);
		expect(c.r.fixedPortInTest.length).toBeGreaterThan(0);
		expect(nonNull(c.r.fixedPortInTest[0]).check).toBe("fixed_port_in_test");
	});

	it("P2: routes an in-tree mkdtemp into inTreeTempFixture with the check id", () => {
		const c = ctx('import { mkdtempSync } from "node:fs";\nconst dir = mkdtempSync(resolve(CLI_ROOT, "_x_fixtures-"));\nit("a", () => { expect(dir).toBe(dir); });\n');
		runTestDiscriminationChecks(c);
		expect(c.r.inTreeTempFixture.length).toBeGreaterThan(0);
		expect(nonNull(c.r.inTreeTempFixture[0]).check).toBe("in_tree_temp_fixture");
	});

	it("P3: routes a spy-only block into spyCallUnpinnedArgs with the check id", () => {
		const c = ctx('import { run } from "./run";\nit("calls", () => { const spy = vi.fn(); run(spy); expect(spy).toHaveBeenCalled(); });\n');
		runTestDiscriminationChecks(c);
		expect(c.r.spyCallUnpinnedArgs.length).toBeGreaterThan(0);
		expect(nonNull(c.r.spyCallUnpinnedArgs[0]).check).toBe("spy_call_unpinned_args");
	});
});

describe("runTestDiscriminationChecks — negative (must not fire)", () => {
	it("N1: leaves every bucket empty for a non-test file", () => {
		const c = ctx('it("x", () => { expect(a).toBeNull(); });\n', "/tmp/sample.ts");
		runTestDiscriminationChecks(c);
		for (const key of TEST_DISCRIMINATION_KEYS) {
			expect(c.r[key], key).toEqual([]);
		}
	});

	it("N2: leaves every bucket empty for a test with a pinned literal and no isolation smell", () => {
		const c = ctx('import { add } from "./add";\nit("adds", () => { expect(add(1, 2)).toBe(3); });\n');
		runTestDiscriminationChecks(c);
		for (const key of TEST_DISCRIMINATION_KEYS) {
			expect(c.r[key], key).toEqual([]);
		}
	});
});
