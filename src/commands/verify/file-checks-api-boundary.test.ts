import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPublicApiLeaksInternalType } from "../../harness/checks/api-surface.js";
import { detectJsdocParamDrift } from "../../harness/checks/jsdoc-param-drift.js";
import { detectUnvalidatedInputBoundary } from "../../harness/checks/unvalidated-input-boundary.js";
import * as parser from "../../harness/checks/cyclomatic-ast.js";
import { getEffectiveSkipChecks } from "./advisory-skips.js";
import { timingSnapshot, withVerifyTimings, type VerifyCheckTiming } from "./check-timing.js";
import { outputJson } from "./output-json.js";
import { getActiveSkipChecks, setActiveSkipChecks, streamAllCqSections } from "./streaming-output.js";
import { runCodeQualityChecks } from "./tool-results.js";

const cases = [
	{ check: "public_api_leaks_internal_type", bucket: "publicApiLeaksInternalType", detector: checkPublicApiLeaksInternalType, cap: 5,
		source: (index: number) => `${index === 0 ? "interface Internal { value: string }\n" : ""}export function exposed${index}(): Internal { return { value: 'ok' }; }`,
		benign: "export interface Public { value: string }\nexport function exposed(): Public { return { value: 'ok' }; }" },
	{ check: "jsdoc_param_drift", bucket: "jsdocParamDrift", detector: detectJsdocParamDrift, cap: 10,
		source: (index: number) => `/**\n * @param previous old argument\n */\nexport function documented${index}(current: string) { return current; }`,
		benign: "/**\n * @param current current argument\n */\nexport function documented(current: string) { return current; }" },
	{ check: "unvalidated_input_boundary", bucket: "unvalidatedInputBoundary", detector: detectUnvalidatedInputBoundary, cap: 10,
		source: (index: number) => `export async function boundary${index}(response: Response) { return await response.json(); }`,
		benign: "export async function boundary(response: Response) { return schema.parse(await response.json()); }" },
] as const;

let root: string;
let originalExit: typeof process.exitCode;
let originalSkips: Set<string>;
beforeEach(() => {
	root = mkdtempSync(join(process.cwd(), "scratch", "verify-api-boundary-"));
	originalExit = process.exitCode;
	originalSkips = getActiveSkipChecks();
});
afterEach(() => {
	vi.restoreAllMocks();
	setActiveSkipChecks(originalSkips);
	process.exitCode = originalExit;
	rmSync(root, { recursive: true, force: true });
});
async function collect(content: string, allChecks = true, skip?: string) {
	const file = join(root, "service.ts");
	writeFileSync(file, content);
	let coverage: VerifyCheckTiming[] = [];
	const results = await withVerifyTimings(root, () => runCodeQualityChecks([file], root), {
		skipChecks: getEffectiveSkipChecks(skip, allChecks), onFinish: run => { coverage = timingSnapshot(run); },
	});
	return { results, coverage };
}

