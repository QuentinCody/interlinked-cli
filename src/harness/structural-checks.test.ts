// Behavioral companion tests for structural-checks.ts — the thin orchestrator
// for runStructuralChecks (PostToolUse dispatch) and getPreToolUseContext
// (PreToolUse context injection).
//
// Strategy: the orchestrator delegates the *work* of every check to sibling
// modules. We mock those siblings so each returns a controllable result, then
// drive every gate / branch / ternary in the orchestrator itself with realistic
// inputs. The real helpers (isWriteOperation / isReadOperation / extractFilePath
// / exportSurfaceChanged) are NOT mocked — the orchestrator's branch coverage
// depends on their real behavior. The ProjectGraph / SessionTracker / RouteMap /
// SessionTrajectory inputs use complete fixtures with controlled methods.

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- node:fs: only existsSync is read by structural-checks (sibling_awareness) ---
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
}));

// --- Delegated check modules: return controllable results so the orchestrator's
//     own branches are what we exercise. ---
vi.mock("./structural-checks/export-surface.js", () => ({
	checkExportSurface: vi.fn(() => []),
	checkExportRippleCompilation: vi.fn(() => []),
	checkRippleTests: vi.fn(() => []),
	findTestFileForSource: vi.fn(() => null),
}));
vi.mock("./structural-checks/imports.js", () => ({
	checkImportResolution: vi.fn(() => []),
	checkDuplicateSymbols: vi.fn(() => []),
	checkDeadImports: vi.fn(() => []),
	checkHallucinatedImports: vi.fn(() => []),
	checkCrossPackageImports: vi.fn(() => []),
}));
vi.mock("./structural-checks/misc-checks.js", () => ({
	checkCoDependencyStaleness: vi.fn(() => []),
	checkInterfaceChangeImpact: vi.fn(() => []),
	checkTestProximity: vi.fn(() => []),
	checkJSDocParamMismatch: vi.fn(() => []),
}));
vi.mock("./structural-checks/cycles.js", () => ({
	checkImportCycles: vi.fn(() => []),
}));
vi.mock("./structural-checks/new-import-cycle.js", () => ({
	checkNewImportCycle: vi.fn(() => []),
}));
vi.mock("./structural-checks/dead-exports.js", () => ({
	checkDeadExports: vi.fn(() => []),
}));
vi.mock("./structural-checks/env-vars.js", () => ({
	checkUndefinedEnvVars: vi.fn(() => []),
}));
vi.mock("./cross-file-checks.js", () => ({
	checkCrossFileSwitchDiscriminant: vi.fn(() => []),
	checkSingleImplementationInterface: vi.fn(() => []),
}));
vi.mock("./change-propagation.js", () => ({
	findPropagationTargets: vi.fn(() => []),
	formatPropagationWarnings: vi.fn(() => []),
}));
vi.mock("./impact-analysis.js", () => ({
	checkFollowUpViolation: vi.fn(() => null),
}));
vi.mock("./dependency-view.js", () => ({
	resolveDependencyView: vi.fn(() => ({
		getDependents: () => [],
		classifyModule: () => "leaf",
		source: "internal",
	})),
}));

import { existsSync } from "node:fs";
import { findPropagationTargets, formatPropagationWarnings } from "./change-propagation.js";
import {
	checkCrossFileSwitchDiscriminant,
	checkSingleImplementationInterface,
} from "./cross-file-checks.js";
import { type DependencyView, resolveDependencyView } from "./dependency-view.js";
import { makeSession } from "./__tests__/fixtures/evaluator.js";
import { checkFollowUpViolation } from "./impact-analysis.js";
import { ProjectGraph } from "./project-graph.js";
import { RouteMap } from "./route-map.js";
import { SessionTracker } from "./session-state.js";
import { checkImportCycles } from "./structural-checks/cycles.js";
import {
	checkExportRippleCompilation,
	checkExportSurface,
	checkRippleTests,
	findTestFileForSource,
} from "./structural-checks/export-surface.js";
import { checkImportResolution } from "./structural-checks/imports.js";
import { checkJSDocParamMismatch } from "./structural-checks/misc-checks.js";
import { checkNewImportCycle } from "./structural-checks/new-import-cycle.js";
import {
	getPreToolUseContext,
	runStructuralChecks,
	shouldSkipTsc,
} from "./structural-checks.js";
import type { Endpoint } from "./types/session.js";
import type {
	ExportedSymbol,
	HarnessEvent,
	SessionTrajectory,
	StructuralChecksConfig,
} from "./types.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedResolveDependencyView = vi.mocked(resolveDependencyView);

// ---------------------------------------------------------------------------
// Fixtures / builders
// ---------------------------------------------------------------------------

/** A fully-enabled structural config — individual tests flip flags off. */
function fullConfig(over: Partial<StructuralChecksConfig> = {}): StructuralChecksConfig {
	return {
		enabled: true,
		export_surface: true,
		import_resolution: true,
		duplicate_symbols: true,
		co_dependency_staleness: true,
		import_cycles: true,
		interface_change_impact: true,
		test_proximity: true,
		smart_tsc: true,
		blast_radius: true,
		stale_read_warning: true,
		sibling_awareness: true,
		staleness_window_s: 300,
		blast_radius_threshold: 3,
		recently_failed: true,
		completion_tracking: true,
		route_context: true,
		redundant_reread: true,
		dead_imports: true,
		completion_reminder_threshold: 10,
		dead_exports: true,
		hallucinated_imports: true,
		cross_package_imports: true,
		undefined_env_vars: true,
		layer_violations: true,
		impact_analysis: true,
		impact_high_threshold: 4,
		test_first: true,
		test_first_mode: "nudge",
		...over,
	};
}

