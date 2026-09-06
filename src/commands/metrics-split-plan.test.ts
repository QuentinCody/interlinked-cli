// ===========================================
// interlinked metrics split-plan — plan assembly, naming, render, command
// ===========================================
// P* cases: the plan must propose modules, names, and cross edges as
// described. N* cases: it must not invent names, duplicate files, or run on
// input it cannot judge.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSplitGraph } from "./metrics-split-plan-graph.js";
import {
	buildSplitPlan,
	metricsSplitPlanCommand,
	moduleSlug,
	renderSplitPlan,
	renderSplitPlanShort,
	type SplitPlan,
	toKebabCase,
} from "./metrics-split-plan.js";

// buildSplitGraph is mocked (default implementation delegates to the real
// function) so one command test can force the "typescript unavailable" path
// without touching the module under test.
vi.mock("./metrics-split-plan-graph.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./metrics-split-plan-graph.js")>();
	return { ...actual, buildSplitGraph: vi.fn(actual.buildSplitGraph) };
});

const SOURCE = [
	'import { readFileSync } from "node:fs";',
	'import { join } from "node:path";',
	"",
	"/** Public entry: parses then validates. */",
	"export function parseConfig(raw: string): number {",
	"\treturn validateShape(tokenize(raw));",
	"}",
	"",
	"function tokenize(raw: string): string[] {",
	'\treturn raw.split(",");',
	"}",
	"",
	"function validateShape(parts: string[]): number {",
	"\tif (parts.length === 0) return 0;",
	"\treturn parts.length;",
	"}",
	"",
	"export function loadReport(dir: string): string {",
	'\treturn readFileSync(join(dir, "report.json"), "utf8");',
	"}",
	"",
	"function reportPath(dir: string): string {",
	'\treturn join(dir, "report.json");',
	"}",
	"",
	"export function reportExists(dir: string): boolean {",
	"\treturn reportPath(dir).length > 0;",
	"}",
	"",
].join("\n");

function plan(): SplitPlan {
	const graph = buildSplitGraph(SOURCE, "src/lib/config-loader.ts");
	if (!graph) throw new Error("typescript unavailable — AST path required for this suite");
	return buildSplitPlan(graph, { lineCap: 20 });
}

// Four independent units (no calls between them): `main` is the sole export
// (entry cluster); `shared`/`sharedHelper` share an import so they merge into
// one cluster whose hub is named `shared`; `Shared` stays its own cluster.
// `moduleSlug("thing", "Shared")` collapses to the same slug as `moduleSlug("thing", "shared")`
// (`toKebabCase` is case-insensitive on a single word), so the second cluster's
// suggested filename collides with the first's and must be renamed `-2`.
const COLLISION_SOURCE = [
	'import { sharedImportFn } from "some-module";',
	"",
	"export function main(): number {",
	"\treturn 1;",
	"}",
	"",
	"function shared(): number {",
	"\treturn sharedImportFn();",
	"}",
	"",
	"function sharedHelper(): number {",
	"\treturn sharedImportFn();",
	"}",
	"",
	"function Shared(): number {",
	"\treturn 42;",
	"}",
	"",
].join("\n");

function collisionPlan(maxClusters?: number): SplitPlan {
	const graph = buildSplitGraph(COLLISION_SOURCE, "thing.ts");
	if (!graph) throw new Error("typescript unavailable — AST path required for this suite");
	return buildSplitPlan(graph, { lineCap: 100, ...(maxClusters !== undefined ? { maxClusters } : {}) });
}

const cleanups: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("toKebabCase — positive (must fire)", () => {
	it("P1: converts camelCase, PascalCase, and SCREAMING_SNAKE to kebab", () => {
		expect(toKebabCase("parseConfig")).toBe("parse-config");
		expect(toKebabCase("HTTPServer")).toBe("http-server");
		expect(toKebabCase("MAX_LINES")).toBe("max-lines");
	});
});

describe("moduleSlug — negative (must not fire)", () => {
	it("N1: a hub whose name repeats the file's base name does not duplicate it in the slug", () => {
		expect(moduleSlug("simplification-agent-ci-request", "SimplificationAgentCiRequestV1")).toBe("v1");
	});

	it("N2: a hub that IS the base name falls back to the cluster index", () => {
		expect(moduleSlug("config-loader", "configLoader", 2)).toBe("part-3");
	});
});

