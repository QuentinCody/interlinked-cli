import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrapFinding } from "../harness/checks/crap.js";
import type { FunctionComplexityEntry } from "../harness/checks/cyclomatic.js";
import type { CanonicalCoverage } from "../harness/coverage-canonical.js";
import type { PerFileCoverage } from "../harness/coverage-final-reader.js";
import type { CoverageSummary } from "../harness/coverage-ratchet.js";
import type { FunctionTokenMetricsReport } from "./metrics-function-tokens.js";

// ===========================================
// metricsCommand — behavioral, module-boundary mocks
// ===========================================
// metrics.ts is a pure orchestrator: it composes file discovery, the AST
// complexity pass, the coverage readers, the CRAP scorer, and the companion-
// path helper, then renders. We mock each of those at the import boundary so
// every branch (output modes, coverage present/absent, files over/under
// thresholds, empty, companion exempt/present/missing, the ?? / && / ||
// fall-throughs) is exercised deterministically with no filesystem reliance.

// --- hoisted mock fns ---------------------------------------------------
const m = vi.hoisted(() => ({
	discoverFiles: vi.fn<(root: string) => string[]>(),
	computeCyclomaticAst:
		vi.fn<(content: string, filePath: string) => FunctionComplexityEntry[] | null>(),
	computeCyclomaticComplexity:
		vi.fn<(content: string, filePath: string) => FunctionComplexityEntry[]>(),
	computeFunctionTokens: vi.fn(),
	buildFunctionTokenMetricsReport: vi.fn<() => FunctionTokenMetricsReport>(),
	loadCoverageFinal:
		vi.fn<(p: string, root: string) => Map<string, PerFileCoverage> | null>(),
	coverageForFile:
		vi.fn<(c: Map<string, PerFileCoverage>, rel: string) => PerFileCoverage | undefined>(),
	loadCoverageSummary: vi.fn<(p: string) => CoverageSummary | null>(),
	loadLcovFile: vi.fn<(p: string, opts?: unknown) => CanonicalCoverage | null>(),
	canonicalToCoverageSummary: vi.fn<(cov: CanonicalCoverage) => CoverageSummary>(),
	perFileCoverageFromCanonical:
		vi.fn<(cf: unknown, rel: string, mtime: number, fns: unknown) => PerFileCoverage>(),
	astComplexityAvailable: vi.fn<() => boolean>(),
	computeCrapForFile: vi.fn<() => CrapFinding[]>(),
	companionTestCandidates: vi.fn<(srcAbs: string) => string[]>(),
	isTddExemptPath: vi.fn<(p: string) => boolean>(),
	readFileSync: vi.fn<(p: unknown, enc?: unknown) => string>(),
	realpathSync: vi.fn<(p: unknown) => string>(),
	statSync: vi.fn<(p: unknown) => { mtimeMs: number }>(),
	existsSync: vi.fn<(p: unknown) => boolean>(),
}));

vi.mock("node:fs", () => ({
	readFileSync: (p: unknown, enc?: unknown) => m.readFileSync(p, enc),
	realpathSync: (p: unknown) => m.realpathSync(p),
	statSync: (p: unknown) => m.statSync(p),
	existsSync: (p: unknown) => m.existsSync(p),
}));
vi.mock("./verify/file-discovery.js", () => ({ discoverFiles: m.discoverFiles }));
vi.mock("../harness/checks/cyclomatic-ast.js", () => ({
	computeCyclomaticAst: m.computeCyclomaticAst,
	astComplexityAvailable: m.astComplexityAvailable,
}));
vi.mock("../harness/checks/cyclomatic.js", () => ({
	computeCyclomaticComplexity: m.computeCyclomaticComplexity,
}));
vi.mock("../harness/function-tokens/index.js", () => ({
	computeFunctionTokens: m.computeFunctionTokens,
}));
vi.mock("./metrics-function-tokens.js", () => ({
	buildFunctionTokenMetricsReport: m.buildFunctionTokenMetricsReport,
}));
vi.mock("../harness/coverage-final-reader.js", () => ({
	loadCoverageFinal: m.loadCoverageFinal,
	coverageForFile: m.coverageForFile,
}));
vi.mock("../harness/coverage-ratchet.js", () => ({
	loadCoverageSummary: m.loadCoverageSummary,
}));
vi.mock("../harness/coverage-lcov.js", () => ({
	loadLcovFile: m.loadLcovFile,
	canonicalToCoverageSummary: m.canonicalToCoverageSummary,
	perFileCoverageFromCanonical: m.perFileCoverageFromCanonical,
}));
vi.mock("../harness/coverage-adapters.js", () => ({
	CANONICAL_LCOV_PATH: "coverage/lcov.info",
	lcovReportPaths: () => ["coverage/lcov.info"],
}));
vi.mock("../harness/checks/crap.js", () => ({ computeCrapForFile: m.computeCrapForFile }));
vi.mock("../harness/evaluator/tdd-new-file-gate.js", () => ({
	companionTestCandidates: m.companionTestCandidates,
	isTddExemptPath: m.isTddExemptPath,
}));

// formatter is real (color-stripped under CI/NO_COLOR — tests assert plain text).

import { nonNull } from "../lib/non-null.js";
import { loadMetricsCoverage } from "./metrics-coverage.js";
import { cyclomaticForMetrics, metricsCommand } from "./metrics.js";

