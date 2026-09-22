import { parseWire, wireNumber, wireObject } from "../lib/value-validation.js";
// ===========================================
// metrics-complexity tests — report assembly, rendering, and the two commands
// ===========================================
// The report builder and renderers are exercised against the same pinned
// fixtures as the census core. The command entry points run end-to-end over a
// tmpdir: one test through a real `git init` (the default enumeration), the
// rest through an injected file list so the oracle is exact. Only console.log
// is mocked (to capture what the user would see).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_COGNITIVE } from "../harness/checks/cognitive-ast.js";
import {
	DEFAULT_MAX_COGNITIVE_CAP,
	DEFAULT_MAX_CYCLOMATIC,
	DEFAULT_MAX_LINES,
} from "../harness/metric-caps.js";
import { collectCensusRows } from "./metrics-complexity-census.js";
import {
	buildComplexityReport,
	capsProposeAction,
	DIRECTORY_MIN_FILES,
	metricsComplexityCommand,
	parseMetricSelection,
	renderCapProposals,
	renderComplexityReport,
	renderShortSummary,
} from "./metrics-complexity.js";

const SIMPLE = "export function one(a: number): number {\n\treturn a;\n}\n";
const BRANCHY = [
	"export function branchy(a: number): number {",
	"\tif (a > 1) {",
	"\t\tif (a > 2) {",
	"\t\t\treturn 2;",
	"\t\t}",
	"\t\treturn 1;",
	"\t}",
	"\tfor (let i = 0; i < a; i++) {",
	"\t\tif (i % 2 === 0 && i > 3) continue;",
	"\t}",
	"\treturn 0;",
	"}",
	"",
	"export const arrow = (x: number): number => (x > 0 ? x : -x);",
	"",
].join("\n");

const FIXTURE_ROWS = (() => {
	const rows = collectCensusRows(
		[
			{ file: "src/simple.ts", content: SIMPLE },
			{ file: "src/branchy.ts", content: BRANCHY },
		],
		"/repo",
	);
	if (rows === null) throw new Error("TS analyzer unavailable in the test environment");
	return rows;
})();

const TIGHT_CAPS = {
	cyclomatic: { value: 5, source: "metric-caps.json" },
	cognitive: { value: 6, source: "metric-caps.json" },
	lines: { value: 10, source: "default" },
};

describe("parseMetricSelection", () => {
	it("P1: 'all' and an absent flag select every metric in report order", () => {
		expect(parseMetricSelection(undefined)).toEqual(["cyclomatic", "cognitive", "lines"]);
		expect(parseMetricSelection("all")).toEqual(["cyclomatic", "cognitive", "lines"]);
	});

	it("P2: a single metric name selects just that metric", () => {
		expect(parseMetricSelection("cognitive")).toEqual(["cognitive"]);
	});

	it("N1: an unknown name yields null rather than a silent default", () => {
		expect(parseMetricSelection("halstead")).toBeNull();
	});
});

