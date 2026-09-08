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
vi.mock("./tool-classifiers.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./tool-classifiers.js")>();
	return { ...actual, estimateEditLine: vi.fn(() => 42) };
});

import { getPatternWarnings } from "../pattern-detector.js";
import {
	checkConcurrentEdit,
	checkDirtyWorkingTree,
	checkEnvLeakToGit,
	checkLargeFileLineCountWrite,
	checkLargeFileWrite,
	checkSelfKill,
	checkStaleBranch,
} from "../pre-checks.js";
import type { ErrorHistory } from "../error-history.js";
import type { ProjectGraph } from "../project-graph.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";
import { checkCognitiveComplexityWrite } from "./cognitive-write-guard.js";
import { recordComplexityPulse } from "./complexity-pulse.js";
import { checkFunctionComplexityWrite } from "./complexity-write-guard.js";
import {
	evaluateErrorMemory,
	evaluatePreChecksSelfKillEnv,
	evaluatePreChecksTail,
} from "./pre-tool-phases.js";
import { checkTestSignalErosion } from "./pre-tool-test-integrity.js";

const CWD = "/workspace/project";
const TS = "2026-08-20T00:00:00.000Z";
type ToolInput = NonNullable<HarnessEvent["tool_input"]>;

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

describe("evaluatePreChecksSelfKillEnv mutation contracts (wave 2)", () => {
	// test-contract: security — a real, distinct cwd must reach env-leak scanning verbatim; a
	// truthy/falsy/&&-mangled fallback expression would substitute a different value here.
	it("forwards the exact configured cwd to env-leak scanning", () => {
		vi.mocked(checkEnvLeakToGit).mockReturnValueOnce(null);
		const out = evaluatePreChecksSelfKillEnv(
			event({ cwd: "/custom/cwd" }),
			"Write",
			{ file_path: ".env", content: "X" },
			[],
		);
		expect(out).toBeNull();
		expect(checkEnvLeakToGit).toHaveBeenCalledWith(".env", "X", "/custom/cwd");
	});

	// test-contract: invariant — a non-Bash tool never invokes self-kill detection even when a
	// command-shaped field is present in its input.
	it("never checks self-kill for a non-Bash tool", () => {
		evaluatePreChecksSelfKillEnv(event(), "Write", { command: "kill 1" } as ToolInput, []);
		expect(checkSelfKill).not.toHaveBeenCalled();
	});

	// test-contract: boundary — a Bash call with no command field at all must not invoke
	// self-kill detection (the "" fallback keeps the outer `if` falsy).
	it("skips self-kill detection when the Bash command field is entirely absent", () => {
		evaluatePreChecksSelfKillEnv(event(), "Bash", {}, []);
		expect(checkSelfKill).not.toHaveBeenCalled();
	});

	// test-contract: boundary — a Write with neither file_path nor path present must not invoke
	// env-leak scanning (the "" fallback keeps the outer `if` falsy).
	it("skips env-leak scanning when neither file_path nor path is present", () => {
		evaluatePreChecksSelfKillEnv(event(), "Write", { content: "irrelevant" }, []);
		expect(checkEnvLeakToGit).not.toHaveBeenCalled();
	});

	// test-contract: invariant — a non-file-write tool never invokes env-leak scanning even when
	// file_path/content fields are present in its input.
	it("never checks env-leak for a non-file-write tool", () => {
		evaluatePreChecksSelfKillEnv(event(), "Bash", { file_path: ".env", content: "X" } as ToolInput, []);
		expect(checkEnvLeakToGit).not.toHaveBeenCalled();
	});
});