function tokenReport(entries: Array<{ name: string; line: number; tokens: number }> = []): FunctionTokenMetricsReport {
	const functions = entries.map((entry) => ({
		file: "src/a.ts",
		name: entry.name,
		qualifiedName: entry.name,
		declarationKind: "function" as const,
		language: "typescript",
		line: entry.line,
		endLine: entry.line,
		canonicalTokens: entry.tokens,
		sourceScope: "product" as const,
		capEnforced: true,
		overCap: entry.tokens > 500,
	}));
	const values = functions.map((entry) => entry.canonicalTokens).sort((a, b) => a - b);
	const sum = values.reduce((total, value) => total + value, 0);
	const maximum = values.at(-1) ?? null;
	const summary = {
		count: values.length,
		sum,
		min: values[0] ?? null,
		mean: values.length === 0 ? null : sum / values.length,
		p50: values[Math.max(0, Math.ceil(values.length * 0.5) - 1)] ?? null,
		p75: values[Math.max(0, Math.ceil(values.length * 0.75) - 1)] ?? null,
		p90: values[Math.max(0, Math.ceil(values.length * 0.9) - 1)] ?? null,
		p95: values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? null,
		p99: maximum,
		max: maximum,
	};
	const files = entries.length === 0 ? [] : [{
		file: "src/a.ts",
		sourceScope: "product" as const,
		capEnforced: true,
		functionCount: entries.length,
		summedFunctionTokens: sum,
		meanFunctionTokens: summary.mean,
		medianFunctionTokens: summary.p50,
		p95FunctionTokens: summary.p95,
		maxFunctionTokens: maximum,
		functionsOverCap: functions.filter((entry) => entry.overCap).length,
	}];
	return {
		schemaVersion: 1,
		tokenizer: "interlinked-code-v1",
		cap: 500,
		elapsedMs: 0,
		scope: {
			includeTests: false,
			discoveredFiles: files.length,
			candidateFiles: files.length,
			measuredFiles: files.length,
			filesWithFunctions: files.length,
			productFiles: files.length,
			testFiles: 0,
			unmeasuredFiles: 0,
			functionCount: functions.length,
			productFunctions: functions.length,
			testFunctions: 0,
		},
		totals: {
			summedFunctionTokens: sum,
			functionsOverCap: functions.filter((entry) => entry.overCap).length,
			enforcedFunctionsOverCap: functions.filter((entry) => entry.overCap).length,
			functionTokens: summary,
			summedFileFunctionTokens: files.length === 0 ? summary : {
				...summary,
				count: 1,
				min: sum,
				mean: sum,
				p50: sum,
				p75: sum,
				p90: sum,
				p95: sum,
				p99: sum,
				max: sum,
			},
		},
		distributions: {
			functions: {
				"≤100": values.filter((value) => value <= 100).length,
				"101–250": values.filter((value) => value >= 101 && value <= 250).length,
				"251–500": values.filter((value) => value >= 251 && value <= 500).length,
				">500": values.filter((value) => value > 500).length,
			},
			files: { "0": files.length === 0 ? 0 : Number(sum === 0) },
		},
		topFunctions: [...functions].sort((a, b) => b.canonicalTokens - a.canonicalTokens),
		topFiles: files,
		functions,
		files,
		notMeasured: [],
	};
}

// --- helpers ------------------------------------------------------------
let logged = "";
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	logged = "";
	logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logged += `${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`;
	});
	// Sensible defaults; individual tests override.
	m.discoverFiles.mockReturnValue([]);
	m.computeCyclomaticAst.mockReturnValue([]);
	m.computeCyclomaticComplexity.mockReturnValue([]);
	m.computeFunctionTokens.mockReturnValue([]);
	m.buildFunctionTokenMetricsReport.mockReturnValue(tokenReport());
	m.realpathSync.mockImplementation((p) => String(p));
	m.loadCoverageFinal.mockReturnValue(null);
	m.coverageForFile.mockReturnValue(undefined);
	m.loadCoverageSummary.mockReturnValue(null);
	m.loadLcovFile.mockReturnValue(null);
	m.canonicalToCoverageSummary.mockReturnValue({});
	m.perFileCoverageFromCanonical.mockImplementation((_cf, rel) => ({
		filePath: rel,
		mtime: 1000,
		functions: [],
	}));
	m.astComplexityAvailable.mockReturnValue(true);
	m.computeCrapForFile.mockReturnValue([]);
	m.companionTestCandidates.mockReturnValue([]);
	m.isTddExemptPath.mockReturnValue(false);
	m.readFileSync.mockReturnValue("// content\n");
	m.statSync.mockReturnValue({ mtimeMs: 1000 });
	m.existsSync.mockReturnValue(false);
});
afterEach(() => {
	logSpy.mockRestore();
});

/** Discover returns absolute paths; metrics.ts relativizes against cwd. */
const CWD = "/repo";
function abs(rel: string): string {
	return `${CWD}/${rel}`;
}
function comp(over: Partial<FunctionComplexityEntry> = {}): FunctionComplexityEntry {
	return { name: "fn", line: 1, endLine: 2, cyclomatic: 5, language: "js_ts", ...over };
}
function crap(over: Partial<CrapFinding> = {}): CrapFinding {
	return {
		file: "src/a.ts",
		function: "fn",
		line: 1,
		complexity: 5,
		coverage_pct: 80,
		crap_score: 10,
		stale: false,
		...over,
	};
}
function perFile(rel: string): PerFileCoverage {
	return { filePath: rel, mtime: 1000, functions: [] };
}

interface JsonReport {
	scope: {
		files: number;
		functions: number;
		coverageAvailable: boolean;
		coverageSource: "istanbul" | "lcov" | null;
		astComplexityAvailable: boolean;
	};
	gates: {
		functionsOverCrap: number;
		functionsCyclomaticReview: number;
		functionsCyclomaticBad: number;
		filesMissingCompanion: number;
		filesNoCoverage: number;
		functionsOverTokenCap?: number;
	};
	distributions: {
		cyclomatic: Record<string, number>;
		crap: Record<string, number>;
		functionTokens?: Record<string, number>;
	};
	hotspots: Array<{ file: string; name: string; crap: number | null; cyclomatic: number }>;
	tokenHotspots?: Array<{ file: string; name: string; canonicalTokens?: number | null }>;
	functionTokenMetrics?: FunctionTokenMetricsReport;
	missingCompanion: string[];
	files: Array<{
		file: string;
		functions: number;
		linePct: number | null;
		maxCyclomatic: number;
		maxCrap: number | null;
		companion: boolean | null;
		overGate: number;
	}>;
}
function lastJson(): JsonReport {
	return JSON.parse(logged) as JsonReport;
}

