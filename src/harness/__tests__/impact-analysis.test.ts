import { makeProjectGraph as completeProjectGraphFixture } from "./fixtures/managers.js";
// ===========================================
// Impact Analysis — Unit Tests
// ===========================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { InternalDependencyView } from "../dependency-view.js";
import {
	checkFollowUpViolation,
	formatImpactWarning,
	recordImpactFollowUps,
	runImpactAnalysis,
} from "../impact-analysis.js";
import type { ProjectGraph } from "../project-graph.js";
import type {
	ExportedSymbol,
	ImpactAnalysisResult,
	ModuleRole,
	SessionTrajectory,
	StructuralCheckResult,
} from "../types.js";

// -------------------------------------------
// Helpers
// -------------------------------------------

// Deterministic fixtures.
const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

function makeSession(overrides?: Partial<SessionTrajectory>): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 10,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: FIXED_NOW,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
		...overrides,
	};
}

function makeGraph(opts: {
	dependents?: string[];
	moduleRole?: ModuleRole;
	toRelative?: (f: string) => string;
}) {
	return completeProjectGraphFixture({
		getDependents: vi.fn().mockReturnValue(opts.dependents || []),
		classifyModule: vi.fn().mockReturnValue(opts.moduleRole || "leaf"),
		getExports: vi.fn().mockReturnValue([]),
		toRelative: opts.toRelative || ((f: string) => f.replace(/^\/project\//, "")),
		isInitialized: true,
	});
}

/**
 * Wrap a mock graph in a real `InternalDependencyView`. The view only calls
 * `getDependents`/`classifyModule`, both of which the mock provides — so the
 * dependency-aware facts under test still come from `opts`.
 */
function makeView(graph: ProjectGraph): InternalDependencyView {
	return new InternalDependencyView(graph);
}

function makeExports(...names: string[]): ExportedSymbol[] {
	return names.map((name) => ({
		name,
		kind: "function" as const,
		isTypeOnly: false,
		line: 1,
	}));
}

// -------------------------------------------
// Severity classification
// -------------------------------------------

describe("runImpactAnalysis — severity", () => {
	const config = { highThreshold: 4 };

	it("classifies leaf file with no export change as low", () => {
		const graph = makeGraph({ dependents: [], moduleRole: "leaf" });
		const exports = makeExports("foo", "bar");

		const result = runImpactAnalysis(
			"/project/src/leaf.ts",
			makeView(graph),
			graph,
			exports,
			exports,
			[],
			config,
		);

		expect(result.severity).toBe("low");
		expect(result.exportSurfaceChanged).toBe(false);
		expect(result.dependentCount).toBe(0);
		expect(result.summary).toBe(
			"LOW: src/leaf.ts is a leaf file with 0 dependents. Internal-only change.",
		);
	});

	it("classifies internal file with dependents but no export change as low", () => {
		const graph = makeGraph({
			dependents: ["/project/src/a.ts", "/project/src/b.ts"],
			moduleRole: "internal",
		});
		const exports = makeExports("foo");

		const result = runImpactAnalysis(
			"/project/src/utils.ts",
			makeView(graph),
			graph,
			exports,
			exports,
			[],
			config,
		);

		expect(result.severity).toBe("low");
	});

	it("classifies file with 2 dependents and removed export as medium", () => {
		const graph = makeGraph({
			dependents: ["/project/src/a.ts", "/project/src/b.ts"],
			moduleRole: "internal",
		});
		const oldExports = makeExports("foo", "bar");
		const newExports = makeExports("foo");
		const structural: StructuralCheckResult[] = [
			{
				check: "export_surface",
				severity: "warning",
				message: "Removed export: bar",
				file: "/project/src/utils.ts",
				affectedFiles: ["/project/src/a.ts"],
			},
		];

		const result = runImpactAnalysis(
			"/project/src/utils.ts",
			makeView(graph),
			graph,
			oldExports,
			newExports,
			structural,
			config,
		);

		expect(result.severity).toBe("medium");
		expect(result.breakingFiles).toEqual(["/project/src/a.ts"]);
		expect(result.followUpFiles).toEqual(["/project/src/a.ts"]);
		expect(result.summary).toBe(
			"MEDIUM: src/utils.ts (internal) export surface changed. 1 file(s) may break.",
		);
	});

	it("classifies file with 5+ dependents and export change as high", () => {
		const deps = Array.from({ length: 5 }, (_, i) => `/project/src/dep${i}.ts`);
		const graph = makeGraph({ dependents: deps, moduleRole: "internal" });
		const oldExports = makeExports("foo", "bar");
		const newExports = makeExports("foo");

		const result = runImpactAnalysis(
			"/project/src/core.ts",
			makeView(graph),
			graph,
			oldExports,
			newExports,
			[],
			config,
		);

		expect(result.severity).toBe("high");
		expect(result.breakingFiles).toEqual([]);
		expect(result.summary).toBe(
			"HIGH: src/core.ts is a internal module with 5 dependents. 5 dependents affected.",
		);
	});

	it("classifies hub module with breaking changes as critical", () => {
		const deps = Array.from({ length: 10 }, (_, i) => `/project/src/dep${i}.ts`);
		const graph = makeGraph({ dependents: deps, moduleRole: "hub" });
		const structural: StructuralCheckResult[] = [
			{
				check: "export_surface",
				severity: "error",
				message: "Removed export: doStuff",
				file: "/project/src/hub.ts",
				affectedFiles: ["/project/src/a.ts", "/project/src/b.ts"],
			},
		];

		const result = runImpactAnalysis(
			"/project/src/hub.ts",
			makeView(graph),
			graph,
			makeExports("doStuff"),
			makeExports(),
			structural,
			config,
		);

		expect(result.severity).toBe("critical");
		expect(result.dependentCount).toBe(10);
		expect(result.summary).toBe(
			"CRITICAL: src/hub.ts is a hub module with 10 dependents. Breaks 2 file(s).",
		);
	});

	it("classifies root module with breaking changes as critical", () => {
		const graph = makeGraph({ dependents: [], moduleRole: "root" });
		const structural: StructuralCheckResult[] = [
			{
				check: "export_surface",
				severity: "error",
				message: "Removed export: doStuff",
				file: "/project/src/root.ts",
				affectedFiles: ["/project/src/a.ts"],
			},
		];

		const result = runImpactAnalysis(
			"/project/src/root.ts",
			makeView(graph),
			graph,
			makeExports("doStuff"),
			makeExports(),
			structural,
			config,
		);

		expect(result.severity).toBe("critical");
	});

	it("does not classify a hub module as critical when there are no breaking files", () => {
		const graph = makeGraph({ dependents: [], moduleRole: "hub" });
		const exports = makeExports("foo");

		const result = runImpactAnalysis(
			"/project/src/hub.ts",
			makeView(graph),
			graph,
			exports,
			exports,
			[],
			config,
		);

		expect(result.severity).toBe("low");
	});

	it("classifies breaking files alone (non-hub/root, no export change) as medium", () => {
		const graph = makeGraph({ dependents: [], moduleRole: "internal" });
		const exports = makeExports("foo");
		const structural: StructuralCheckResult[] = [
			{
				check: "export_surface",
				severity: "warning",
				message: "unrelated",
				file: "/project/src/utils.ts",
				affectedFiles: ["/project/src/a.ts"],
			},
		];

		const result = runImpactAnalysis(
			"/project/src/utils.ts",
			makeView(graph),
			graph,
			exports,
			exports,
			structural,
			config,
		);

		expect(result.exportSurfaceChanged).toBe(false);
		expect(result.severity).toBe("medium");
	});

	it("classifies exactly highThreshold dependents with an export change as high (boundary)", () => {
		const deps = Array.from({ length: 4 }, (_, i) => `/project/src/dep${i}.ts`);
		const graph = makeGraph({ dependents: deps, moduleRole: "internal" });
		const oldExports = makeExports("foo", "bar");
		const newExports = makeExports("foo");

		const result = runImpactAnalysis(
			"/project/src/core.ts",
			makeView(graph),
			graph,
			oldExports,
			newExports,
			[],
			config,
		);

		expect(result.dependentCount).toBe(4);
		expect(result.severity).toBe("high");
	});

	it("classifies an export change with zero dependents and no breaking files as low", () => {
		const graph = makeGraph({ dependents: [], moduleRole: "internal" });
		const oldExports = makeExports("foo", "bar");
		const newExports = makeExports("foo");

		const result = runImpactAnalysis(
			"/project/src/utils.ts",
			makeView(graph),
			graph,
			oldExports,
			newExports,
			[],
			config,
		);

		expect(result.exportSurfaceChanged).toBe(true);
		expect(result.dependentCount).toBe(0);
		expect(result.severity).toBe("low");
	});
});

// -------------------------------------------
// exportSurfaceChanged — export diffing
// -------------------------------------------

describe("runImpactAnalysis — exportSurfaceChanged export diffing", () => {
	const config = { highThreshold: 4 };

	it("flags a renamed export (equal counts, one name removed) as changed", () => {
		const graph = makeGraph({ dependents: [], moduleRole: "internal" });
		const oldExports = makeExports("foo", "bar");
		const newExports = makeExports("foo", "baz");

		const result = runImpactAnalysis(
			"/project/src/utils.ts",
			makeView(graph),
			graph,
			oldExports,
			newExports,
			[],
			config,
		);

		expect(result.exportSurfaceChanged).toBe(true);
	});

	it("flags a pure addition (no removed export, size grows) as changed", () => {
		const graph = makeGraph({ dependents: [], moduleRole: "internal" });
		const oldExports = makeExports("foo");
		const newExports = makeExports("foo", "bar");

		const result = runImpactAnalysis(
			"/project/src/utils.ts",
			makeView(graph),
			graph,
			oldExports,
			newExports,
			[],
			config,
		);

		expect(result.exportSurfaceChanged).toBe(true);
	});
});

// -------------------------------------------
// structuralResults check-type guards
// -------------------------------------------

describe("runImpactAnalysis — structural result check-type guards", () => {
	const config = { highThreshold: 4 };

	it("only pulls breakingFiles from export_surface results and tolerates missing affectedFiles", () => {
		const graph = makeGraph({ dependents: [], moduleRole: "internal" });
		const exports = makeExports("foo");
		const structural: StructuralCheckResult[] = [
			{
				check: "export_surface",
				severity: "warning",
				message: "Removed export: bar",
				file: "/project/src/utils.ts",
				affectedFiles: ["/project/src/a.ts"],
			},
			{
				check: "interface_change_impact",
				severity: "warning",
				message: "no affected files reported",
				file: "/project/src/utils.ts",
				// affectedFiles intentionally omitted
			},
			{
				check: "some_other_check",
				severity: "info",
				message: "unrelated check, should never contribute",
				file: "/project/src/utils.ts",
				affectedFiles: ["/project/src/z.ts"],
			},
		];

		let result!: ImpactAnalysisResult;
		expect(() => {
			result = runImpactAnalysis(
				"/project/src/utils.ts",
				makeView(graph),
				graph,
				exports,
				exports,
				structural,
				config,
			);
		}).not.toThrow();

		// breakingFiles must come ONLY from the export_surface entry.
		expect(result.breakingFiles).toEqual(["/project/src/a.ts"]);
		// followUpFiles must be seeded from breakingFiles even though the
		// interface_change_impact entry contributed nothing of its own.
		expect(result.followUpFiles).toEqual(["/project/src/a.ts"]);
	});
});

// -------------------------------------------
// Follow-up tracking
// -------------------------------------------

describe("recordImpactFollowUps", () => {
	it("creates pending completions for follow-up files", () => {
		const session = makeSession();
		const result: ImpactAnalysisResult = {
			file: "/project/src/utils.ts",
			severity: "medium",
			moduleRole: "internal",
			dependentCount: 2,
			breakingFiles: ["/project/src/a.ts"],
			testFiles: [],
			followUpFiles: ["/project/src/a.ts", "/project/src/b.ts"],
			exportSurfaceChanged: true,
			summary: "MEDIUM: utils.ts export surface changed.",
		};

		recordImpactFollowUps(result, session);

		expect(session.pending_completions.has("/project/src/utils.ts")).toBe(true);
		const completion = session.pending_completions.get("/project/src/utils.ts")!;
		expect(completion.affected_files).toEqual(["/project/src/a.ts", "/project/src/b.ts"]);
		expect(completion.resolved_files.size).toBe(0);
	});

	it("merges with existing completion for same source file", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: ["/project/src/a.ts"],
			resolved_files: new Set(),
			recorded_at_tool_call: 5,
			description: "old description",
		});

		const result: ImpactAnalysisResult = {
			file: "/project/src/utils.ts",
			severity: "medium",
			moduleRole: "internal",
			dependentCount: 2,
			breakingFiles: [],
			testFiles: [],
			followUpFiles: ["/project/src/a.ts", "/project/src/c.ts"],
			exportSurfaceChanged: true,
			summary: "MEDIUM: new description",
		};

		recordImpactFollowUps(result, session);

		const completion = session.pending_completions.get("/project/src/utils.ts")!;
		// Exact equality (not just .toContain) — proves the merge dedups against
		// the pre-existing "/project/src/a.ts" entry instead of appending a
		// duplicate, and proves the object was mutated in place rather than
		// replaced (recorded_at_tool_call below only survives a true merge).
		expect(completion.affected_files).toEqual(["/project/src/a.ts", "/project/src/c.ts"]);
		expect(completion.description).toBe("MEDIUM: new description");
		expect(completion.recorded_at_tool_call).toBe(5);
	});

	it("does nothing when no follow-up files", () => {
		const session = makeSession();
		const result: ImpactAnalysisResult = {
			file: "/project/src/leaf.ts",
			severity: "low",
			moduleRole: "leaf",
			dependentCount: 0,
			breakingFiles: [],
			testFiles: [],
			followUpFiles: [],
			exportSurfaceChanged: false,
			summary: "LOW: no impact.",
		};

		recordImpactFollowUps(result, session);
		expect(session.pending_completions.size).toBe(0);
	});
});

