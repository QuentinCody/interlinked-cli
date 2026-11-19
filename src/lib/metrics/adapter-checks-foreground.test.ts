import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECK_REGISTRY } from "../../harness/check-registry/index.js";
import { checkRoot, reportNotMeasured } from "../../harness/checks/check-root.js";
import { withForegroundCheckScan } from "../../harness/checks/check-scan-policy.js";
import { measureContentChecks } from "./adapter-checks.js";
import { analyzeRepository } from "./analysis.js";
import { collectCompositeScoreReport } from "./composite-report.js";
import { FOREGROUND_UNCAPPED_SCORED_CHECKS, SCORED_CHECK_RUNTIME_RESULT_LIMITS, SCORED_CHECKS } from "./catalog-policy.js";
import { collectRepositoryInventory } from "./inventory.js";
import { collectStaticMeasurements } from "./static-measurements.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(content: string, file = "index.ts") {
	const root = mkdtempSync(join(process.cwd(), "scratch", "metrics-scored-results-")); roots.push(root);
	writeFileSync(join(root, file), content);
	return { root, analysis: analyzeRepository(collectRepositoryInventory(root, { resourcePolicy: "foreground-survey" })) };
}

describe.each([
	{ id: "nan_comparison", dimension: "correctness" as const, file: "index.ts", cap: 10,
		source: (i: number) => `if (value === NaN) fail${i}();` },
	{ id: "async_promise_executor", dimension: "correctness" as const, file: "index.ts", cap: 10,
		source: (i: number) => `const pending${i} = new Promise(async resolve => resolve(1));` },
	{ id: "unsafe_optional_chaining", dimension: "correctness" as const, file: "index.ts", cap: 10,
		source: (i: number) => `const value${i} = (maybe?.value).field;` },
	{ id: "ubs_tls_verify_disabled", dimension: "correctness" as const, file: "index.ts", cap: 10,
		source: (i: number) => `const options${i} = { rejectUnauthorized: false };` },
	{ id: "assertion_free_test", dimension: "test_integrity" as const, file: "index.test.ts", cap: 10,
		source: (i: number) => `it("case ${i}", () => { work(); });` },
	{ id: "tautological_assertion", dimension: "test_integrity" as const, file: "index.test.ts", cap: 10,
		source: (i: number) => `it("case ${i}", () => { expect(value).toBe(value); });` },
	{ id: "focused_tests", dimension: "test_integrity" as const, file: "index.test.ts", cap: 15,
		source: (i: number) => `it.only("case ${i}", () => { expect(actual).toBe(expected); });` },
	{ id: "disabled_tests", dimension: "test_integrity" as const, file: "index.test.ts", cap: 15,
		source: (i: number) => `it.skip("case ${i}", () => {});` },
	{ id: "vacuous_loop_assertion", dimension: "test_integrity" as const, file: "index.test.ts", cap: 10,
		source: (i: number) => `it("case ${i}", () => { for (const value of rows) { expect(value).toBeDefined(); } });` },
	{ id: "commented_out_assertion", dimension: "test_integrity" as const, file: "index.test.ts", cap: 10,
		source: (i: number) => `it("case ${i}", () => {\n// expect(value).toBe(1);\nwork();\n});` },
	{ id: "fallback_only_assertion", dimension: "test_integrity" as const, file: "index.test.ts", cap: 10,
		source: (i: number) => `it("case ${i}", () => { expect(decode(input)).toBeNull(); });` },
	{ id: "introverted_test", dimension: "test_integrity" as const, file: "index.test.ts", cap: 10,
		source: (i: number) => `${i === 0 ? 'import { compute } from "./index";\n' : ""}it("case ${i}", () => { expect(2 + 2).toBe(4); });` },
	{ id: "throw_literal", dimension: "correctness" as const, file: "index.ts", cap: 10,
		source: (i: number) => `export function fail${i}() {\nthrow "failure";\n}` },
	{ id: "promise_reject_non_error", dimension: "correctness" as const, file: "index.ts", cap: 10,
		source: () => 'Promise.reject("failure");' },
	{ id: "catch_without_assertion_guard", dimension: "test_integrity" as const, file: "index.test.ts", cap: 10,
		source: (i: number) => `it("case ${i}", () => { try { work(); } catch (err) { expect(err.message).toBe("bad"); } });` },
	{ id: "mock_only_test", dimension: "test_integrity" as const, file: "index.test.ts", cap: 12,
		source: (i: number) => `it("case ${i}", () => { expect(log).toHaveBeenCalled(); });` },
])("foreground scored population $id", ({ id, dimension, file, cap, source }) => {
	it("retains twenty observations in static and composite collectors while direct runtime calls stay bounded", () => {
		const { root, analysis } = fixture(Array.from({ length: 20 }, (_, index) => source(index)).join("\n"), file);
		const own = (findings: { message: string; line: number }[]) => findings.filter(finding => finding.message.startsWith(`${id}:`));
		const before = measureContentChecks(analysis, dimension);
		expect(own(before.findings)).toHaveLength(cap);
		expect(before.metrics[0]?.limitations.some(reason => reason.startsWith(`${id}: reporting cap`))).toBe(true);
		for (const report of [collectStaticMeasurements(root), collectCompositeScoreReport(root)]) {
			expect(own(report.findings)).toHaveLength(20);
			const lastSourceLine = Array.from({ length: 19 }, (_, index) => source(index).split("\n").length).reduce((sum, lines) => sum + lines, 0) + 1;
			expect(own(report.findings).at(-1)?.line).toBeGreaterThanOrEqual(lastSourceLine);
			expect(report.metrics.flatMap(reading => reading.limitations).some(reason => reason.startsWith(`${id}: reporting cap`))).toBe(false);
		}
		expect(own(measureContentChecks(analysis, dimension).findings)).toHaveLength(cap);
	});
});