/** Real graph state with controlled discovery methods. */
function fakeGraph(over: Partial<ProjectGraph> = {}): ProjectGraph {
	const graph = new ProjectGraph("/repo");
	const { isInitialized = true, ...methods } = over;
	vi.spyOn(graph, "isInitialized", "get").mockReturnValue(isInitialized);
	const defaults: Partial<ProjectGraph> = {
		toRelative: (f: string) => f.replace(/^\/repo\//, ""),
		getProjectBoundary: () => "/repo",
		getDependents: () => [],
		getSiblingFiles: () => [],
		findCyclesThrough: () => [],
		classifyModule: () => "leaf",
	};
	return Object.assign(graph, defaults, methods);
}

/** Fake SessionTracker: only getAll() is read. */
function fakeSessions(all: SessionTrajectory[] = []): SessionTracker {
	const tracker = new SessionTracker();
	vi.spyOn(tracker, "getAll").mockReturnValue(all);
	return tracker;
}

/** Minimal SessionTrajectory with empty maps/sets — tests populate specifics. */
function fakeSession(over: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		...makeSession(),
		session_id: "s1",
		agent_name: "agent-a",
		tool_call_count: 100,
		failed_files: new Map(),
		test_runs: new Map(),
		files_written: new Set<string>(),
		file_read_at: new Map<string, number>(),
		file_write_times: new Map<string, string>(),
		pending_completions: new Map(),
		...over,
	};
}

function dependencyView(over: Partial<DependencyView> = {}): DependencyView {
	return {
		answerScope: "repo", source: "internal",
		getDependents: () => [], hasFile: () => true,
		classifyModule: () => "leaf", getBlastRadius: () => null,
		getCallers: () => [], ...over,
	};
}

function evt(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		timestamp: "2026-06-06T00:00:00Z",
		...over,
	};
}

/** Build a PostToolUse-shaped event for a write to `file`. */
function writeEvent(file: string, tool = "Edit"): HarnessEvent {
	return evt({ tool_name: tool, tool_input: { file_path: file } });
}

const TS = "/repo/src/foo.ts";

beforeEach(() => {
	vi.clearAllMocks();
	mockedExistsSync.mockReturnValue(false);
	mockedResolveDependencyView.mockReturnValue(dependencyView({
		getDependents: () => [],
		classifyModule: () => "leaf",
		source: "internal",
	}));
});

// ===========================================================================
// runStructuralChecks
// ===========================================================================

describe("runStructuralChecks — guards / early returns", () => {
	const graph = fakeGraph();
	const sessions = fakeSessions();
	const noExports: ExportedSymbol[] = [];
	const noBodies = new Map<string, string>();

	it("returns [] when config.enabled is false", () => {
		const out = runStructuralChecks(
			writeEvent(TS),
			fullConfig({ enabled: false }),
			graph,
			sessions,
			noExports,
			noBodies,
		);
		expect(out).toEqual([]);
		expect(checkExportSurface).not.toHaveBeenCalled();
	});

	it("returns [] when no file path is present", () => {
		const out = runStructuralChecks(
			evt({ tool_name: "Edit", tool_input: {} }),
			fullConfig(),
			graph,
			sessions,
			noExports,
			noBodies,
		);
		expect(out).toEqual([]);
	});

	it("returns [] for a non-TS/JS extension", () => {
		const out = runStructuralChecks(
			writeEvent("/repo/README.md"),
			fullConfig(),
			graph,
			sessions,
			noExports,
			noBodies,
		);
		expect(out).toEqual([]);
	});

	it("returns [] when the file resolves outside the project root", () => {
		const outside = fakeGraph({ toRelative: () => "../other/x.ts" });
		const out = runStructuralChecks(
			writeEvent("/elsewhere/x.ts"),
			fullConfig(),
			outside,
			sessions,
			noExports,
			noBodies,
		);
		expect(out).toEqual([]);
	});

	it("accepts each TS/JS extension variant", () => {
		for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
			(vi.mocked(checkExportSurface)).mockClear();
			runStructuralChecks(
				writeEvent(`/repo/src/foo${ext}`),
				fullConfig(),
				graph,
				sessions,
				noExports,
				noBodies,
			);
			expect(checkExportSurface).toHaveBeenCalled();
		}
	});
});

describe("runStructuralChecks — per-check dispatch", () => {
	const graph = fakeGraph();
	const sessions = fakeSessions();
	const noExports: ExportedSymbol[] = [];
	const noBodies = new Map<string, string>();

	it("runs the full enabled pipeline and aggregates every check's results", () => {
		// Give a couple of checks something to return so aggregation is observable.
		(vi.mocked(checkExportSurface)).mockReturnValue([
			{ check: "export_surface", severity: "warning", message: "m", file: TS },
		]);
		(vi.mocked(checkImportResolution)).mockReturnValue([
			{ check: "import_resolution", severity: "warning", message: "m", file: TS },
		]);

		const out = runStructuralChecks(
			writeEvent(TS),
			fullConfig(),
			graph,
			sessions,
			noExports,
			noBodies,
		);

		const checks = out.map((r) => r.check);
		expect(checks).toContain("export_surface");
		expect(checks).toContain("import_resolution");
		// Every gated check function was invoked under the full config.
		expect(checkExportSurface).toHaveBeenCalled();
		expect(checkImportResolution).toHaveBeenCalled();
		expect(checkImportCycles).toHaveBeenCalled();
		expect(checkNewImportCycle).toHaveBeenCalled();
		expect(checkJSDocParamMismatch).toHaveBeenCalled();
		expect(checkCrossFileSwitchDiscriminant).toHaveBeenCalled();
		expect(checkSingleImplementationInterface).toHaveBeenCalled();
	});

	it("leaves compilation and test execution to the async quality phase", () => {
		(vi.mocked(checkExportSurface)).mockReturnValue([
			{
				check: "export_surface",
				severity: "warning",
				message: "removed",
				file: TS,
				affectedFiles: ["/repo/src/bar.ts"],
			},
		]);

		runStructuralChecks(writeEvent(TS), fullConfig(), graph, sessions, noExports, noBodies);

		expect(checkExportRippleCompilation).not.toHaveBeenCalled();
		expect(checkRippleTests).not.toHaveBeenCalled();
	});

	it("skips ripple tier when export surface produced no affected files", () => {
		(vi.mocked(checkExportSurface)).mockReturnValue([
			{ check: "export_surface", severity: "warning", message: "x", file: TS },
		]);

		runStructuralChecks(writeEvent(TS), fullConfig(), graph, sessions, noExports, noBodies);

		expect(checkExportRippleCompilation).not.toHaveBeenCalled();
		expect(checkRippleTests).not.toHaveBeenCalled();
	});

	it("skips every optional check when its flag is off but still runs the unconditional checks", () => {
		const off = fullConfig({
			export_surface: false,
			import_resolution: false,
			duplicate_symbols: false,
			co_dependency_staleness: false,
			dead_imports: false,
			import_cycles: false,
			interface_change_impact: false,
			test_proximity: false,
			dead_exports: false,
			hallucinated_imports: false,
			cross_package_imports: false,
			undefined_env_vars: false,
			// The two taste checks and new_import_cycle are gated by `!== false`,
			// so flip them off too.
			cross_file_switch_discriminant: false,
			single_implementation_interface: false,
			new_import_cycle: false,
		});

		runStructuralChecks(writeEvent(TS), off, graph, sessions, noExports, noBodies);

		expect(checkExportSurface).not.toHaveBeenCalled();
		expect(checkImportResolution).not.toHaveBeenCalled();
		expect(checkImportCycles).not.toHaveBeenCalled();
		expect(checkNewImportCycle).not.toHaveBeenCalled();
		expect(checkCrossFileSwitchDiscriminant).not.toHaveBeenCalled();
		expect(checkSingleImplementationInterface).not.toHaveBeenCalled();
		// jsdoc is unconditional — always runs.
		expect(checkJSDocParamMismatch).toHaveBeenCalled();
	});

	it("runs the taste checks when their flags are explicitly true (not just defaulted)", () => {
		const cfg = fullConfig({
			cross_file_switch_discriminant: true,
			single_implementation_interface: true,
		});
		runStructuralChecks(writeEvent(TS), cfg, graph, sessions, noExports, noBodies);
		expect(checkCrossFileSwitchDiscriminant).toHaveBeenCalled();
		expect(checkSingleImplementationInterface).toHaveBeenCalled();
	});
});