describe("buildComplexityReport", () => {
	it("P1: one section per selected metric with over-cap counts against the resolved caps", () => {
		const report = buildComplexityReport(FIXTURE_ROWS, TIGHT_CAPS, ["cyclomatic", "cognitive", "lines"], 20);
		expect(report.files).toBe(2);
		expect(report.functions).toBe(3);
		const [cyclo, cog, lines] = report.metrics;
		expect(cyclo?.over_cap).toBe(1);
		expect(cyclo?.distribution.n).toBe(3);
		expect(cyclo?.histogram.at(-1)).toEqual({ lo: 31, hi: null, count: 0 });
		expect(cyclo?.advisory).toBeNull();
		expect(cog?.over_cap).toBe(1);
		expect(cog?.advisory).toEqual({ threshold: DEFAULT_MAX_COGNITIVE, over: 0 });
		expect(lines?.over_cap).toBe(1);
		expect(lines?.top[0]).toEqual({ file: "src/branchy.ts", value: 15, pct: 50 });
	});

	it("P2: top-N is ranked by value and capped at --top", () => {
		const report = buildComplexityReport(FIXTURE_ROWS, TIGHT_CAPS, ["cyclomatic"], 1);
		// pct ranks within the run: branchy (6) is above 2 of 3 functions; its file's ΣCC is above 1 of 2 files.
		expect(report.metrics[0]?.top).toEqual([{ file: "src/branchy.ts", name: "branchy", line: 1, value: 6, pct: 67 }]);
		expect(report.files_by_mass[0]).toEqual({ file: "src/branchy.ts", cc: 8, cog: 8, fns: 2, density: 4, pct: 50 });
	});

	it("P4: hotspots multiply a file's ΣCC by its churn and rank among files with churn", () => {
		const churn = new Map([
			["src/branchy.ts", { lines: 10, commits: 2 }],
			["src/simple.ts", { lines: 100, commits: 5 }],
		]);
		const report = buildComplexityReport(FIXTURE_ROWS, TIGHT_CAPS, ["cyclomatic"], 20, { churn, churnDays: 30 });
		expect(report.churn_days).toBe(30);
		expect(report.hotspots).toEqual([
			{ file: "src/simple.ts", cc: 1, churn_lines: 100, commits: 5, score: 100, pct: 50 },
			{ file: "src/branchy.ts", cc: 8, churn_lines: 10, commits: 2, score: 80, pct: 0 },
		]);
	});

	it("N3: with no churn the hotspot list is empty and the window still defaults to 90 days", () => {
		const report = buildComplexityReport(FIXTURE_ROWS, TIGHT_CAPS, ["cyclomatic"], 20);
		expect(report.hotspots).toEqual([]);
		expect(report.churn_days).toBe(90);
	});

	it("N1: an unselected metric is absent from the report", () => {
		const report = buildComplexityReport(FIXTURE_ROWS, TIGHT_CAPS, ["lines"], 20);
		expect(report.metrics.map((m) => m.metric)).toEqual(["lines"]);
	});

	it("P3: directories with ≥ DIRECTORY_MIN_FILES files get a Gini row, capped at --top", () => {
		const rows = {
			...FIXTURE_ROWS,
			lines: [
				...FIXTURE_ROWS.lines,
				{ file: "src/third.ts", value: 300 },
				{ file: "lib/a.ts", value: 7 },
				{ file: "lib/b.ts", value: 7 },
				{ file: "lib/c.ts", value: 7 },
			],
		};
		const report = buildComplexityReport(rows, TIGHT_CAPS, ["lines"], 1);
		expect(DIRECTORY_MIN_FILES).toBe(3);
		// src/ holds 4 + 15 + 300 lines: G = 2·(4+30+900)/(3·319) − 4/3 = 0.6186
		expect(report.directories).toEqual([{ dir: "src", files: 3, lines: 319, gini: expect.closeTo(0.6186, 3) }]);
	});

	it("N2: a 2-file directory yields no spread row — the fixture's src/ is below the floor", () => {
		expect(buildComplexityReport(FIXTURE_ROWS, TIGHT_CAPS, ["lines"], 20).directories).toEqual([]);
	});
});