// -------------------------------------------
// Follow-up violation check
// -------------------------------------------

describe("checkFollowUpViolation", () => {
	it("returns null when no pending completions", () => {
		const session = makeSession();
		expect(checkFollowUpViolation("/project/src/other.ts", session)).toBeNull();
	});

	it("returns null when writing to an affected file", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: ["/project/src/a.ts", "/project/src/b.ts"],
			resolved_files: new Set(),
			recorded_at_tool_call: 5,
			description: "Export changed",
		});

		expect(checkFollowUpViolation("/project/src/a.ts", session)).toBeNull();
	});

	it("returns null when writing to the source file itself", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: ["/project/src/a.ts"],
			resolved_files: new Set(),
			recorded_at_tool_call: 5,
			description: "Export changed",
		});

		expect(checkFollowUpViolation("/project/src/utils.ts", session)).toBeNull();
	});

	it("returns warning when writing to unrelated file", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: ["/project/src/a.ts", "/project/src/b.ts"],
			resolved_files: new Set(),
			recorded_at_tool_call: 5,
			description: "Export changed",
		});

		const result = checkFollowUpViolation("/project/src/unrelated.ts", session);
		// Exact match (not substring) pins the separator, arrow, and trailing
		// sentence verbatim.
		expect(result).toBe(
			"Unresolved follow-ups from export changes: /project/src/utils.ts → " +
				"/project/src/a.ts, /project/src/b.ts. Update affected files before moving to unrelated work.",
		);
	});

	it("returns null when all affected files are resolved", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: ["/project/src/a.ts"],
			resolved_files: new Set(["/project/src/a.ts"]),
			recorded_at_tool_call: 5,
			description: "Export changed",
		});

		expect(checkFollowUpViolation("/project/src/other.ts", session)).toBeNull();
	});

	it("returns null when the target is resolved but a sibling file is still unresolved", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: ["/project/src/a.ts", "/project/src/b.ts"],
			// a.ts already resolved; b.ts still pending — remaining = ["b.ts"],
			// non-empty, so the loop reaches the includes-check block below.
			resolved_files: new Set(["/project/src/a.ts"]),
			recorded_at_tool_call: 5,
			description: "Export changed",
		});

		// a.ts is not in `remaining` (it's resolved) but IS in affected_files —
		// writing to it must still be treated as safe.
		expect(checkFollowUpViolation("/project/src/a.ts", session)).toBeNull();
	});

	it("joins two unresolved sources with '; '", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: ["/project/src/a.ts"],
			resolved_files: new Set(),
			recorded_at_tool_call: 5,
			description: "Export changed",
		});
		session.pending_completions.set("/project/src/other.ts", {
			source_file: "/project/src/other.ts",
			affected_files: ["/project/src/x.ts"],
			resolved_files: new Set(),
			recorded_at_tool_call: 6,
			description: "Also changed",
		});

		const result = checkFollowUpViolation("/project/src/unrelated.ts", session);
		// A single-completion fixture can't distinguish the "; " join
		// separator from "" (join of one element is a no-op either way) — two
		// completions are required to pin it.
		expect(result).toBe(
			"Unresolved follow-ups from export changes: /project/src/utils.ts → /project/src/a.ts; " +
				"/project/src/other.ts → /project/src/x.ts. Update affected files before moving to unrelated work.",
		);
	});
});

