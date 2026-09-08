// Mutation-kill companion for pre-tool-context-phases.ts.
//
// Every phase in the SUT is thin orchestration: read a guard/flag, call one
// collaborator, conditionally push the collaborator's result into a shared
// `warnings` array. The collaborators from "./pre-tool-helpers.js" and
// "../structural-checks.js" are mocked so each phase's own branch logic
// (guard conditions, ||/&& defaults, regexes, length checks) can be driven
// directly without paying for real tsc/fs/graph work. "./tool-classifiers.js",
// "./spans.js", and "../server-tool-helpers.js" are used FOR REAL — they are
// pure and deterministic, and exercising the real classifiers kills more
// mutants (regex edits, boolean-literal flips) than mocking would.
//
// Two length-check phases (evaluateTrajectoryDetectorPhase,
// evaluateProjectSetupPhase) push via `warnings.push(...collabResult)`. When
// collabResult is `[]`, `push()` is a no-op REGARDLESS of the guard, so a
// "the guard is stuck true" mutant cannot be told apart from correct
// behavior by inspecting final array content alone — both leave `warnings`
// unchanged. We spy on `warnings.push` itself in that branch so an
// always-true guard is caught by the spurious (zero-arg) call, not by array
// content.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./pre-tool-helpers.js", () => ({
	runTrajectoryDetector: vi.fn(() => []),
	evaluateCurlMcpGuards: vi.fn(() => []),
	evaluateMarkdownFirstCurlGuard: vi.fn(() => []),
	getPreToolUseDiagnostics: vi.fn(() => []),
	getProjectSetupWarnings: vi.fn(() => []),
	getSupermodelCallContext: vi.fn(() => null),
	getSupermodelGraphWarning: vi.fn(() => null),
}));

vi.mock("../structural-checks.js", () => ({
	getPreToolUseContext: vi.fn(() => []),
}));

import type { ProjectGraph } from "../project-graph.js";
import type { RouteMap } from "../route-map.js";
import type { SessionTracker } from "../session-state.js";
import { getPreToolUseContext } from "../structural-checks.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";
import {
	evaluateCurlMcpGuards,
	evaluateMarkdownFirstCurlGuard,
	getPreToolUseDiagnostics,
	getProjectSetupWarnings,
	getSupermodelCallContext,
	getSupermodelGraphWarning,
	runTrajectoryDetector,
} from "./pre-tool-helpers.js";
import {
	evaluateCurlMcpPhase,
	evaluateDiagnosticsPhase,
	evaluateMarkdownFirstPhase,
	evaluateProjectSetupPhase,
	evaluateStructuralContextPhase,
	evaluateSupermodelGraphContext,
	evaluateTrajectoryDetectorPhase,
	type ToolInput,
} from "./pre-tool-context-phases.js";

const CWD = "/repo";
const FIXED_TS = "2026-04-01T00:00:00.000Z";

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "t",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: {},
		cwd: CWD,
		timestamp: FIXED_TS,
		...overrides,
	} as HarnessEvent;
}

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "t",
		agent_name: "agent",
		started_at: FIXED_TS,
		tool_call_count: 0,
		tool_sequence: [],
		sensitivity_level: "Public",
		soft_blocks: new Set(),
		fired_reminders: new Set(),
		suggested_permissions: new Set(),
		consecutive_pattern: null,
		curl_localhost_count: {},
		injection_detected_steps: [],
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		...overrides,
	} as unknown as SessionTrajectory;
}

function makeRules(overrides: Partial<GuardRulesConfig> = {}): GuardRulesConfig {
	return {
		version: 1,
		enabled: true,
		rules: [],
		protected_files: [],
		file_reminders: [],
		curl_mcp_detection: { enabled: false, localhost_ports: [], escalate_after: 5, message: "" },
		quality_checks: {},
		structural_checks: {} as GuardRulesConfig["structural_checks"],
		error_memory: { enabled: false, expires_after_s: 0, scope: "file" },
		taint_tracking: { enabled: false } as GuardRulesConfig["taint_tracking"],
		output_scanning: { enabled: false } as GuardRulesConfig["output_scanning"],
		...overrides,
	} as GuardRulesConfig;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(runTrajectoryDetector).mockReturnValue([]);
	vi.mocked(evaluateCurlMcpGuards).mockReturnValue([]);
	vi.mocked(evaluateMarkdownFirstCurlGuard).mockReturnValue([]);
	vi.mocked(getPreToolUseDiagnostics).mockReturnValue([]);
	vi.mocked(getProjectSetupWarnings).mockReturnValue([]);
	vi.mocked(getSupermodelCallContext).mockReturnValue(null);
	vi.mocked(getSupermodelGraphWarning).mockReturnValue(null);
	vi.mocked(getPreToolUseContext).mockReturnValue([]);
});

