import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pre-checks.js", () => ({
	checkConcurrentEdit: vi.fn(() => null),
	checkDirtyWorkingTree: vi.fn(() => null),
	checkEnvLeakToGit: vi.fn(() => null),
	checkLargeFileLineCountWrite: vi.fn(() => null),
	checkLargeFileWrite: vi.fn(() => null),
	checkSelfKill: vi.fn(() => null),
	checkStaleBranch: vi.fn(() => null),
}));
vi.mock("./complexity-write-guard.js", () => ({
	checkFunctionComplexityWrite: vi.fn(() => null),
}));
vi.mock("./cognitive-write-guard.js", () => ({
	checkCognitiveComplexityWrite: vi.fn(() => null),
}));
vi.mock("./complexity-pulse.js", () => ({ recordComplexityPulse: vi.fn() }));
vi.mock("./pre-tool-test-integrity.js", () => ({ checkTestSignalErosion: vi.fn(() => null) }));
vi.mock("../pattern-detector.js", () => ({ getPatternWarnings: vi.fn(() => []) }));

import {
	checkConcurrentEdit,
	checkDirtyWorkingTree,
	checkEnvLeakToGit,
	checkLargeFileLineCountWrite,
	checkLargeFileWrite,
	checkSelfKill,
	checkStaleBranch,
} from "../pre-checks.js";
import { getPatternWarnings } from "../pattern-detector.js";
import { checkCognitiveComplexityWrite } from "./cognitive-write-guard.js";
import { recordComplexityPulse } from "./complexity-pulse.js";
import { checkFunctionComplexityWrite } from "./complexity-write-guard.js";
import { checkTestSignalErosion } from "./pre-tool-test-integrity.js";
import {
	evaluateErrorMemory,
	evaluatePreChecksSelfKillEnv,
	evaluatePreChecksTail,
} from "./pre-tool-phases.js";
import type { ErrorHistory } from "../error-history.js";
import type { ProjectGraph } from "../project-graph.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";

const CWD = "/workspace/project";
const TS = "2026-08-20T00:00:00.000Z";

beforeEach(() => {
	vi.clearAllMocks();
});

function event(overrides: (Partial<Omit<HarnessEvent, "cwd">> & { cwd?: string | undefined }) = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "session-1",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: {},
		cwd: CWD,
		timestamp: TS,
		...overrides,
	} as HarnessEvent;
}

function session(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "session-1",
		agent_name: "agent",
		started_at: TS,
		tool_call_count: 1,
		tool_sequence: [],
		sensitivity_level: "Public",
		soft_blocks: new Set(),
		fired_reminders: new Set(),
		suggested_permissions: new Set(),
		consecutive_pattern: null,
		curl_localhost_count: {},
		injection_detected_steps: [],
		taint_sources: [],
		files_written: new Set(),
		files_read: new Set(),
		file_write_times: new Map(),
		step_limit: Number.POSITIVE_INFINITY,
		...overrides,
	} as SessionTrajectory;
}

function rules(errorMemory?: GuardRulesConfig["error_memory"]): GuardRulesConfig {
	return { error_memory: errorMemory } as GuardRulesConfig;
}

function history(): ErrorHistory {
	return {
		getFileHistoryWarning: vi.fn(() => null),
		getRecords: vi.fn(() => []),
	} as unknown as ErrorHistory;
}

function graph(): ProjectGraph {
	return { toRelative: vi.fn((path: string) => `relative/${path}`) } as unknown as ProjectGraph;
}

