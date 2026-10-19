import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FP_FILTER_DEFAULT_THRESHOLD } from "../../harness/fp-filter.js";
import { formatFpFilterSection, fpFilterJson, resolveVerifyFpFilter, summarizeFpFilter } from "./fp-filter-section.js";
import { outputJson } from "./output-json.js";
import { emptyResults } from "./tool-results-types.js";

const CWD = "/repo";
const issue = (check: string, file: string, len = 70) => ({ check, file, line: 1, message: "x".repeat(len) });

function sampleCq() {
	const cq = emptyResults();
	cq.functionArgCount.push(issue("function_arg_count", `${CWD}/src/a.ts`), issue("function_arg_count", "src/b.ts"));
	cq.magicNumber.push(issue("magic_number", "src/c.ts", 60));
	cq.complexity.push(issue("typescript", "src/d.ts"));
	return cq;
}

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("summarizeFpFilter", () => {
	it("counts scored and suppressed findings per check; [proven] ids are not scored", () => {
		const s = summarizeFpFilter(sampleCq(), CWD);
		expect(s.threshold).toBe(FP_FILTER_DEFAULT_THRESHOLD);
		expect(s.scored).toBe(3);
		expect(s.suppressed).toBe(2);
		expect(s.per_check).toEqual([
			{ check: "function_arg_count", scored: 2, suppressed: 2 },
			{ check: "magic_number", scored: 1, suppressed: 0 },
		]);
	});

	it("min_p moves the cut", () => {
		expect(summarizeFpFilter(sampleCq(), CWD, 0.99).suppressed).toBe(3);
	});

	it("reports the configured threshold even when no findings are eligible", () => {
		const cq = emptyResults();
		cq.complexity.push(issue("typescript", "src/a.ts"));
		expect(summarizeFpFilter(cq, CWD, 0.5)).toEqual({ threshold: 0.5, scored: 0, suppressed: 0, per_check: [] });
		expect(summarizeFpFilter(emptyResults(), CWD, Number.NaN).threshold).toBe(FP_FILTER_DEFAULT_THRESHOLD);
	});
});

describe("verify output", () => {
	it("streaming lines name the per-check suppressed counts and the calibration caveat", () => {
		const lines = formatFpFilterSection(summarizeFpFilter(sampleCq(), CWD)).join("\n");
		expect(lines).toContain("fp_filter");
		expect(lines).toContain("2 / 3 [heuristic] findings would be suppressed");
		expect(lines).toContain("function_arg_count  2/2");
		expect(lines).toContain("magic_number  0/1");
		expect(lines).toContain("calibrated on one repository");
	});

	it("--json carries an fp_filter key with the same counts", () => {
		const chunks: string[] = [];
		const orig = process.stdout.write;
		process.stdout.write = ((c: string) => {
			chunks.push(c);
			return true;
		}) as typeof process.stdout.write;
		try {
			outputJson({
				tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [],
				auditResult: null, cq: sampleCq(), suggestions: null, totalFiles: 4,
				fpFilter: fpFilterJson(summarizeFpFilter(sampleCq(), CWD)),
			});
		} finally {
			process.stdout.write = orig;
		}
		const parsed = JSON.parse(chunks.join(""));
		expect(parsed.fp_filter.suppressed).toBe(2);
		expect(parsed.fp_filter.scored).toBe(3);
		expect(parsed.fp_filter.per_check[0]).toEqual({ check: "function_arg_count", scored: 2, suppressed: 2 });
	});

	it("--json has no fp_filter key when the filter is not requested", () => {
		const chunks: string[] = [];
		const orig = process.stdout.write;
		process.stdout.write = ((c: string) => {
			chunks.push(c);
			return true;
		}) as typeof process.stdout.write;
		try {
			outputJson({
				tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [],
				auditResult: null, cq: emptyResults(), suggestions: null, totalFiles: 0,
			});
		} finally {
			process.stdout.write = orig;
		}
		expect(JSON.parse(chunks.join("")).fp_filter).toBeUndefined();
	});
});

describe("resolveVerifyFpFilter", () => {
	it("is off by default and on with the flag", () => {
		const root = mkdtempSync(join(tmpdir(), "il-fp-verify-"));
		roots.push(root);
		expect(resolveVerifyFpFilter(root, undefined)).toBeUndefined();
		expect(resolveVerifyFpFilter(root, true)).toEqual({});
	});

	it("honors fp_filter in guard-rules.local.json, including min_p", () => {
		const root = mkdtempSync(join(tmpdir(), "il-fp-verify-"));
		roots.push(root);
		mkdirSync(join(root, ".interlinked"));
		writeFileSync(join(root, ".interlinked", "guard-rules.local.json"), JSON.stringify({ fp_filter: { enabled: true, min_p: 0.5 } }));
		expect(resolveVerifyFpFilter(root, undefined)).toEqual({ minP: 0.5 });
	});
});