// ============================================================
// evaluateTrajectoryDetectorPhase
// ============================================================
describe("evaluateTrajectoryDetectorPhase", () => {
	it("P1: session present + detector finds warnings -> forwards event/session/config and pushes results", () => {
		vi.mocked(runTrajectoryDetector).mockReturnValue(["[traj] w1"]);
		const event = makeEvent();
		const session = makeSession();
		const warnings: string[] = [];
		evaluateTrajectoryDetectorPhase(event, session, null, warnings);
		expect(warnings).toEqual(["[traj] w1"]);
		expect(runTrajectoryDetector).toHaveBeenCalledWith(event, session, null);
	});

	it("N1: session undefined -> returns immediately, detector never called, warnings untouched", () => {
		const warnings: string[] = ["existing"];
		evaluateTrajectoryDetectorPhase(makeEvent(), undefined, null, warnings);
		expect(runTrajectoryDetector).not.toHaveBeenCalled();
		expect(warnings).toEqual(["existing"]);
	});

	it("N2: detector returns an empty array -> warnings.push is never invoked (not just content-empty)", () => {
		vi.mocked(runTrajectoryDetector).mockReturnValue([]);
		const warnings: string[] = [];
		const pushSpy = vi.spyOn(warnings, "push");
		evaluateTrajectoryDetectorPhase(makeEvent(), makeSession(), null, warnings);
		expect(pushSpy).not.toHaveBeenCalled();
	});
});

// ============================================================
// evaluateCurlMcpPhase
// ============================================================
describe("evaluateCurlMcpPhase", () => {
	it("P1: Bash tool with a real /mcp command -> scans it and forwards the full arg bag", () => {
		vi.mocked(evaluateCurlMcpGuards).mockReturnValue(["[curlmcp] hit"]);
		const session = makeSession();
		const rules = makeRules({
			curl_mcp_detection: { enabled: true, localhost_ports: [3000], escalate_after: 5, message: "m" },
		});
		const toolInput = { command: "curl http://localhost:3000/mcp/status" } as ToolInput;
		const warnings: string[] = [];
		evaluateCurlMcpPhase(session, rules, "Bash", toolInput, warnings);
		expect(evaluateCurlMcpGuards).toHaveBeenCalledWith({
			mcpScanCommand: "curl http://localhost:3000/mcp/status",
			targetsMcpPath: true,
			curlMcpDetection: rules.curl_mcp_detection,
			session,
		});
		expect(warnings).toEqual(["[curlmcp] hit"]);
	});

	it("N1: non-Bash tool -> extraction and guard are skipped entirely", () => {
		const toolInput = { command: "curl http://localhost:3000/mcp/status" } as ToolInput;
		const warnings: string[] = [];
		evaluateCurlMcpPhase(makeSession(), makeRules(), "Read", toolInput, warnings);
		expect(evaluateCurlMcpGuards).not.toHaveBeenCalled();
		expect(warnings).toEqual([]);
	});

	it("P2: singular /message path still targets the MCP-shaped-path regex", () => {
		const toolInput = { command: "curl http://localhost:9999/message/42" } as ToolInput;
		const warnings: string[] = [];
		evaluateCurlMcpPhase(makeSession(), makeRules(), "Bash", toolInput, warnings);
		expect(evaluateCurlMcpGuards).toHaveBeenCalledWith(
			expect.objectContaining({ targetsMcpPath: true }),
		);
	});

	it("N2: missing command -> scans an empty string, not a boolean literal", () => {
		const toolInput = {} as ToolInput;
		const warnings: string[] = [];
		evaluateCurlMcpPhase(makeSession(), makeRules(), "Bash", toolInput, warnings);
		expect(evaluateCurlMcpGuards).toHaveBeenCalledWith(
			expect.objectContaining({ mcpScanCommand: "", targetsMcpPath: false }),
		);
	});
});

