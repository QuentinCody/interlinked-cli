import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHECK_REGISTRY } from "../check-registry/index.js";
import { reportNotMeasured } from "./check-root.js";
import { hashBytes } from "../../lib/metrics/inventory.js";
import { scanStandardsEvidence } from "../../lib/standards/evidence.js";
import { runCodeQualityChecks } from "../../commands/verify/tool-results.js";
import { timingSnapshot, withVerifyTimings, type VerifyCheckTiming } from "../../commands/verify/check-timing.js";
import { outputJson } from "../../commands/verify/output-json.js";

let root: string;
let originalExit: typeof process.exitCode;
beforeEach(() => {
	root = mkdtempSync(join(process.cwd(), "scratch", "own-barrel-survey-"));
	originalExit = process.exitCode;
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = originalExit;
	rmSync(root, { recursive: true, force: true });
});
function put(name: string, content: string) {
	writeFileSync(join(root, name), content);
	return { path: name, content, role: "product" as const, language: "typescript", sha256: hashBytes(content) };
}

it("retains unknown dependency evidence in actual verify timing, JSON and actions", async () => {
	const files = [put("foo.ts", 'import { leaf } from "./index.js";'), put("index.ts", 'export * from "./missing.js";')];
	let timings: VerifyCheckTiming[] = [];
	const skipChecks = new Set(CHECK_REGISTRY.filter(check => check.id !== "import_from_own_barrel").map(check => check.id));
	const cq = await withVerifyTimings(root, () => runCodeQualityChecks(files.map(file => join(root, file.path)), root), {
		skipChecks, onFinish: run => { timings = timingSnapshot(run); },
	});
	expect(cq.importFromOwnBarrel).toEqual([]);
	expect(timings).toContainEqual(expect.objectContaining({ check: "import_from_own_barrel", skipped: 1,
		unavailable_inputs: [expect.objectContaining({ reason: expect.stringContaining("missing") })] }));
	expect(process.exitCode).toBe(75);
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	outputJson({ tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [], auditResult: null, cq,
		suggestions: null, totalFiles: files.length, checkTimings: timings });
	const report = JSON.parse(stdout.mock.calls.map(call => String(call[0])).join(""));
	expect(report.check_coverage.timings).toContainEqual(expect.objectContaining({ check: "import_from_own_barrel", skipped: 1 }));
	expect(report.actions.actions).toContainEqual(expect.objectContaining({ classification: "evidence_gap",
		evidence: expect.arrayContaining([expect.objectContaining({ check: "import_from_own_barrel" })]) }));
});

it("standards retains unavailable coverage separately from a witnessed dependency pattern", () => {
	const file = put("foo.ts", 'import { leaf } from "./index.js";\nexport const leaf = 1;');
	put("index.ts", 'export * from "./missing.js";\nexport * from "./foo.js";');
	const report = scanStandardsEvidence(root, [file], ["import_from_own_barrel"]);
	expect(report.occurrences.filter(row => row.rule === "import_from_own_barrel")).toHaveLength(1);
	expect(report.checks).toContainEqual(expect.objectContaining({ id: "import_from_own_barrel", measuredFiles: 0, unknownFiles: 1 }));
	expect(report.notMeasured.join("\n")).toContain("missing");
});

it("standards retains every unavailable notice beyond the JavaScript argument ceiling", () => {
	const check = CHECK_REGISTRY.find(row => row.id === "import_from_own_barrel");
	if (!check) throw new Error("Existing own-barrel registry entry missing");
	const file = put("foo.ts", "export const value = 1;");
	const registry = [{ ...check, fn: () => {
		for (let index = 0; index < 150_001; index++) reportNotMeasured(check.id, `Unavailable graph branch ${index}`);
		return [];
	} }];
	const report = scanStandardsEvidence(root, [file], [check.id], registry);
	expect(report.notMeasured).toHaveLength(150_001);
	expect(report.notMeasured.at(-1)).toContain("150000");
	expect(report.checks[0]).toMatchObject({ measuredFiles: 0, unknownFiles: 1 });
});