describe("evaluatePreChecksSelfKillEnv mutation contracts", () => {
	// test-contract: security — only a non-empty Bash command is sent to the self-kill detector;
	// an empty command must not invoke the detector or manufacture a block.
	it("skips self-kill detection for an empty Bash command", () => {
		const warnings: string[] = [];
		const out = evaluatePreChecksSelfKillEnv(event(), "Bash", { command: "" }, warnings);
		expect(out).toBeNull();
		expect(checkSelfKill).not.toHaveBeenCalled();
		expect(warnings).toEqual([]);
	});

	// test-contract: security — a detector block is returned with the exact public decision metadata.
	it("returns the self-kill block and does not continue into other phases", () => {
		vi.mocked(checkSelfKill).mockReturnValueOnce({ block: "do not kill this process" });
		const warnings: string[] = [];
		const out = evaluatePreChecksSelfKillEnv(event(), "Bash", { command: "kill 123" }, warnings);
		expect(out).toEqual({
			decision: "block",
			reason: "do not kill this process",
			rule_id: "self-kill-protection",
			severity: "critical",
			category: "process-killing",
		});
		expect(checkSelfKill).toHaveBeenCalledWith("kill 123");
	});

	// test-contract: security — file writes resolve file_path before path and forward cwd/content to env scanning.
	it("routes a file write through env-leak scanning with exact arguments", () => {
		vi.mocked(checkEnvLeakToGit).mockReturnValueOnce({ warning: "environment warning" });
		const warnings: string[] = [];
		const out = evaluatePreChecksSelfKillEnv(
			event({ cwd: "/repo" }),
			"Write",
			{ file_path: ".env", path: "ignored.env", content: "FLAG=1" },
			warnings,
		);
		expect(out).toBeNull();
		expect(checkEnvLeakToGit).toHaveBeenCalledWith(".env", "FLAG=1", "/repo");
		expect(warnings).toEqual(["environment warning"]);
	});

	// test-contract: boundary — an absent cwd uses process.cwd(), while a non-file-write tool never adds another env scan.
	it("uses cwd fallback without routing Bash through env scanning", () => {
		const warnings: string[] = [];
		evaluatePreChecksSelfKillEnv(event({ cwd: undefined }), "Write", { file_path: ".env", content: "FLAG=1" }, warnings);
		expect(checkEnvLeakToGit).toHaveBeenCalledWith(".env", "FLAG=1", process.cwd());
		evaluatePreChecksSelfKillEnv(event({ cwd: undefined }), "Bash", { command: "echo ok" }, warnings);
		expect(checkEnvLeakToGit).toHaveBeenCalledTimes(1);
	});
});

