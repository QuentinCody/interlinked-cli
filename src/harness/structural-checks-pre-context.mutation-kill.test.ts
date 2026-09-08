import type { PreToolContext } from "./structural-checks-pre-context.js";
import { makeProjectGraph as completeProjectGraphFixture } from "./__tests__/fixtures/managers.js";
import { makeSessionTracker as completeSessionTrackerFixture } from "./__tests__/fixtures/managers.js";
import { makeRouteMap as completeRouteMapFixture } from "./__tests__/fixtures/managers.js";
import { makeMinimalEvent as completeEventFixture, makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
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

// SAFETY: fixture builder — every caller supplies only the config keys it exercises.
function baseConfig(): StructuralChecksConfig {
	return {
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
	};
}

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

describe("preCheckRecentlyFailed — mutation kills", () => {
	// test-contract: boundary — a tool that is neither a read nor a write must never enter the body, even with a matching failed-file entry.
	it("stays silent for a non read/write tool despite a matching failed-file entry", () => {
		const c = { ...baseConfig(), recently_failed: true };
		const s = session({ failed_files: new Map([[file, { recorded_at: "2026-08-20T00:00:00.000Z", failure_count: 1, checks: ["x"], tool_call_count: 5 }]]) });
		expect(preCheckRecentlyFailed(ctx({ config: c, toolName: "Bash" }), s)).toEqual([]);
	});

	// test-contract: invariant — a file with no recorded failure entry must return empty, not a placeholder array.
	it("returns exactly [] when the file has no recorded failure entry", () => {
		const c = { ...baseConfig(), recently_failed: true };
		const s = session({ failed_files: new Map() });
		expect(preCheckRecentlyFailed(ctx({ config: c, toolName: "Read" }), s)).toEqual([]);
	});

	// test-contract: invariant — elapsed tool-call count is a subtraction, not an addition.
	it("computes the elapsed tool-call count by subtraction", () => {
		const c = { ...baseConfig(), recently_failed: true };
		const s = session({
			tool_call_count: 20,
			failed_files: new Map([[file, { recorded_at: "2026-08-20T00:00:00.000Z", failure_count: 3, checks: ["tsc"], tool_call_count: 6 }]]),
		});
		expect(preCheckRecentlyFailed(ctx({ config: c, toolName: "Write" }), s)).toEqual([
			"[interlinked:recently-failed] src/feature.ts had 3 check failure(s) (tsc) 14 tool call(s) ago. They may still be unresolved.",
		]);
	});
});

describe("preCheckTestFirst — mutation kills", () => {
	// test-contract: boundary — an extension outside the recognized source-extension set must not enter the test-first flow.
	it("skips the check entirely for a non-source extension", () => {
		const c = { ...baseConfig(), test_first: true };
		const out = preCheckTestFirst(
			ctx({ config: c, ext: ".py", filePath: "/workspace/src/tool.py", relPath: "src/tool.py" }),
			session(),
		);
		expect(out).toEqual([]);
	});

	// test-contract: boundary — a file already recognized as a test must never trigger the test-first nudge.
	it("skips the check for a file recognized as a test via __tests__", () => {
		const c = { ...baseConfig(), test_first: true };
		const out = preCheckTestFirst(
			ctx({
				config: c,
				filePath: "/workspace/src/__tests__/helper.ts",
				relPath: "src/__tests__/helper.ts",
			}),
			session(),
		);
		expect(out).toEqual([]);
	});

	// test-contract: invariant — once a discovered test file has actually been run this session, the nudge falls silent (the terminal empty-array branch).
	it("returns [] once the discovered test file has been run this session", () => {
		// Resolve the real colocated source/test pair from this module. A hardcoded
		// developer checkout path made discovery return null on Linux and in any
		// clone outside /Users/quentincody.
		const source = join(import.meta.dirname, "structural-checks.ts");
		const testFile = join(import.meta.dirname, "structural-checks.test.ts");
		const c = { ...baseConfig(), test_first: true };
		const s = session({ test_runs: new Map([[testFile, { status: "pass", at_step: 1 }]]) });
		const out = preCheckTestFirst(
			ctx({ config: c, filePath: source, relPath: "src/harness/structural-checks.ts" }),
			s,
		);
		expect(out).toEqual([]);
	});

	// test-contract: public-api — every listed source extension must individually enter the test-first branch; deleting any one from the recognized set would exempt that extension.
	it("recognizes every supported source extension as eligible for the test-first nudge", () => {
		const c = { ...baseConfig(), test_first: true };
		const extensions = [".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
		for (const ext of extensions) {
			const out = preCheckTestFirst(
				ctx({
					config: c,
					ext,
					filePath: `/workspace/src/missing${ext}`,
					relPath: `src/missing${ext}`,
				}),
				session(),
			);
			expect(out).toEqual([
				`[interlinked:test-first] No test file found for src/missing${ext}. Write tests before modifying the implementation.`,
			]);
		}
	});

	// test-contract: boundary — the test-name pattern must anchor at the very end of the path; a
	// recognized-extension source file whose name merely CONTAINS ".test.js" mid-string (followed
	// by another extension segment) is source, not a test, because the match cannot reach the end.
	it("treats a mid-path .test.js segment on a .ts file as source, not as a test", () => {
		const c = { ...baseConfig(), test_first: true };
		const out = preCheckTestFirst(
			ctx({
				config: c,
				filePath: "/workspace/src/widget.test.js.ts",
				relPath: "src/widget.test.js.ts",
				ext: ".ts",
			}),
			session(),
		);
		expect(out).toEqual([
			"[interlinked:test-first] No test file found for src/widget.test.js.ts. Write tests before modifying the implementation.",
		]);
	});
});

describe("preCheckBlastRadius — mutation kills", () => {
	// test-contract: boundary — below the configured threshold, the check must produce nothing at all (not a placeholder array).
	it("returns exactly [] when dependents are below the configured threshold", () => {
		const c = { ...baseConfig(), blast_radius: true, blast_radius_threshold: 5 };
		const deps = ["/workspace/src/a.ts", "/workspace/src/b.ts"];
		const out = preCheckBlastRadius(
			ctx({ config: c, graph: graph({ getDependents: vi.fn().mockReturnValue(deps) }) }),
		);
		expect(out).toEqual([]);
	});

	// test-contract: public-api — a leaf module must carry no "(hub module)" role label, and the dependent join must use a comma separator.
	it("omits the hub label for a leaf module and joins two dependents with a comma", () => {
		const c = { ...baseConfig(), blast_radius: true, blast_radius_threshold: 2 };
		const deps = ["/workspace/src/dep0.ts", "/workspace/src/dep1.ts"];
		const out = preCheckBlastRadius(
			ctx({
				config: c,
				graph: graph({
					getDependents: vi.fn().mockReturnValue(deps),
					classifyModule: vi.fn().mockReturnValue("leaf"),
				}),
			}),
		);
		expect(out).toEqual([
			"[interlinked:blast-radius] src/feature.ts is imported by 2 files (src/dep0.ts, src/dep1.ts). Changes to exports will have wide impact.",
		]);
	});

	// test-contract: boundary — exactly five dependents at the truncation boundary must show no overflow suffix at all.
	it("shows no overflow suffix at exactly five dependents", () => {
		const c = { ...baseConfig(), blast_radius: true, blast_radius_threshold: 1 };
		const deps = Array.from({ length: 5 }, (_, i) => `/workspace/src/d${i}.ts`);
		const out = preCheckBlastRadius(
			ctx({ config: c, graph: graph({ getDependents: vi.fn().mockReturnValue(deps) }) }),
		);
		expect(out).toEqual([
			"[interlinked:blast-radius] src/feature.ts is imported by 5 files (src/d0.ts, src/d1.ts, src/d2.ts, src/d3.ts, src/d4.ts). Changes to exports will have wide impact.",
		]);
	});

	// test-contract: public-api — the dependent path transform must go through graph.toRelative, not a constant/undefined stand-in.
	it("maps each dependent path through graph.toRelative", () => {
		const c = { ...baseConfig(), blast_radius: true, blast_radius_threshold: 1 };
		const deps = ["/workspace/src/nested/dep.ts"];
		const g = graph({
			getDependents: vi.fn().mockReturnValue(deps),
			toRelative: (p: string) => `REL(${p.replace("/workspace/", "")})`,
		});
		const out = preCheckBlastRadius(ctx({ config: c, graph: g }));
		expect(out).toEqual([
			"[interlinked:blast-radius] src/feature.ts is imported by 1 files (REL(src/nested/dep.ts)). Changes to exports will have wide impact.",
		]);
	});

	// test-contract: boundary — beyond five dependents, the listed names must actually be truncated to the first five, not the whole set.
	it("truncates the listed dependent names to five when there are seven", () => {
		const c = { ...baseConfig(), blast_radius: true, blast_radius_threshold: 1 };
		const deps = Array.from({ length: 7 }, (_, i) => `/workspace/src/dep${i}.ts`);
		const out = preCheckBlastRadius(
			ctx({ config: c, graph: graph({ getDependents: vi.fn().mockReturnValue(deps) }) }),
		);
		expect(out).toEqual([
			"[interlinked:blast-radius] src/feature.ts is imported by 7 files (src/dep0.ts, src/dep1.ts, src/dep2.ts, src/dep3.ts, src/dep4.ts and 2 more). Changes to exports will have wide impact.",
		]);
	});
});

describe("preCheckStaleRead — mutation kills", () => {
	// test-contract: invariant — a session with the SAME (empty) agent name as the current event must be skipped as self, not compared against a placeholder.
	it("skips a same-named session even when the current event carries no agent name", () => {
		const other = session({
			agent_name: "",
			file_write_times: new Map([[file, new Date(Date.now() - 1000).toISOString()]]),
		});
		const sessions = completeSessionTrackerFixture({ getAll: vi.fn().mockReturnValue([other]) });
		const c = { ...baseConfig(), stale_read_warning: true, staleness_window_s: 300 };
		const out = preCheckStaleRead(
			ctx({ config: c, toolName: "Read", sessions, event: { ...completeEventFixture(), cwd: "/workspace" } }),
		);
		expect(out).toEqual([]);
	});

	// test-contract: invariant — the "ago" seconds figure is a division by 1000, not a multiplication.
	it("computes the elapsed seconds by dividing the millisecond delta by 1000", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-20T00:00:05.000Z"));
		const other = session({
			agent_name: "alice",
			file_write_times: new Map([[file, "2026-08-20T00:00:00.000Z"]]),
		});
		const sessions = completeSessionTrackerFixture({ getAll: vi.fn().mockReturnValue([other]) });
		const c = { ...baseConfig(), stale_read_warning: true, staleness_window_s: 300 };
		const out = preCheckStaleRead(ctx({ config: c, toolName: "Read", sessions }));
		expect(out).toEqual([
			"[interlinked:stale-read] src/feature.ts was modified by alice 5s ago. Contents may differ from what you previously read.",
		]);
		vi.useRealTimers();
	});

	// test-contract: public-api — no other session has written the file within the window, so the loop must fall through to the terminal empty array.
	it("returns exactly [] when no other session's write time falls within the window", () => {
		const other = session({ agent_name: "alice", file_write_times: new Map() });
		const sessions = completeSessionTrackerFixture({ getAll: vi.fn().mockReturnValue([other]) });
		const c = { ...baseConfig(), stale_read_warning: true, staleness_window_s: 300 };
		const out = preCheckStaleRead(ctx({ config: c, toolName: "Read", sessions }));
		expect(out).toEqual([]);
	});

	// test-contract: boundary — a write landing exactly ON the staleness-window boundary must NOT be flagged (strict less-than), while one millisecond inside it must.
	it("does not flag a write exactly at the staleness-window boundary, but does flag one just inside it", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-20T00:00:10.000Z"));
		const c = { ...baseConfig(), stale_read_warning: true, staleness_window_s: 10 };
		const atBoundary = session({
			agent_name: "alice",
			file_write_times: new Map([[file, "2026-08-20T00:00:00.000Z"]]),
		});
		const boundarySessions = completeSessionTrackerFixture({ getAll: vi.fn().mockReturnValue([atBoundary]) });
		expect(preCheckStaleRead(ctx({ config: c, toolName: "Read", sessions: boundarySessions }))).toEqual([]);

		const insideWindow = session({
			agent_name: "alice",
			file_write_times: new Map([[file, "2026-08-20T00:00:00.001Z"]]),
		});
		const insideSessions = completeSessionTrackerFixture({ getAll: vi.fn().mockReturnValue([insideWindow]) });
		expect(preCheckStaleRead(ctx({ config: c, toolName: "Read", sessions: insideSessions }))).toHaveLength(1);
		vi.useRealTimers();
	});
});