describe("buildSplitPlan — positive (must fire)", () => {
	it("P1: groups the parse chain and the report helpers into separate modules", () => {
		const p = plan();
		expect(p.modules).toHaveLength(2);
		const names = p.modules.map((m) => m.units.map((u) => u.name));
		expect(names).toContainEqual(["parseConfig", "tokenize", "validateShape"]);
		expect(names).toContainEqual(["loadReport", "reportPath", "reportExists"]);
	});

	it("P2: the module with the most exports keeps the source filename; others get a hub-named sibling", () => {
		const files = plan().modules.map((m) => m.file);
		expect(files).toContain("config-loader.ts");
		expect(files).toContain("config-loader-report-path.ts");
	});

	it("P3: reports per-module line count, ΣCC, and imports", () => {
		const p = plan();
		const report = p.modules.find((m) => m.file === "config-loader-report-path.ts");
		expect(report?.lines).toBe(9);
		expect(report?.cyclomatic).toBe(3);
		expect(report?.imports).toEqual(["node:fs", "node:path"]);
		const parse = p.modules.find((m) => m.file === "config-loader.ts");
		expect(parse?.cyclomatic).toBe(4);
		expect(parse?.imports).toEqual([]);
	});

	it("P4: carries the file totals, the cap, and the preamble", () => {
		const p = plan();
		expect(p.source).toBe("src/lib/config-loader.ts");
		expect(p.totalLines).toBe(29);
		expect(p.lineCap).toBe(20);
		expect(p.unitCount).toBe(6);
		expect(p.preambleLines).toBe(29 - 11 - 9);
		expect(p.overCap).toBe(true);
	});

	it("P5: a call across the proposed boundary is listed with the units that must gain export", () => {
		const graph = buildSplitGraph(
			[
				"export function a(): number {",
				"\treturn helper() + b();",
				"}",
				"function helper(): number {",
				"\treturn 1;",
				"}",
				"export function b(): number {",
				"\treturn 2;",
				"}",
				"",
			].join("\n"),
			"x.ts",
		);
		if (!graph) throw new Error("typescript unavailable");
		const p = buildSplitPlan(graph, { lineCap: 5, maxShareOfLines: 0.4 });
		expect(p.crossEdges.length).toBeGreaterThan(0);
		for (const e of p.crossEdges) expect(e.fromModule).not.toBe(e.toModule);
		const targets = p.crossEdges.map((e) => e.to);
		expect(p.newlyExported.every((n) => targets.includes(n))).toBe(true);
		expect(p.newlyExported).not.toContain("b");
	});

	it("P6: a filename collision between two non-entry clusters is resolved with a -2 suffix", () => {
		const p = collisionPlan();
		const files = p.modules.map((m) => m.file);
		expect(files).toEqual(["thing.ts", "thing-shared.ts", "thing-shared-2.ts"]);
		const renamed = p.modules.find((m) => m.file === "thing-shared-2.ts");
		expect(renamed?.units.map((u) => u.name)).toEqual(["Shared"]);
	});

	it("P7: maxClusters forces extra clusters to merge even without a merge affinity", () => {
		const p = collisionPlan(2);
		expect(p.modules).toHaveLength(2);
	});
});

describe("buildSplitPlan — negative (must not fire)", () => {
	it("N1: no two modules share a filename", () => {
		const files = plan().modules.map((m) => m.file);
		expect(new Set(files).size).toBe(files.length);
	});

	it("N2: a file with no units yields no modules and no cross edges", () => {
		const graph = buildSplitGraph('console.log("x");\n', "y.ts");
		if (!graph) throw new Error("typescript unavailable");
		const p = buildSplitPlan(graph, { lineCap: 500 });
		expect(p.modules).toEqual([]);
		expect(p.crossEdges).toEqual([]);
		expect(p.overCap).toBe(false);
	});

	it("N3: an already-exported cross-edge target is not listed as newly exported", () => {
		const p = plan();
		expect(p.newlyExported).not.toContain("parseConfig");
	});
});