// ===========================================================================
// shouldSkipTsc
// ===========================================================================

describe("shouldSkipTsc", () => {
	const a: ExportedSymbol[] = [{ name: "foo", kind: "function", isTypeOnly: false, line: 1 }];
	const aPlus: ExportedSymbol[] = [
		{ name: "foo", kind: "function", isTypeOnly: false, line: 1 },
		{ name: "bar", kind: "const", isTypeOnly: false, line: 2 },
	];

	it("returns false when smart_tsc is disabled", () => {
		expect(shouldSkipTsc(fullConfig({ smart_tsc: false }), a, aPlus)).toBe(false);
	});

	it("returns true for an internal-only edit (export surface unchanged)", () => {
		expect(shouldSkipTsc(fullConfig({ smart_tsc: true }), a, a)).toBe(true);
	});

	it("returns false when the export surface changed", () => {
		expect(shouldSkipTsc(fullConfig({ smart_tsc: true }), a, aPlus)).toBe(false);
	});
});

// ===========================================================================
// getPreToolUseContext — guards
// ===========================================================================

describe("getPreToolUseContext — guards / early returns", () => {
	const sessions = fakeSessions();

	it("returns [] when config is disabled", () => {
		expect(
			getPreToolUseContext(writeEvent(TS), fullConfig({ enabled: false }), fakeGraph(), sessions),
		).toEqual([]);
	});

	it("returns [] when the graph is not initialized", () => {
		expect(
			getPreToolUseContext(writeEvent(TS), fullConfig(), fakeGraph({ isInitialized: false }), sessions),
		).toEqual([]);
	});

	it("returns [] when there is no file path", () => {
		expect(
			getPreToolUseContext(evt({ tool_name: "Edit", tool_input: {} }), fullConfig(), fakeGraph(), sessions),
		).toEqual([]);
	});

	it("returns [] for a non-code extension", () => {
		expect(
			getPreToolUseContext(writeEvent("/repo/notes.txt"), fullConfig(), fakeGraph(), sessions),
		).toEqual([]);
	});

	it("returns [] when the file is outside the project root", () => {
		const g = fakeGraph({ toRelative: () => "../x.ts" });
		expect(getPreToolUseContext(writeEvent("/x.ts"), fullConfig(), g, sessions)).toEqual([]);
	});

	it("defaults toolName to empty string when the event omits tool_name", () => {
		// tool_name absent → `event.tool_name || ""` takes the "" fallback;
		// every write/read-gated block is skipped, so no warnings are produced
		// even though the file path resolves cleanly inside the project.
		const e = evt({ tool_input: { file_path: TS } });
		const out = getPreToolUseContext(e, fullConfig(), fakeGraph(), sessions, fakeSession());
		expect(out).toEqual([]);
	});
});

// ===========================================================================
// getPreToolUseContext — recently-failed
// ===========================================================================

describe("getPreToolUseContext — recently-failed-here", () => {
	it("warns when touching a file with unresolved failures", () => {
		const session = fakeSession({
			tool_call_count: 50,
			failed_files: new Map([
				[
					TS,
					{
						failure_count: 2,
						checks: ["tsc", "biome"],
						recorded_at: "2026-06-06T00:00:00Z",
						tool_call_count: 45,
					},
				],
			]),
		});
		// Disable other write-path warnings so we isolate this one.
		const cfg = fullConfig({
			blast_radius: false,
			sibling_awareness: false,
			test_first: false,
			completion_tracking: false,
			impact_analysis: false,
		});
		const out = getPreToolUseContext(writeEvent(TS), cfg, fakeGraph(), fakeSessions(), session);
		const w = out.find((m) => m.includes("recently-failed"));
		expect(w).toBeDefined();
		expect(w).toContain("2 check failure(s)");
		expect(w).toContain("tsc, biome");
		expect(w).toContain("5 tool call(s) ago");
	});

	it("does not warn when the file has no failure entry", () => {
		const session = fakeSession({ failed_files: new Map() });
		const out = getPreToolUseContext(
			writeEvent(TS),
			fullConfig({ blast_radius: false, sibling_awareness: false, test_first: false }),
			fakeGraph(),
			fakeSessions(),
			session,
		);
		expect(out.some((m) => m.includes("recently-failed"))).toBe(false);
	});

	it("does not warn when recently_failed is disabled", () => {
		const session = fakeSession({
			failed_files: new Map([
				[TS, { failure_count: 1, checks: ["tsc"], recorded_at: "t", tool_call_count: 1 }],
			]),
		});
		const out = getPreToolUseContext(
			writeEvent(TS),
			fullConfig({ recently_failed: false, blast_radius: false, test_first: false }),
			fakeGraph(),
			fakeSessions(),
			session,
		);
		expect(out.some((m) => m.includes("recently-failed"))).toBe(false);
	});

	it("checks failures on read operations too", () => {
		const session = fakeSession({
			tool_call_count: 10,
			failed_files: new Map([
				[TS, { failure_count: 1, checks: ["tsc"], recorded_at: "t", tool_call_count: 3 }],
			]),
		});
		const out = getPreToolUseContext(
			evt({ tool_name: "Read", tool_input: { file_path: TS } }),
			fullConfig(),
			fakeGraph(),
			fakeSessions(),
			session,
		);
		expect(out.some((m) => m.includes("recently-failed"))).toBe(true);
	});
});