describe("renderComplexityReport", () => {
	it("P1: prints the census-style header, histogram, top-N with file:line, and per-file mass", () => {
		const text = renderComplexityReport(
			buildComplexityReport(FIXTURE_ROWS, TIGHT_CAPS, ["cyclomatic", "cognitive", "lines"], 20),
		);
		expect(text).toContain("== Cyclomatic per function — n=3 mean=3.0 p50=2 p75=6 p90=6 p95=6 p99=6 max=6 | >cap 5: 1");
		expect(text).toContain(">15 (advisory): 0");
		expect(text).toContain("src/branchy.ts:1  branchy");
		expect(text).toContain("== Top 20 lines per file");
		expect(text).toContain("== Top 20 files by cyclomatic mass (ΣCC / Σcognitive / fns / density)");
		expect(text).toContain("8 /    8 /   2 /  4.0  src/branchy.ts");
		expect(text).toMatch(/\n {5}0–1 {9}1\n/);
		expect(text).toMatch(/>30 {12}0\n/);
	});

	it("P2: the short summary carries n, over-cap per metric, and the caps", () => {
		const report = buildComplexityReport(FIXTURE_ROWS, TIGHT_CAPS, ["cyclomatic", "cognitive", "lines"], 20);
		expect(renderShortSummary(report)).toBe(
			"2 files, 3 functions; over cap: cyclomatic 1/3 (>5), cognitive 1/3 (>6), lines 1/2 (>10)",
		);
	});

	it("P3: the directory-spread section prints files / lines / gini per directory", () => {
		const rows = { ...FIXTURE_ROWS, lines: [...FIXTURE_ROWS.lines, { file: "src/third.ts", value: 300 }] };
		const text = renderComplexityReport(buildComplexityReport(rows, TIGHT_CAPS, ["lines"], 20));
		expect(text).toContain(
			"== Top 20 directories by line-count spread (files / lines / gini; ≥3 files, telemetry only)",
		);
		expect(text).toContain("    3 /    319 / 0.619  src");
	});

	it("N2: no directory reaches the floor → the spread section is omitted, not printed empty", () => {
		const text = renderComplexityReport(buildComplexityReport(FIXTURE_ROWS, TIGHT_CAPS, ["lines"], 20));
		expect(text).not.toContain("directories by line-count spread");
		expect(text).not.toContain("hotspots");
	});

	it("P4: the hotspot section prints score, rank, the ΣCC × lines product, and the window", () => {
		const churn = new Map([["src/branchy.ts", { lines: 10, commits: 2 }]]);
		const text = renderComplexityReport(
			buildComplexityReport(FIXTURE_ROWS, TIGHT_CAPS, ["cyclomatic"], 20, { churn, churnDays: 30 }),
		);
		expect(text).toContain("== Top 20 hotspots (ΣCC × lines changed in 30d; pct = rank among files with churn)");
		expect(text).toContain("       80   p0     8 ×    10 lines /   2 commits  src/branchy.ts");
		expect(text).toContain("  p50    8 /    8 /   2 /  4.0  src/branchy.ts");
		expect(text).toContain("6  p67  src/branchy.ts:1  branchy");
	});

	it("N1: rendering a report with no metrics selected still prints the totals line", () => {
		const text = renderComplexityReport(buildComplexityReport(FIXTURE_ROWS, TIGHT_CAPS, [], 20));
		expect(text).toContain("Complexity census — 2 files, 3 functions");
		expect(text).not.toContain("== ");
	});
});

describe("renderCapProposals", () => {
	it("P1: prints p90/p95 per metric, the current cap, and says nothing was written", () => {
		const text = renderCapProposals(FIXTURE_ROWS, TIGHT_CAPS);
		expect(text).toContain("cyclomatic");
		expect(text).toContain("nothing written");
		expect(text).toContain("interlinked caps set");
		expect(text).toMatch(/cyclomatic\s+3\s+6\s+6\s+5 \[metric-caps\.json\]/);
	});
});

// ---- command entry points --------------------------------------------------

const AMBIENT_GIT_ENV: NodeJS.ProcessEnv = {};
for (const [key, value] of Object.entries(process.env)) {
	if (key.startsWith("GIT_")) AMBIENT_GIT_ENV[key] = value;
}

function scrubAmbientGitEnv(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("GIT_")) delete process.env[key];
	}
}

let root = "";
let logSpy: ReturnType<typeof vi.spyOn>;
const logged = (): string =>
	logSpy.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n");