describe("preCheckRedundantReread — mutation kills", () => {
	// test-contract: boundary — with the feature flag off, a read tool with a matching prior read must still be silent (config gate, not the tool-kind gate, decides).
	it("returns [] when redundant_reread is disabled even for a matching prior read", () => {
		const c = { ...baseConfig(), redundant_reread: false };
		const s = session({ file_read_at: new Map([[file, 3]]) });
		expect(preCheckRedundantReread(ctx({ config: c, toolName: "Read" }), s)).toEqual([]);
	});

	// test-contract: boundary — a write tool must be excluded even when the feature flag is on and a prior read is recorded (AND, not OR, gates entry).
	it("returns [] for a write tool even with redundant_reread enabled and a recorded prior read", () => {
		const c = { ...baseConfig(), redundant_reread: true };
		const s = session({ file_read_at: new Map([[file, 3]]) });
		expect(preCheckRedundantReread(ctx({ config: c, toolName: "Write" }), s)).toEqual([]);
	});

	// test-contract: invariant — no recorded prior read at all must produce the terminal empty array, not a placeholder.
	it("returns exactly [] when the file has never been read this session", () => {
		const c = { ...baseConfig(), redundant_reread: true };
		const s = session({ file_read_at: new Map() });
		expect(preCheckRedundantReread(ctx({ config: c, toolName: "Read" }), s)).toEqual([]);
	});

	// test-contract: invariant — a file modified since the read must fall through to the terminal empty array, not a placeholder.
	it("returns exactly [] when the file was modified by this session since the read", () => {
		const c = { ...baseConfig(), redundant_reread: true };
		const s = session({ file_read_at: new Map([[file, 3]]), files_written: new Set([file]) });
		expect(preCheckRedundantReread(ctx({ config: c, toolName: "Read" }), s)).toEqual([]);
	});
});