// ===========================================================================
// getPreToolUseContext — test-first
// ===========================================================================

describe("getPreToolUseContext — test-first nudge", () => {
	const baseCfg = () =>
		fullConfig({
			recently_failed: false,
			blast_radius: false,
			sibling_awareness: false,
			completion_tracking: false,
			impact_analysis: false,
		});

	it("warns when no test file exists for a source file", () => {
		(vi.mocked(findTestFileForSource)).mockReturnValue(null);
		const session = fakeSession();
		const out = getPreToolUseContext(writeEvent(TS), baseCfg(), fakeGraph(), fakeSessions(), session);
		const w = out.find((m) => m.includes("test-first"));
		expect(w).toContain("No test file found");
	});

	it("warns when the test file exists but has not been run this session", () => {
		const testPath = "/repo/src/foo.test.ts";
		(vi.mocked(findTestFileForSource)).mockReturnValue(testPath);
		const session = fakeSession({
			test_runs: new Map(),
		});
		const out = getPreToolUseContext(writeEvent(TS), baseCfg(), fakeGraph(), fakeSessions(), session);
		const w = out.find((m) => m.includes("test-first"));
		expect(w).toContain("haven't been run this session");
	});

	it("stays silent when the test file has already been run", () => {
		const testPath = "/repo/src/foo.test.ts";
		(vi.mocked(findTestFileForSource)).mockReturnValue(testPath);
		const session = fakeSession({
			test_runs: new Map([[testPath, { status: "pass" as const, at_step: 1 }]]),
		});
		const out = getPreToolUseContext(writeEvent(TS), baseCfg(), fakeGraph(), fakeSessions(), session);
		expect(out.some((m) => m.includes("test-first"))).toBe(false);
	});

	it("does not nudge when editing a test file itself (filename pattern)", () => {
		const out = getPreToolUseContext(
			writeEvent("/repo/src/foo.test.ts"),
			baseCfg(),
			fakeGraph(),
			fakeSessions(),
			fakeSession(),
		);
		expect(out.some((m) => m.includes("test-first"))).toBe(false);
	});

	it("does not nudge when editing a file under __tests__", () => {
		const out = getPreToolUseContext(
			writeEvent("/repo/src/__tests__/foo.ts"),
			baseCfg(),
			fakeGraph(),
			fakeSessions(),
			fakeSession(),
		);
		expect(out.some((m) => m.includes("test-first"))).toBe(false);
	});

	it("does not nudge on read operations", () => {
		const out = getPreToolUseContext(
			evt({ tool_name: "Read", tool_input: { file_path: TS } }),
			baseCfg(),
			fakeGraph(),
			fakeSessions(),
			fakeSession(),
		);
		expect(out.some((m) => m.includes("test-first"))).toBe(false);
	});

	it("does not nudge when test_first is disabled", () => {
		const out = getPreToolUseContext(
			writeEvent(TS),
			{ ...baseCfg(), test_first: false },
			fakeGraph(),
			fakeSessions(),
			fakeSession(),
		);
		expect(out.some((m) => m.includes("test-first"))).toBe(false);
	});
});

// ===========================================================================
// getPreToolUseContext — blast radius
// ===========================================================================

describe("getPreToolUseContext — blast radius", () => {
	const cfg = (over: Partial<StructuralChecksConfig> = {}) =>
		fullConfig({
			recently_failed: false,
			test_first: false,
			sibling_awareness: false,
			completion_tracking: false,
			impact_analysis: false,
			blast_radius_threshold: 3,
			...over,
		});

	it("warns with hub-module label when dependents meet the threshold and role is hub", () => {
		mockedResolveDependencyView.mockReturnValue(dependencyView({
			getDependents: () => ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"],
			classifyModule: () => "hub",
			source: "internal",
		}));
		const out = getPreToolUseContext(writeEvent(TS), cfg(), fakeGraph(), fakeSessions());
		const w = out.find((m) => m.includes("blast-radius"));
		expect(w).toContain("(hub module)");
		expect(w).toContain("imported by 3 files");
		expect(w).toContain("Changes to exports will have wide impact.");
		expect(w).not.toContain("Supermodel");
	});

	it("omits the hub label for a non-hub role", () => {
		mockedResolveDependencyView.mockReturnValue(dependencyView({
			getDependents: () => ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"],
			classifyModule: () => "internal",
			source: "internal",
		}));
		const out = getPreToolUseContext(writeEvent(TS), cfg(), fakeGraph(), fakeSessions());
		const w = out.find((m) => m.includes("blast-radius"));
		expect(w).not.toContain("(hub module)");
	});

	it("truncates the dependent list at five and reports the overflow count", () => {
		const deps = Array.from({ length: 8 }, (_, i) => `/repo/src/d${i}.ts`);
		mockedResolveDependencyView.mockReturnValue(dependencyView({
			getDependents: () => deps,
			classifyModule: () => "hub",
			source: "internal",
		}));
		const out = getPreToolUseContext(writeEvent(TS), cfg(), fakeGraph(), fakeSessions());
		const w = out.find((m) => m.includes("blast-radius"));
		expect(w).toContain("imported by 8 files");
		expect(w).toContain("and 3 more");
	});

	it("adds the Supermodel provenance clause when the view source is supermodel", () => {
		mockedResolveDependencyView.mockReturnValue(dependencyView({
			getDependents: () => ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"],
			classifyModule: () => "hub",
			source: "supermodel",
		}));
		const out = getPreToolUseContext(writeEvent(TS), cfg(), fakeGraph(), fakeSessions());
		const w = out.find((m) => m.includes("blast-radius"));
		expect(w).toContain("per Supermodel `.graph` shard");
	});

	it("does not warn when dependents are below the threshold", () => {
		mockedResolveDependencyView.mockReturnValue(dependencyView({
			getDependents: () => ["/repo/src/a.ts"],
			classifyModule: () => "leaf",
			source: "internal",
		}));
		const out = getPreToolUseContext(writeEvent(TS), cfg(), fakeGraph(), fakeSessions());
		expect(out.some((m) => m.includes("blast-radius"))).toBe(false);
	});

	it("does not run on read operations", () => {
		const out = getPreToolUseContext(
			evt({ tool_name: "Read", tool_input: { file_path: TS } }),
			cfg(),
			fakeGraph(),
			fakeSessions(),
		);
		expect(out.some((m) => m.includes("blast-radius"))).toBe(false);
		expect(resolveDependencyView).not.toHaveBeenCalled();
	});

	it("uses event.cwd when provided for the dependency view resolution", () => {
		mockedResolveDependencyView.mockReturnValue(dependencyView({
			getDependents: () => [],
			classifyModule: () => "leaf",
			source: "internal",
		}));
		const e = evt({ tool_name: "Edit", tool_input: { file_path: TS }, cwd: "/repo" });
		getPreToolUseContext(e, cfg(), fakeGraph(), fakeSessions());
		expect(resolveDependencyView).toHaveBeenCalledWith(TS, "/repo", expect.anything());
	});
});