beforeAll(() => {
	scrubAmbientGitEnv();
	root = mkdtempSync(join(tmpdir(), "il-metrics-complexity-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "simple.ts"), SIMPLE);
	writeFileSync(join(root, "src", "branchy.ts"), BRANCHY);
	writeFileSync(join(root, "src", "branchy.test.ts"), BRANCHY);
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	execFileSync("git", ["init", "-q"], { cwd: root, env, stdio: "pipe" });
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	Object.assign(process.env, AMBIENT_GIT_ENV);
});

afterEach(() => {
	logSpy?.mockRestore();
	process.exitCode = undefined;
});

const listFixture = (): string[] => ["src/simple.ts", "src/branchy.ts", "src/branchy.test.ts"];

describe("metricsComplexityCommand", () => {
	it("P1: --json emits the report over git-visible cappable files with default caps", async () => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await metricsComplexityCommand({ cwd: root, json: true });
		const parsed: unknown = JSON.parse(logged());
		expect(parsed).toMatchObject({
			files: 2,
			functions: 3,
			caps: {
				cyclomatic: { value: DEFAULT_MAX_CYCLOMATIC, source: "default" },
				cognitive: { value: DEFAULT_MAX_COGNITIVE_CAP, source: "default" },
				lines: { value: DEFAULT_MAX_LINES, source: "default" },
			},
		});
		expect(process.exitCode).toBeUndefined();
	});

	it("P2: --metric and --top narrow the normal rendering", async () => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await metricsComplexityCommand({ cwd: root, metric: "cognitive", top: "1" }, { listFiles: listFixture });
		const text = logged();
		expect(text).toContain("== Cognitive per function — n=3");
		expect(text).not.toContain("== Cyclomatic");
		expect(text).toContain("== Top 1 cognitive");
		expect(text).toContain("src/branchy.ts:1  branchy");
		expect(text).not.toContain("arrow");
	});

	it("P4: with no --top and no --churn-days the report uses the defaults, not zero", async () => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const churn = () => new Map([["src/branchy.ts", { lines: 10, commits: 2 }]]);
		await metricsComplexityCommand({ cwd: root, json: true }, { listFiles: listFixture, churn });
		const parsed: unknown = JSON.parse(logged());
		expect(parsed).toMatchObject({ top: 20, churn_days: 90, hotspots: [{ file: "src/branchy.ts", score: 80 }] });
	});

	it("P3: --short prints the one-line summary", async () => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await metricsComplexityCommand({ cwd: root, short: true }, { listFiles: listFixture });
		expect(logged()).toMatch(/^2 files, 3 functions; over cap: cyclomatic 0\/3/);
	});

	it("N1: an unknown --metric exits 1 with a usage line and prints no report", async () => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await metricsComplexityCommand({ cwd: root, metric: "halstead" }, { listFiles: listFixture });
		expect(process.exitCode).toBe(1);
		expect(String(errSpy.mock.calls[0]?.[0])).toContain("--metric must be one of");
		expect(logSpy).not.toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("N3: a listed file that vanished before it could be read is excluded, not fatal", async () => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await metricsComplexityCommand(
			{ cwd: root, json: true },
			{ listFiles: () => ["src/simple.ts", "src/does-not-exist-any-more.ts"] },
		);
		const parsed = parseWire(JSON.parse(logged()), wireObject({ "files": wireNumber, "functions": wireNumber }), "test JSON value");
		expect(parsed.files).toBe(1);
		expect(parsed.functions).toBe(1);
		expect(process.exitCode).toBeUndefined();
	});

	it("N2: an unavailable TS analyzer exits 1 loudly instead of printing an empty census", async () => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await metricsComplexityCommand(
			{ cwd: root },
			{ listFiles: listFixture, analyzers: { cyclomatic: () => null, cognitive: () => null } },
		);
		expect(process.exitCode).toBe(1);
		expect(String(errSpy.mock.calls[0]?.[0])).toContain("typescript");
		expect(logSpy).not.toHaveBeenCalled();
		errSpy.mockRestore();
	});
});

describe("capsProposeAction", () => {
	it("P1: --json reports p90/p95 per metric with written:false and creates no caps file", async () => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const code = await capsProposeAction({ json: true }, { cwd: root, listFiles: listFixture });
		expect(code).toBe(0);
		expect(JSON.parse(logged())).toEqual({
			written: false,
			files: 2,
			proposals: {
				cyclomatic: { n: 3, p90: 6, p95: 6, current: { value: DEFAULT_MAX_CYCLOMATIC, source: "default" } },
				cognitive: { n: 3, p90: 7, p95: 7, current: { value: DEFAULT_MAX_COGNITIVE_CAP, source: "default" } },
				lines: { n: 2, p90: 15, p95: 15, current: { value: DEFAULT_MAX_LINES, source: "default" } },
			},
		});
		expect(existsSync(join(root, ".interlinked", "metric-caps.json"))).toBe(false);
	});

	it("P2: the normal rendering names the apply command and says nothing was written", async () => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const code = await capsProposeAction({}, { cwd: root, listFiles: listFixture });
		expect(code).toBe(0);
		expect(logged()).toContain("nothing written");
		expect(logged()).toContain("interlinked caps set cyclomatic <n>");
	});

	it("N1: an unavailable TS analyzer returns 1 and proposes nothing", async () => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const code = await capsProposeAction(
			{},
			{ cwd: root, listFiles: listFixture, analyzers: { cyclomatic: () => null, cognitive: () => null } },
		);
		expect(code).toBe(1);
		expect(logSpy).not.toHaveBeenCalled();
		errSpy.mockRestore();
	});
});