describe.each(cases)("advisory verify integration $check", entry => {
	it("P1 retains twenty real observations and their tail beyond runtime match caps", async () => {
		const content = Array.from({ length: 20 }, (_, index) => entry.source(index)).join("\n");
		expect(entry.detector(content, join(root, "service.ts"))).toHaveLength(entry.cap);
		const { results, coverage } = await collect(content);
		const rows = Reflect.get(results, entry.bucket);
		expect(rows).toHaveLength(20);
		expect(rows.at(-1)).toMatchObject({ check: entry.check, file: "service.ts" });
		expect(rows.at(-1)?.line).toBeGreaterThan(entry.cap);
		expect(coverage.find(row => row.check === entry.check)).toMatchObject({ skipped: 0, errors: 0 });
		expect(entry.detector(content, join(root, "service.ts"))).toHaveLength(entry.cap);
	});

	it("N1 keeps default advisory selection and explicit skips outside execution", async () => {
		for (const [allChecks, skip] of [[false, undefined], [true, entry.check]] as const) {
			const { results, coverage } = await collect(entry.source(0), allChecks, skip);
			expect(Reflect.get(results, entry.bucket)).toEqual([]);
			expect(coverage.some(row => row.check === entry.check)).toBe(false);
		}
	});

	it("N2 preserves the detector's corrected-source exception", async () => {
		const { results } = await collect(entry.benign);
		expect(Reflect.get(results, entry.bucket)).toEqual([]);
	});

	it("N3 applies a rationale-bearing inline suppression through the normal collector", async () => {
		const source = entry.source(0), lines = source.split("\n");
		const match = entry.detector(source, join(root, "service.ts"))[0]!;
		lines.splice(match.line - 1, 0, `// interlinked-ignore: ${entry.check} — reviewed intentional source pattern`);
		const { results } = await collect(lines.join("\n"));
		expect(Reflect.get(results, entry.bucket)).toEqual([]);
	});

	it("N4 applies a persisted suppression through the normal collector", async () => {
		mkdirSync(join(root, ".interlinked"));
		writeFileSync(join(root, ".interlinked/verify-suppressions.json"), JSON.stringify({ "service.ts": { [entry.check]: {
			reason: "Intentional source pattern reviewed", by: "test", at: "2026-11-12",
		} } }));
		const { results } = await collect(entry.source(0));
		expect(Reflect.get(results, entry.bucket)).toEqual([]);
	});

	it("P2 retains complete raw JSON, candidate actions, captured source identity and human output", async () => {
		const content = Array.from({ length: 20 }, (_, index) => entry.source(index)).join("\n");
		const { results } = await collect(content);
		const rows = Reflect.get(results, entry.bucket);
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		outputJson({ tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [], auditResult: null, cq: results, suggestions: null, totalFiles: 1 });
		const output = JSON.parse(stdout.mock.calls.map(call => String(call[0])).join(""));
		expect(output[entry.check]).toMatchObject({ issues: 20, details: rows });
		const actions = output.actions.actions.filter((action: { evidence: { check: string }[] }) => action.evidence.some(row => row.check === entry.check));
		expect(actions).toHaveLength(20);
		expect(actions.every((action: { classification: string; sourceHash: string; evidence: { sourceHash: string }[] }) =>
			action.classification === "candidate" && action.evidence.every(row => row.sourceHash === createHash("sha256").update(content).digest("hex")))).toBe(true);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		setActiveSkipChecks(new Set());
		const flagged = new Set<string>();
		streamAllCqSections(results, true, flagged);
		expect(stripVTControlCharacters(stderr.mock.calls.map(call => String(call[0])).join(""))).toContain(entry.check.replaceAll("_", " "));
		expect(flagged).toContain("service.ts");
	});
});

describe("selected JSDoc parser coverage", () => {
	it("P3 records parser absence as a named unavailable input", async () => {
		vi.spyOn(parser, "parseTsSource").mockReturnValue(null);
		const { results, coverage } = await collect(cases[1].source(0));
		expect(Reflect.get(results, "jsdocParamDrift")).toEqual([]);
		expect(coverage.find(row => row.check === "jsdoc_param_drift")).toMatchObject({ skipped: 1,
			unavailable_inputs: [{ file: "service.ts", reason: expect.stringContaining("parser unavailable") }] });
		expect(process.exitCode).toBe(75);
	});

	it("P4 records parser recovery as unavailable without certifying recovered JSDoc matches", async () => {
		const { results, coverage } = await collect(cases[1].source(0) + "\nfunction broken( {");
		expect(Reflect.get(results, "jsdocParamDrift")).toEqual([]);
		expect(coverage.find(row => row.check === "jsdoc_param_drift")).toMatchObject({ skipped: 1,
			unavailable_inputs: [{ file: "service.ts", reason: expect.stringContaining("recovery") }] });
	});

	it("P5 retains lexical input-boundary candidates and its structured unavailable parser evidence", async () => {
		vi.spyOn(parser, "parseTsSource").mockReturnValue(null);
		const { results, coverage } = await collect(cases[2].source(0));
		expect(Reflect.get(results, "unvalidatedInputBoundary")).toHaveLength(1);
		expect(coverage.find(row => row.check === "unvalidated_input_boundary")).toMatchObject({ skipped: 1,
			unavailable_inputs: [{ file: "service.ts", reason: expect.stringContaining("AST evidence unavailable") }] });
		expect(process.exitCode).toBe(75);
	});

	it("N5 applies selection before parser work and preserves irrelevant input", async () => {
		const parse = vi.spyOn(parser, "parseTsSource").mockReturnValue(null);
		const { coverage } = await collect(cases[1].source(0), false);
		expect(coverage.some(row => row.check === "jsdoc_param_drift")).toBe(false);
		parse.mockRestore();
		const irrelevant = await collect("export const value = 1;");
		expect(irrelevant.coverage.find(row => row.check === "jsdoc_param_drift")).toMatchObject({ skipped: 0 });
	});
});