// ===========================================================================
// getPreToolUseContext — stale read
// ===========================================================================

describe("getPreToolUseContext — stale read warning", () => {
	const readEvt = evt({ tool_name: "Read", tool_input: { file_path: TS }, agent_name: "agent-a" });
	const cfg = fullConfig({
		recently_failed: false,
		redundant_reread: false,
		route_context: false,
	});

	it("warns when another agent wrote the file within the staleness window", () => {
		const other = fakeSession({
			agent_name: "agent-b",
			file_write_times: new Map([[TS, new Date(Date.now() - 10_000).toISOString()]]),
		});
		const out = getPreToolUseContext(readEvt, cfg, fakeGraph(), fakeSessions([other]));
		const w = out.find((m) => m.includes("stale-read"));
		expect(w).toContain("was modified by agent-b");
		expect(w).toContain("Contents may differ");
	});

	it("ignores writes from the same agent", () => {
		const same = fakeSession({
			agent_name: "agent-a",
			file_write_times: new Map([[TS, new Date(Date.now() - 5_000).toISOString()]]),
		});
		const out = getPreToolUseContext(readEvt, cfg, fakeGraph(), fakeSessions([same]));
		expect(out.some((m) => m.includes("stale-read"))).toBe(false);
	});

	it("ignores writes older than the staleness window", () => {
		const other = fakeSession({
			agent_name: "agent-b",
			file_write_times: new Map([[TS, new Date(Date.now() - 10 * 60_000).toISOString()]]),
		});
		const out = getPreToolUseContext(readEvt, cfg, fakeGraph(), fakeSessions([other]));
		expect(out.some((m) => m.includes("stale-read"))).toBe(false);
	});

	it("ignores sessions with no recorded write for the file", () => {
		const other = fakeSession({ agent_name: "agent-b", file_write_times: new Map() });
		const out = getPreToolUseContext(readEvt, cfg, fakeGraph(), fakeSessions([other]));
		expect(out.some((m) => m.includes("stale-read"))).toBe(false);
	});

	it("does not run when stale_read_warning is disabled", () => {
		const other = fakeSession({
			agent_name: "agent-b",
			file_write_times: new Map([[TS, new Date(Date.now() - 1_000).toISOString()]]),
		});
		const out = getPreToolUseContext(
			readEvt,
			{ ...cfg, stale_read_warning: false },
			fakeGraph(),
			fakeSessions([other]),
		);
		expect(out.some((m) => m.includes("stale-read"))).toBe(false);
	});

	it("handles a missing agent_name on the event (defaults to empty string)", () => {
		const noName = evt({ tool_name: "Read", tool_input: { file_path: TS } });
		// An empty-string agent_name on the event still won't match "agent-b".
		const other = fakeSession({
			agent_name: "agent-b",
			file_write_times: new Map([[TS, new Date(Date.now() - 1_000).toISOString()]]),
		});
		const out = getPreToolUseContext(noName, cfg, fakeGraph(), fakeSessions([other]));
		expect(out.some((m) => m.includes("stale-read"))).toBe(true);
	});
});

// ===========================================================================
// getPreToolUseContext — redundant re-read
// ===========================================================================