describe("preCheckRouteContext — mutation kills", () => {
	// test-contract: boundary — a tool that is neither read nor write must never surface route context, even with matching endpoints.
	it("returns [] for an unsupported tool despite matching endpoints", () => {
		const c = { ...baseConfig(), route_context: true };
		const routeMap = completeRouteMapFixture({
			extractEndpointsForFile: vi.fn().mockReturnValue([{ method: "GET", path: "/x" }]),
		});
		expect(preCheckRouteContext(ctx({ config: c, toolName: "Bash" }), routeMap)).toEqual([]);
	});

	// test-contract: invariant — zero matching endpoints must return exactly [], not a placeholder array.
	it("returns exactly [] when no endpoints match the file", () => {
		const c = { ...baseConfig(), route_context: true };
		const routeMap = completeRouteMapFixture({ extractEndpointsForFile: vi.fn().mockReturnValue([]) });
		expect(preCheckRouteContext(ctx({ config: c, toolName: "Read" }), routeMap)).toEqual([]);
	});

	// test-contract: public-api — two distinct route descriptions must be joined with a comma-space separator.
	it("joins two distinct descriptions with a comma separator", () => {
		const c = { ...baseConfig(), route_context: true };
		const routeMap = completeRouteMapFixture({
			extractEndpointsForFile: vi
				.fn()
				.mockReturnValue([
					{ method: "GET", path: "/a" },
					{ method: "POST", path: "/b" },
				]),
		});
		expect(preCheckRouteContext(ctx({ config: c, toolName: "Read" }), routeMap)).toEqual([
			"[interlinked:route-context] This file handles: GET /a, POST /b. Changes may affect API consumers.",
		]);
	});
});

