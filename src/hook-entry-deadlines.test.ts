import { describe, expect, it } from "vitest";
import type { UnifiedAction, UnifiedHookEvent } from "./harness/unified-event.js";
import { makeUnifiedEvent } from "./harness/__tests__/fixtures/unified-event.js";
import {
	defaultTimeoutForPhase,
	isCodeEditEvent,
	isCommitOrPushEvent,
} from "./hook-entry-deadlines.js";

function preTool(action: UnifiedAction): UnifiedHookEvent {
	return makeUnifiedEvent({ action });
}
function edit(tool: string): UnifiedHookEvent {
	return preTool({ kind: "tool_call", tool_name: tool, tool_class: "modify", tool_input: {}, tool_input_redacted: {} });
}
function bash(command: string): UnifiedHookEvent {
	return preTool({ kind: "shell_command", command, tool_class: "modify" });
}

describe("isCodeEditEvent", () => {
	it("is true for file operations and edit tool calls (any naming style)", () => {
		expect(isCodeEditEvent(preTool({ kind: "file_operation", operation: "edit", path: "/workspace/a.ts", tool_class: "modify" }))).toBe(true);
		for (const t of ["Write", "Edit", "MultiEdit", "multi_edit", "apply_patch", "notebook_edit"]) {
			expect(isCodeEditEvent(edit(t))).toBe(true);
		}
	});

	it("is false for non-edit tool calls and shell commands", () => {
		expect(isCodeEditEvent(edit("Read"))).toBe(false);
		expect(isCodeEditEvent(edit("Grep"))).toBe(false);
		expect(isCodeEditEvent(bash("git commit -m x"))).toBe(false);
	});
});

describe("isCommitOrPushEvent", () => {
	it("is true for a git commit or push Bash command", () => {
		expect(isCommitOrPushEvent(bash('git commit -m "x"'))).toBe(true);
		expect(isCommitOrPushEvent(bash("git push origin main"))).toBe(true);
		expect(isCommitOrPushEvent(bash('git add -A && git commit -m "x" && git push'))).toBe(true);
	});

	it("is false for non-commit Bash, edits, and quoted/comment near-misses", () => {
		expect(isCommitOrPushEvent(bash("git status"))).toBe(false);
		expect(isCommitOrPushEvent(bash("# git commit"))).toBe(false);
		expect(isCommitOrPushEvent(bash('echo "git push"'))).toBe(false);
		expect(isCommitOrPushEvent(edit("Edit"))).toBe(false);
	});
});

describe("defaultTimeoutForPhase — the invariant client < 240s hook grant", () => {
	it("gives a code edit the 180s overlay ceiling", () => {
		expect(defaultTimeoutForPhase(edit("Edit"))).toBe(180_000);
	});

	it("gives a git commit/push the 220s full-suite ceiling (was 5s — the fixed bug)", () => {
		expect(defaultTimeoutForPhase(bash("git commit -m x"))).toBe(220_000);
		expect(defaultTimeoutForPhase(bash("git push"))).toBe(220_000);
	});

	it("keeps plain Bash/Read/Grep on the snappy 5s legacy ceiling", () => {
		expect(defaultTimeoutForPhase(bash("ls"))).toBe(5_000);
		expect(defaultTimeoutForPhase(edit("Read"))).toBe(5_000);
	});

	it("gives non-PreToolUse events the 60s default", () => {
		const post = makeUnifiedEvent({ phase: "post-tool" });
		expect(defaultTimeoutForPhase(post)).toBe(60_000);
	});

	it("caps UserPromptSubmit at seconds — the USER is waiting on this one", () => {
		// The 60s default violated this file's own invariant for user-prompt:
		// Claude Code grants that hook 30s, so a slow daemon made the client wait
		// past the grant and the runner killed the hook — "UserPromptSubmit hook
		// timed out after 30s — output discarded" — with the user eating the full
		// 30s of keystroke latency (observed live 2026-07-28, daemon mid heap
		// spike). Prompt-time context is nice-to-have; on timeout the prompt
		// proceeds without it, which is the correct degradation.
		const prompt = makeUnifiedEvent({ phase: "user-prompt", action: { kind: "user_prompt", text: "hello" } });
		expect(defaultTimeoutForPhase(prompt)).toBeLessThanOrEqual(3_000);
	});

	it("every PreToolUse ceiling stays below the 240s PreToolUse hook grant", () => {
		for (const ev of [edit("Edit"), bash("git commit -m x"), bash("ls")]) {
			expect(defaultTimeoutForPhase(ev)).toBeLessThan(240_000);
		}
	});
});