describe("metricsCommand — file selection (isAnalyzableSource)", () => {
	it("keeps analyzable source languages under src/ and drops every excluded shape", async () => {
		m.discoverFiles.mockReturnValue([
			abs("src/keep.ts"),
			abs("src/keep.tsx"),
			abs("src/keep.js"), // JS is analyzable
			abs("src/keep.py"), // Python is analyzable
			abs("lib/outside.ts"), // not under src/, not covered → dropped
			abs("src/notes.md"), // not a source language
			abs("src/types.d.ts"), // declaration
			abs("src/a.test.ts"), // test
			abs("src/a.spec.tsx"), // spec
			abs("src/__tests__/t.ts"), // tests dir
			abs("src/__fixtures__/f.ts"), // fixtures dir
		]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.files.map((f) => f.file)).toEqual([
			"src/keep.js",
			"src/keep.py",
			"src/keep.ts",
			"src/keep.tsx",
		]);
		expect(r.scope.files).toBe(4);
	});

	it("includes a non-src file that appears in the coverage report (F4 multi-language)", async () => {
		// A Python package outside src/ — admitted because LCOV reports it.
		m.loadLcovFile.mockReturnValue({
			files: new Map([["pkg/calc.py", {} as never]]),
			source: "lcov",
		} as unknown as CanonicalCoverage);
		m.discoverFiles.mockReturnValue([abs("pkg/calc.py"), abs("scripts/build.ts")]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		// calc.py admitted via the coverage fileSet; build.ts (not src/, not covered) dropped.
		expect(r.files.map((f) => f.file)).toEqual(["pkg/calc.py"]);
		expect(r.scope.coverageSource).toBe("lcov");
	});

	it("reports an empty scope when nothing is analyzable", async () => {
		m.discoverFiles.mockReturnValue([abs("src/a.test.ts"), abs("docs/x.md")]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.scope).toEqual({
			files: 0,
			functions: 0,
			coverageAvailable: false,
			coverageSource: null,
			astComplexityAvailable: true,
		});
		expect(r.hotspots).toEqual([]);
		expect(r.distributions.cyclomatic).toEqual({
			"≤5": 0,
			"5–10": 0,
			"10–15": 0,
			"15–25": 0,
			">25": 0,
		});
	});
});

describe("metricsCommand — canonical function-token metrics", () => {
	it("reports exact stable buckets and hotspots independently of complexity inventory", async () => {
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
		m.computeCyclomaticAst.mockReturnValue([]);
		m.buildFunctionTokenMetricsReport.mockReturnValue(tokenReport([
			{ name: "tiny", line: 1, tokens: 100 },
			{ name: "review", line: 10, tokens: 250 },
			{ name: "large", line: 20, tokens: 500 },
			{ name: "over", line: 30, tokens: 501 },
		]));
		await metricsCommand({ cwd: CWD, json: true });
		const report = lastJson();
		expect(report.distributions.functionTokens).toEqual({
			"≤100": 1,
			"101–250": 1,
			"251–500": 1,
			">500": 1,
		});
		expect(report.gates.functionsOverTokenCap).toBe(1);
		expect(report.tokenHotspots?.map((item) => item.name)).toEqual(["over", "large", "review", "tiny"]);
		expect(report.functionTokenMetrics?.functions).toHaveLength(4);
	});

	it("uses the enforced product-function denominator when advisory tests are included", async () => {
		const report = tokenReport([{ name: "over", line: 1, tokens: 501 }]);
		report.scope = {
			...report.scope,
			includeTests: true,
			functionCount: 2,
			productFunctions: 1,
			testFunctions: 1,
		};
		m.buildFunctionTokenMetricsReport.mockReturnValue(report);

		await metricsCommand({ cwd: CWD, includeTests: true, short: true });
		expect(logged).toContain("fn-tokens>500: 1/1 measured");

		logged = "";
		await metricsCommand({ cwd: CWD, includeTests: true });
		// The gate row colors the count on a color-capable terminal; assert on the
		// text, not on whether this shell had NO_COLOR/CI set.
		expect(logged.replace(/\x1b\[[0-9;]*m/g, "")).toContain("1 / 1 measured functions");
	});
});

describe("metricsCommand — no coverage (fail-open)", () => {
	it("uses AST complexity, marks coverage absent, classifies cyclomatic gates", async () => {
		m.discoverFiles.mockReturnValue([abs("src/a.ts"), abs("src/b.ts"), abs("src/c.ts")]);
		// a: review band (16..25), b: bad (>25), c: ok (<=15)
		m.computeCyclomaticAst.mockImplementation((_c, p) => {
			if (p.endsWith("a.ts")) return [comp({ name: "review", cyclomatic: 20 })];
			if (p.endsWith("b.ts")) return [comp({ name: "bad", cyclomatic: 30 })];
			return [comp({ name: "ok", cyclomatic: 4 })];
		});
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.scope.coverageAvailable).toBe(false);
		expect(r.scope.functions).toBe(3);
		expect(r.gates.functionsCyclomaticReview).toBe(1);
		expect(r.gates.functionsCyclomaticBad).toBe(1);
		// No coverage → CRAP unavailable everywhere.
		expect(r.gates.functionsOverCrap).toBe(0);
		expect(r.hotspots).toEqual([]);
		expect(r.files.every((f) => f.linePct === null && f.maxCrap === null)).toBe(true);
		expect(m.computeCrapForFile).not.toHaveBeenCalled();
		// loadCoverageFinal returned null → coverageForFile never consulted.
		expect(m.coverageForFile).not.toHaveBeenCalled();
	});

	it("falls back to the guarded walker when the AST pass returns null", async () => {
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
		m.computeCyclomaticAst.mockReturnValue(null); // typescript unavailable path
		m.computeCyclomaticComplexity.mockReturnValue([comp({ name: "walked", cyclomatic: 7 })]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(m.computeCyclomaticComplexity).toHaveBeenCalledOnce();
		expect(r.scope.functions).toBe(1);
		expect(r.distributions.cyclomatic["5–10"]).toBe(1);
	});

	it("skips a file whose content cannot be read", async () => {
		m.discoverFiles.mockReturnValue([abs("src/good.ts"), abs("src/bad.ts")]);
		m.readFileSync.mockImplementation((p: unknown) => {
			if (String(p).endsWith("bad.ts")) throw new Error("EACCES");
			return "ok\n";
		});
		m.computeCyclomaticAst.mockReturnValue([comp()]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.files.map((f) => f.file)).toEqual(["src/good.ts"]);
		expect(r.scope.functions).toBe(1);
	});
});

describe("metricsCommand — companion presence (TDD gate)", () => {
	it("marks exempt files null, present files true, missing files false", async () => {
		m.discoverFiles.mockReturnValue([
			abs("src/exempt.ts"),
			abs("src/has-test.ts"),
			abs("src/no-test.ts"),
		]);
		m.computeCyclomaticAst.mockReturnValue([comp()]);
		m.isTddExemptPath.mockImplementation((p) => p === "src/exempt.ts");
		m.companionTestCandidates.mockImplementation((a) => [`${a}.candidate`]);
		// existsSync true only for the has-test candidate.
		m.existsSync.mockImplementation((p: unknown) => String(p).includes("has-test"));
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		const byFile = Object.fromEntries(r.files.map((f) => [f.file, f.companion]));
		expect(byFile["src/exempt.ts"]).toBeNull();
		expect(byFile["src/has-test.ts"]).toBe(true);
		expect(byFile["src/no-test.ts"]).toBe(false);
		expect(r.missingCompanion).toEqual(["src/no-test.ts"]);
		expect(r.gates.filesMissingCompanion).toBe(1);
	});
});

describe("metricsCommand — coverage present (CRAP path)", () => {
	function withCoverage(): void {
		m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
		m.loadCoverageSummary.mockReturnValue({
			total: { lines: { pct: 0 }, branches: { pct: 0 } },
			"/repo/src/a.ts": { lines: { pct: 91.5 }, branches: { pct: 80 } },
		});
		m.computeCyclomaticAst.mockReturnValue([comp({ cyclomatic: 12 })]);
	}

	it("computes CRAP, hotspots, gate counts, per-file linePct, and overGate", async () => {
		withCoverage();
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
		m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
		// Scores are joined back onto the complexity entries by name:line, so the
		// AST mock must declare the same two functions the CRAP mock scores.
		m.computeCyclomaticAst.mockReturnValue([
			comp({ name: "lo", line: 1, cyclomatic: 5 }),
			comp({ name: "hi", line: 20, cyclomatic: 12 }),
		]);
		m.computeCrapForFile.mockReturnValue([
			crap({ function: "lo", line: 1, crap_score: 12, coverage_pct: 90 }),
			crap({ function: "hi", line: 20, crap_score: 45, coverage_pct: 10, complexity: 12 }),
		]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.scope.coverageAvailable).toBe(true);
		expect(r.gates.functionsOverCrap).toBe(1); // only the 45 is >= 30
		expect(r.gates.filesNoCoverage).toBe(0);
		// hotspots sorted desc by crap.
		expect(r.hotspots.map((h) => h.name)).toEqual(["hi", "lo"]);
		const file = r.files[0];
		expect(nonNull(file).linePct).toBe(91.5);
		expect(nonNull(file).maxCrap).toBe(45);
		expect(nonNull(file).maxCyclomatic).toBe(12);
		expect(nonNull(file).overGate).toBe(1);
		// CRAP distribution buckets the two scores: 12 ≤30, 45 in 30–60.
		expect(r.distributions.crap["10–30"]).toBe(1);
		expect(r.distributions.crap["30–60"]).toBe(1);
	});

	it("counts files with no per-file coverage entry (filesNoCoverage)", async () => {
		withCoverage();
		m.discoverFiles.mockReturnValue([abs("src/a.ts"), abs("src/uncovered.ts")]);
		m.coverageForFile.mockImplementation((_c, rel) =>
			rel === "src/a.ts" ? perFile("src/a.ts") : undefined,
		);
		m.computeCrapForFile.mockReturnValue([crap()]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.gates.filesNoCoverage).toBe(1);
		// uncovered.ts falls back to the complexity-only mapping (crap null).
		const uncovered = r.files.find((f) => f.file === "src/uncovered.ts");
		expect(uncovered?.maxCrap).toBeNull();
		expect(uncovered?.overGate).toBe(0);
	});

	it("handles CRAP findings carrying a zero score via the ?? fallbacks", async () => {
		withCoverage();
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
		m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
		m.computeCrapForFile.mockReturnValue([crap({ crap_score: 0, coverage_pct: 100 })]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(nonNull(r.files[0]).maxCrap).toBe(0);
		expect(r.gates.functionsOverCrap).toBe(0);
		// crap !== null so it IS a hotspot, with crap 0.
		expect(r.hotspots).toHaveLength(1);
		expect(nonNull(r.hotspots[0]).crap).toBe(0);
	});
});

describe("metricsCommand — linePctFor branches", () => {
	function singleCoveredFile(): void {
		m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
		m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
		m.computeCyclomaticAst.mockReturnValue([comp()]);
		m.computeCrapForFile.mockReturnValue([crap()]);
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
	}

	it("matches an exact repo-relative summary key (no leading slash)", async () => {
		singleCoveredFile();
		// Exact-key match (key === rel) plus an undefined entry that is skipped.
		m.loadCoverageSummary.mockReturnValue({
			total: undefined, // entry === undefined → skipped
			"src/a.ts": { lines: { pct: 77 }, branches: { pct: 0 } },
		});
		await metricsCommand({ cwd: CWD, json: true });
		expect(nonNull(lastJson().files[0]).linePct).toBe(77);
	});

	it("returns null linePct when the matched summary pct is not a number", async () => {
		singleCoveredFile();
		m.loadCoverageSummary.mockReturnValue({
			// An ABSOLUTE in-repo key normalizes to src/a.ts (exact match), but the
			// pct is non-numeric → null branch.
			"/repo/src/a.ts": { lines: { pct: "x" as unknown as number }, branches: { pct: 0 } },
		});
		await metricsCommand({ cwd: CWD, json: true });
		expect(nonNull(lastJson().files[0]).linePct).toBeNull();
	});

	it("does NOT attribute another file's coverage by path TAIL (monorepo collision, finding 2026-06)", async () => {
		singleCoveredFile();
		m.loadCoverageSummary.mockReturnValue({
			// The packages/ file shares the `/src/a.ts` tail — the old suffix match
			// could hand its 11% to the root src/a.ts depending on iteration order.
			"/repo/packages/x/src/a.ts": { lines: { pct: 11 }, branches: { pct: 0 } },
			"/repo/src/a.ts": { lines: { pct: 88 }, branches: { pct: 0 } },
		});
		await metricsCommand({ cwd: CWD, json: true });
		expect(nonNull(lastJson().files[0]).linePct).toBe(88);
	});

	it("drops a summary key OUTSIDE the repo even when its tail matches", async () => {
		singleCoveredFile();
		m.loadCoverageSummary.mockReturnValue({
			"/elsewhere/src/a.ts": { lines: { pct: 11 }, branches: { pct: 0 } },
		});
		await metricsCommand({ cwd: CWD, json: true });
		expect(nonNull(lastJson().files[0]).linePct).toBeNull();
	});

	it("returns null linePct when no summary key matches the file", async () => {
		singleCoveredFile();
		m.loadCoverageSummary.mockReturnValue({
			"src/other.ts": { lines: { pct: 50 }, branches: { pct: 0 } },
		});
		await metricsCommand({ cwd: CWD, json: true });
		expect(nonNull(lastJson().files[0]).linePct).toBeNull();
	});

	it("returns null linePct when the summary itself is absent", async () => {
		singleCoveredFile();
		m.loadCoverageSummary.mockReturnValue(null);
		await metricsCommand({ cwd: CWD, json: true });
		expect(nonNull(lastJson().files[0]).linePct).toBeNull();
	});
});

describe("metricsCommand — output modes", () => {
	beforeEach(() => {
		m.discoverFiles.mockReturnValue([abs("src/a.ts"), abs("src/b.ts")]);
		m.computeCyclomaticAst.mockImplementation((_c, p) =>
			p.endsWith("b.ts") ? [comp({ name: "bad", cyclomatic: 30 })] : [comp({ name: "ok" })],
		);
		m.isTddExemptPath.mockReturnValue(false);
		m.companionTestCandidates.mockReturnValue(["/x"]);
		m.existsSync.mockReturnValue(false); // both missing companions
	});

	it("normal mode renders the header, gates, distribution, and missing list (no coverage)", async () => {
		await metricsCommand({ cwd: CWD });
		expect(logged).toContain("Test-Quality Metrics");
		expect(logged).toContain("Source files");
		expect(logged).toContain("absent (CRAP/coverage unavailable");
		expect(logged).toContain("Gates");
		expect(logged).toContain("CRAP ≥ 30");
		expect(logged).toContain("cyclomatic > 25");
		expect(logged).toContain("CRAP distribution");
		expect(logged).toContain("Function-token distribution (interlinked-code-v1)");
		expect(logged).toContain("summedFunctionTokens=");
		expect(logged).toContain("files by summed function tokens");
		// no coverage → "files no coverage" line is suppressed.
		expect(logged).not.toContain("files no coverage");
		// no coverage → empty hotspots placeholder line.
		expect(logged).toContain("(no coverage data — CRAP unavailable)");
		expect(logged).toContain("Files missing a companion test (2)");
		expect(logged).toContain("src/a.ts");
		expect(logged).toContain("src/b.ts");
		// gateStr: nonzero counts rendered; ✗ marker on each missing companion.
		expect(logged).toContain("✗");
	});

	it("normal mode shows the coverage line, hotspots, and files-no-coverage when present", async () => {
		m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
		m.coverageForFile.mockImplementation((_c, rel) =>
			rel === "src/a.ts" ? perFile("src/a.ts") : undefined,
		);
		m.computeCyclomaticAst.mockReturnValue([comp({ name: "hot", line: 1 })]);
		m.computeCrapForFile.mockReturnValue([
			crap({ function: "hot", line: 1, crap_score: 50, coverage_pct: 5 }),
		]);
		m.loadCoverageSummary.mockReturnValue({
			"src/a.ts": { lines: { pct: 40 }, branches: { pct: 0 } },
		});
		m.isTddExemptPath.mockReturnValue(true); // suppress missing-companion section
		await metricsCommand({ cwd: CWD });
		expect(logged).toContain("present");
		expect(logged).toContain("files no coverage");
		// hotspot row formatting: rounded crap, cyc, cov%.
		expect(logged).toContain("hot");
		expect(logged).toContain("cov=  5%");
		expect(logged).not.toContain("Files missing a companion test");
	});

	it("normal mode splits the missing-companion list by coverage when data is present", async () => {
		// P: coverage available → the section header carries the under/covered
		// split and each row carries its line%. src/a.ts is covered (90% ≥ the
		// 60% default), src/b.ts has no summary entry → counts as under.
		m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
		m.loadCoverageSummary.mockReturnValue({
			"src/a.ts": { lines: { pct: 90 }, branches: { pct: 80 } },
		});
		await metricsCommand({ cwd: CWD });
		expect(logged).toContain("Files missing a companion test (2: 1 under 60% lines, 1 covered via other tests)");
		expect(logged).toContain("covered elsewhere (≥60% lines):");
		expect(logged).toContain("(90% lines)");
		expect(logged).toContain("(no coverage data)");
	});

	it("short mode emits the one-line summary including (no coverage)", async () => {
		await metricsCommand({ cwd: CWD, short: true });
		expect(logged).toContain("2 files");
		expect(logged).toContain("2 fns");
		expect(logged).toContain("CRAP≥30: 0");
		expect(logged).toContain("cyc>25: 1");
		expect(logged).toContain("no-companion: 2");
		expect(logged).toContain("(no coverage)");
		expect(logged).toMatch(/\n$/);
	});

	it("short mode drops the (no coverage) suffix when coverage is present", async () => {
		m.loadCoverageFinal.mockReturnValue(new Map());
		await metricsCommand({ cwd: CWD, short: true });
		expect(logged).toContain("2 files");
		expect(logged).not.toContain("(no coverage)");
	});

	it("full mode adds the exhaustive function-token inventory", async () => {
		await metricsCommand({ cwd: CWD, full: true });
		expect(logged).toContain("Test-Quality Metrics");
		expect(logged).toContain("All per-file function-token totals");
		expect(logged).toContain("All functions by file and line");
	});

	it("json mode emits pretty-printed JSON", async () => {
		await metricsCommand({ cwd: CWD, json: true });
		expect(logged).toContain('"scope"');
		expect(logged).toContain('"functionTokenMetrics"');
		expect(logged).toContain("\n  "); // 2-space indentation from JSON.stringify
		expect(() => lastJson()).not.toThrow();
	});
});

describe("metricsCommand — missing-companion truncation", () => {
	it("lists the first 25 and a '… and N more' line past the cap", async () => {
		const files = Array.from({ length: 30 }, (_, i) => abs(`src/f${i}.ts`));
		m.discoverFiles.mockReturnValue(files);
		m.computeCyclomaticAst.mockReturnValue([comp()]);
		m.isTddExemptPath.mockReturnValue(false);
		m.companionTestCandidates.mockReturnValue(["/x"]);
		m.existsSync.mockReturnValue(false);
		await metricsCommand({ cwd: CWD });
		expect(logged).toContain("Files missing a companion test (30)");
		expect(logged).toContain("… and 5 more");
	});
});

describe("metricsCommand — topN clamping", () => {
	function manyHot(count: number): void {
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
		m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
		m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
		// Each scored function needs a matching complexity entry — the report
		// joins the two by name:line and drops scores it cannot attribute.
		m.computeCyclomaticAst.mockReturnValue(
			Array.from({ length: count }, (_, i) => comp({ name: `f${i}`, line: i + 1 })),
		);
		m.computeCrapForFile.mockReturnValue(
			Array.from({ length: count }, (_, i) =>
				crap({ function: `f${i}`, line: i + 1, crap_score: i + 1 }),
			),
		);
	}

	it("respects an explicit --top value", async () => {
		manyHot(10);
		await metricsCommand({ cwd: CWD, json: true, top: "3" });
		expect(lastJson().hotspots).toHaveLength(3);
	});

	it("defaults to 25 when --top is omitted", async () => {
		manyHot(10);
		await metricsCommand({ cwd: CWD, json: true });
		expect(lastJson().hotspots).toHaveLength(10); // all 10, under the 25 default
	});

	it("falls back to 25 when --top is non-numeric", async () => {
		manyHot(10);
		await metricsCommand({ cwd: CWD, json: true, top: "abc" });
		expect(lastJson().hotspots).toHaveLength(10);
	});

	it("clamps a negative --top up to 1", async () => {
		// parseInt("-5") is truthy → bypasses the `|| 25` default and exercises
		// the Math.max(1, …) lower clamp.
		manyHot(10);
		await metricsCommand({ cwd: CWD, json: true, top: "-5" });
		expect(lastJson().hotspots).toHaveLength(1);
	});

	it("clamps --top above 200 down to 200", async () => {
		manyHot(250);
		await metricsCommand({ cwd: CWD, json: true, top: "999" });
		expect(lastJson().hotspots).toHaveLength(200);
	});
});

describe("metricsCommand — cwd resolution default", () => {
	it("uses process.cwd() when no cwd is supplied", async () => {
		await metricsCommand({ json: true });
		expect(m.discoverFiles).toHaveBeenCalledWith(process.cwd());
		expect(lastJson().scope.files).toBe(0);
	});
});

describe("metricsCommand — LCOV coverage source (F4)", () => {
	function withLcov(): void {
		m.loadCoverageFinal.mockReturnValue(null); // istanbul absent → LCOV is the source
		m.loadLcovFile.mockReturnValue({
			files: new Map([["src/a.ts", {} as never]]),
			source: "lcov",
		} as unknown as CanonicalCoverage);
		m.canonicalToCoverageSummary.mockReturnValue({
			"src/a.ts": { lines: { pct: 60 }, branches: { pct: 0 } },
		});
		m.perFileCoverageFromCanonical.mockReturnValue(perFile("src/a.ts"));
		m.computeCyclomaticAst.mockReturnValue([comp({ cyclomatic: 12 })]);
		m.computeCrapForFile.mockReturnValue([
			crap({ crap_score: 40, coverage_pct: 20, complexity: 12 }),
		]);
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
	}

	it("reports coverage from the canonical LCOV spine when istanbul JSON is absent", async () => {
		withLcov();
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.scope.coverageAvailable).toBe(true);
		expect(r.scope.coverageSource).toBe("lcov");
		expect(m.perFileCoverageFromCanonical).toHaveBeenCalled();
		// CRAP is computed via the LCOV-derived per-function coverage.
		expect(nonNull(r.files[0]).maxCrap).toBe(40);
		expect(r.gates.functionsOverCrap).toBe(1);
		expect(nonNull(r.files[0]).linePct).toBe(60);
	});

	it("istanbul alone still reports source 'istanbul' (LCOV consulted but absent)", async () => {
		m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
		m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
		m.computeCyclomaticAst.mockReturnValue([comp()]);
		m.computeCrapForFile.mockReturnValue([crap()]);
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
		await metricsCommand({ cwd: CWD, json: true });
		expect(lastJson().scope.coverageSource).toBe("istanbul");
		// MERGE, not precedence (finding 2026-06): the LCOV loader is always
		// consulted now; with no lcov.info it simply contributes nothing.
		expect(m.loadLcovFile).toHaveBeenCalled();
	});

	it("MERGES istanbul with LCOV when both exist — the LCOV-only file is no longer dropped (finding 2026-06)", async () => {
		// istanbul covers the TS file; LCOV covers the Python file. The old
		// unconditional istanbul precedence discarded the LCOV report entirely,
		// so src/b.py lost its coverage (and the tested-file gate went blind to it).
		m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
		m.coverageForFile.mockImplementation((_c, rel) =>
			rel === "src/a.ts" ? perFile("src/a.ts") : undefined,
		);
		m.loadLcovFile.mockReturnValue({
			files: new Map([["src/b.py", {} as never]]),
		} as unknown as CanonicalCoverage);
		m.canonicalToCoverageSummary.mockReturnValue({
			"src/b.py": { lines: { pct: 70 }, branches: { pct: 0 } },
		});
		m.perFileCoverageFromCanonical.mockReturnValue(perFile("src/b.py"));
		m.computeCyclomaticAst.mockReturnValue([comp()]);
		m.computeCrapForFile.mockReturnValue([crap()]);
		m.discoverFiles.mockReturnValue([abs("src/a.ts"), abs("src/b.py")]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.scope.coverageSource).toBe("istanbul+lcov");
		const bPy = r.files.find((f: { file: string }) => f.file === "src/b.py");
		expect(bPy?.linePct).toBe(70); // served by the LCOV side of the merge
		expect(r.files.some((f: { file: string }) => f.file === "src/a.ts")).toBe(true);
	});

	it("surfaces the regex-fallback warning when the AST pass is unavailable", async () => {
		m.astComplexityAvailable.mockReturnValue(false);
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
		m.computeCyclomaticAst.mockReturnValue(null);
		m.computeCyclomaticComplexity.mockReturnValue([comp()]);
		await metricsCommand({ cwd: CWD });
		expect(logged).toContain("regex fallback");
		logged = "";
		await metricsCommand({ cwd: CWD, json: true });
		expect(lastJson().scope.astComplexityAvailable).toBe(false);
	});
});

	describe("metricsCommand — mutation-targeted regression cases", () => {
		it("does not treat a declaration-lookalike extension as a .d.ts file (anchor on $)", async () => {
			// "component.d.tsx" contains the substring ".d.ts" but is NOT a .d.ts
			// declaration file — it's a real .tsx source. An unanchored /\\.d\\.ts/
			// regex would wrongly exclude it.
			m.discoverFiles.mockReturnValue([abs("src/component.d.tsx")]);
			m.computeCyclomaticAst.mockReturnValue([comp()]);
			await metricsCommand({ cwd: CWD, json: true });
			expect(lastJson().files.map((f) => f.file)).toEqual(["src/component.d.tsx"]);
		});

		it("excludes a tests/ dir at the START of a repo-relative path (no leading slash to match)", async () => {
			// A covered non-src Python file living directly under "tests/" (no
			// leading "/" — it's the START of the relative path string) must still
			// be excluded. A regex requiring a literal preceding "/" before the
			// tests-dir segment would miss this exact case.
			m.loadLcovFile.mockReturnValue({
				files: new Map([["tests/x.py", {} as never]]),
				source: "lcov",
			} as unknown as CanonicalCoverage);
			m.discoverFiles.mockReturnValue([abs("tests/x.py")]);
			await metricsCommand({ cwd: CWD, json: true });
			expect(lastJson().files.map((f) => f.file)).toEqual([]);
		});

		it("returns null (not a throw) when a matched summary entry has no lines field", async () => {
			m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
			m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
			m.computeCyclomaticAst.mockReturnValue([comp()]);
			m.computeCrapForFile.mockReturnValue([crap()]);
			m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
			// `lines` entirely absent — the optional-chain `entry.lines?.pct` must
			// short-circuit to undefined (→ null) rather than throwing on `.pct`.
			m.loadCoverageSummary.mockReturnValue({
				"src/a.ts": { branches: { pct: 0 } } as unknown as CoverageSummary[string],
			});
			await expect(metricsCommand({ cwd: CWD, json: true })).resolves.not.toThrow();
			expect(nonNull(lastJson().files[0]).linePct).toBeNull();
		});

		it("drops a summary entry keyed by the empty string (rel === '')", async () => {
			m.loadCoverageFinal.mockReturnValue(new Map());
			m.loadCoverageSummary.mockReturnValue({
				"": { lines: { pct: 42 }, branches: { pct: 0 } },
			});
			const cov = loadMetricsCoverage(CWD);
			expect(cov.linePct("")).toBeNull();
		});

		it("drops an out-of-repo summary key even when its relative path doesn't END with '..'", async () => {
			m.loadCoverageFinal.mockReturnValue(new Map());
			m.loadCoverageSummary.mockReturnValue({
				"/elsewhere/src/a.ts": { lines: { pct: 11 }, branches: { pct: 0 } },
			});
			const cov = loadMetricsCoverage(CWD);
			// The raw relative-path key ("../elsewhere/src/a.ts") must never surface —
			// this pins the *whole* out-of-repo guard, not just the queried alias.
			expect(cov.linePct("../elsewhere/src/a.ts")).toBeNull();
			expect(cov.linePct("elsewhere/src/a.ts")).toBeNull();
		});

		it("normalizes a literal backslash in a summary key to a forward slash", async () => {
			m.loadCoverageFinal.mockReturnValue(new Map());
			m.loadCoverageSummary.mockReturnValue({
				"src\\weird.ts": { lines: { pct: 55 }, branches: { pct: 0 } },
			});
			const cov = loadMetricsCoverage(CWD);
			expect(cov.linePct("src/weird.ts")).toBe(55);
		});

		it("calls loadLcovFile with the cwd option so relative fixture paths resolve", async () => {
			m.loadCoverageFinal.mockReturnValue(null);
			m.loadLcovFile.mockReturnValue(null);
			m.discoverFiles.mockReturnValue([]);
			await metricsCommand({ cwd: CWD, json: true });
			expect(m.loadLcovFile).toHaveBeenCalledWith(`${CWD}/coverage/lcov.info`, { cwd: CWD });
		});

		it("normalizes a backslash in a discovered file path before matching the src/ prefix", async () => {
			// discoverFiles returning a Windows-style separator must still land as
			// "src/weird.ts" (in scope) — a broken normalizer would turn it into
			// "srcweird.ts" and silently drop the file (fails the src/ prefix check).
			m.discoverFiles.mockReturnValue([`${CWD}/src\\weird.ts`]);
			m.computeCyclomaticAst.mockReturnValue([comp()]);
			await metricsCommand({ cwd: CWD, json: true });
			expect(lastJson().files.map((f) => f.file)).toEqual(["src/weird.ts"]);
		});

		it("passes computeCrapForFile the exact scoring arguments (filePath/threshold/staleTolerance)", async () => {
			m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
			m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
			const comps = [comp({ name: "fn", line: 1 })];
			m.computeCyclomaticAst.mockReturnValue(comps);
			m.computeCrapForFile.mockReturnValue([crap()]);
			m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
			await metricsCommand({ cwd: CWD, json: true });
			expect(m.computeCrapForFile).toHaveBeenCalledWith({
				complexities: comps,
				perFile: perFile("src/a.ts"),
				filePath: "src/a.ts",
				fileMtime: 1000,
				threshold: 0,
				staleTolerance: "include",
			});
		});

		it("marks companion present when only SOME of multiple candidates exist (uses .some, not .every)", async () => {
			m.discoverFiles.mockReturnValue([abs("src/multi.ts")]);
			m.computeCyclomaticAst.mockReturnValue([comp()]);
			m.isTddExemptPath.mockReturnValue(false);
			m.companionTestCandidates.mockReturnValue(["/repo/multi.test.ts", "/repo/multi.spec.ts"]);
			// Only ONE of the two candidates exists.
			m.existsSync.mockImplementation((p: unknown) => String(p).endsWith("multi.test.ts"));
			await metricsCommand({ cwd: CWD, json: true });
			const file = lastJson().files.find((f) => f.file === "src/multi.ts");
			expect(file?.companion).toBe(true);
		});

		it("counts a function whose crap score sits exactly ON the gate as over-gate (>= not >)", async () => {
			m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
			m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
			m.computeCyclomaticAst.mockReturnValue([comp({ name: "fn", line: 1 })]);
			// Default crap_threshold is 30 (no .interlinked/metric-caps.json in the mock fs).
			m.computeCrapForFile.mockReturnValue([crap({ function: "fn", line: 1, crap_score: 30 })]);
			m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
			await metricsCommand({ cwd: CWD, json: true });
			const r = lastJson();
			expect(r.gates.functionsOverCrap).toBe(1);
			expect(nonNull(r.files[0]).overGate).toBe(1);
		});

		it("classifies the cyclomatic review/bad bands at their exact boundaries", async () => {
			m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
			// review band = (15, 25]; bad = (25, ∞). 15 is the exclusive lower bound
			// (must NOT count as review); 25 is the inclusive upper bound of review
			// (must count as review, must NOT count as bad).
			m.computeCyclomaticAst.mockReturnValue([
				comp({ name: "atLower", line: 1, cyclomatic: 15 }),
				comp({ name: "atUpper", line: 2, cyclomatic: 25 }),
			]);
			await metricsCommand({ cwd: CWD, json: true });
			const r = lastJson();
			expect(r.gates.functionsCyclomaticReview).toBe(1); // only atUpper (25)
			expect(r.gates.functionsCyclomaticBad).toBe(0); // 25 is not > 25
		});

		it("pins the exact cyclomatic distribution buckets at every boundary value", async () => {
			m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
			// bounds [5, 10, 15, 25]; values chosen exactly on each boundary plus one
			// below the first and one above the last, so every filter predicate
			// (both the `> lo` and `<= b` sides, and the tail `> lo`) is exercised at
			// its exact edge in both directions.
			m.computeCyclomaticAst.mockReturnValue(
				[4, 5, 10, 15, 25, 26].map((cyclomatic, i) =>
					comp({ name: `f${i}`, line: i + 1, cyclomatic }),
				),
			);
			await metricsCommand({ cwd: CWD, json: true });
			expect(lastJson().distributions.cyclomatic).toEqual({
				"≤5": 2,
				"5–10": 1,
				"10–15": 1,
				"15–25": 1,
				">25": 1,
			});
		});

		it("excludes null-crap functions from the CRAP distribution and over-gate count", async () => {
			m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
			m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
			m.computeCyclomaticAst.mockReturnValue([
				comp({ name: "scored", line: 1 }),
				comp({ name: "unscored", line: 2 }),
			]);
			// computeCrapForFile only reports "scored" — "unscored" has no CRAP entry
			// and must end up with crap: null, excluded from the numeric distribution.
			m.computeCrapForFile.mockReturnValue([crap({ function: "scored", line: 1, crap_score: 12 })]);
			m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
			await metricsCommand({ cwd: CWD, json: true });
			const r = lastJson();
			expect(r.distributions.crap).toEqual({
				"≤10": 0,
				"10–30": 1,
				"30–60": 0,
				"60–100": 0,
				">100": 0,
			});
			expect(r.gates.functionsOverCrap).toBe(0);
		});

		it("sorts hotspots strictly descending by crap score (distinct nonzero scores stay ordered)", async () => {
			m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
			m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
			// Insertion order is deliberately NOT already crap-ascending (mid, low,
			// high) — a broken comparator (e.g. one that drops the `b` operand via
			// `b.crap && 0` instead of `b.crap ?? 0`) sorts correctly by coincidence
			// on an already-ascending input but diverges on this permutation.
			m.computeCyclomaticAst.mockReturnValue([
				comp({ name: "mid", line: 2 }),
				comp({ name: "low", line: 1 }),
				comp({ name: "high", line: 3 }),
			]);
			m.computeCrapForFile.mockReturnValue([
				crap({ function: "mid", line: 2, crap_score: 40 }),
				crap({ function: "low", line: 1, crap_score: 5 }),
				crap({ function: "high", line: 3, crap_score: 90 }),
			]);
			m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
			await metricsCommand({ cwd: CWD, json: true });
			expect(lastJson().hotspots.map((h) => h.name)).toEqual(["high", "mid", "low"]);
		});

		it("dispatches every JS/TS-family extension to the AST pass, not the regex walker", async () => {
			const exts = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
			for (const ext of exts) {
				m.computeCyclomaticAst.mockClear();
				m.computeCyclomaticComplexity.mockClear();
				m.computeCyclomaticAst.mockReturnValue([comp()]);
				cyclomaticForMetrics("// content", `/repo/src/file${ext}`);
				expect(m.computeCyclomaticAst).toHaveBeenCalledOnce();
				expect(m.computeCyclomaticComplexity).not.toHaveBeenCalled();
			}
		});

		it("does not misclassify a .jsonnet file as an analyzable JS source (extension regex is anchored)", async () => {
			m.discoverFiles.mockReturnValue([abs("src/foo.jsonnet")]);
			await metricsCommand({ cwd: CWD, json: true });
			expect(lastJson().files.map((f) => f.file)).toEqual([]);
		});

		it("does not misclassify a *.test.js file as non-test (jsx? must still match bare 'js')", async () => {
			m.discoverFiles.mockReturnValue([abs("src/foo.test.js")]);
			await metricsCommand({ cwd: CWD, json: true });
			expect(lastJson().files.map((f) => f.file)).toEqual([]);
		});

		it("does not misclassify a non-test file whose name merely CONTAINS a test-extension substring", async () => {
			// "foo.test.js.ts" is a real .ts source (analyzable). An unanchored
			// TEST_EXT_RE would match the mid-string ".test.js" run and wrongly
			// treat it as a test file even though the string doesn't actually END
			// in ".test.<ext>".
			m.discoverFiles.mockReturnValue([abs("src/foo.test.js.ts")]);
			m.computeCyclomaticAst.mockReturnValue([comp()]);
			await metricsCommand({ cwd: CWD, json: true });
			expect(lastJson().files.map((f) => f.file)).toEqual(["src/foo.test.js.ts"]);
		});
	});