describe("preCheckSiblingAwareness — mutation kills", () => {
	// test-contract: invariant — an empty sibling directory must return exactly [], not a placeholder array.
	it("returns exactly [] for a new file with no siblings", () => {
		const c = { ...baseConfig(), sibling_awareness: true };
		const out = preCheckSiblingAwareness(
			ctx({ config: c, filePath: "/workspace/src/new.ts", graph: graph({ getSiblingFiles: vi.fn().mockReturnValue([]) }) }),
		);
		expect(out).toEqual([]);
	});

	// test-contract: boundary — exactly eight siblings at the truncation boundary must show no overflow suffix, and the ninth-item truncation must actually drop entries.
	it("shows all eight names with no overflow suffix at exactly the boundary", () => {
		const c = { ...baseConfig(), sibling_awareness: true };
		const siblings = Array.from({ length: 8 }, (_, i) => `/workspace/src/s${i}.ts`);
		const out = preCheckSiblingAwareness(
			ctx({
				config: c,
				filePath: "/workspace/src/new.ts",
				graph: graph({ getSiblingFiles: vi.fn().mockReturnValue(siblings) }),
			}),
		);
		expect(out).toEqual([
			"[interlinked:sibling-awareness] Directory src/ already contains: s0.ts, s1.ts, s2.ts, s3.ts, s4.ts, s5.ts, s6.ts, s7.ts. Consider whether this new file duplicates existing functionality.",
		]);
	});

	// test-contract: boundary — beyond eight siblings, the listed names must actually be truncated to the first eight, not the whole set.
	it("truncates the listed sibling names to eight when there are ten", () => {
		const c = { ...baseConfig(), sibling_awareness: true };
		const siblings = Array.from({ length: 10 }, (_, i) => `/workspace/src/s${i}.ts`);
		const out = preCheckSiblingAwareness(
			ctx({
				config: c,
				filePath: "/workspace/src/new.ts",
				graph: graph({ getSiblingFiles: vi.fn().mockReturnValue(siblings) }),
			}),
		);
		expect(out).toEqual([
			"[interlinked:sibling-awareness] Directory src/ already contains: s0.ts, s1.ts, s2.ts, s3.ts, s4.ts, s5.ts, s6.ts, s7.ts and 2 more. Consider whether this new file duplicates existing functionality.",
		]);
	});
});