describe("evaluatePreChecksTail — checkFileWriteMetricCaps mutation contracts (wave 2)", () => {
	// test-contract: invariant — a cyclomatic-only block must short-circuit even though the
	// cognitive gate returned nothing (guards the &&-vs-|| combinator on the two negated checks).
	it("still blocks when only the cyclomatic gate fires", () => {
		vi.mocked(checkFunctionComplexityWrite).mockReturnValueOnce({ block: "cyclomatic only" });
		vi.mocked(checkCognitiveComplexityWrite).mockReturnValueOnce(null);
		const out = evaluatePreChecksTail(event(), undefined, undefined, "Write", { file_path: "f.ts" }, []);
		expect(out).not.toBeNull();
		expect(out?.rule_id).toBe("cyclomatic-cap");
	});

	// test-contract: invariant — a non-file-write tool bypasses the line-cap probe entirely.
	it("never probes the line-cap for a non-file-write tool", () => {
		const out = evaluatePreChecksTail(event(), undefined, undefined, "Read", { file_path: "f.ts" }, []);
		expect(out).toBeNull();
		expect(checkLargeFileLineCountWrite).not.toHaveBeenCalled();
	});

	// test-contract: invariant — the two block reasons join on exactly "\n\n" with no extra
	// segments from Boolean-filtered falsy entries.
	it("joins both block reasons on exactly the double-newline separator", () => {
		vi.mocked(checkFunctionComplexityWrite).mockReturnValueOnce({ block: "reason-one" });
		vi.mocked(checkCognitiveComplexityWrite).mockReturnValueOnce({ block: "reason-two" });
		const out = evaluatePreChecksTail(event(), undefined, undefined, "Write", { file_path: "f.ts" }, []);
		expect(out?.reason).toBe("reason-one\n\nreason-two");
	});

	// test-contract: boundary — when only the cyclomatic gate returns a block, the joined reason
	// is that single string with no trailing separator (guards `.filter(Boolean)`).
	it("does not append a trailing separator when only one gate fires", () => {
		vi.mocked(checkFunctionComplexityWrite).mockReturnValueOnce({ block: "solo reason" });
		vi.mocked(checkCognitiveComplexityWrite).mockReturnValueOnce(null);
		const out = evaluatePreChecksTail(event(), undefined, undefined, "Write", { file_path: "f.ts" }, []);
		expect(out?.reason).toBe("solo reason");
	});

	// test-contract: boundary — an undefined (not null) cyclomatic result must not be
	// dereferenced without optional chaining; a cognitive-only block is still produced cleanly.
	it("handles an undefined cyclomatic result alongside a cognitive block", () => {
		vi.mocked(checkFunctionComplexityWrite).mockReturnValueOnce(undefined as never);
		vi.mocked(checkCognitiveComplexityWrite).mockReturnValueOnce({ block: "cog reason" });
		const out = evaluatePreChecksTail(event(), undefined, undefined, "Write", { file_path: "f.ts" }, []);
		expect(out).toEqual({
			decision: "block",
			reason: "cog reason",
			rule_id: "cognitive-cap",
			severity: "medium",
			category: "complexity",
		});
	});

	// test-contract: boundary — an undefined (not null) cognitive result must not be
	// dereferenced without optional chaining; a cyclomatic-only block is still produced cleanly.
	it("handles an undefined cognitive result alongside a cyclomatic block", () => {
		vi.mocked(checkFunctionComplexityWrite).mockReturnValueOnce({ block: "cyc reason" });
		vi.mocked(checkCognitiveComplexityWrite).mockReturnValueOnce(undefined as never);
		const out = evaluatePreChecksTail(event(), undefined, undefined, "Write", { file_path: "f.ts" }, []);
		expect(out).toEqual({
			decision: "block",
			reason: "cyc reason",
			rule_id: "cyclomatic-cap",
			severity: "medium",
			category: "complexity",
		});
	});

	// test-contract: invariant — the pulse-recording callback body must actually run (not be
	// stubbed to a no-op) when the cyclomatic gate invokes it.
	it("invokes the pulse-recording callback body", () => {
		vi.mocked(checkFunctionComplexityWrite).mockImplementationOnce((_input, _cwd, callback) => {
			callback?.("rel/file.ts", [{ x: 1 }] as never, [{ x: 2 }] as never, "content");
			return null;
		});
		const out = evaluatePreChecksTail(event({ session_id: "cb-session" }), undefined, undefined, "Write", { file_path: "rel/file.ts" }, []);
		expect(out).toBeNull();
		expect(recordComplexityPulse).toHaveBeenCalledWith(
			"cb-session",
			`${CWD}/rel/file.ts`,
			[{ x: 1 }],
			[{ x: 2 }],
			"content",
		);
	});
});

