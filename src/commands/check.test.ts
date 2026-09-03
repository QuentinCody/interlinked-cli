// Behavioral tests for `checkCommand` — the project-wide structural + engine
// check handler. The pure helpers (`findDeadImports`, `extractBindings`) are
// covered in __tests__/check.test.ts; this file drives the large async command
// itself, mocking the harness graph, the CheckEngine, the quality-check
// detectors, and node:fs so every branch is exercised deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckReport, ToolId } from "../harness/check-engine/index.js";
import type { ExportedSymbol, ImportEdge } from "../harness/types/graph.js";

// -------------------------------------------------------------------
// Mock control surface (mutated per-test, read inside the class mocks)
// -------------------------------------------------------------------

interface GraphState {
	files: string[];
	deps: Record<string, ImportEdge[]>;
	exports: Record<string, ExportedSymbol[]>;
	dependents: Record<string, string[]>;
	cycles: Record<string, string[][]>;
	boundary: Record<string, string>;
	fileCount: number;
	initialized: boolean;
}

const graphState: GraphState = {
	files: [],
	deps: {},
	exports: {},
	dependents: {},
	cycles: {},
	boundary: {},
	fileCount: 0,
	initialized: false,
};

function resetGraphState(): void {
	graphState.files = [];
	graphState.deps = {};
	graphState.exports = {};
	graphState.dependents = {};
	graphState.cycles = {};
	graphState.boundary = {};
	graphState.fileCount = 0;
	graphState.initialized = false;
}

// Engine control surface
interface EngineState {
	toolReport: string;
	report: CheckReport;
}

function emptyReport(): CheckReport {
	return {
		results: [],
		toolsRun: [],
		toolsSkipped: [],
		skipped: [],
		elapsedMs: 0,
		metrics: [],
		deduplicatedCount: 0,
	};
}

const engineState: EngineState = {
	toolReport: "tool report body",
	report: emptyReport(),
};

function resetEngineState(): void {
	engineState.toolReport = "tool report body";
	engineState.report = emptyReport();
}

// fs control surface
const existing = new Set<string>();
const fileContents = new Map<string, string>();
const unreadable = new Set<string>();

function resetFs(): void {
	existing.clear();
	fileContents.clear();
	unreadable.clear();
}

// quality-check control surface — file content -> finding count
let secretsHits = new Set<string>();
let anyTypesHits = new Set<string>();

// -------------------------------------------------------------------
// Module mocks
// -------------------------------------------------------------------

// Call-capture surface: records the raw arguments the command passed into the
// mocked ProjectGraph/CheckEngine constructors and CheckEngine#runChecks, so
// mutants that corrupt those pass-through values (cwd resolution, the engine
// tools filter, the runChecks scope/options objects) are directly observable
// instead of being masked by the mocks discarding their arguments.
interface GraphCallCapture {
	constructedCwd: string[];
	initializeCalls: number;
}
const graphCalls: GraphCallCapture = { constructedCwd: [], initializeCalls: 0 };
function resetGraphCalls(): void {
	graphCalls.constructedCwd = [];
	graphCalls.initializeCalls = 0;
}

interface EngineCallCapture {
	constructedCwd: string[];
	runChecksCalls: Array<{ scope: unknown; opts: { tools?: ToolId[]; timeoutMs?: number } }>;
}
const engineCalls: EngineCallCapture = { constructedCwd: [], runChecksCalls: [] };
function resetEngineCalls(): void {
	engineCalls.constructedCwd = [];
	engineCalls.runChecksCalls = [];
}

vi.mock("../harness/project-graph.js", () => ({
	ProjectGraph: class {
		constructor(cwd: string) {
			graphCalls.constructedCwd.push(cwd);
		}
		initialize(): void {
			graphCalls.initializeCalls++;
			graphState.initialized = true;
		}
		get fileCount(): number {
			return graphState.fileCount;
		}
		allFiles(): string[] {
			return graphState.files;
		}
		getDependencies(file: string): ImportEdge[] {
			return graphState.deps[file] ?? [];
		}
		getExports(file: string): ExportedSymbol[] {
			return graphState.exports[file] ?? [];
		}
		getDependents(file: string): string[] {
			return graphState.dependents[file] ?? [];
		}
		findCyclesThrough(file: string): string[][] {
			return graphState.cycles[file] ?? [];
		}
		getProjectBoundary(file: string): string {
			return graphState.boundary[file] ?? "root";
		}
		toRelative(file: string): string {
			return file.replace(/^\/abs\//, "");
		}
	},
}));

vi.mock("../harness/check-engine/index.js", () => ({
	CheckEngine: class {
		constructor(public readonly projectRoot: string) {
			engineCalls.constructedCwd.push(projectRoot);
		}
		formatToolReport(): string {
			return engineState.toolReport;
		}
		runChecks(scope: unknown, opts: { tools?: ToolId[]; timeoutMs?: number }): CheckReport {
			engineCalls.runChecksCalls.push({ scope, opts });
			return engineState.report;
		}
	},
}));

vi.mock("../harness/quality-checks.js", () => ({
	containsSecrets: (content: string): unknown[] => (secretsHits.has(content) ? [{}] : []),
	findAnyTypes: (content: string): unknown[] => (anyTypesHits.has(content) ? [{}] : []),
}));

vi.mock("node:fs", () => ({
	existsSync: (p: string): boolean => existing.has(p),
	readFileSync: (p: string): string => {
		if (unreadable.has(p)) throw new Error(`unreadable: ${p}`);
		return fileContents.get(p) ?? "";
	},
}));

// Import AFTER mocks are registered.
import { checkCommand } from "./check.js";

// -------------------------------------------------------------------
// IO capture
// -------------------------------------------------------------------

interface Captured {
	stdout: string;
	stderr: string;
	exitCode: number | string | undefined;
}

function captureIO(): { mocks: () => Captured; restore: () => void } {
	let stdout = "";
	let stderr = "";
	const origExit = process.exitCode;
	process.exitCode = undefined;
	const outSpy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: string | Uint8Array): boolean => {
			stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		});
	const errSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: string | Uint8Array): boolean => {
			stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		});
	return {
		mocks: () => ({ stdout, stderr, exitCode: process.exitCode }),
		restore: () => {
			outSpy.mockRestore();
			errSpy.mockRestore();
			process.exitCode = origExit;
		},
	};
}

// -------------------------------------------------------------------
// Builders
// -------------------------------------------------------------------