describe("evaluatePreChecksTail mutation contracts", () => {
	// test-contract: invariant — a non-write tool bypasses all metric-cap collaborators and tail warnings.
	it("returns null for a non-write tool without metric checks", () => {
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(event(), session(), undefined, "Read", {}, warnings);
		expect(out).toBeNull();
		expect(checkLargeFileLineCountWrite).not.toHaveBeenCalled();
		expect(checkFunctionComplexityWrite).not.toHaveBeenCalled();
		expect(checkCognitiveComplexityWrite).not.toHaveBeenCalled();
		expect(warnings).toEqual([]);
	});

	// test-contract: invariant — cyclomatic-only and cognitive-only blocks each short-circuit with their own rule id.
	it("preserves each independent metric block and exact reason", () => {
		vi.mocked(checkFunctionComplexityWrite).mockReturnValueOnce({ block: "cyclomatic reason" });
		vi.mocked(checkCognitiveComplexityWrite).mockReturnValueOnce({ block: "cognitive reason" });
		const out = evaluatePreChecksTail(event(), session(), undefined, "Write", { file_path: "f.ts" }, []);
		expect(out).toEqual({
			decision: "block",
			reason: "cyclomatic reason\n\ncognitive reason",
			rule_id: "cyclomatic-cap",
			severity: "medium",
			category: "complexity",
		});

		vi.mocked(checkFunctionComplexityWrite).mockReturnValueOnce(null);
		vi.mocked(checkCognitiveComplexityWrite).mockReturnValueOnce({ block: "cognitive only" });
		const cognitiveOnly = evaluatePreChecksTail(event(), session(), undefined, "Write", { file_path: "f.ts" }, []);
		expect(cognitiveOnly?.rule_id).toBe("cognitive-cap");
		expect(cognitiveOnly?.reason).toBe("cognitive only");
	});

	// test-contract: invariant — the complexity pulse callback resolves relative paths against cwd and forwards all measurements.
	it("records the complexity pulse with an absolute resolved path", () => {
		vi.mocked(checkFunctionComplexityWrite).mockImplementationOnce((_input, _cwd, callback) => {
			callback?.("src/file.ts", [], [], "new content");
			return null;
		});
		const warnings: string[] = [];
		evaluatePreChecksTail(event({ session_id: "pulse-session" }), session(), undefined, "Write", { file_path: "src/file.ts" }, warnings);
		expect(recordComplexityPulse).toHaveBeenCalledWith(
		"pulse-session",
		`${CWD}/src/file.ts`,
			[],
			[],
		"new content",
		);
	});

	// test-contract: boundary — stale-branch checking includes call counts 1, 3 and excludes 4.
	it("checks stale branches through the inclusive limit", () => {
		// Once per expected call: a persistent mockReturnValue would survive
		// vi.clearAllMocks() (it clears calls, not implementations) and leak
		// "stale" into later tests in this file.
		vi.mocked(checkStaleBranch)
			.mockReturnValueOnce({ warning: "stale" })
			.mockReturnValueOnce({ warning: "stale" });
		for (const count of [1, 3]) {
			const warnings: string[] = [];
			evaluatePreChecksTail(event({ session_id: `s-${count}` }), session({ tool_call_count: count }), undefined, "Read", {}, warnings);
			expect(warnings).toEqual(["stale"]);
		}
		const warnings: string[] = [];
		evaluatePreChecksTail(event(), session({ tool_call_count: 4 }), undefined, "Read", {}, warnings);
		expect(warnings).toEqual([]);
	});

	// test-contract: boundary — Bash dirty-tree and file-write large-file checks require non-empty command/content, with exact forwarding.
	it("routes non-empty Bash commands and write content to their warning checks", () => {
		vi.mocked(checkDirtyWorkingTree).mockReturnValueOnce({ warning: "dirty" });
		vi.mocked(checkLargeFileWrite).mockReturnValueOnce({ warning: "large" });
		const bashWarnings: string[] = [];
		evaluatePreChecksTail(event(), undefined, undefined, "Bash", { command: "git status" }, bashWarnings);
		expect(checkDirtyWorkingTree).toHaveBeenCalledWith("git status", CWD);
		expect(bashWarnings).toEqual(["dirty"]);

		const writeWarnings: string[] = [];
		evaluatePreChecksTail(event(), undefined, undefined, "Write", { content: "abc" }, writeWarnings);
		expect(checkLargeFileWrite).toHaveBeenCalledWith("abc");
		expect(writeWarnings).toEqual(["large"]);
	});

	// test-contract: boundary — an empty command skips dirty-tree work, while empty write content is forwarded as the exact fallback string.
	it("handles empty command and content at their exact boundaries", () => {
		const bashWarnings: string[] = [];
		evaluatePreChecksTail(event(), undefined, undefined, "Bash", { command: "" }, bashWarnings);
		const writeWarnings: string[] = [];
		evaluatePreChecksTail(event(), undefined, undefined, "Write", { content: "" }, writeWarnings);
		expect(checkDirtyWorkingTree).not.toHaveBeenCalled();
		expect(checkLargeFileWrite).toHaveBeenCalledWith("");
		expect(bashWarnings).toEqual([]);
		expect(writeWarnings).toEqual([]);
	});

	// test-contract: security — concurrent-edit checking requires both a tracker and a non-empty file path.
	it("forwards file-write concurrency checks only when sessions and path exist", () => {
		const tracker = { getAll: vi.fn(() => ["session"]), } as never;
		vi.mocked(checkConcurrentEdit).mockReturnValueOnce({ warning: "concurrent" });
		const warnings: string[] = [];
		evaluatePreChecksTail(event(), undefined, tracker, "Write", { file_path: "src/a.ts" }, warnings);
		expect(checkConcurrentEdit).toHaveBeenCalledWith("src/a.ts", "session-1", ["session"]);
		expect(warnings).toEqual(["concurrent"]);
	});

	// test-contract: invariant — an active session forwards test-signal erosion exactly, while no session is an early no-op.
	it("forwards test-signal erosion only when a session exists", () => {
		vi.mocked(checkTestSignalErosion).mockReturnValueOnce("erosion warning");
		const warnings: string[] = [];
		evaluatePreChecksTail(event({ tool_name: "Write", tool_input: { file_path: "test.ts" } }), session(), undefined, "Read", {}, warnings);
		expect(checkTestSignalErosion).toHaveBeenCalledWith("Write", { file_path: "test.ts" }, expect.anything(), CWD);
		expect(warnings).toEqual(["erosion warning"]);

		const noSessionWarnings: string[] = [];
		evaluatePreChecksTail(event(), undefined, undefined, "Read", {}, noSessionWarnings);
		expect(checkTestSignalErosion).toHaveBeenCalledTimes(1);
		expect(noSessionWarnings).toEqual([]);
	});
});