describe("evaluatePreChecksTail — pushTailWarnings mutation contracts (wave 2)", () => {
	// test-contract: boundary — stale-branch checking fires exactly at the inclusive limit and
	// stops the call after it, distinguishing <= from <, >, and an always-true/false gate.
	it("gates stale-branch checking on the exact inclusive call-count boundary", () => {
		vi.mocked(checkStaleBranch).mockReturnValueOnce({ warning: "stale" });
		const atLimit: string[] = [];
		evaluatePreChecksTail(event(), session({ tool_call_count: 3 }), undefined, "Read", {}, atLimit);
		expect(atLimit).toEqual(["stale"]);
		const overLimit: string[] = [];
		evaluatePreChecksTail(event(), session({ tool_call_count: 4 }), undefined, "Read", {}, overLimit);
		expect(overLimit).toEqual([]);
		expect(checkStaleBranch).toHaveBeenCalledTimes(1);
	});

	// test-contract: invariant — an undefined session never triggers stale-branch checking,
	// even though the call count would otherwise be within limit (distinguishes an
	// always-true `session && ...` mutant).
	it("never checks stale branches without a session", () => {
		const warnings: string[] = [];
		evaluatePreChecksTail(event(), undefined, undefined, "Read", {}, warnings);
		expect(checkStaleBranch).not.toHaveBeenCalled();
		expect(warnings).toEqual([]);
	});

	// test-contract: invariant — the dirty-tree block must actually execute for a Bash command
	// (guards against the whole `if (isBash(...))` body being stubbed out).
	it("pushes the dirty-tree warning for a Bash command", () => {
		vi.mocked(checkDirtyWorkingTree).mockReturnValueOnce({ warning: "dirty" });
		const warnings: string[] = [];
		evaluatePreChecksTail(event(), undefined, undefined, "Bash", { command: "git status" }, warnings);
		expect(checkDirtyWorkingTree).toHaveBeenCalledOnce();
		expect(checkDirtyWorkingTree).toHaveBeenCalledWith("git status", CWD);
		expect(warnings).toEqual(["dirty"]);
	});

	// test-contract: invariant — a non-Bash tool never triggers dirty-tree checking even though
	// its input carries a command-shaped field.
	it("never checks dirty-tree state for a non-Bash tool", () => {
		evaluatePreChecksTail(event(), undefined, undefined, "Write", { command: "rm -rf x", file_path: "a.ts" }, []);
		expect(checkDirtyWorkingTree).not.toHaveBeenCalled();
	});

	// test-contract: boundary — a Bash call with no command field at all must not trigger
	// dirty-tree checking (both the "" fallback and the truthiness gate matter here).
	it("skips dirty-tree checking when the Bash command field is entirely absent", () => {
		evaluatePreChecksTail(event(), undefined, undefined, "Bash", {}, []);
		expect(checkDirtyWorkingTree).not.toHaveBeenCalled();
	});

	// test-contract: boundary — an absent content field on a file write is forwarded to the
	// byte-size check as the exact empty-string fallback, not a mutated placeholder.
	it("forwards the exact empty-string fallback when content is entirely absent", () => {
		vi.mocked(checkLargeFileWrite).mockReturnValueOnce(null);
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(event(), undefined, undefined, "Write", {}, warnings);
		expect(out).toBeNull();
		expect(warnings).toEqual([]);
		expect(checkLargeFileWrite).toHaveBeenCalledWith("");
	});

	// test-contract: invariant — a non-file-write tool never triggers the byte-size or
	// concurrent-edit checks even though its input carries file-write-shaped fields.
	it("never checks byte-size or concurrency for a non-file-write tool", () => {
		const tracker = { getAll: vi.fn(() => []) } as never;
		evaluatePreChecksTail(event(), undefined, tracker, "Read", { content: "stuff", file_path: "a.ts" }, []);
		expect(checkLargeFileWrite).not.toHaveBeenCalled();
		expect(checkConcurrentEdit).not.toHaveBeenCalled();
	});

	// test-contract: boundary — a file write with neither file_path nor path present must not
	// trigger concurrent-edit checking, whether the fallback or the truthiness gate is mangled.
	it("skips concurrent-edit checking when no file path is resolvable", () => {
		const tracker = { getAll: vi.fn(() => []) } as never;
		evaluatePreChecksTail(event(), undefined, tracker, "Write", { content: "abc" }, []);
		expect(checkConcurrentEdit).not.toHaveBeenCalled();
	});
});