describe("preCheckCompletionTracking — mutation kills", () => {
	// test-contract: boundary — with the feature flag off, an outstanding completion past the threshold must still be silent (gate returns the terminal empty array).
	it("returns exactly [] when completion_tracking is disabled", () => {
		const c = { ...baseConfig(), completion_tracking: false };
		const completion = {
			source_file: "src",
			affected_files: [file],
			resolved_files: new Set<string>(),
			description: "x",
			recorded_at_tool_call: 0,
		};
		const s = session({ tool_call_count: 50, pending_completions: new Map([["src", completion]]) });
		expect(preCheckCompletionTracking(ctx({ config: c }), s)).toEqual([]);
	});

	// test-contract: boundary — exactly four remaining files at the truncation boundary must show no overflow suffix, and a sixth file must actually be truncated.
	it("truncates remaining files at four and reports the overflow count for a sixth", () => {
		const completion = {
			source_file: "src",
			affected_files: Array.from({ length: 6 }, (_, i) => `/workspace/src/r${i}.ts`),
			resolved_files: new Set<string>(),
			description: "sync exports",
			recorded_at_tool_call: 0,
		};
		const c = { ...baseConfig(), completion_tracking: true, completion_reminder_threshold: 5 };
		const s = session({ tool_call_count: 5, pending_completions: new Map([["src", completion]]) });
		expect(preCheckCompletionTracking(ctx({ config: c }), s)).toEqual([
			"[interlinked:completion-tracking] sync exports (5 tool calls ago). Still needs updating: src/r0.ts, src/r1.ts, src/r2.ts, src/r3.ts and 2 more",
		]);
	});

	// test-contract: boundary — exactly four remaining files must show no overflow suffix at all.
	it("shows no overflow suffix at exactly four remaining files", () => {
		const completion = {
			source_file: "src",
			affected_files: Array.from({ length: 4 }, (_, i) => `/workspace/src/r${i}.ts`),
			resolved_files: new Set<string>(),
			description: "sync exports",
			recorded_at_tool_call: 0,
		};
		const c = { ...baseConfig(), completion_tracking: true, completion_reminder_threshold: 5 };
		const s = session({ tool_call_count: 5, pending_completions: new Map([["src", completion]]) });
		expect(preCheckCompletionTracking(ctx({ config: c }), s)).toEqual([
			"[interlinked:completion-tracking] sync exports (5 tool calls ago). Still needs updating: src/r0.ts, src/r1.ts, src/r2.ts, src/r3.ts",
		]);
	});
});

describe("preCheckFollowUpViolation — mutation kills", () => {
	// test-contract: invariant — no pending completions means checkFollowUpViolation returns null, so the terminal empty array must fire, not a placeholder.
	it("returns exactly [] when there are no pending completions to violate", () => {
		const c = { ...baseConfig(), impact_analysis: true };
		const s = session({ pending_completions: new Map() });
		expect(preCheckFollowUpViolation(ctx({ config: c, toolName: "Write" }), s)).toEqual([]);
	});
});