describe("renderSplitPlan", () => {
	it("P1: names every proposed module with its line count and ΣCC", () => {
		const text = renderSplitPlan(plan());
		expect(text).toContain("config-loader-report-path.ts");
		expect(text).toContain("9 lines");
		expect(text).toContain("ΣCC 3");
		expect(text).toContain("parseConfig");
	});

	it("P2: the short form is one line", () => {
		expect(renderSplitPlanShort(plan()).split("\n")).toHaveLength(1);
	});

	it("P3: lists a cross-module reference and the units that need `export`", () => {
		const graph = buildSplitGraph(
			[
				"export function a(): number {",
				"\treturn helper() + b();",
				"}",
				"function helper(): number {",
				"\treturn 1;",
				"}",
				"export function b(): number {",
				"\treturn 2;",
				"}",
				"",
			].join("\n"),
			"x.ts",
		);
		if (!graph) throw new Error("typescript unavailable");
		const p = buildSplitPlan(graph, { lineCap: 5, maxShareOfLines: 0.4 });
		const text = renderSplitPlan(p);
		const edge = p.crossEdges[0];
		if (!edge) throw new Error("expected at least one cross edge in this fixture");
		expect(text).toContain(`${edge.fromModule}:${edge.from} → ${edge.toModule}:${edge.to}`);
		expect(text).toContain("Needs `export` to cross the boundary: helper");
	});
});

describe("metricsSplitPlanCommand", () => {
	function tmpRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "split-plan-"));
		cleanups.push(dir);
		return dir;
	}

	it("P1: --json prints the plan for a real file", async () => {
		const dir = tmpRepo();
		writeFileSync(join(dir, "loader.ts"), SOURCE);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await metricsSplitPlanCommand({ file: "loader.ts", cwd: dir, json: true });
		const printed = JSON.parse(String(log.mock.calls[0]?.[0])) as SplitPlan;
		expect(printed.modules.map((m) => m.file)).toContain("loader.ts");
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("N1: a missing file sets a non-zero exit code and prints nothing on stdout", async () => {
		const dir = tmpRepo();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await metricsSplitPlanCommand({ file: "absent.ts", cwd: dir });
		expect(log).not.toHaveBeenCalled();
		expect(err).toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});

	it("N2: a non-JS/TS file is refused", async () => {
		const dir = tmpRepo();
		writeFileSync(join(dir, "notes.md"), "# hi\n");
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await metricsSplitPlanCommand({ file: "notes.md", cwd: dir });
		expect(String(err.mock.calls[0]?.[0])).toMatch(/JS\/TS/);
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});

	it("N3: when the AST parser is unavailable it fails loudly and prints nothing", async () => {
		const dir = tmpRepo();
		writeFileSync(join(dir, "loader.ts"), SOURCE);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.mocked(buildSplitGraph).mockReturnValueOnce(null);
		await metricsSplitPlanCommand({ file: "loader.ts", cwd: dir });
		expect(log).not.toHaveBeenCalled();
		expect(String(err.mock.calls[0]?.[0])).toContain(
			"split-plan needs the optional `typescript` dependency (AST parse) — install it and retry",
		);
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});

	it("P2: --max-clusters clamps and forces fewer modules than the default", async () => {
		const dir = tmpRepo();
		writeFileSync(join(dir, "thing.ts"), COLLISION_SOURCE);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await metricsSplitPlanCommand({ file: "thing.ts", cwd: dir, json: true, maxClusters: "2" });
		const printed = JSON.parse(String(log.mock.calls[0]?.[0])) as SplitPlan;
		expect(printed.modules).toHaveLength(2);
	});

	it("N4: an unparsable --max-clusters is ignored, keeping the default cluster count", async () => {
		const dir = tmpRepo();
		writeFileSync(join(dir, "thing.ts"), COLLISION_SOURCE);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await metricsSplitPlanCommand({ file: "thing.ts", cwd: dir, json: true, maxClusters: "not-a-number" });
		const printed = JSON.parse(String(log.mock.calls[0]?.[0])) as SplitPlan;
		expect(printed.modules).toHaveLength(3);
	});

	it("P3: the default (normal) mode prints the full multi-line plan", async () => {
		const dir = tmpRepo();
		writeFileSync(join(dir, "loader.ts"), SOURCE);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await metricsSplitPlanCommand({ file: "loader.ts", cwd: dir });
		const printed = String(log.mock.calls[0]?.[0]);
		expect(printed).toContain("Split plan — loader.ts:");
		expect(printed).toContain("loader-report-path.ts");
		expect(printed).toContain("parseConfig");
	});

	it("P4: --short prints exactly one summary line naming the file and module count", async () => {
		const dir = tmpRepo();
		writeFileSync(join(dir, "loader.ts"), SOURCE);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await metricsSplitPlanCommand({ file: "loader.ts", cwd: dir, short: true });
		const printed = String(log.mock.calls[0]?.[0]);
		expect(printed.split("\n")).toHaveLength(1);
		expect(printed).toContain("loader.ts: 29 lines → 2 modules");
	});
});