describe("maybeWarnTestErosion via evaluatePreChecksTail (wave 2)", () => {
	// test-contract: invariant — with an active session, the event's own tool_name/tool_input
	// (not the phase's toolName/toolInput params) are forwarded verbatim to erosion checking,
	// and a truthy result is pushed into warnings.
	it("forwards the event's own tool identity and pushes a truthy erosion warning", () => {
		vi.mocked(checkTestSignalErosion).mockReturnValueOnce("erosion!");
		const warnings: string[] = [];
		evaluatePreChecksTail(
			event({ tool_name: "EventTool", tool_input: { marker: "yes" } }),
			session(),
			undefined,
			"Read",
			{},
			warnings,
		);
		expect(checkTestSignalErosion).toHaveBeenCalledWith("EventTool", { marker: "yes" }, expect.anything(), CWD);
		expect(warnings).toEqual(["erosion!"]);
	});

	// test-contract: invariant — without an active session, erosion checking must never run at
	// all (distinguishes an inverted or always-false early-return guard).
	it("never runs erosion checking without an active session", () => {
		evaluatePreChecksTail(event(), undefined, undefined, "Read", {}, []);
		expect(checkTestSignalErosion).not.toHaveBeenCalled();
	});
});

describe("evaluateErrorMemory mutation contracts (wave 2)", () => {
	// test-contract: security — a missing error_memory config must not be dereferenced without
	// optional chaining (would throw instead of no-op).
	it("does not throw and adds no warnings when error_memory config is entirely absent", () => {
		const warnings: string[] = [];
		expect(() =>
			evaluateErrorMemory(event(), rules(undefined), session(), graph(), history(), "Read", { file_path: "a.ts" }, warnings),
		).not.toThrow();
		expect(warnings).toEqual([]);
	});

	// test-contract: invariant — a tool that is neither a read nor a write must never reach
	// history lookup, even with memory enabled and a resolvable path.
	it("never looks up file history for a tool that is neither read nor write", () => {
		const h = history();
		evaluateErrorMemory(
			event(),
			rules({ enabled: true } as GuardRulesConfig["error_memory"]),
			session(),
			graph(),
			h,
			"Bash",
			{ file_path: "a.ts" },
			[],
		);
		expect(h.getFileHistoryWarning).not.toHaveBeenCalled();
	});

	// test-contract: invariant — the Edit-line-estimate conjunction requires ALL of
	// toolName==="Edit", old_string, and filePath; the happy path assigns a numeric line.
	it("estimates the edit line only on the full Edit+old_string+filePath happy path", () => {
		const h = history();
		const g = graph();
		vi.mocked(getPatternWarnings).mockReturnValueOnce(["pattern-happy"]);
		const warnings: string[] = [];
		evaluateErrorMemory(
			event(),
			rules({ enabled: true } as GuardRulesConfig["error_memory"]),
			session(),
			g,
			h,
			"Edit",
			{ file_path: "a.ts", old_string: "old" },
			warnings,
		);
		expect(warnings).toEqual(["pattern-happy"]);
		expect(getPatternWarnings).toHaveBeenCalledWith([], "relative/a.ts", expect.anything(), 42);
	});

	// test-contract: boundary — a non-Edit tool with old_string and filePath both present must
	// not estimate a line (guards the whole-conjunction always-true mutants and the
	// toolName==="Edit" atomic/equality mutants).
	it("never estimates a line for a non-Edit tool even with old_string and filePath present", () => {
		const h = history();
		const g = graph();
		vi.mocked(getPatternWarnings).mockReturnValueOnce(["pattern-non-edit"]);
		const warnings: string[] = [];
		evaluateErrorMemory(
			event(),
			rules({ enabled: true } as GuardRulesConfig["error_memory"]),
			session(),
			g,
			h,
			"Write",
			{ file_path: "a.ts", old_string: "old" },
			warnings,
		);
		expect(warnings).toEqual(["pattern-non-edit"]);
		expect(getPatternWarnings).toHaveBeenCalledWith([], "relative/a.ts", expect.anything(), undefined);
	});

	// test-contract: boundary — a non-Edit tool with filePath but no old_string must not
	// estimate a line (guards the inner (toolName==="Edit" && old_string) sub-expression's
	// always-true and &&-to-|| mutants).
	it("never estimates a line for a non-Edit tool with no old_string", () => {
		const h = history();
		const g = graph();
		vi.mocked(getPatternWarnings).mockReturnValueOnce(["pattern-no-old-string"]);
		const warnings: string[] = [];
		evaluateErrorMemory(
			event(),
			rules({ enabled: true } as GuardRulesConfig["error_memory"]),
			session(),
			g,
			h,
			"Write",
			{ file_path: "a.ts" },
			warnings,
		);
		expect(warnings).toEqual(["pattern-no-old-string"]);
		expect(getPatternWarnings).toHaveBeenCalledWith([], "relative/a.ts", expect.anything(), undefined);
	});
});
