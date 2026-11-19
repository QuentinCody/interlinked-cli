import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectNumericZeroDefault } from "../../harness/checks/numeric-zero-default.js";
import { getEffectiveSkipChecks } from "./advisory-skips.js";
import { timingSnapshot, withVerifyTimings, type VerifyCheckTiming } from "./check-timing.js";
import { outputJson } from "./output-json.js";
import { runCodeQualityChecks } from "./tool-results.js";

let root: string;
let originalExit: typeof process.exitCode;
beforeEach(() => {
	root = mkdtempSync(join(process.cwd(), "scratch", "verify-numeric-zero-"));
	originalExit = process.exitCode;
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = originalExit;
	rmSync(root, { recursive: true, force: true });
});
async function collect(sources: Record<string, string>, allChecks = true, skip?: string) {
	const files = Object.entries(sources).map(([file, content]) => { const path = join(root, file); writeFileSync(path, content); return path; });
	let coverage: VerifyCheckTiming[] = [];
	const results = await withVerifyTimings(root, () => runCodeQualityChecks(files, root), {
		skipChecks: getEffectiveSkipChecks(skip, allChecks), onFinish: run => { coverage = timingSnapshot(run); },
	});
	return { results, coverage };
}
function json(results: Awaited<ReturnType<typeof collect>>["results"]) {
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	outputJson({ tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [], auditResult: null, cq: results, suggestions: null, totalFiles: 1 });
	return JSON.parse(stdout.mock.calls.map(call => String(call[0])).join(""));
}

describe("numeric zero advisory verify integration", () => {
	it("P1 retains the complete twenty-expression population in raw JSON and actions", async () => {
		const content = Array.from({ length: 20 }, (_, index) => `export const value${index} = Number.parseInt(raw, 10) || 2;`).join("\n");
		expect(detectNumericZeroDefault(content, join(root, "service.ts"))).toHaveLength(20);
		const { results, coverage } = await collect({ "service.ts": content });
		expect(results.numericZeroDefault).toHaveLength(20);
		expect(results.numericZeroDefault.at(-1)).toMatchObject({ file: "service.ts", line: 20 });
		expect(coverage.find(row => row.check === "numeric_zero_default")).toMatchObject({ skipped: 0, errors: 0 });
		const output = json(results);
		expect(output.numeric_zero_default).toMatchObject({ issues: 20, details: results.numericZeroDefault });
		expect(output.actions.actions.filter((action: { evidence: { check: string }[] }) => action.evidence.some(row => row.check === "numeric_zero_default"))).toHaveLength(20);
	});

	it("N1 skips advisory work before invocation by default and for explicit exclusion", async () => {
		for (const [allChecks, skip] of [[false, undefined], [true, "numeric_zero_default"]] as const) {
			const { results, coverage } = await collect({ "service.ts": "export const count = Number.parseInt(raw, 10) || 2;" }, allChecks, skip);
			expect(results.numericZeroDefault).toEqual([]);
			expect(coverage.some(row => row.check === "numeric_zero_default")).toBe(false);
		}
	});

	it.each([
		"const parsed = Number.parseInt(raw, 10); export const count = Number.isNaN(parsed) ? 2 : parsed;",
		"export const count = Number.parseInt(raw, 10) || 0;",
		"export const count = Number.parseInt(raw, 10) ?? 2;",
		"function local(Number: { parseInt(raw: string, radix: number): number }, raw: string) { return Number.parseInt(raw, 10) || 2; }",
	])("N2 retains the corrected or legitimate numeric exception %s", async content => {
		const { results } = await collect({ "service.ts": content });
		expect(results.numericZeroDefault).toEqual([]);
	});

	it("N3 applies ordinary inline rationale suppression", async () => {
		const { results } = await collect({ "service.ts": "// interlinked-ignore: numeric_zero_default — intentional caller policy replaces zero\nexport const count = Number.parseInt(raw, 10) || 2;" });
		expect(results.numericZeroDefault).toEqual([]);
	});

	it("N4 applies persisted rationale suppression through the shared result bucket", async () => {
		mkdirSync(join(root, ".interlinked"));
		writeFileSync(join(root, ".interlinked/verify-suppressions.json"), JSON.stringify({ "service.ts": { numeric_zero_default: {
			reason: "Intentional caller policy replaces zero", by: "test", at: "2026-11-12",
		} } }));
		const { results } = await collect({ "service.ts": "export const count = Number.parseInt(raw, 10) || 2;" });
		expect(results.numericZeroDefault).toEqual([]);
	});

	it("P2 retains a valid observation beside explicitly numeric but opaque helper evidence", async () => {
		const { results, coverage } = await collect({
			"valid.ts": "export const count = Number.parseInt(raw, 10) || 2;",
			"parse.ts": "export function parseCount(raw: string): number { if (raw) return Number(raw); return custom(raw); }",
			"unavailable.ts": "import { parseCount } from './parse.js'; export const count = parseCount(raw) || 2;",
		});
		expect(results.numericZeroDefault).toHaveLength(1);
		expect(results.numericZeroDefault[0]?.file).toBe("valid.ts");
		expect(coverage.find(row => row.check === "numeric_zero_default")?.skipped).toBeGreaterThan(0);
		expect(process.exitCode).toBe(75);
	});

	it("P3 retains exact loaded producer and consumer source identities in raw details and actions", async () => {
		const producer = "export function parseCount(raw: string) { return Number.parseInt(raw, 10); }";
		const consumer = "import { parseCount } from './parse.js'; export const count = parseCount(raw) || 2;";
		const { results } = await collect({ "parse.ts": producer, "service.ts": consumer });
		expect(results.numericZeroDefault).toHaveLength(1);
		const expected = [
			expect.objectContaining({ file: expect.stringContaining("parse.ts"), sha256: createHash("sha256").update(producer).digest("hex"), role: "producer" }),
			expect.objectContaining({ file: expect.stringContaining("service.ts"), sha256: createHash("sha256").update(consumer).digest("hex"), role: "consumer" }),
		];
		expect(Reflect.get(results.numericZeroDefault[0]!, "sourceEvidence")).toEqual(expect.arrayContaining(expected));
		const output = json(results);
		expect(output.numeric_zero_default.details[0].sourceEvidence).toEqual(expect.arrayContaining(expected));
		const action = output.actions.actions.find((row: { evidence: { check: string }[] }) => row.evidence.some(evidence => evidence.check === "numeric_zero_default"));
		expect(action.evidence[0].sourceEvidence).toEqual(expect.arrayContaining(expected));
	});
});