// -------------------------------------------
// Warning formatting
// -------------------------------------------

describe("formatImpactWarning", () => {
	const graph = makeGraph({});

	it("returns empty array for low severity", () => {
		const result: ImpactAnalysisResult = {
			file: "/project/src/leaf.ts",
			severity: "low",
			moduleRole: "leaf",
			dependentCount: 0,
			breakingFiles: [],
			testFiles: [],
			followUpFiles: [],
			exportSurfaceChanged: false,
			summary: "LOW: leaf file.",
		};

		expect(formatImpactWarning(result, graph)).toHaveLength(0);
	});

	it("returns single warning for medium severity", () => {
		const result: ImpactAnalysisResult = {
			file: "/project/src/utils.ts",
			severity: "medium",
			moduleRole: "internal",
			dependentCount: 2,
			breakingFiles: ["/project/src/a.ts"],
			testFiles: ["src/utils.test.ts"],
			followUpFiles: ["/project/src/a.ts"],
			exportSurfaceChanged: true,
			summary: "MEDIUM: utils.ts export surface changed.",
		};

		expect(formatImpactWarning(result, graph)).toEqual([
			"[interlinked:impact_analysis] MEDIUM: utils.ts export surface changed. 1 test file(s) may need updating.",
		]);
	});

	it("returns multi-line warnings for critical severity", () => {
		const result: ImpactAnalysisResult = {
			file: "/project/src/hub.ts",
			severity: "critical",
			moduleRole: "hub",
			dependentCount: 10,
			breakingFiles: ["/project/src/a.ts", "/project/src/b.ts"],
			testFiles: ["src/hub.test.ts"],
			followUpFiles: ["/project/src/a.ts", "/project/src/b.ts"],
			exportSurfaceChanged: true,
			summary: "CRITICAL: hub.ts is a hub module with 10 dependents.",
		};

		expect(formatImpactWarning(result, graph)).toEqual([
			"[interlinked:impact_analysis] CRITICAL: hub.ts is a hub module with 10 dependents.",
			"[interlinked:impact_analysis] Breaking imports in: src/a.ts, src/b.ts",
			"[interlinked:impact_analysis] Test files to verify: src/hub.test.ts",
			"[interlinked:impact_analysis] Update these files before moving on: src/a.ts, src/b.ts",
		]);
	});

	it("omits the test-files line for medium severity with no test files", () => {
		const result: ImpactAnalysisResult = {
			file: "/project/src/utils.ts",
			severity: "medium",
			moduleRole: "internal",
			dependentCount: 2,
			breakingFiles: ["/project/src/a.ts"],
			testFiles: [],
			followUpFiles: ["/project/src/a.ts"],
			exportSurfaceChanged: true,
			summary: "MEDIUM: utils.ts export surface changed.",
		};

		expect(formatImpactWarning(result, graph)).toEqual([
			"[interlinked:impact_analysis] MEDIUM: utils.ts export surface changed.",
		]);
	});

	it("adds a (+N more) suffix past 5 breaking files for critical severity", () => {
		const breakingFiles = Array.from({ length: 6 }, (_, i) => `/project/src/b${i}.ts`);
		const result: ImpactAnalysisResult = {
			file: "/project/src/hub.ts",
			severity: "critical",
			moduleRole: "hub",
			dependentCount: 10,
			breakingFiles,
			testFiles: ["src/hub.test.ts"],
			followUpFiles: ["/project/src/a.ts"],
			exportSurfaceChanged: true,
			summary: "CRITICAL: hub.ts is a hub module with 10 dependents.",
		};

		const warnings = formatImpactWarning(result, graph);
		const breakingLine = warnings.find((w) => w.includes("Breaking imports"));
		// Exact match: pins the 5-item truncation (b5.ts excluded), the ", "
		// separator, real toRelative output (not "undefined"), and the
		// literal "(+1 more)" suffix all at once.
		expect(breakingLine).toBe(
			"[interlinked:impact_analysis] Breaking imports in: src/b0.ts, src/b1.ts, src/b2.ts, src/b3.ts, src/b4.ts (+1 more)",
		);
	});

	it("omits the (+N more) suffix when exactly 5 breaking files are present", () => {
		const breakingFiles = Array.from({ length: 5 }, (_, i) => `/project/src/b${i}.ts`);
		const result: ImpactAnalysisResult = {
			file: "/project/src/hub.ts",
			severity: "critical",
			moduleRole: "hub",
			dependentCount: 10,
			breakingFiles,
			testFiles: [],
			followUpFiles: [],
			exportSurfaceChanged: true,
			summary: "CRITICAL: hub.ts is a hub module with 10 dependents.",
		};

		const warnings = formatImpactWarning(result, graph);
		const breakingLine = warnings.find((w) => w.includes("Breaking imports"));
		expect(breakingLine).toBe(
			"[interlinked:impact_analysis] Breaking imports in: src/b0.ts, src/b1.ts, src/b2.ts, src/b3.ts, src/b4.ts",
		);
	});

	it("truncates the test-files line to 3 entries with no overflow suffix", () => {
		const result: ImpactAnalysisResult = {
			file: "/project/src/hub.ts",
			severity: "critical",
			moduleRole: "hub",
			dependentCount: 10,
			breakingFiles: [],
			testFiles: ["src/t0.test.ts", "src/t1.test.ts", "src/t2.test.ts", "src/t3.test.ts"],
			followUpFiles: [],
			exportSurfaceChanged: true,
			summary: "CRITICAL: hub.ts is a hub module with 10 dependents.",
		};

		const warnings = formatImpactWarning(result, graph);
		const testLine = warnings.find((w) => w.includes("Test files"));
		expect(testLine).toBe(
			"[interlinked:impact_analysis] Test files to verify: src/t0.test.ts, src/t1.test.ts, src/t2.test.ts",
		);
	});

	it("truncates the follow-up-files line to 5 entries with no overflow suffix", () => {
		const followUpFiles = Array.from({ length: 6 }, (_, i) => `/project/src/f${i}.ts`);
		const result: ImpactAnalysisResult = {
			file: "/project/src/hub.ts",
			severity: "critical",
			moduleRole: "hub",
			dependentCount: 10,
			breakingFiles: [],
			testFiles: [],
			followUpFiles,
			exportSurfaceChanged: true,
			summary: "CRITICAL: hub.ts is a hub module with 10 dependents.",
		};

		const warnings = formatImpactWarning(result, graph);
		const followUpLine = warnings.find((w) => w.includes("Update these files"));
		expect(followUpLine).toBe(
			"[interlinked:impact_analysis] Update these files before moving on: " +
				"src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, src/f4.ts",
		);
	});

	it("omits breaking/test/follow-up lines for high severity when all are empty", () => {
		const result: ImpactAnalysisResult = {
			file: "/project/src/core.ts",
			severity: "high",
			moduleRole: "internal",
			dependentCount: 5,
			breakingFiles: [],
			testFiles: [],
			followUpFiles: [],
			exportSurfaceChanged: true,
			summary: "HIGH: core.ts export surface changed.",
		};

		expect(formatImpactWarning(result, graph)).toEqual([
			"[interlinked:impact_analysis] HIGH: core.ts export surface changed.",
		]);
	});
});

