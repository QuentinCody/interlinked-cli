import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectCatchRewrapLosesCause, detectJsonStringifyError, detectResourceHandleLeak } from "../../harness/checks/error-context.js";
import * as errorContext from "../../harness/checks/error-context.js";
import { getEffectiveSkipChecks } from "./advisory-skips.js";
import { timingSnapshot, withVerifyTimings, type VerifyCheckTiming } from "./check-timing.js";
import { outputJson } from "./output-json.js";
import { getActiveSkipChecks, setActiveSkipChecks, streamAllCqSections } from "./streaming-output.js";
import { runCodeQualityChecks } from "./tool-results.js";
import { runErrorContextChecks } from "./file-checks-error-context.js";
import { emptyResults } from "./tool-results-types.js";

const cases = [
	{ check: "json_stringify_error", bucket: "jsonStringifyError", detector: detectJsonStringifyError,
		source: (index: number) => `function serialize${index}() { try { work(); } catch (err) { log(JSON.stringify(err)); } }`,
		benign: 'try { work(); } catch (err) { log(JSON.stringify({ message: err.message })); }' },
	{ check: "catch_rewrap_loses_cause", bucket: "catchRewrapLosesCause", detector: detectCatchRewrapLosesCause,
		source: (index: number) => `function rethrow${index}() { try { work(); } catch (err) { throw new Error(String(err)); } }`,
		benign: 'try { work(); } catch (err) { throw new Error(String(err), { cause: err }); }' },
	{ check: "resource_handle_leak", bucket: "resourceHandleLeak", detector: detectResourceHandleLeak,
		source: (index: number) => `function acquire${index}(path) { const fd${index} = fs.openSync(path, "r"); if (fd${index} < 0) throw new Error("bad descriptor"); }`,
		benign: 'function acquire(path) { const fd = fs.openSync(path, "r"); fs.closeSync(fd); }' },
] as const;

const detectorNames = {
	json_stringify_error: "detectJsonStringifyError",
	catch_rewrap_loses_cause: "detectCatchRewrapLosesCause",
	resource_handle_leak: "detectResourceHandleLeak",
} as const;

let root: string;
let originalExit: typeof process.exitCode;
let originalSkips: Set<string>;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "verify-error-context-"));
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
		skipChecks: getEffectiveSkipChecks(skip, allChecks),
		onFinish: run => { coverage = timingSnapshot(run); },
	});
	return { results, coverage };
}

describe.each(cases)("verify advisory $check", entry => {
	it("P3 retains full results beyond the JavaScript argument limit", () => {
		const matches = Array.from({ length: 150_000 }, (_, index) => ({ line: index + 1, text: "Retained boundary observation" }));
		vi.spyOn(errorContext, detectorNames[entry.check]).mockReturnValue(matches);
		const results = emptyResults();
		runErrorContextChecks({ file: join(root, "service.ts"), content: "", relPath: "service.ts", cwd: root, r: results, piiOpts: {} });
		expect(results[entry.bucket]).toHaveLength(matches.length);
		expect(results[entry.bucket].at(-1)).toMatchObject({ check: entry.check, line: 150_000 });
	});

	it("P1 retains all twenty real-detector findings beyond the hook match cap", async () => {
		const content = ['import * as fs from "node:fs";', ...Array.from({ length: 20 }, (_, index) => entry.source(index))].join("\n");
		expect(entry.detector(content, join(root, "service.ts"))).toHaveLength(10);
		const { results, coverage } = await collect(content);
		expect(results[entry.bucket]).toHaveLength(20);
		expect(results[entry.bucket].map(row => row.line)).toEqual(Array.from({ length: 20 }, (_, index) => index + 2));
		expect(coverage.find(row => row.check === entry.check)).toMatchObject({ calls: 1, skipped: 0 });
	});

	it("N1 skips the advisory detector before execution in the default selection", async () => {
		const { results, coverage } = await collect(entry.source(0), false);
		expect(results[entry.bucket]).toEqual([]);
		expect(coverage.some(row => row.check === entry.check)).toBe(false);
	});

	it("N2 honors explicit skip even when all advisory checks are requested", async () => {
		const { results, coverage } = await collect(entry.source(0), true, entry.check);
		expect(results[entry.bucket]).toEqual([]);
		expect(coverage.some(row => row.check === entry.check)).toBe(false);
	});

	it("N3 preserves the detector's legitimate exception", async () => {
		const { results } = await collect(entry.benign);
		expect(results[entry.bucket]).toEqual([]);
	});

	it("N4 honors an inline rationale suppression through the real collector", async () => {
		const content = `// interlinked-ignore: ${entry.check} — intentional behavior reviewed for this boundary\n${entry.source(0)}`;
		const { results } = await collect(content);
		expect(results[entry.bucket]).toEqual([]);
		expect(results.suppressionHygiene.filter(row => row.message.includes(entry.check))).toEqual([]);
	});

	it("N5 honors persisted suppression through the real collector", async () => {
		const dir = join(root, ".interlinked");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "verify-suppressions.json"), JSON.stringify({ "service.ts": { [entry.check]: {
			reason: "Intentional behavior reviewed for this boundary", by: "test", at: "2026-11-12",
		} } }));
		const { results } = await collect(entry.source(0));
		expect(results[entry.bucket]).toEqual([]);
	});

	it("P2 retains every finding in raw JSON details and actions and renders the human section", async () => {
		const content = Array.from({ length: 20 }, (_, index) => entry.source(index)).join("\n");
		const { results } = await collect(content);
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		outputJson({ tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [], auditResult: null, cq: results, suggestions: null, totalFiles: 1 });
		const parsed = JSON.parse(stdout.mock.calls.map(call => String(call[0])).join(""));
		expect(parsed[entry.check]).toMatchObject({ issues: 20, details: results[entry.bucket] });
		const actions = parsed.actions.actions.filter((action: { evidence: { check: string }[] }) => action.evidence.some(row => row.check === entry.check));
		expect(actions).toHaveLength(20);
		expect(actions.every((action: { classification: string }) => action.classification === "candidate")).toBe(true);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const flagged = new Set<string>();
		setActiveSkipChecks(new Set());
		streamAllCqSections(results, true, flagged);
		const human = stderr.mock.calls.map(call => String(call[0])).join("").replace(/\x1b\[[0-9;]*m/g, "");
		expect(human).toContain(entry.check.replaceAll("_", " "));
		expect(human).toContain("20");
		expect(flagged).toContain("service.ts");
		stderr.mockClear();
		setActiveSkipChecks(new Set([entry.check]));
		streamAllCqSections(results, true, new Set());
		expect(stderr.mock.calls.map(call => String(call[0])).join("")).not.toContain(entry.check.replaceAll("_", " "));
	});
});