// ============================================================
// evaluateMarkdownFirstPhase
// ============================================================
describe("evaluateMarkdownFirstPhase", () => {
	it("P1: browser-navigate tool with a real https URL -> pushes the markdown-first literal warning", () => {
		const toolInput = { url: "https://example.com/page" } as ToolInput;
		const warnings: string[] = [];
		evaluateMarkdownFirstPhase("mcp__playwright__browser_navigate", toolInput, warnings);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[interlinked:markdown-first]");
		expect(warnings[0]).toContain("https://example.com/page");
	});

	it("N1: a tool that is neither browser-navigate nor Bash -> neither branch fires", () => {
		const toolInput = { url: "https://example.com/page" } as ToolInput;
		const warnings: string[] = [];
		evaluateMarkdownFirstPhase("Grep", toolInput, warnings);
		expect(warnings).toEqual([]);
		expect(evaluateMarkdownFirstCurlGuard).not.toHaveBeenCalled();
	});

	it("P2: Bash tool with a real command -> forwards the exact command string to the curl guard", () => {
		vi.mocked(evaluateMarkdownFirstCurlGuard).mockReturnValue(["[md-first] hit"]);
		const toolInput = { command: "curl http://x" } as ToolInput;
		const warnings: string[] = [];
		evaluateMarkdownFirstPhase("Bash", toolInput, warnings);
		expect(evaluateMarkdownFirstCurlGuard).toHaveBeenCalledWith("curl http://x");
		expect(warnings).toEqual(["[md-first] hit"]);
	});
});

// ============================================================
// evaluateStructuralContextPhase
// ============================================================
describe("evaluateStructuralContextPhase", () => {
	it("P1: graph + sessions + structural_checks.enabled all present -> forwards every arg and pushes results", () => {
		vi.mocked(getPreToolUseContext).mockReturnValue(["[struct] ctx"]);
		const event = makeEvent();
		const graph = {} as unknown as ProjectGraph;
		const sessions = {} as unknown as SessionTracker;
		const session = makeSession();
		const routeMap = {} as unknown as RouteMap;
		const rules = makeRules({
			structural_checks: { enabled: true } as unknown as GuardRulesConfig["structural_checks"],
		});
		const warnings: string[] = [];
		evaluateStructuralContextPhase(event, rules, graph, sessions, session, routeMap, warnings);
		expect(getPreToolUseContext).toHaveBeenCalledWith(
			event,
			rules.structural_checks,
			graph,
			sessions,
			session,
			routeMap,
		);
		expect(warnings).toEqual(["[struct] ctx"]);
	});

	it("N1: graph is undefined -> guard short-circuits, context is never computed", () => {
		const sessions = {} as unknown as SessionTracker;
		const rules = makeRules({
			structural_checks: { enabled: true } as unknown as GuardRulesConfig["structural_checks"],
		});
		const warnings: string[] = [];
		evaluateStructuralContextPhase(
			makeEvent(),
			rules,
			undefined,
			sessions,
			makeSession(),
			undefined,
			warnings,
		);
		expect(getPreToolUseContext).not.toHaveBeenCalled();
		expect(warnings).toEqual([]);
	});
});

// ============================================================
// evaluateSupermodelGraphContext
// ============================================================
describe("evaluateSupermodelGraphContext", () => {
	it("P1: file-write tool with a resolvable edited path -> looks up the graph warning for it and pushes it", () => {
		vi.mocked(getSupermodelGraphWarning).mockReturnValue("[graph] a.ts");
		const event = makeEvent({ tool_input: { file_path: "src/a.ts" } as ToolInput, cwd: "/repo" });
		const warnings: string[] = [];
		evaluateSupermodelGraphContext(event, "Write", warnings);
		expect(getSupermodelGraphWarning).toHaveBeenCalledWith("src/a.ts", "/repo");
		expect(warnings).toEqual(["[graph] a.ts"]);
	});

	it("N1: non-file-write tool -> the edited-path loop never runs", () => {
		const event = makeEvent({ tool_input: { file_path: "src/a.ts" } as ToolInput, cwd: "/repo" });
		const warnings: string[] = [];
		evaluateSupermodelGraphContext(event, "Read", warnings);
		expect(getSupermodelGraphWarning).not.toHaveBeenCalled();
		expect(warnings).toEqual([]);
	});
});