describe("getPreToolUseContext — redundant re-read", () => {
	const readEvt = evt({ tool_name: "Read", tool_input: { file_path: TS }, agent_name: "agent-a" });
	const cfg = fullConfig({
		recently_failed: false,
		stale_read_warning: false,
		route_context: false,
	});

	it("warns when re-reading a file unchanged since the last read", () => {
		const session = fakeSession({
			tool_call_count: 20,
			file_read_at: new Map([[TS, 12]]),
			files_written: new Set(),
		});
		const out = getPreToolUseContext(readEvt, cfg, fakeGraph(), fakeSessions(), session);
		const w = out.find((m) => m.includes("redundant-reread"));
		expect(w).toContain("8 tool call(s) ago");
		expect(w).toContain("hasn't changed");
	});

	it("stays silent when this session has written the file since reading", () => {
		const session = fakeSession({
			tool_call_count: 20,
			file_read_at: new Map([[TS, 12]]),
			files_written: new Set([TS]),
		});
		const out = getPreToolUseContext(readEvt, cfg, fakeGraph(), fakeSessions(), session);
		expect(out.some((m) => m.includes("redundant-reread"))).toBe(false);
	});

	it("stays silent when another session wrote the file since reading", () => {
		const session = fakeSession({
			tool_call_count: 20,
			file_read_at: new Map([[TS, 12]]),
			files_written: new Set(),
		});
		const other = fakeSession({
			session_id: "other",
			file_write_times: new Map([[TS, "2026-06-06T00:00:00Z"]]),
		});
		const out = getPreToolUseContext(readEvt, cfg, fakeGraph(), fakeSessions([session, other]), session);
		expect(out.some((m) => m.includes("redundant-reread"))).toBe(false);
	});

	it("does not warn when the file was never read before", () => {
		const session = fakeSession({ tool_call_count: 20, file_read_at: new Map() });
		const out = getPreToolUseContext(readEvt, cfg, fakeGraph(), fakeSessions(), session);
		expect(out.some((m) => m.includes("redundant-reread"))).toBe(false);
	});

	it("still warns when another session exists but has no write for the file", () => {
		// The cross-session loop visits `other` (≠ session) whose
		// file_write_times lacks this file → inner `has()` is false, loop
		// completes without setting modifiedSince, and the warning fires.
		const session = fakeSession({
			tool_call_count: 20,
			file_read_at: new Map([[TS, 12]]),
			files_written: new Set(),
		});
		const other = fakeSession({
			session_id: "other",
			file_write_times: new Map([["/repo/src/unrelated.ts", "2026-06-06T00:00:00Z"]]),
		});
		const out = getPreToolUseContext(
			readEvt,
			cfg,
			fakeGraph(),
			fakeSessions([session, other]),
			session,
		);
		expect(out.some((m) => m.includes("redundant-reread"))).toBe(true);
	});

	it("does not warn when zero tool calls have elapsed since the read", () => {
		const session = fakeSession({ tool_call_count: 12, file_read_at: new Map([[TS, 12]]) });
		const out = getPreToolUseContext(readEvt, cfg, fakeGraph(), fakeSessions(), session);
		expect(out.some((m) => m.includes("redundant-reread"))).toBe(false);
	});

	it("skips the cross-session loop entry that is the session itself", () => {
		// The current session is also in getAll(); the loop must `continue` past it.
		const session = fakeSession({
			tool_call_count: 20,
			file_read_at: new Map([[TS, 12]]),
			files_written: new Set(),
			// Self has a write-time entry — but `sess === session` skip means it's ignored.
			file_write_times: new Map([[TS, "2026-06-06T00:00:00Z"]]),
		});
		const out = getPreToolUseContext(readEvt, cfg, fakeGraph(), fakeSessions([session]), session);
		// Self-write is skipped by the loop, so the warning still fires.
		expect(out.some((m) => m.includes("redundant-reread"))).toBe(true);
	});
});

// ===========================================================================
// getPreToolUseContext — route context
// ===========================================================================

describe("getPreToolUseContext — route context", () => {
	const cfg = fullConfig({
		recently_failed: false,
		stale_read_warning: false,
		redundant_reread: false,
		blast_radius: false,
		test_first: false,
		sibling_awareness: false,
		completion_tracking: false,
		impact_analysis: false,
	});

	function makeRouteMap(endpoints: Endpoint[]): RouteMap {
		const routes = new RouteMap("/repo");
		vi.spyOn(routes, "extractEndpointsForFile").mockReturnValue(endpoints);
		return routes;
	}

	function endpoint(over: Partial<Endpoint>): Endpoint {
		return {
			framework: "express",
			method: "GET",
			path: "/x",
			file: TS,
			auth_chain: [],
			declared_params: [],
			...over,
		};
	}

	it("renders method+path for a normal HTTP route", () => {
		const rm = makeRouteMap([endpoint({ method: "POST", path: "/users" })]);
		const out = getPreToolUseContext(writeEvent(TS), cfg, fakeGraph(), fakeSessions(), undefined, rm);
		const w = out.find((m) => m.includes("route-context"));
		expect(w).toContain("POST /users");
	});

	it("renders the MCP TOOL method specially", () => {
		const rm = makeRouteMap([endpoint({ method: "TOOL", path: "my_tool" })]);
		const out = getPreToolUseContext(writeEvent(TS), cfg, fakeGraph(), fakeSessions(), undefined, rm);
		const w = out.find((m) => m.includes("route-context"));
		expect(w).toContain("TOOL my_tool");
	});

	it("renders an ALL/match-anything route as just the path", () => {
		const rm = makeRouteMap([endpoint({ method: "ALL", path: "/wildcard" })]);
		const out = getPreToolUseContext(writeEvent(TS), cfg, fakeGraph(), fakeSessions(), undefined, rm);
		const w = out.find((m) => m.includes("route-context"));
		expect(w).toContain("/wildcard");
		expect(w).not.toContain("ALL /wildcard");
	});

	it("de-duplicates identical endpoint descriptions", () => {
		const rm = makeRouteMap([
			endpoint({ method: "GET", path: "/dup" }),
			endpoint({ method: "GET", path: "/dup" }),
		]);
		const out = getPreToolUseContext(writeEvent(TS), cfg, fakeGraph(), fakeSessions(), undefined, rm);
		const w = out.find((m) => m.includes("route-context")) ?? "";
		expect(w.match(/GET \/dup/g)).toHaveLength(1);
	});

	it("does not warn when the file has no endpoints", () => {
		const rm = makeRouteMap([]);
		const out = getPreToolUseContext(writeEvent(TS), cfg, fakeGraph(), fakeSessions(), undefined, rm);
		expect(out.some((m) => m.includes("route-context"))).toBe(false);
	});

	it("does not run without a routeMap argument", () => {
		const out = getPreToolUseContext(writeEvent(TS), cfg, fakeGraph(), fakeSessions());
		expect(out.some((m) => m.includes("route-context"))).toBe(false);
	});

	it("runs on read operations as well", () => {
		const rm = makeRouteMap([endpoint({ method: "GET", path: "/r" })]);
		const out = getPreToolUseContext(
			evt({ tool_name: "Read", tool_input: { file_path: TS } }),
			cfg,
			fakeGraph(),
			fakeSessions(),
			undefined,
			rm,
		);
		expect(out.some((m) => m.includes("route-context"))).toBe(true);
	});

	it("does not run when route_context is disabled", () => {
		const rm = makeRouteMap([endpoint({ method: "GET", path: "/r" })]);
		const out = getPreToolUseContext(
			writeEvent(TS),
			{ ...cfg, route_context: false },
			fakeGraph(),
			fakeSessions(),
			undefined,
			rm,
		);
		expect(out.some((m) => m.includes("route-context"))).toBe(false);
	});
});

