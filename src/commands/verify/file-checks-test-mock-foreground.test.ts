import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InlineMatch } from "../../harness/check-registry/types.js";
import * as sutSelf from "../../harness/checks/test-hygiene-quality-sut.js";
import * as mockOnly from "../../harness/checks/test-hygiene-quality-mock-only.js";
import * as catchGuard from "../../harness/checks/test-discrimination-catch.js";
import * as mockEcho from "../../harness/checks/test-mock-return-echo.js";
import * as mockingSut from "../../harness/taste-checks-test-assertions.js";
import * as privateMember from "../../harness/taste-checks-private-member.js";
import { getEffectiveSkipChecks } from "./advisory-skips.js";
import { withVerifyTimings } from "./check-timing.js";
import { runEndpointAndLazinessChecks } from "./file-checks-endpoint-laziness.js";
import { runReactAndTasteChecks } from "./file-checks-react-test.js";
import { runTestDiscriminationChecks } from "./file-checks-test-discrimination.js";
import { outputJson } from "./output-json.js";
import { runCodeQualityChecks } from "./tool-results.js";
import { emptyResults } from "./tool-results-types.js";

const cases = [
	{ check: "mocking_the_sut_self", bucket: "mockingTheSutSelf", runner: runEndpointAndLazinessChecks,
		mock: (matches: InlineMatch[]) => vi.spyOn(sutSelf, "checkMockingTheSutSelf").mockReturnValue(matches),
		source: () => 'vi.mock("./foo.js");' },
	{ check: "mock_only_test", bucket: "mockOnlyTest", runner: runEndpointAndLazinessChecks,
		mock: (matches: InlineMatch[]) => vi.spyOn(mockOnly, "checkMockOnlyTest").mockReturnValue(matches),
		source: (index: number) => `it("case ${index}", () => { expect(log).toHaveBeenCalled(); });` },
	{ check: "catch_without_assertion_guard", bucket: "catchWithoutAssertionGuard", runner: runTestDiscriminationChecks,
		mock: (matches: InlineMatch[]) => vi.spyOn(catchGuard, "checkCatchWithoutAssertionGuard").mockReturnValue(matches),
		source: (index: number) => `it("case ${index}", () => { try { sut(); } catch (err) { expect(err.message).toBe("bad"); } });` },
	{ check: "mock_return_echo", bucket: "mockReturnEcho", runner: runTestDiscriminationChecks,
		mock: (matches: InlineMatch[]) => vi.spyOn(mockEcho, "checkMockReturnEcho").mockReturnValue(matches),
		source: (index: number) => `it("case ${index}", () => { dep.mockReturnValue("echo-${index}"); const result = sut(dep); expect(result).toBe("echo-${index}"); });` },
	{ check: "mocking_the_sut", bucket: "mockingTheSut", runner: runReactAndTasteChecks,
		mock: (matches: InlineMatch[]) => vi.spyOn(mockingSut, "checkMockingTheSUT").mockReturnValue(matches),
		source: () => 'vi.mock("./foo.js");' },
	{ check: "private_member_test_access", bucket: "privateMemberTestAccess", runner: runReactAndTasteChecks,
		mock: (matches: InlineMatch[]) => vi.spyOn(privateMember, "checkPrivateMemberTestAccess").mockReturnValue(matches),
		source: () => "(svc as any)._cache.clear();" },
] as const;

let root: string;
let originalExit: typeof process.exitCode;
beforeEach(() => {
	root = mkdtempSync(join(process.cwd(), "scratch", "verify-test-mock-foreground-"));
	originalExit = process.exitCode;
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = originalExit;
	rmSync(root, { recursive: true, force: true });
});

describe.each(cases)("foreground verification $check", entry => {
	it("P1 retains the complete mocked result above the JavaScript argument ceiling", () => {
		const matches = Array.from({ length: 150_000 }, (_, index) => ({ line: index + 1, text: "Retained boundary observation" }));
		entry.mock(matches);
		const results = emptyResults();
		entry.runner({ file: join(root, "foo.test.ts"), content: "", relPath: "foo.test.ts", cwd: root, r: results, piiOpts: {} });
		expect(results[entry.bucket]).toHaveLength(matches.length);
		expect(results[entry.bucket].at(-1)).toMatchObject({ check: entry.check, line: 150_000 });
	});

	it("P2 retains twenty real findings and the tail in the public collector, JSON and actions", async () => {
		const file = join(root, "foo.test.ts");
		writeFileSync(file, Array.from({ length: 20 }, (_, index) => entry.source(index)).join("\n"));
		const results = await withVerifyTimings(root, () => runCodeQualityChecks([file], root), { skipChecks: getEffectiveSkipChecks(undefined, true) });
		expect(results[entry.bucket].map(row => row.line)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		outputJson({ tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [], auditResult: null, cq: results, suggestions: null, totalFiles: 1 });
		const report = JSON.parse(stdout.mock.calls.map(call => String(call[0])).join(""));
		expect(report[entry.check].issues).toBe(20);
		const actions = report.actions.actions.filter((action: { evidence: { check: string }[] }) => action.evidence.some(evidence => evidence.check === entry.check));
		expect(actions).toHaveLength(20);
		expect(actions.some((action: { line: number }) => action.line === 20)).toBe(true);
	});
});
