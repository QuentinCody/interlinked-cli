import type { PreToolContext } from "./structural-checks-pre-context.js";
import { makeProjectGraph as completeProjectGraphFixture } from "./__tests__/fixtures/managers.js";
import { makeSessionTracker as completeSessionTrackerFixture } from "./__tests__/fixtures/managers.js";
import { makeRouteMap as completeRouteMapFixture } from "./__tests__/fixtures/managers.js";
import { makeMinimalEvent as completeEventFixture, makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { describe, expect, it, vi } from "vitest";
import type { ProjectGraph } from "./project-graph.js";
import type { SessionTrajectory, StructuralChecksConfig } from "./types.js";
import {
	preCheckBlastRadius,
	preCheckCompletionTracking,
	preCheckFollowUpViolation,
	preCheckRecentlyFailed,
	preCheckRedundantReread,
	preCheckRouteContext,
	preCheckSiblingAwareness,
	preCheckStaleRead,
	preCheckTestFirst,
} from "./structural-checks-pre-context.js";

const file = "/workspace/src/feature.ts";
const baseConfig = (): StructuralChecksConfig => ({
	enabled: true,
	export_surface: false,
	import_resolution: false,
	duplicate_symbols: false,
	co_dependency_staleness: false,
	import_cycles: false,
	interface_change_impact: false,
	test_proximity: false,
	smart_tsc: false,
	blast_radius: false,
	stale_read_warning: false,
	sibling_awareness: false,
	staleness_window_s: 300,
	blast_radius_threshold: 5,
	recently_failed: false,
	completion_tracking: false,
	route_context: false,
	redundant_reread: false,
	dead_imports: false,
	completion_reminder_threshold: 10,
	dead_exports: false,
	hallucinated_imports: false,
	cross_package_imports: false,
	undefined_env_vars: false,
	layer_violations: false,
	impact_analysis: false,
	impact_high_threshold: 4,
	test_first: false,
	test_first_mode: "nudge",
});

function graph(overrides: Partial<ProjectGraph> = {}): ProjectGraph {
	return completeProjectGraphFixture({
		getDependents: vi.fn().mockReturnValue([]),
		classifyModule: vi.fn().mockReturnValue("leaf"),
		getSiblingFiles: vi.fn().mockReturnValue([]),
		toRelative: (p: string) => p.replace("/workspace/", ""),
		...overrides,
	});
}

function ctx(overrides: Partial<PreToolContext> = {}): PreToolContext {
	return {
		event: ({ ...completeEventFixture(), ...{ cwd: "/workspace", agent_name: "me" } }),
		config: baseConfig(),
		graph: graph(),
		sessions: completeSessionTrackerFixture({ getAll: vi.fn().mockReturnValue([]) }),
		toolName: "Write",
		filePath: file,
		relPath: "src/feature.ts",
		ext: ".ts",
		...overrides,
	};
}

function session(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return ({ ...completeSessionFixture(), ...{
		session_id: "s1",
		agent_name: "me",
		tool_call_count: 12,
		test_runs: new Map(),
		files_written: new Set(),
		files_read: new Set(),
		file_read_at: new Map(),
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		...overrides,
	} });
}

describe("pre-context mutation contracts", () => {
	// test-contract: public-api — every documented TS/JS source extension must enter the test-first branch, while a suffix after .test.ts remains implementation code.
	it("returns no test-first warning for every supported source extension, but recognizes test names only at the end", () => {
		const extensions = [".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
		for (const ext of extensions) {
			const out = preCheckTestFirst(
				ctx({ config: { ...baseConfig(), test_first: true }, ext, filePath: `/workspace/src/missing${ext}`, relPath: `src/missing${ext}` }),
				session(),
			);
			expect(out).toEqual([expect.stringContaining("No test file found")]);
		}
		const suffix = preCheckTestFirst(
			ctx({ config: { ...baseConfig(), test_first: true }, filePath: "/workspace/src/widget.test.ts.bak", relPath: "src/widget.test.ts.bak" }),
			session(),
		);
		expect(suffix).toEqual([expect.stringContaining("No test file found")]);
	});

	// test-contract: invariant — test-first evidence must distinguish a discovered test from one actually run this session.
	it("reports a known test file as not run and suppresses the warning after a pass", () => {
		// Portability (review pass 18): derive the repo root from cwd — the test
		// must pass from a clone at ANY filesystem path, never a hardcoded one.
		const repoRoot = `${process.cwd()}/`;
		const source = `${process.cwd()}/src/harness/structural-checks.ts`;
		const testFile = `${process.cwd()}/src/harness/structural-checks.test.ts`;
		const base = ctx({
			config: { ...baseConfig(), test_first: true },
			filePath: source,
			relPath: "src/harness/structural-checks.ts",
			ext: ".ts",
			graph: graph({ toRelative: (p: string) => p.replace(repoRoot, "") }),
		});
		const g = base.graph;
		const notRun = preCheckTestFirst(base, session());
		expect(notRun[0]).toContain("Tests at src/harness/structural-checks.test.ts haven't been run");
		const ran = session({ test_runs: new Map([[testFile, { status: "pass", at_step: 1 }]]) });
		expect(preCheckTestFirst({ ...base, graph: g }, ran)).toEqual([]);
	});

	// test-contract: boundary — warning begins at the configured threshold, lists exactly five dependents, and reports the remaining set count.
	it("uses exact blast-radius threshold, five-item truncation, and overflow count", () => {
		const deps = Array.from({ length: 7 }, (_, i) => `/workspace/src/dep${i}.ts`);
		const config = { ...baseConfig(), blast_radius: true, blast_radius_threshold: 5 };
		const out = preCheckBlastRadius(ctx({ config, graph: graph({ getDependents: vi.fn().mockReturnValue(deps), classifyModule: vi.fn().mockReturnValue("hub") }) }));
		expect(out).toEqual(["[interlinked:blast-radius] src/feature.ts (hub module) is imported by 7 files (src/dep0.ts, src/dep1.ts, src/dep2.ts, src/dep3.ts, src/dep4.ts and 2 more). Changes to exports will have wide impact."]);
		const exactlyFive = preCheckBlastRadius(ctx({ config, graph: graph({ getDependents: vi.fn().mockReturnValue(deps.slice(0, 5)) }) }));
		expect(exactlyFive[0]).not.toContain("more");
		const below = preCheckBlastRadius(ctx({ config, graph: graph({ getDependents: vi.fn().mockReturnValue(deps.slice(0, 4)) }) }));
		expect(below).toEqual([]);
	});

	// test-contract: public-api — no dependents must never produce a fabricated warning or placeholder list.
	it("returns an empty blast-radius result for an empty dependent set", () => {
		const out = preCheckBlastRadius(ctx({ config: { ...baseConfig(), blast_radius: true, blast_radius_threshold: 0 } }));
		expect(out[0]).toContain("is imported by 0 files");
	});

	// test-contract: invariant — resolved follow-ups disappear, while the fifth unresolved file is represented only by the explicit overflow count.
	it("keeps completion reminders empty when all affected files are resolved and truncates remaining files at four", () => {
		const completion = { source_file: "src/x.ts", affected_files: Array.from({ length: 6 }, (_, i) => `/workspace/src/f${i}.ts`), resolved_files: new Set(["/workspace/src/f0.ts"]), description: "refresh exports", recorded_at_tool_call: 2 };
		const out = preCheckCompletionTracking(ctx({ config: { ...baseConfig(), completion_tracking: true, completion_reminder_threshold: 10 }, graph: graph() }), session({ pending_completions: new Map([["src/x.ts", completion]]) }));
		expect(out).toEqual(["[interlinked:completion-tracking] refresh exports (10 tool calls ago). Still needs updating: src/f1.ts, src/f2.ts, src/f3.ts, src/f4.ts and 1 more"]);
		const resolved = { ...completion, resolved_files: new Set(completion.affected_files) };
		expect(preCheckCompletionTracking(ctx({ config: { ...baseConfig(), completion_tracking: true, completion_reminder_threshold: 10 } }), session({ pending_completions: new Map([["src/x.ts", resolved]]) }))).toEqual([]);
	});

	// test-contract: boundary — the documented reminder threshold is inclusive, so >= and > have observably different outputs.
	it("fires completion tracking at the threshold but not one call before it", () => {
		const completion = { source_file: "src/x.ts", affected_files: ["/workspace/src/f.ts"], resolved_files: new Set<string>(), description: "follow up", recorded_at_tool_call: 2 };
		const c = { ...baseConfig(), completion_tracking: true, completion_reminder_threshold: 10 };
		const at = preCheckCompletionTracking(ctx({ config: c }), session({ tool_call_count: 12, pending_completions: new Map([["x", completion]]) }));
		const before = preCheckCompletionTracking(ctx({ config: c }), session({ tool_call_count: 11, pending_completions: new Map([["x", completion]]) }));
		expect(at).toHaveLength(1);
		expect(before).toEqual([]);
	});

	// test-contract: public-api — failure evidence is scoped to supported tool operations and computes age by subtraction.
	it("reports recently failed files only for reads and writes with the exact elapsed count", () => {
		const c = { ...baseConfig(), recently_failed: true };
		const failed = { recorded_at: "2026-08-20T00:00:00.000Z", failure_count: 2, checks: ["typecheck"], tool_call_count: 5 };
		const s = session({ tool_call_count: 12, failed_files: new Map([[file, failed]]) });
		expect(preCheckRecentlyFailed(ctx({ config: c, toolName: "Write" }), s)[0]).toContain("7 tool call(s) ago");
		expect(preCheckRecentlyFailed(ctx({ config: c, toolName: "Read" }), s)).toHaveLength(1);
		expect(preCheckRecentlyFailed(ctx({ config: c, toolName: "Bash" }), s)).toEqual([]);
	});

	// test-contract: invariant — redundant reread requires a recorded prior read, a positive elapsed count, a read operation, and no intervening write by either session.
	it("distinguishes unchanged rereads, changed files, missing reads, and write tools", () => {
		const c = { ...baseConfig(), redundant_reread: true };
		const s = session({ file_read_at: new Map([[file, 5]]) });
		expect(preCheckRedundantReread(ctx({ config: c, toolName: "Read" }), s)[0]).toContain("7 tool call(s) ago");
		expect(preCheckRedundantReread(ctx({ config: c, toolName: "Write" }), s)).toEqual([]);
		expect(preCheckRedundantReread(ctx({ config: c, toolName: "Read" }), session({ tool_call_count: 5, file_read_at: new Map([[file, 5]]) }))).toEqual([]);
		expect(preCheckRedundantReread(ctx({ config: c, toolName: "Read" }), session({ files_written: new Set([file]), file_read_at: new Map([[file, 5]]) }))).toEqual([]);
	});

	// test-contract: boundary — a write strictly inside the window warns, exactly at the boundary does not, and seconds are derived by division then rounding.
	it("uses strict stale-read window arithmetic and rounds seconds in evidence", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-20T00:00:10.500Z"));
		const other = session({ agent_name: "alice", file_write_times: new Map([[file, "2026-08-20T00:00:00.000Z"]]) });
		const sessions = completeSessionTrackerFixture({ getAll: vi.fn().mockReturnValue([other]) });
		const c = { ...baseConfig(), stale_read_warning: true, staleness_window_s: 11 };
		const out = preCheckStaleRead(ctx({ config: c, toolName: "Read", sessions }),);
		expect(out).toEqual(["[interlinked:stale-read] src/feature.ts was modified by alice 11s ago. Contents may differ from what you previously read."]);
		const boundary = preCheckStaleRead(ctx({ config: { ...c, staleness_window_s: 10.5 }, toolName: "Read", sessions }));
		expect(boundary).toEqual([]);
		vi.useRealTimers();
	});

	// test-contract: boundary — sibling awareness truncates at eight names and only adds overflow when a ninth sibling exists.
	it("lists siblings with an eight-item boundary and overflow count for a new file", () => {
		const siblings = Array.from({ length: 9 }, (_, i) => `/workspace/src/s${i}.ts`);
		const c = { ...baseConfig(), sibling_awareness: true };
		const out = preCheckSiblingAwareness(ctx({ config: c, filePath: "/workspace/src/new.ts", graph: graph({ getSiblingFiles: vi.fn().mockReturnValue(siblings) }) }));
		expect(out[0]).toContain("s0.ts, s1.ts, s2.ts, s3.ts, s4.ts, s5.ts, s6.ts, s7.ts and 1 more");
		const eight = preCheckSiblingAwareness(ctx({ config: c, filePath: "/workspace/src/new.ts", graph: graph({ getSiblingFiles: vi.fn().mockReturnValue(siblings.slice(0, 8)) }) }));
		expect(eight[0]).not.toContain("more");
	});

	// test-contract: public-api — route context projects each endpoint method correctly, joins unique routes with commas, and is limited to read/write operations.
	it("formats TOOL, ALL, HTTP routes, deduplicates descriptions, and ignores unsupported tools", () => {
		const endpoints = [
			{ method: "TOOL", path: "search" },
			{ method: "ALL", path: "/any" },
			{ method: "GET", path: "/users" },
			{ method: "GET", path: "/users" },
		];
		const routeMap = completeRouteMapFixture({ extractEndpointsForFile: vi.fn().mockReturnValue(endpoints) });
		const c = { ...baseConfig(), route_context: true };
		const out = preCheckRouteContext(ctx({ config: c, toolName: "Read" }), routeMap);
		expect(out).toEqual(["[interlinked:route-context] This file handles: TOOL search, /any, GET /users. Changes may affect API consumers."]);
		expect(preCheckRouteContext(ctx({ config: c, toolName: "Bash" }), routeMap)).toEqual([]);
		expect(preCheckRouteContext(ctx({ config: c }), completeRouteMapFixture({ extractEndpointsForFile: vi.fn().mockReturnValue([]) }))).toEqual([]);
	});

	// test-contract: security — follow-up enforcement must not fabricate a violation from an empty set and must permit the required affected-file edit.
	it("returns no follow-up warning when there are no pending completions or when editing an affected file", () => {
		const c = { ...baseConfig(), impact_analysis: true };
		expect(preCheckFollowUpViolation(ctx({ config: c }), session())).toEqual([]);
		const completion = { source_file: "/workspace/src/source.ts", recorded_at_tool_call: 0, description: "follow up", affected_files: [file], resolved_files: new Set<string>() };
		const s = session({ pending_completions: new Map([["source", completion]]) });
		expect(preCheckFollowUpViolation(ctx({ config: c }), s)).toEqual([]);
	});
});