function edge(partial: Partial<ImportEdge>): ImportEdge {
	return {
		fromFile: "/abs/src/a.ts",
		toFile: "/abs/src/b.ts",
		specifier: "./b",
		symbols: [],
		isTypeOnly: false,
		...partial,
	};
}

function exp(partial: Partial<ExportedSymbol>): ExportedSymbol {
	return {
		name: "Thing",
		kind: "const",
		isTypeOnly: false,
		line: 1,
		...partial,
	};
}

function report(partial: Partial<CheckReport>): CheckReport {
	return { ...emptyReport(), ...partial };
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

describe("checkCommand", () => {
	let io: ReturnType<typeof captureIO>;

	beforeEach(() => {
		resetGraphState();
		resetEngineState();
		resetFs();
		resetGraphCalls();
		resetEngineCalls();
		secretsHits = new Set();
		anyTypesHits = new Set();
		io = captureIO();
	});

	afterEach(() => {
		io.restore();
	});

	// ---- Unknown --only ----
	it("rejects an unknown --only check with exit code 1", async () => {
		await checkCommand({ only: "not-a-real-check", cwd: "/abs" });
		const { stderr, exitCode } = io.mocks();
		expect(stderr).toContain('Unknown check: "not-a-real-check"');
		expect(stderr).toContain("broken-imports");
		expect(stderr).toContain("tsc");
		expect(exitCode).toBe(1);
	});

	// ---- newly-added engine tools are --only-able (drift fix, finding 2026-06) ----
	it.each(["rustfmt", "lizard"])(
		"accepts engine tool %s for --only instead of rejecting it as 'Unknown check'",
		async (tool) => {
			await checkCommand({ only: tool, cwd: "/abs" });
			const { stderr, exitCode } = io.mocks();
			expect(stderr).not.toContain("Unknown check");
			expect(exitCode).not.toBe(1);
		},
	);

	// ---- discovery-only engine tools rejected, not falsely-cleaned ----
	it.each(["dep-audit", "docs-check"])(
		"rejects discovery-only engine tool %s with exit 1 (no 0-finding false clean)",
		async (tool) => {
			await checkCommand({ only: tool, cwd: "/abs" });
			const { stdout, stderr, exitCode } = io.mocks();
			expect(exitCode).toBe(1);
			expect(stderr).toContain("discovery-only");
			expect(stderr).toContain("interlinked verify");
			expect(stdout).toBe("");
		},
	);

	// ---- --tools drops discovery-only ids (no phantom clean row) ----
	it("drops a discovery-only tool from --tools and warns instead of a clean row", async () => {
		engineState.report = report({
			toolsRun: [{ id: "tsc", available: true, version: "5.0" }],
			results: [],
		});
		await checkCommand({ tools: "tsc,dep-audit", cwd: "/abs" });
		const { stderr, exitCode } = io.mocks();
		expect(stderr).toContain("Skipping discovery-only tool(s) dep-audit");
		expect(stderr).toContain("tsc [5.0]");
		expect(stderr).not.toContain("dep-audit [");
		expect(exitCode).not.toBe(1);
	});

	// ---- --report short-circuit ----
	it("prints the tool report and returns early when only --report is set", async () => {
		engineState.toolReport = "REPORT-XYZ";
		await checkCommand({ report: true, cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stderr).toContain("REPORT-XYZ");
		// Early return: no structural summary header was written.
		expect(stderr).not.toContain("Interlinked project check");
		expect(stderr).not.toContain("running external tools");
		expect(stdout).toBe("");
	});

	it("continues past --report when --tools is also given", async () => {
		engineState.toolReport = "REPORT-XYZ";
		engineState.report = report({
			toolsRun: [{ id: "tsc", available: true, version: "5.0" }],
			results: [],
		});
		await checkCommand({ report: true, tools: true, cwd: "/abs" });
		const { stderr } = io.mocks();
		expect(stderr).toContain("REPORT-XYZ");
		expect(stderr).toContain("running external tools");
		expect(stderr).toContain("Interlinked project check");
		expect(stderr).toContain("tsc [5.0]");
	});

	// ---- Structural full summary: all clean ----
	it("reports all-clean structural checks with check marks and no error exit", async () => {
		graphState.files = [];
		graphState.fileCount = 0;
		await checkCommand({ cwd: "/abs" });
		const { stderr, stdout, exitCode } = io.mocks();
		expect(stderr).toContain("Interlinked project check (0 files indexed)");
		expect(stderr).toContain("Structural checks:");
		expect(stderr).toContain("broken-imports [error]:");
		expect(stderr).toContain("blast-radius [info]:");
		expect(stderr).toContain("total unique: 0 / 0 files");
		expect(stdout).toBe("");
		expect(exitCode).toBeUndefined();
	});

	// ---- broken-imports: all sub-branches ----
	it("flags broken imports for missing target files and skips json/node_modules/no-toFile", async () => {
		graphState.files = ["/abs/src/a.ts"];
		graphState.fileCount = 1;
		graphState.deps["/abs/src/a.ts"] = [
			edge({ toFile: "", specifier: "./missing-resolve" }), // no toFile -> continue
			edge({ specifier: "./data.json", toFile: "/abs/src/data.json" }), // .json -> continue
			edge({ toFile: "/abs/node_modules/lib/index.js" }), // node_modules -> continue
			edge({ toFile: "/abs/src/gone.ts" }), // not existing -> flag + break
		];
		await checkCommand({ only: "broken-imports", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain("src/a.ts");
		expect(stderr).toContain("1 files");
	});

	it("flags broken imports when an imported symbol is not exported by the target", async () => {
		graphState.files = ["/abs/src/a.ts"];
		graphState.fileCount = 1;
		existing.add("/abs/src/b.ts");
		graphState.deps["/abs/src/a.ts"] = [
			edge({ toFile: "/abs/src/b.ts", symbols: ["Missing"] }),
		];
		graphState.exports["/abs/src/b.ts"] = [exp({ name: "Present" })];
		await checkCommand({ only: "broken-imports", cwd: "/abs" });
		expect(io.mocks().stdout).toContain("src/a.ts");
	});

	it("does not flag broken imports when all symbols (incl. default) resolve", async () => {
		graphState.files = ["/abs/src/a.ts"];
		graphState.fileCount = 1;
		existing.add("/abs/src/b.ts");
		graphState.deps["/abs/src/a.ts"] = [
			edge({ toFile: "/abs/src/b.ts", symbols: ["Present", "default"] }),
		];
		graphState.exports["/abs/src/b.ts"] = [exp({ name: "Present" })];
		await checkCommand({ only: "broken-imports", cwd: "/abs" });
		expect(io.mocks().stderr).toContain("0 files");
	});

	// ---- cycles ----
	it("records every file in a detected cycle and dedups via visited set", async () => {
		graphState.files = ["/abs/src/a.ts", "/abs/src/b.ts"];
		graphState.fileCount = 2;
		// a participates in a cycle a->b->a; b is then already visited.
		graphState.cycles["/abs/src/a.ts"] = [["/abs/src/a.ts", "/abs/src/b.ts"]];
		graphState.cycles["/abs/src/b.ts"] = [["/abs/src/b.ts", "/abs/src/a.ts"]];
		await checkCommand({ only: "cycles", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain("src/a.ts");
		expect(stdout).toContain("src/b.ts");
		expect(stderr).toContain("2 files");
	});

	// ---- duplicates ----
	it("flags duplicate non-type, non-reexport exports within a boundary", async () => {
		graphState.files = ["/abs/src/a.ts", "/abs/src/b.ts", "/abs/src/c.ts"];
		graphState.fileCount = 3;
		graphState.boundary = {
			"/abs/src/a.ts": "root",
			"/abs/src/b.ts": "root",
			"/abs/src/c.ts": "root",
		};
		graphState.exports = {
			// dup across a and b
			"/abs/src/a.ts": [exp({ name: "Dup" })],
			"/abs/src/b.ts": [exp({ name: "Dup" })],
			// these must all be ignored (default/star/type-only/re-export)
			"/abs/src/c.ts": [
				exp({ name: "default", kind: "default" }),
				exp({ name: "*", kind: "namespace" }),
				exp({ name: "Dup", isTypeOnly: true }),
				exp({ name: "Dup", kind: "re-export" }),
			],
		};
		await checkCommand({ only: "duplicates", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain("src/a.ts");
		expect(stdout).toContain("src/b.ts");
		expect(stdout).not.toContain("src/c.ts");
		expect(stderr).toContain("2 files");
	});

	// ---- missing-tests: skip rules + candidate present/missing ----
	it("flags only real source files missing tests and honors every skip rule", async () => {
		graphState.files = [
			"/abs/src/real.ts", // flagged (no test file present)
			"/abs/src/tested.ts", // not flagged (has a __tests__ companion)
			"/abs/src/styles.css", // ext not in list -> skip
			"/abs/src/foo.test.ts", // .test -> skip
			"/abs/src/foo.spec.ts", // .spec -> skip
			"/abs/src/types.d.ts", // .d basename + .d.ts -> skip
			"/abs/src/index.ts", // index -> skip
			"/abs/src/app.config.ts", // .config. -> skip
			"/abs/src/jest.setup.ts", // .setup. -> skip
			"/abs/src/__tests__/x.ts", // __tests__ -> skip
			"/abs/src/__mocks__/y.ts", // __mocks__ -> skip
			"/abs/test/z.ts", // /test/ -> skip
			"/abs/tests/z2.ts", // /tests/ -> skip
			"/abs/fixtures/f.ts", // /fixtures/ -> skip
			"/abs/__fixtures__/f2.ts", // /__fixtures__/ -> skip
			"/abs/orchestration-scripts/o.ts", // -> skip
			"/abs/templates/t.ts", // -> skip
		];
		graphState.fileCount = graphState.files.length;
		// tested.ts has a companion in __tests__
		existing.add("/abs/src/__tests__/tested.test.ts");
		await checkCommand({ only: "missing-tests", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain("src/real.ts");
		expect(stdout).not.toContain("src/tested.ts");
		expect(stdout).not.toContain("styles.css");
		expect(stdout).not.toContain("index.ts");
		expect(stderr).toContain("1 files");
	});

	it("does not flag a source file when a sibling .test file exists", async () => {
		graphState.files = ["/abs/src/real.ts"];
		graphState.fileCount = 1;
		existing.add("/abs/src/real.test.ts");
		await checkCommand({ only: "missing-tests", cwd: "/abs" });
		expect(io.mocks().stderr).toContain("0 files");
	});

	// ---- secrets ----
	it("flags files whose content trips the secrets detector, skipping non-source + test files", async () => {
		graphState.files = [
			"/abs/src/leaky.ts", // flagged
			"/abs/src/clean.ts", // no hit
			"/abs/src/notes.md", // ext skip
			"/abs/src/x.test.ts", // .test skip
			"/abs/src/__tests__/y.ts", // __tests__ skip
			"/abs/test/z.ts", // /test/ skip
			"/abs/src/broken.ts", // unreadable -> catch
		];
		graphState.fileCount = graphState.files.length;
		fileContents.set("/abs/src/leaky.ts", "SECRET-CONTENT");
		fileContents.set("/abs/src/clean.ts", "ok");
		unreadable.add("/abs/src/broken.ts");
		secretsHits = new Set(["SECRET-CONTENT"]);
		await checkCommand({ only: "secrets", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain("src/leaky.ts");
		expect(stdout).not.toContain("src/clean.ts");
		expect(stderr).toContain("1 files");
	});

	// ---- any-types ----
	it("flags .ts/.tsx files containing any-types, skipping .d.ts and test files and unreadable", async () => {
		graphState.files = [
			"/abs/src/anyfile.ts", // flagged
			"/abs/src/typed.ts", // no hit
			"/abs/src/x.spec.ts", // .spec skip
			"/abs/src/decl.d.ts", // .d.ts skip
			"/abs/src/script.js", // ext skip
			"/abs/src/oops.ts", // unreadable -> catch
		];
		graphState.fileCount = graphState.files.length;
		fileContents.set("/abs/src/anyfile.ts", "HAS-ANY");
		fileContents.set("/abs/src/typed.ts", "clean");
		unreadable.add("/abs/src/oops.ts");
		anyTypesHits = new Set(["HAS-ANY"]);
		await checkCommand({ only: "any-types", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain("src/anyfile.ts");
		expect(stdout).not.toContain("src/typed.ts");
		expect(stderr).toContain("1 files");
	});

	// ---- blast-radius ----
	it("flags files with five or more dependents", async () => {
		graphState.files = ["/abs/src/hub.ts", "/abs/src/leaf.ts"];
		graphState.fileCount = 2;
		graphState.dependents["/abs/src/hub.ts"] = ["a", "b", "c", "d", "e"];
		graphState.dependents["/abs/src/leaf.ts"] = ["a"];
		await checkCommand({ only: "blast-radius", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain("src/hub.ts");
		expect(stdout).not.toContain("src/leaf.ts");
		expect(stderr).toContain("1 files");
	});

	// ---- dead-imports ----
	it("flags files with dead imports and skips unreadable + non-code files", async () => {
		graphState.files = [
			"/abs/src/dead.ts", // unused import -> flagged
			"/abs/src/live.ts", // used import -> clean
			"/abs/src/data.json", // ext skip
			"/abs/src/bad.ts", // unreadable -> catch
		];
		graphState.fileCount = graphState.files.length;
		fileContents.set("/abs/src/dead.ts", "import { foo } from './x';\nconst y = 1;");
		fileContents.set("/abs/src/live.ts", "import { foo } from './x';\nconsole.log(foo);");
		unreadable.add("/abs/src/bad.ts");
		await checkCommand({ only: "dead-imports", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain("src/dead.ts");
		expect(stdout).not.toContain("src/live.ts");
		expect(stderr).toContain("1 files");
	});

	// ---- structural --only with zero results ----
	it("prints '0 files' for a structural --only check with no findings", async () => {
		graphState.files = ["/abs/src/hub.ts"];
		graphState.fileCount = 1;
		graphState.dependents["/abs/src/hub.ts"] = ["a"]; // < 5
		await checkCommand({ only: "blast-radius", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	// ---- engine --only with findings ----
	it("prints engine-only findings sorted by file with a findings count", async () => {
		engineState.report = report({
			toolsRun: [{ id: "tsc", available: true, version: "5.0" }],
			results: [
				{ tool: "tsc", severity: "error", file: "z.ts", line: 9, message: "late" },
				{ tool: "tsc", severity: "error", file: "a.ts", line: 3, message: "early" },
				{ tool: "biome", severity: "warning", file: "b.ts", line: 1, message: "other" },
			],
		});
		await checkCommand({ only: "tsc", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		// Only tsc rows, sorted a.ts before z.ts.
		expect(stdout).toBe("a.ts:3: early\nz.ts:9: late\n");
		expect(stderr).toContain("2 findings");
	});

	it("prints '0 findings' for an engine --only check with no matching results", async () => {
		engineState.report = report({
			toolsRun: [{ id: "tsc", available: true, version: "5.0" }],
			results: [],
		});
		await checkCommand({ only: "tsc", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 findings");
	});

	// ---- JSON output (structural + engine) ----
	it("emits JSON combining structural counts and engine findings", async () => {
		graphState.files = ["/abs/src/hub.ts"];
		graphState.fileCount = 1;
		graphState.dependents["/abs/src/hub.ts"] = ["a", "b", "c", "d", "e"];
		engineState.report = report({
			toolsRun: [{ id: "tsc", available: true, version: "5.0" }],
			results: [
				{
					tool: "tsc",
					severity: "error",
					file: "hub.ts",
					line: 2,
					message: "boom",
					ruleId: "TS1",
				},
			],
		});
		await checkCommand({ json: true, tools: true, cwd: "/abs" });
		const { stdout } = io.mocks();
		const parsed = JSON.parse(stdout) as Record<string, unknown>;
		expect(parsed["blast-radius"]).toEqual({ count: 1, files: ["src/hub.ts"] });
		expect(parsed.tsc).toEqual({
			count: 1,
			findings: [
				{ file: "hub.ts", line: 2, severity: "error", message: "boom", ruleId: "TS1" },
			],
		});
	});

	it("emits structural-only JSON when no engine run is requested", async () => {
		graphState.files = [];
		graphState.fileCount = 0;
		await checkCommand({ json: true, cwd: "/abs" });
		const { stdout } = io.mocks();
		const parsed = JSON.parse(stdout) as Record<string, unknown>;
		expect(parsed["broken-imports"]).toEqual({ count: 0, files: [] });
		expect(parsed.tsc).toBeUndefined();
	});

	// ---- Full summary with engine: errors, warnings, zero, skipped ----
	it("renders the full summary with engine errors and sets exit code 1", async () => {
		graphState.files = ["/abs/src/a.ts"];
		graphState.fileCount = 1;
		// structural error: a broken import (missing target) -> hasErrors
		graphState.deps["/abs/src/a.ts"] = [edge({ toFile: "/abs/src/gone.ts" })];
		engineState.report = report({
			toolsRun: [
				{ id: "tsc", available: true, version: "5.0" }, // errors
				{ id: "biome", available: true }, // warning only (no version -> "?")
				{ id: "oxlint", available: true, version: "1.0" }, // zero findings
			],
			toolsSkipped: [
				{ id: "mypy", available: false, reason: "not installed" },
				{ id: "ruff", available: false }, // no reason -> "skipped"
				{ id: "knip", available: true }, // available -> filtered OUT of skipped list
			],
			results: [
				{ tool: "tsc", severity: "error", file: "a.ts", line: 1, message: "type err" },
				{ tool: "biome", severity: "warning", file: "a.ts", line: 2, message: "style" },
			],
			elapsedMs: 2500,
		});
		await checkCommand({ tools: true, cwd: "/abs" });
		const { stderr, exitCode } = io.mocks();
		expect(stderr).toContain("External tool checks:");
		expect(stderr).toContain("tsc [5.0]");
		expect(stderr).toContain("(1 errors, 0 warnings)");
		expect(stderr).toContain("biome [?]");
		expect(stderr).toContain("(0 errors, 1 warnings)");
		expect(stderr).toContain("oxlint [1.0]");
		expect(stderr).toContain("mypy: not installed");
		expect(stderr).toContain("ruff: skipped");
		expect(stderr).not.toContain("knip:");
		expect(stderr).toContain("completed in 2.5s");
		expect(exitCode).toBe(1);
	});

	it("does not set exit code 1 when only info-level structural findings exist", async () => {
		graphState.files = ["/abs/src/hub.ts"];
		graphState.fileCount = 1;
		graphState.dependents["/abs/src/hub.ts"] = ["a", "b", "c", "d", "e"]; // blast-radius = info
		await checkCommand({ cwd: "/abs" });
		const { stderr, exitCode } = io.mocks();
		expect(stderr).toContain("blast-radius [info]:");
		expect(stderr).toContain("total unique: 1 / 1 files");
		expect(exitCode).toBeUndefined();
	});

	// ---- tools as a comma-separated string ----
	it("parses --tools as a comma-separated filter and runs the engine path", async () => {
		graphState.files = [];
		graphState.fileCount = 0;
		engineState.report = report({
			toolsRun: [{ id: "tsc", available: true, version: "5.0" }],
			results: [],
		});
		// `--tools "tsc, biome"` exercises the string-split/trim branch building
		// engineToolFilter; the engine mock still returns our report.
		await checkCommand({ tools: "tsc, biome", cwd: "/abs" });
		const { stderr } = io.mocks();
		expect(stderr).toContain("running external tools");
		expect(stderr).toContain("tsc [5.0]");
	});

	it("renders a zero-finding engine tool with an unknown version as '?'", async () => {
		graphState.files = [];
		graphState.fileCount = 0;
		engineState.report = report({
			// no version -> exercises the `tool.version || "?"` falsy arm on the
			// zero-findings line.
			toolsRun: [{ id: "tsc", available: true }],
			results: [],
		});
		await checkCommand({ tools: true, cwd: "/abs" });
		const { stderr } = io.mocks();
		expect(stderr).toContain("tsc [?]: ");
		expect(stderr).toContain("0\x1b[0m findings");
	});

	// ---- dead-imports: multi-line buffered import + used default import ----
	it("handles multi-line named imports and used default imports in dead-imports", async () => {
		graphState.files = ["/abs/src/multi.ts", "/abs/src/def.ts"];
		graphState.fileCount = 2;
		// Multi-line import where the opening line has `{` but no `}` -> buffer path.
		// `Used` is referenced; `Dead` is not -> file is flagged.
		fileContents.set(
			"/abs/src/multi.ts",
			"import {\n  Used,\n  Dead,\n} from './x';\nconsole.log(Used);",
		);
		// Default import that IS used -> not flagged.
		fileContents.set("/abs/src/def.ts", "import Foo from './y';\nconsole.log(Foo);");
		await checkCommand({ only: "dead-imports", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain("src/multi.ts");
		expect(stdout).not.toContain("src/def.ts");
		expect(stderr).toContain("1 files");
	});

	it("exercises dead-import edge cases: namespace, side-effect, single-char, post-section import-text", async () => {
		graphState.files = ["/abs/src/edge.ts"];
		graphState.fileCount = 1;
		// - `import * as ns` and `import './side'` route through extractBindings'
		//   early-return arms (namespace / side-effect skip).
		// - `import a from './a'` pushes a single-char binding -> length<2 skip.
		// - `Keep` is unused so the file is flagged.
		// - After the import section ends, a line that looks like an import is
		//   ignored (importSectionEnded continue).
		fileContents.set(
			"/abs/src/edge.ts",
			[
				"import * as ns from './ns';",
				"import './side';",
				"import a from './a';",
				"import { Keep } from './k';",
				"const code = 1;",
				"import { LooksLikeImport } from './ignored';",
			].join("\n"),
		);
		await checkCommand({ only: "dead-imports", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		// Keep is unused -> flagged. (a is single-char so ignored; ns/side-effect
		// contribute no bindings; the post-section import line is not scanned.)
		expect(stdout).toContain("src/edge.ts");
		expect(stderr).toContain("1 files");
	});

	it("runs the trailing-buffer path for an unterminated import at EOF", async () => {
		graphState.files = ["/abs/src/trail.ts"];
		graphState.fileCount = 1;
		// File begins with an import that opens `{` but is never closed and has
		// no `from`/quote, so the buffer is still open at EOF -> the trailing
		// `if (buffer) extractBindings(...)` branch runs. extractBindings finds no
		// closing `}`, yields no bindings, so the file is not flagged (but the
		// branch is exercised).
		fileContents.set("/abs/src/trail.ts", "import {\n  Dead");
		await checkCommand({ only: "dead-imports", cwd: "/abs" });
		expect(io.mocks().stderr).toContain("0 files");
	});

	// ---- default cwd fallback ----
	it("falls back to process.cwd() when no cwd is provided", async () => {
		const spy = vi.spyOn(process, "cwd").mockReturnValue("/abs");
		graphState.files = [];
		graphState.fileCount = 0;
		await checkCommand({});
		expect(io.mocks().stderr).toContain("Interlinked project check");
		spy.mockRestore();
	});
});

// -------------------------------------------------------------------
// Mutation-targeted branch isolation.
//
// The tests above exercise the command's public behaviors; this block adds
// narrowly-scoped tests that isolate individual conditions/operators/literals
// so a mutant flipping ONE of them changes an observable result even when a
// broader test wouldn't notice (e.g. because a later `break`/dedup masks it,
// or because the mutated value never reaches stdout/stderr on its own).
// -------------------------------------------------------------------
describe("checkCommand — mutation-targeted branch isolation", () => {
	let io: ReturnType<typeof captureIO>;

	beforeEach(() => {
		resetGraphState();
		resetEngineState();
		resetFs();
		resetGraphCalls();
		resetEngineCalls();
		secretsHits = new Set();
		anyTypesHits = new Set();
		io = captureIO();
	});

	afterEach(() => {
		io.restore();
	});

	// ---- scanBrokenImports: each `continue` guard isolated on its own file ----

	it("does not flag a file whose only edge has an empty toFile (no-toFile guard)", async () => {
		graphState.files = ["/abs/src/only-empty.ts"];
		graphState.fileCount = 1;
		graphState.deps["/abs/src/only-empty.ts"] = [edge({ toFile: "", specifier: "./x" })];
		await checkCommand({ only: "broken-imports", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	it("does not flag a file whose only edge is a non-existent .json specifier (json-skip guard)", async () => {
		graphState.files = ["/abs/src/only-json.ts"];
		graphState.fileCount = 1;
		// specifier ends with ".json" and toFile does NOT exist: if the endsWith
		// guard (or its continue) is disabled, this falls through to the
		// existsSync check and gets flagged; the guard must skip it first.
		graphState.deps["/abs/src/only-json.ts"] = [
			edge({ specifier: "./data.json", toFile: "/abs/src/data.json" }),
		];
		await checkCommand({ only: "broken-imports", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	it("does not flag a file whose only edge targets a missing node_modules path (node_modules guard)", async () => {
		graphState.files = ["/abs/src/only-nm.ts"];
		graphState.fileCount = 1;
		graphState.deps["/abs/src/only-nm.ts"] = [
			edge({ specifier: "lib", toFile: "/abs/node_modules/lib/index.js" }),
		];
		await checkCommand({ only: "broken-imports", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	// ---- scanCycles: visited-file skip actually changes the result set ----

	it("does not re-process an already-visited file's own cycle list (visited guard)", async () => {
		graphState.files = ["/abs/src/a.ts", "/abs/src/b.ts", "/abs/src/c.ts"];
		graphState.fileCount = 3;
		// a's cycle visits a and b. b, if re-processed despite being visited,
		// would (per this mock) pull in c via its own independent cycle list —
		// something the real algorithm wouldn't produce for a true cycle, but it
		// lets the test observe whether the `visited.has` skip actually ran.
		graphState.cycles["/abs/src/a.ts"] = [["/abs/src/a.ts", "/abs/src/b.ts"]];
		graphState.cycles["/abs/src/b.ts"] = [["/abs/src/b.ts", "/abs/src/c.ts"]];
		await checkCommand({ only: "cycles", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain("src/a.ts");
		expect(stdout).toContain("src/b.ts");
		expect(stdout).not.toContain("src/c.ts");
		expect(stderr).toContain("2 files");
	});

	// ---- scanDuplicates: each exemption disjunct + the dedup key + the >1 gate ----

	it("does not treat two files' `default` exports as duplicates (default-exemption disjunct)", async () => {
		graphState.files = ["/abs/src/x.ts", "/abs/src/y.ts"];
		graphState.fileCount = 2;
		graphState.boundary = { "/abs/src/x.ts": "root", "/abs/src/y.ts": "root" };
		graphState.exports = {
			"/abs/src/x.ts": [exp({ name: "default", kind: "default" })],
			"/abs/src/y.ts": [exp({ name: "default", kind: "default" })],
		};
		await checkCommand({ only: "duplicates", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	it("does not treat two files' `*` exports as duplicates (star-exemption disjunct)", async () => {
		graphState.files = ["/abs/src/x.ts", "/abs/src/y.ts"];
		graphState.fileCount = 2;
		graphState.boundary = { "/abs/src/x.ts": "root", "/abs/src/y.ts": "root" };
		graphState.exports = {
			"/abs/src/x.ts": [exp({ name: "*", kind: "namespace" })],
			"/abs/src/y.ts": [exp({ name: "*", kind: "namespace" })],
		};
		await checkCommand({ only: "duplicates", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	it("does not treat two files' type-only exports as duplicates (isTypeOnly-exemption disjunct)", async () => {
		graphState.files = ["/abs/src/x.ts", "/abs/src/y.ts"];
		graphState.fileCount = 2;
		graphState.boundary = { "/abs/src/x.ts": "root", "/abs/src/y.ts": "root" };
		graphState.exports = {
			"/abs/src/x.ts": [exp({ name: "TypeExp", isTypeOnly: true })],
			"/abs/src/y.ts": [exp({ name: "TypeExp", isTypeOnly: true })],
		};
		await checkCommand({ only: "duplicates", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	it("does not collide two files exporting DIFFERENT names into one dedup key", async () => {
		graphState.files = ["/abs/src/x.ts", "/abs/src/y.ts"];
		graphState.fileCount = 2;
		graphState.boundary = { "/abs/src/x.ts": "root", "/abs/src/y.ts": "root" };
		graphState.exports = {
			"/abs/src/x.ts": [exp({ name: "Alpha" })],
			"/abs/src/y.ts": [exp({ name: "Beta" })],
		};
		await checkCommand({ only: "duplicates", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		// If the dedup key collapses to a constant, Alpha and Beta collide and
		// both get flagged as "duplicates" of each other despite different names.
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	it("does not flag a single file's unique (non-duplicated) export", async () => {
		graphState.files = ["/abs/src/solo.ts"];
		graphState.fileCount = 1;
		graphState.boundary = { "/abs/src/solo.ts": "root" };
		graphState.exports = { "/abs/src/solo.ts": [exp({ name: "Solo" })] };
		await checkCommand({ only: "duplicates", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	// ---- isMissingTestExempt: base.endsWith(".d") isolated from file.endsWith(".d.ts") ----

	it("exempts a base ending in literal '.d' even when the full path is not *.d.ts", async () => {
		// ext=".js" so file.endsWith(".d.ts") is false; only base.endsWith(".d")
		// (true for base "foo.d") can exempt this file.
		graphState.files = ["/abs/src/foo.d.js"];
		graphState.fileCount = 1;
		await checkCommand({ only: "missing-tests", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	// ---- scanMissingTests: each allowed extension is actually scanned ----

	it.each([
		["/abs/src/real.tsx", ".tsx"],
		["/abs/src/real.js", ".js"],
		["/abs/src/real.jsx", ".jsx"],
	])("flags a missing-test source file with extension %s", async (file) => {
		graphState.files = [file];
		graphState.fileCount = 1;
		await checkCommand({ only: "missing-tests", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain(file.replace("/abs/", ""));
		expect(stderr).toContain("1 files");
	});

	// ---- scanMissingTests: the .spec / __tests__ candidate paths individually ----

	it("does not flag a source file when only the flat .spec sibling exists", async () => {
		graphState.files = ["/abs/src/real.ts"];
		graphState.fileCount = 1;
		existing.add("/abs/src/real.spec.ts");
		await checkCommand({ only: "missing-tests", cwd: "/abs" });
		expect(io.mocks().stderr).toContain("0 files");
	});

	it("does not flag a source file when only the __tests__/*.spec sibling exists", async () => {
		graphState.files = ["/abs/src/real.ts"];
		graphState.fileCount = 1;
		existing.add("/abs/src/__tests__/real.spec.ts");
		await checkCommand({ only: "missing-tests", cwd: "/abs" });
		expect(io.mocks().stderr).toContain("0 files");
	});

	// ---- scanFileContent (shared by secrets/any-types): each guard isolated ----

	it("skips a disallowed extension even though its content would trip any-types", async () => {
		graphState.files = ["/abs/src/thing.mdx"];
		graphState.fileCount = 1;
		fileContents.set("/abs/src/thing.mdx", "HAS-ANY-EXT-SKIP");
		anyTypesHits = new Set(["HAS-ANY-EXT-SKIP"]);
		await checkCommand({ only: "any-types", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	it("skips a .d.ts file for any-types (skipDecl=true) even though its content would trip the detector", async () => {
		graphState.files = ["/abs/src/decl.d.ts"];
		graphState.fileCount = 1;
		fileContents.set("/abs/src/decl.d.ts", "HAS-ANY-DECL-SKIP");
		anyTypesHits = new Set(["HAS-ANY-DECL-SKIP"]);
		await checkCommand({ only: "any-types", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	it("flags a .d.ts file for secrets (skipDecl=false) when its content trips the detector", async () => {
		graphState.files = ["/abs/src/leaky.d.ts"];
		graphState.fileCount = 1;
		fileContents.set("/abs/src/leaky.d.ts", "SECRET-IN-DECL");
		secretsHits = new Set(["SECRET-IN-DECL"]);
		await checkCommand({ only: "secrets", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain("src/leaky.d.ts");
		expect(stderr).toContain("1 files");
	});

	it("skips a base ending only in '.test' even though its content would trip the detector", async () => {
		graphState.files = ["/abs/src/only.test.ts"];
		graphState.fileCount = 1;
		fileContents.set("/abs/src/only.test.ts", "SECRET-IN-TEST");
		secretsHits = new Set(["SECRET-IN-TEST"]);
		await checkCommand({ only: "secrets", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	it("skips a base ending only in '.spec' even though its content would trip the detector", async () => {
		graphState.files = ["/abs/src/only.spec.ts"];
		graphState.fileCount = 1;
		fileContents.set("/abs/src/only.spec.ts", "SECRET-IN-SPEC");
		secretsHits = new Set(["SECRET-IN-SPEC"]);
		await checkCommand({ only: "secrets", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	it("flags a __tests__ file for any-types, which does NOT skip test directories", async () => {
		graphState.files = ["/abs/src/__tests__/anyfile.ts"];
		graphState.fileCount = 1;
		fileContents.set("/abs/src/__tests__/anyfile.ts", "HAS-ANY-IN-TESTDIR");
		anyTypesHits = new Set(["HAS-ANY-IN-TESTDIR"]);
		await checkCommand({ only: "any-types", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain("src/__tests__/anyfile.ts");
		expect(stderr).toContain("1 files");
	});

	it("skips a __tests__ file for secrets, which DOES skip test directories", async () => {
		graphState.files = ["/abs/src/__tests__/leaky.ts"];
		graphState.fileCount = 1;
		fileContents.set("/abs/src/__tests__/leaky.ts", "SECRET-IN-TESTS-DIR");
		secretsHits = new Set(["SECRET-IN-TESTS-DIR"]);
		await checkCommand({ only: "secrets", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	it("skips a __mocks__ file for secrets even without __tests__ in the path", async () => {
		graphState.files = ["/abs/src/__mocks__/leaky.ts"];
		graphState.fileCount = 1;
		fileContents.set("/abs/src/__mocks__/leaky.ts", "SECRET-IN-MOCKS-DIR");
		secretsHits = new Set(["SECRET-IN-MOCKS-DIR"]);
		await checkCommand({ only: "secrets", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	it("skips a /tests/ file for secrets even without /test/ in the path", async () => {
		graphState.files = ["/abs/tests/leaky.ts"];
		graphState.fileCount = 1;
		fileContents.set("/abs/tests/leaky.ts", "SECRET-IN-TESTS-SLASH");
		secretsHits = new Set(["SECRET-IN-TESTS-SLASH"]);
		await checkCommand({ only: "secrets", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	// ---- scanSecrets / scanAnyTypes: every allowed extension is actually scanned ----

	it.each([".tsx", ".js", ".jsx", ".mjs", ".cjs"])(
		"flags a %s file for secrets when its content trips the detector",
		async (ext) => {
			const file = `/abs/src/leaky${ext}`;
			graphState.files = [file];
			graphState.fileCount = 1;
			fileContents.set(file, "SECRET-EXT");
			secretsHits = new Set(["SECRET-EXT"]);
			await checkCommand({ only: "secrets", cwd: "/abs" });
			const { stdout, stderr } = io.mocks();
			expect(stdout).toContain(file.replace("/abs/", ""));
			expect(stderr).toContain("1 files");
		},
	);

	it("flags a .tsx file for any-types when its content trips the detector", async () => {
		graphState.files = ["/abs/src/leaky.tsx"];
		graphState.fileCount = 1;
		fileContents.set("/abs/src/leaky.tsx", "HAS-ANY-TSX");
		anyTypesHits = new Set(["HAS-ANY-TSX"]);
		await checkCommand({ only: "any-types", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toContain("src/leaky.tsx");
		expect(stderr).toContain("1 files");
	});

	// ---- scanDeadImports: the ext guard and each allowed extension ----

	it("does not flag a disallowed extension even with unused-import content", async () => {
		graphState.files = ["/abs/other.txt"];
		graphState.fileCount = 1;
		fileContents.set("/abs/other.txt", "import { foo } from './x';\nconst y = 1;");
		await checkCommand({ only: "dead-imports", cwd: "/abs" });
		const { stdout, stderr } = io.mocks();
		expect(stdout).toBe("");
		expect(stderr).toContain("0 files");
	});

	it.each([".tsx", ".js", ".jsx", ".mjs", ".cjs"])(
		"flags a %s file with an unused import",
		async (ext) => {
			const file = `/abs/src/dead${ext}`;
			graphState.files = [file];
			graphState.fileCount = 1;
			fileContents.set(file, "import { foo } from './x';\nconst y = 1;");
			await checkCommand({ only: "dead-imports", cwd: "/abs" });
			const { stdout, stderr } = io.mocks();
			expect(stdout).toContain(file.replace("/abs/", ""));
			expect(stderr).toContain("1 files");
		},
	);

	// ---- resolveCheckPlan / onlyCheck: --only never leaks other checks' results ----

	it("emits only the requested structural check's key in JSON, even though other checks would have findings", async () => {
		graphState.files = ["/abs/src/hub.ts"];
		graphState.fileCount = 1;
		// blast-radius would flag hub.ts (5 dependents); broken-imports would ALSO
		// flag it (a missing target). Only blast-radius was requested.
		graphState.dependents["/abs/src/hub.ts"] = ["a", "b", "c", "d", "e"];
		graphState.deps["/abs/src/hub.ts"] = [edge({ toFile: "/abs/src/gone.ts" })];
		await checkCommand({ only: "blast-radius", json: true, cwd: "/abs" });
		const { stdout } = io.mocks();
		// SAFETY: JSON.parse of our own captured stdout in a controlled test.
		const parsed = JSON.parse(stdout) as Record<string, unknown>;
		expect(parsed).toStrictEqual({ "blast-radius": { count: 1, files: ["src/hub.ts"] } });
	});

	// ---- runEngine / runStructural gating ----

	it("never constructs the engine or writes 'running external tools' on a plain structural run", async () => {
		graphState.files = [];
		graphState.fileCount = 0;
		await checkCommand({ cwd: "/abs" });
		const { stderr } = io.mocks();
		expect(stderr).not.toContain("running external tools");
		expect(engineCalls.runChecksCalls.length).toBe(0);
	});

	it("never constructs the project graph on an engine-only (--only tsc) run", async () => {
		engineState.report = report({
			toolsRun: [{ id: "tsc", available: true, version: "5.0" }],
			results: [],
		});
		await checkCommand({ only: "tsc", cwd: "/abs" });
		expect(graphCalls.constructedCwd.length).toBe(0);
		expect(graphCalls.initializeCalls).toBe(0);
	});

	it("constructs the project graph exactly once on a plain structural run", async () => {
		graphState.files = [];
		graphState.fileCount = 0;
		await checkCommand({ cwd: "/abs" });
		expect(graphCalls.constructedCwd).toStrictEqual(["/abs"]);
		expect(graphCalls.initializeCalls).toBe(1);
	});

	it("resolving an engine-only --only with --json does not crash on the structural fallback array", async () => {
		engineState.report = report({
			toolsRun: [{ id: "tsc", available: true, version: "5.0" }],
			results: [{ tool: "tsc", severity: "error", file: "a.ts", line: 1, message: "boom" }],
		});
		await checkCommand({ only: "tsc", json: true, cwd: "/abs" });
		const { stdout } = io.mocks();
		// SAFETY: JSON.parse of our own captured stdout in a controlled test.
		const parsed = JSON.parse(stdout) as Record<string, unknown>;
		expect(parsed).toStrictEqual({
			tsc: {
				count: 1,
				findings: [{ file: "a.ts", line: 1, severity: "error", message: "boom" }],
			},
		});
	});

	// ---- runEngineChecks: cwd/scope/options pass-through, captured precisely ----

	it("passes the exact scope object through to engine.runChecks", async () => {
		engineState.report = report({ toolsRun: [], results: [] });
		await checkCommand({ tools: true, cwd: "/xyz" });
		expect(engineCalls.runChecksCalls).toHaveLength(1);
		expect(engineCalls.runChecksCalls[0]?.scope).toStrictEqual({
			projectRoot: "/xyz",
			mode: "project",
		});
	});

	it("omits the tools filter entirely (no `tools` key) when no engine filter is resolved", async () => {
		engineState.report = report({ toolsRun: [], results: [] });
		await checkCommand({ tools: true, cwd: "/abs" });
		expect(engineCalls.runChecksCalls[0]?.opts).toStrictEqual({ timeoutMs: 30_000 });
	});

	it("passes the resolved single-tool filter through to engine.runChecks for --only tsc", async () => {
		engineState.report = report({ toolsRun: [], results: [] });
		await checkCommand({ only: "tsc", cwd: "/abs" });
		expect(engineCalls.runChecksCalls[0]?.opts).toStrictEqual({
			tools: ["tsc"],
			timeoutMs: 30_000,
		});
	});

	it("does not apply the engine-only tools filter when --only names a structural check", async () => {
		engineState.report = report({ toolsRun: [], results: [] });
		await checkCommand({ only: "blast-radius", tools: true, cwd: "/abs" });
		expect(engineCalls.runChecksCalls[0]?.opts).toStrictEqual({ timeoutMs: 30_000 });
	});

	it("resolves a comma-separated --tools string, trimmed and filtered, in original order", async () => {
		engineState.report = report({ toolsRun: [], results: [] });
		await checkCommand({ tools: " tsc , ,biome ", cwd: "/abs" });
		expect(engineCalls.runChecksCalls[0]?.opts).toStrictEqual({
			tools: ["tsc", "biome"],
			timeoutMs: 30_000,
		});
	});

	it("drops a discovery-only id from the --tools filter but keeps the runnable ones", async () => {
		engineState.report = report({ toolsRun: [], results: [] });
		await checkCommand({ tools: "dep-audit,tsc", cwd: "/abs" });
		expect(engineCalls.runChecksCalls[0]?.opts).toStrictEqual({
			tools: ["tsc"],
			timeoutMs: 30_000,
		});
	});

	// ---- the --tools discovery-only drop warning: trims before matching, and is silent when nothing is dropped ----

	it("recognizes a discovery-only id in --tools even with surrounding whitespace", async () => {
		await checkCommand({ tools: "tsc, dep-audit ,biome", cwd: "/abs" });
		const { stderr } = io.mocks();
		expect(stderr).toContain(
			"Skipping discovery-only tool(s) dep-audit from --tools — no interlinked check runner; run interlinked verify instead.\n",
		);
	});

	it("prints no discovery-only warning when --tools names only runnable tools", async () => {
		await checkCommand({ tools: "tsc,biome", cwd: "/abs" });
		expect(io.mocks().stderr).not.toContain("Skipping discovery-only");
	});

	// ---- exact unknown-check rejection message + exit code ----

	it("rejects an unknown --only check with the exact message and exit code, writing nothing else", async () => {
		await checkCommand({ only: "not-a-real-check", cwd: "/abs" });
		const { stdout, stderr, exitCode } = io.mocks();
		expect(stderr).toBe(
			`Unknown check: "not-a-real-check". Available: broken-imports, cycles, duplicates, missing-tests, secrets, any-types, blast-radius, dead-imports, tsc, biome, eslint, oxlint, knip, semgrep, gitleaks, dep-audit, mypy, ruff, ruff-format, cargo-check, cargo-clippy, rustfmt, go-build, golangci-lint, go-test, c-compile, clang-tidy, shellcheck, actionlint, hadolint, taplo, swiftlint, swift-build, lizard, docs-check\n`,
		);
		expect(stdout).toBe("");
		expect(exitCode).toBe(1);
	});

	// ---- cwd resolution: the exact string flows through, not a boolean ----

	it("passes the exact explicit cwd through to both the graph and engine constructors", async () => {
		engineState.report = report({ toolsRun: [], results: [] });
		graphState.files = [];
		graphState.fileCount = 0;
		await checkCommand({ cwd: "/xyz-test", tools: true });
		expect(graphCalls.constructedCwd).toStrictEqual(["/xyz-test"]);
		expect(engineCalls.constructedCwd).toStrictEqual(["/xyz-test"]);
	});
});