// ===========================================================================
// getPreToolUseContext — sibling awareness
// ===========================================================================

describe("getPreToolUseContext — sibling awareness", () => {
	const cfg = fullConfig({
		recently_failed: false,
		stale_read_warning: false,
		redundant_reread: false,
		blast_radius: false,
		test_first: false,
		completion_tracking: false,
		impact_analysis: false,
		route_context: false,
	});

	it("lists siblings when creating a new file in a populated directory", () => {
		mockedExistsSync.mockReturnValue(false); // file does not exist → new file
		const g = fakeGraph({
			getSiblingFiles: () => ["/repo/src/a.ts", "/repo/src/b.ts"],
			toRelative: (f: string) => f.replace(/^\/repo\//, ""),
		});
		const out = getPreToolUseContext(writeEvent("/repo/src/new.ts"), cfg, g, fakeSessions());
		const w = out.find((m) => m.includes("sibling-awareness"));
		expect(w).toContain("already contains: a.ts, b.ts");
	});

	it("truncates the sibling list at eight and reports the overflow", () => {
		mockedExistsSync.mockReturnValue(false);
		const sibs = Array.from({ length: 10 }, (_, i) => `/repo/src/s${i}.ts`);
		const g = fakeGraph({ getSiblingFiles: () => sibs });
		const out = getPreToolUseContext(writeEvent("/repo/src/new.ts"), cfg, g, fakeSessions());
		const w = out.find((m) => m.includes("sibling-awareness"));
		expect(w).toContain("and 2 more");
	});

	it("does not warn when the directory has no siblings", () => {
		mockedExistsSync.mockReturnValue(false);
		const g = fakeGraph({ getSiblingFiles: () => [] });
		const out = getPreToolUseContext(writeEvent("/repo/src/new.ts"), cfg, g, fakeSessions());
		expect(out.some((m) => m.includes("sibling-awareness"))).toBe(false);
	});

	it("does not warn when the file already exists (not a new file)", () => {
		mockedExistsSync.mockReturnValue(true); // file exists → skip
		const g = fakeGraph({ getSiblingFiles: () => ["/repo/src/a.ts"] });
		const out = getPreToolUseContext(writeEvent("/repo/src/foo.ts"), cfg, g, fakeSessions());
		expect(out.some((m) => m.includes("sibling-awareness"))).toBe(false);
	});

	it("does not run when sibling_awareness is disabled", () => {
		mockedExistsSync.mockReturnValue(false);
		const g = fakeGraph({ getSiblingFiles: () => ["/repo/src/a.ts"] });
		const out = getPreToolUseContext(
			writeEvent("/repo/src/new.ts"),
			{ ...cfg, sibling_awareness: false },
			g,
			fakeSessions(),
		);
		expect(out.some((m) => m.includes("sibling-awareness"))).toBe(false);
	});
});

// ===========================================================================
// getPreToolUseContext — completion tracking
// ===========================================================================

describe("getPreToolUseContext — completion tracking", () => {
	const cfg = (over: Partial<StructuralChecksConfig> = {}) =>
		fullConfig({
			recently_failed: false,
			stale_read_warning: false,
			redundant_reread: false,
			blast_radius: false,
			test_first: false,
			sibling_awareness: false,
			impact_analysis: false,
			route_context: false,
			completion_reminder_threshold: 10,
			...over,
		});

	function completion(over: Record<string, unknown> = {}) {
		return {
			source_file: "/repo/src/src.ts",
			affected_files: ["/repo/src/dep1.ts", "/repo/src/dep2.ts"],
			resolved_files: new Set<string>(),
			recorded_at_tool_call: 10,
			description: "Export surface changed",
			...over,
		};
	}

	it("reminds about unresolved follow-through past the threshold", () => {
		const session = fakeSession({
			tool_call_count: 25,
			pending_completions: new Map([["/repo/src/src.ts", completion()]]),
		});
		const out = getPreToolUseContext(writeEvent(TS), cfg(), fakeGraph(), fakeSessions(), session);
		const w = out.find((m) => m.includes("completion-tracking"));
		expect(w).toContain("Export surface changed");
		expect(w).toContain("15 tool calls ago");
		expect(w).toContain("Still needs updating: src/dep1.ts, src/dep2.ts");
	});

	it("skips a completion whose affected files are all resolved", () => {
		const session = fakeSession({
			tool_call_count: 25,
			pending_completions: new Map([
				[
					"/repo/src/src.ts",
					completion({ resolved_files: new Set(["/repo/src/dep1.ts", "/repo/src/dep2.ts"]) }),
				],
			]),
		});
		const out = getPreToolUseContext(writeEvent(TS), cfg(), fakeGraph(), fakeSessions(), session);
		expect(out.some((m) => m.includes("completion-tracking"))).toBe(false);
	});

	it("stays silent until the reminder threshold is crossed", () => {
		const session = fakeSession({
			tool_call_count: 12, // only 2 calls since recorded_at_tool_call=10
			pending_completions: new Map([["/repo/src/src.ts", completion()]]),
		});
		const out = getPreToolUseContext(writeEvent(TS), cfg(), fakeGraph(), fakeSessions(), session);
		expect(out.some((m) => m.includes("completion-tracking"))).toBe(false);
	});

	it("truncates the remaining-file list at four with an overflow count", () => {
		const affected = Array.from({ length: 7 }, (_, i) => `/repo/src/d${i}.ts`);
		const session = fakeSession({
			tool_call_count: 30,
			pending_completions: new Map([
				["/repo/src/src.ts", completion({ affected_files: affected })],
			]),
		});
		const out = getPreToolUseContext(writeEvent(TS), cfg(), fakeGraph(), fakeSessions(), session);
		const w = out.find((m) => m.includes("completion-tracking"));
		expect(w).toContain("and 3 more");
	});

	it("does not run when completion_tracking is disabled", () => {
		const session = fakeSession({
			tool_call_count: 30,
			pending_completions: new Map([["/repo/src/src.ts", completion()]]),
		});
		const out = getPreToolUseContext(
			writeEvent(TS),
			cfg({ completion_tracking: false }),
			fakeGraph(),
			fakeSessions(),
			session,
		);
		expect(out.some((m) => m.includes("completion-tracking"))).toBe(false);
	});
});

// ===========================================================================
// getPreToolUseContext — follow-up violation
// ===========================================================================

describe("getPreToolUseContext — follow-up violation", () => {
	const cfg = fullConfig({
		recently_failed: false,
		stale_read_warning: false,
		redundant_reread: false,
		blast_radius: false,
		test_first: false,
		sibling_awareness: false,
		completion_tracking: false,
		route_context: false,
	});

	it("warns when checkFollowUpViolation returns a message", () => {
		(vi.mocked(checkFollowUpViolation)).mockReturnValue(
			"finish updating dep.ts first",
		);
		const out = getPreToolUseContext(writeEvent(TS), cfg, fakeGraph(), fakeSessions(), fakeSession());
		const w = out.find((m) => m.includes("follow-up-required"));
		expect(w).toContain("finish updating dep.ts first");
	});

	it("stays silent when there is no violation", () => {
		(vi.mocked(checkFollowUpViolation)).mockReturnValue(null);
		const out = getPreToolUseContext(writeEvent(TS), cfg, fakeGraph(), fakeSessions(), fakeSession());
		expect(out.some((m) => m.includes("follow-up-required"))).toBe(false);
	});

	it("does not run when impact_analysis is disabled", () => {
		(vi.mocked(checkFollowUpViolation)).mockReturnValue("x");
		const out = getPreToolUseContext(
			writeEvent(TS),
			{ ...cfg, impact_analysis: false },
			fakeGraph(),
			fakeSessions(),
			fakeSession(),
		);
		expect(checkFollowUpViolation).not.toHaveBeenCalled();
		expect(out.some((m) => m.includes("follow-up-required"))).toBe(false);
	});
});

// ===========================================================================
// getPreToolUseContext — change propagation (unconditional on writes)
// ===========================================================================

describe("getPreToolUseContext — change propagation", () => {
	const cfg = fullConfig({
		recently_failed: false,
		stale_read_warning: false,
		redundant_reread: false,
		blast_radius: false,
		test_first: false,
		sibling_awareness: false,
		completion_tracking: false,
		impact_analysis: false,
		route_context: false,
	});

	it("appends propagation warnings on a write operation", () => {
		vi.mocked(findPropagationTargets).mockReturnValue([{
			file: "/repo/README.md", reason: "references the changed export",
			category: "documentation", confidence: "medium",
		}]);
		(vi.mocked(formatPropagationWarnings)).mockReturnValue([
			"[interlinked:propagation] update the docs",
		]);
		const out = getPreToolUseContext(writeEvent(TS), cfg, fakeGraph(), fakeSessions());
		expect(out.some((m) => m.includes("propagation"))).toBe(true);
		expect(findPropagationTargets).toHaveBeenCalled();
	});

	it("uses event.cwd when present for propagation discovery", () => {
		(vi.mocked(findPropagationTargets)).mockReturnValue([]);
		(vi.mocked(formatPropagationWarnings)).mockReturnValue([]);
		const e = evt({ tool_name: "Edit", tool_input: { file_path: TS }, cwd: "/repo" });
		getPreToolUseContext(e, cfg, fakeGraph(), fakeSessions());
		expect(findPropagationTargets).toHaveBeenCalledWith(TS, "/repo");
	});

	it("falls back to process.cwd() when the event omits cwd", () => {
		(vi.mocked(findPropagationTargets)).mockReturnValue([]);
		(vi.mocked(formatPropagationWarnings)).mockReturnValue([]);
		getPreToolUseContext(writeEvent(TS), cfg, fakeGraph(), fakeSessions());
		expect(findPropagationTargets).toHaveBeenCalledWith(TS, process.cwd());
	});

	it("does not run propagation on read operations", () => {
		(vi.mocked(findPropagationTargets)).mockReturnValue([]);
		(vi.mocked(formatPropagationWarnings)).mockReturnValue([]);
		getPreToolUseContext(
			evt({ tool_name: "Read", tool_input: { file_path: TS } }),
			cfg,
			fakeGraph(),
			fakeSessions(),
		);
		expect(findPropagationTargets).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// getPreToolUseContext — combined / no-session paths
// ===========================================================================

describe("getPreToolUseContext — session-optional paths", () => {
	it("runs the write path with no session argument (session-gated checks skipped)", () => {
		// recently_failed / test_first / redundant_reread / completion_tracking /
		// impact_analysis all require `session`; with none passed they must skip,
		// while blast_radius / sibling_awareness / change-propagation still run.
		mockedResolveDependencyView.mockReturnValue(dependencyView({
			getDependents: () => ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"],
			classifyModule: () => "hub",
			source: "internal",
		}));
		(vi.mocked(findPropagationTargets)).mockReturnValue([]);
		(vi.mocked(formatPropagationWarnings)).mockReturnValue([]);

		const out = getPreToolUseContext(writeEvent(TS), fullConfig(), fakeGraph(), fakeSessions());
		// blast-radius still fires without a session.
		expect(out.some((m) => m.includes("blast-radius"))).toBe(true);
		// session-gated checks did not fire.
		expect(out.some((m) => m.includes("recently-failed"))).toBe(false);
		expect(out.some((m) => m.includes("test-first"))).toBe(false);
	});

	it("aggregates multiple warnings from independent blocks in one call", () => {
		mockedResolveDependencyView.mockReturnValue(dependencyView({
			getDependents: () => ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"],
			classifyModule: () => "hub",
			source: "internal",
		}));
		(vi.mocked(findTestFileForSource)).mockReturnValue(null);
		(vi.mocked(checkFollowUpViolation)).mockReturnValue("do follow-up");
		(vi.mocked(findPropagationTargets)).mockReturnValue([]);
		(vi.mocked(formatPropagationWarnings)).mockReturnValue([]);

		const session = fakeSession();
		const out = getPreToolUseContext(writeEvent(TS), fullConfig(), fakeGraph(), fakeSessions(), session);
		expect(out.some((m) => m.includes("blast-radius"))).toBe(true);
		expect(out.some((m) => m.includes("test-first"))).toBe(true);
		expect(out.some((m) => m.includes("follow-up-required"))).toBe(true);
	});
});