it("retains a scored per-file finding population beyond the JavaScript argument ceiling", () => {
	const { analysis } = fixture('throw "failure";');
	const check = CHECK_REGISTRY.find(entry => entry.id === "throw_literal")!;
	vi.spyOn(check, "fn").mockReturnValue(Array.from({ length: 150_000 }, (_, index) => ({ line: 1, text: `collection control ${index}` })));
	const result = withForegroundCheckScan(() => measureContentChecks(analysis, "correctness"));
	expect(result.findings).toHaveLength(150_000);
	expect(result.findings.at(-1)?.message).toContain("collection control 149999");
});

it("retains unavailable notices and positive evidence with the inventory root and absolute source path", () => {
	const { root, analysis } = fixture('Promise.reject("failure");');
	const check = CHECK_REGISTRY.find(entry => entry.id === "promise_reject_non_error")!;
	vi.spyOn(check, "fn").mockImplementation((_content, file) => {
		expect(checkRoot()).toBe(root);
		expect(file).toBe(join(root, "index.ts"));
		reportNotMeasured(check.id, "parser unavailable control");
		return [{ line: 1, text: "retained partial observation" }];
	});
	const result = withForegroundCheckScan(() => measureContentChecks(analysis, "correctness"));
	expect(result.findings.some(finding => finding.message.includes("retained partial observation"))).toBe(true);
	expect(result.metrics[0]?.state).toBe("inconclusive");
	expect(result.metrics[0]?.limitations.some(reason => reason.includes("parser unavailable control"))).toBe(true);
});

it("keeps saturation uncertainty for another scored detector without the foreground result capability", () => {
	const { analysis } = fixture('it("case", () => {});', "index.test.ts");
	const check = CHECK_REGISTRY.find(entry => entry.id === "assertion_free_test")!;
	vi.spyOn(check, "fn").mockReturnValue(Array.from({ length: 10 }, () => ({ line: 1, text: "saturation control" })));
	const originalHas = FOREGROUND_UNCAPPED_SCORED_CHECKS.has.bind(FOREGROUND_UNCAPPED_SCORED_CHECKS);
	vi.spyOn(FOREGROUND_UNCAPPED_SCORED_CHECKS, "has").mockImplementation(id => id === "assertion_free_test" ? false : originalHas(id));
	const result = withForegroundCheckScan(() => measureContentChecks(analysis, "test_integrity"));
	expect(result.metrics[0]?.state).toBe("inconclusive");
	expect(result.metrics[0]?.limitations.some(reason => reason.startsWith("assertion_free_test: reporting cap"))).toBe(true);
});

describe.each(["focused_tests", "disabled_tests"])("actual runtime result limit for %s", id => {
	it.each([10, 11, 12, 13, 14, 15])("reports saturation only at fifteen for a population of %i", count => {
		const marker = id === "focused_tests" ? "only" : "skip";
		const { analysis } = fixture(Array.from({ length: count }, (_, i) => `it.${marker}("case ${i}", () => { expect(actual).toBe(expected); });`).join("\n"), "index.test.ts");
		const result = measureContentChecks(analysis, "test_integrity");
		expect(result.findings.filter(finding => finding.message.startsWith(`${id}:`))).toHaveLength(count);
		expect(result.metrics[0]?.limitations.some(reason => reason.startsWith(`${id}: reporting cap`))).toBe(count === 15);
	});
});

it("accounts for every scored collection policy and retains unknown capability with partial findings", () => {
	expect([...FOREGROUND_UNCAPPED_SCORED_CHECKS].sort()).toEqual(Object.keys(SCORED_CHECKS).sort());
	expect([...SCORED_CHECK_RUNTIME_RESULT_LIMITS.keys()].sort()).toEqual(Object.keys(SCORED_CHECKS).sort());
	const { analysis } = fixture('Promise.reject("failure");');
	const originalGet = SCORED_CHECK_RUNTIME_RESULT_LIMITS.get.bind(SCORED_CHECK_RUNTIME_RESULT_LIMITS);
	vi.spyOn(SCORED_CHECK_RUNTIME_RESULT_LIMITS, "get").mockImplementation(id => id === "promise_reject_non_error" ? undefined : originalGet(id));
	const result = withForegroundCheckScan(() => measureContentChecks(analysis, "correctness"));
	expect(result.findings.some(finding => finding.message.startsWith("promise_reject_non_error:"))).toBe(true);
	expect(result.metrics[0]?.state).toBe("inconclusive");
	expect(result.metrics[0]?.limitations.some(reason => reason.startsWith("promise_reject_non_error: result-collection capability is unknown"))).toBe(true);
});

it("retains a scored detector exception as unavailable evidence", () => {
	const { analysis } = fixture('Promise.reject("failure");');
	const check = CHECK_REGISTRY.find(entry => entry.id === "promise_reject_non_error")!;
	vi.spyOn(check, "fn").mockImplementation(() => { throw new Error("failure control"); });
	const result = withForegroundCheckScan(() => measureContentChecks(analysis, "correctness"));
	expect(result.metrics[0]?.state).toBe("inconclusive");
	expect(result.metrics[0]?.limitations.some(reason => reason.includes("promise_reject_non_error: Error: failure control"))).toBe(true);
});