// -------------------------------------------
// Breaking/follow-up file dedup
// -------------------------------------------

describe("runImpactAnalysis — dedup and no-breaking-file medium path", () => {
	const config = { highThreshold: 4 };

	it("dedups duplicate affectedFiles from export_surface results", () => {
		const graph = makeGraph({ dependents: [], moduleRole: "internal" });
		const oldExports = makeExports("foo", "bar");
		const newExports = makeExports("foo");
		const structural: StructuralCheckResult[] = [
			{
				check: "export_surface",
				severity: "warning",
				message: "Removed export: bar",
				file: "/project/src/utils.ts",
				affectedFiles: ["/project/src/a.ts", "/project/src/a.ts"],
			},
		];

		const result = runImpactAnalysis(
			"/project/src/utils.ts",
			makeView(graph),
			graph,
			oldExports,
			newExports,
			structural,
			config,
		);

		expect(result.breakingFiles).toEqual(["/project/src/a.ts"]);
	});

	it("dedups interface_change_impact follow-ups against breaking files and each other", () => {
		const graph = makeGraph({ dependents: [], moduleRole: "internal" });
		const oldExports = makeExports("foo", "bar");
		const newExports = makeExports("foo");
		const structural: StructuralCheckResult[] = [
			{
				check: "export_surface",
				severity: "warning",
				message: "Removed export: bar",
				file: "/project/src/utils.ts",
				affectedFiles: ["/project/src/a.ts"],
			},
			{
				check: "interface_change_impact",
				severity: "warning",
				message: "Interface changed",
				file: "/project/src/utils.ts",
				affectedFiles: ["/project/src/a.ts", "/project/src/b.ts", "/project/src/b.ts"],
			},
		];

		const result = runImpactAnalysis(
			"/project/src/utils.ts",
			makeView(graph),
			graph,
			oldExports,
			newExports,
			structural,
			config,
		);

		expect(result.followUpFiles).toEqual(["/project/src/a.ts", "/project/src/b.ts"]);
	});

	it("classifies medium via export change + dependents with zero breaking files", () => {
		const graph = makeGraph({
			dependents: ["/project/src/a.ts", "/project/src/b.ts"],
			moduleRole: "internal",
		});
		const oldExports = makeExports("foo", "bar");
		const newExports = makeExports("foo");

		const result = runImpactAnalysis(
			"/project/src/utils.ts",
			makeView(graph),
			graph,
			oldExports,
			newExports,
			[],
			config,
		);

		expect(result.severity).toBe("medium");
		expect(result.breakingFiles).toEqual([]);
		expect(result.summary).toBe(
			"MEDIUM: src/utils.ts (internal) export surface changed. 2 dependent(s).",
		);
	});
});