describe("evaluateErrorMemory mutation contracts", () => {
	// test-contract: boundary — missing/disabled error-memory config is a no-op and must not dereference optional config.
	it("does nothing when error-memory configuration is absent", () => {
		const warnings: string[] = [];
		evaluateErrorMemory(event(), rules(), session(), graph(), history(), "Read", { file_path: "a.ts" }, warnings);
		expect(warnings).toEqual([]);
	});

	// test-contract: boundary — enabled memory still requires both a resolvable path and a project graph.
	it("does nothing when the graph or file path is missing", () => {
		const configured = rules({ enabled: true } as GuardRulesConfig["error_memory"]);
		const h = history();
		evaluateErrorMemory(event(), configured, session(), undefined, h, "Read", { file_path: "a.ts" }, []);
		evaluateErrorMemory(event(), configured, session(), graph(), h, "Read", {}, []);
		expect(h.getFileHistoryWarning).not.toHaveBeenCalled();
		expect(getPatternWarnings).not.toHaveBeenCalled();
	});

	// test-contract: public-api — enabled memory accepts both file writes and reads, but rejects unrelated tools.
	it("limits enabled memory to read and write tools", () => {
		const h = history();
		const g = graph();
		const configured = rules({ enabled: true } as GuardRulesConfig["error_memory"]);
		evaluateErrorMemory(event(), configured, session(), g, h, "Read", { file_path: "a.ts" }, []);
		evaluateErrorMemory(event(), configured, session(), g, h, "Bash", { file_path: "a.ts" }, []);
		expect(h.getFileHistoryWarning).toHaveBeenCalledTimes(1);
	});

	// test-contract: invariant — an Edit with old_string estimates a line and passes it exactly to pattern detection; other tools do not.
	it("passes the Edit line estimate and preserves pattern warnings", () => {
		const h = history();
		const g = graph();
		vi.mocked(getPatternWarnings).mockReturnValueOnce(["pattern warning"]);
		const s = session();
		const warnings: string[] = [];
		// estimateEditLine reads the real filesystem, so the target must exist and
		// contain old_string — package.json (vitest runs from the repo root) does.
		evaluateErrorMemory(event(), rules({ enabled: true } as GuardRulesConfig["error_memory"]), s, g, h, "Edit", { file_path: "package.json", old_string: '"name"' }, warnings);
		expect(getPatternWarnings).toHaveBeenCalledWith([], "relative/package.json", s, expect.any(Number));
		expect(warnings).toEqual(["pattern warning"]);
	});

	// test-contract: boundary — a non-Edit tool, an Edit without old_string, or a missing path must not estimate a line.
	it("does not estimate an edit line when the Edit conjunction is incomplete", () => {
		const h = history();
		const g = graph();
		const configured = rules({ enabled: true } as GuardRulesConfig["error_memory"]);
		for (const [toolName, input] of [["Edit", { file_path: "a.ts" }], ["Write", { file_path: "a.ts", old_string: "old" }], ["Edit", {}]] as const) {
			evaluateErrorMemory(event(), configured, session(), g, h, toolName, input, []);
		}
		expect(getPatternWarnings).toHaveBeenCalledTimes(2);
		expect(getPatternWarnings).toHaveBeenNthCalledWith(1, [], "relative/a.ts", expect.anything(), undefined);
		expect(getPatternWarnings).toHaveBeenNthCalledWith(2, [], "relative/a.ts", expect.anything(), undefined);
	});
});