// ============================================================
// evaluateProjectSetupPhase
// ============================================================
describe("evaluateProjectSetupPhase", () => {
	it("P1: setup warnings found -> pushes them and resolves cwd from the event", () => {
		vi.mocked(getProjectSetupWarnings).mockReturnValue(["[setup] missing config"]);
		const event = makeEvent({ cwd: "/repo/nonempty" });
		const warnings: string[] = [];
		evaluateProjectSetupPhase(event, warnings);
		expect(getProjectSetupWarnings).toHaveBeenCalledWith("/repo/nonempty");
		expect(warnings).toEqual(["[setup] missing config"]);
	});

	it("N1: no setup warnings -> warnings.push is never invoked", () => {
		vi.mocked(getProjectSetupWarnings).mockReturnValue([]);
		const warnings: string[] = [];
		const pushSpy = vi.spyOn(warnings, "push");
		evaluateProjectSetupPhase(makeEvent(), warnings);
		expect(pushSpy).not.toHaveBeenCalled();
	});
});

// ============================================================
// evaluateDiagnosticsPhase (+ module-level DIAGNOSTIC_EXTENSIONS regex)
// ============================================================
describe("evaluateDiagnosticsPhase", () => {
	it("P1: file-write tool + quality checks enabled + .ts path -> runs diagnostics and pushes results", () => {
		vi.mocked(getPreToolUseDiagnostics).mockReturnValue(["[diag] ts issue"]);
		const rules = makeRules();
		const event = makeEvent({ cwd: "/repo" });
		const toolInput = { file_path: "src/foo.ts" } as ToolInput;
		const warnings: string[] = [];
		evaluateDiagnosticsPhase(event, rules, "Write", toolInput, warnings);
		expect(getPreToolUseDiagnostics).toHaveBeenCalledWith("src/foo.ts", "/repo", rules.quality_checks);
		expect(warnings).toEqual(["[diag] ts issue"]);
	});

	it("P2: a plain .js path also matches the diagnosable-extension regex", () => {
		const toolInput = { file_path: "src/foo.js" } as ToolInput;
		const warnings: string[] = [];
		const event = makeEvent();
		const rules = makeRules();
		evaluateDiagnosticsPhase(event, rules, "Write", toolInput, warnings);
		expect(getPreToolUseDiagnostics).toHaveBeenCalledWith("src/foo.js", event.cwd, rules.quality_checks);
	});

	it("N1: a path merely CONTAINING .tsx mid-string (not at the end) does not match", () => {
		const toolInput = { file_path: "src/foo.tsx.bak" } as ToolInput;
		const warnings: string[] = [];
		evaluateDiagnosticsPhase(makeEvent(), makeRules(), "Write", toolInput, warnings);
		expect(getPreToolUseDiagnostics).not.toHaveBeenCalled();
		expect(warnings).toEqual([]);
	});

	it("N2: non-file-write tool -> diagnostics are skipped even for a diagnosable path", () => {
		const toolInput = { file_path: "src/foo.ts" } as ToolInput;
		const warnings: string[] = [];
		evaluateDiagnosticsPhase(makeEvent(), makeRules(), "Read", toolInput, warnings);
		expect(getPreToolUseDiagnostics).not.toHaveBeenCalled();
	});

	it("N3: file-write tool but quality_checks is falsy -> diagnostics are skipped (AND, not OR)", () => {
		const rules = makeRules({
			quality_checks: undefined as unknown as GuardRulesConfig["quality_checks"],
		});
		const toolInput = { file_path: "src/foo.ts" } as ToolInput;
		const warnings: string[] = [];
		evaluateDiagnosticsPhase(makeEvent(), rules, "Write", toolInput, warnings);
		expect(getPreToolUseDiagnostics).not.toHaveBeenCalled();
	});
});