// -------------------------------------------
// Test file discovery (real fs)
// -------------------------------------------

describe("runImpactAnalysis — test file discovery", () => {
	it("discovers colocated, __tests__, and dependent test files", () => {
		const dir = mkdtempSync(join(tmpdir(), "impact-analysis-"));
		try {
			const srcFile = join(dir, "utils.ts");
			writeFileSync(srcFile, "export const x = 1;\n");
			writeFileSync(join(dir, "utils.test.ts"), "");
			mkdirSync(join(dir, "__tests__"));
			writeFileSync(join(dir, "__tests__", "utils.test.ts"), "");

			const graph = makeGraph({
				dependents: ["/project/x.test.ts", "/project/x.test.ts", "/project/normal.ts"],
				moduleRole: "leaf",
				toRelative: (f: string) => f,
			});
			const exports = makeExports("foo");

			const result = runImpactAnalysis(
				srcFile,
				makeView(graph),
				graph,
				exports,
				exports,
				[],
				{ highThreshold: 4 },
			);

			expect(result.testFiles).toEqual([
				join(dir, "utils.test.ts"),
				join(dir, "__tests__", "utils.test.ts"),
				"/project/x.test.ts",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("bounds dependent-test scanning to the first 50 dependents", () => {
		// Regression: `checked` used to be declared `const checked = 0` and was
		// never incremented, so `checked >= 50` was always false and the
		// "1-hop only, bounded" comment's 50-item cap never actually applied —
		// every dependent was scanned regardless of list length.
		const plainDeps = Array.from({ length: 50 }, (_, i) => `/project/src/plain${i}.ts`);
		const dependents = [...plainDeps, "/project/src/overflow.test.ts"];
		const graph = makeGraph({
			dependents,
			moduleRole: "leaf",
			toRelative: (f: string) => f,
		});
		const exports = makeExports("foo");

		const result = runImpactAnalysis(
			"/project/src/does-not-exist-on-disk.ts",
			makeView(graph),
			graph,
			exports,
			exports,
			[],
			{ highThreshold: 4 },
		);

		// The 51st dependent (index 50) is the only test-matching entry, and it
		// sits past the 50-dependent scan bound — it must not be discovered.
		expect(result.testFiles).toEqual([]);
	});
});

// -------------------------------------------
// checkFollowUpViolation — (+N more) suffix
// -------------------------------------------

describe("checkFollowUpViolation — remaining-file overflow", () => {
	it("adds a (+N more) suffix when more than 3 files remain", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: [
				"/project/src/a.ts",
				"/project/src/b.ts",
				"/project/src/c.ts",
				"/project/src/d.ts",
			],
			resolved_files: new Set(),
			recorded_at_tool_call: 5,
			description: "Export changed",
		});

		const result = checkFollowUpViolation("/project/src/unrelated.ts", session);
		// Exact match: pins the 3-item truncation (excludes d.ts), the ", "
		// separator, and the literal "(+1 more)" text all at once.
		expect(result).toBe(
			"Unresolved follow-ups from export changes: /project/src/utils.ts → " +
				"/project/src/a.ts, /project/src/b.ts, /project/src/c.ts (+1 more). " +
				"Update affected files before moving to unrelated work.",
		);
	});

	it("does not add a (+N more) suffix when exactly 3 files remain", () => {
		const session = makeSession();
		session.pending_completions.set("/project/src/utils.ts", {
			source_file: "/project/src/utils.ts",
			affected_files: ["/project/src/a.ts", "/project/src/b.ts", "/project/src/c.ts"],
			resolved_files: new Set(),
			recorded_at_tool_call: 5,
			description: "Export changed",
		});

		const result = checkFollowUpViolation("/project/src/unrelated.ts", session);
		expect(result).toBe(
			"Unresolved follow-ups from export changes: /project/src/utils.ts → " +
				"/project/src/a.ts, /project/src/b.ts, /project/src/c.ts. " +
				"Update affected files before moving to unrelated work.",
		);
	});
});
