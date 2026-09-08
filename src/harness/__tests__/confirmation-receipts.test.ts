import { parseWire, wireObject, wireString } from "../../lib/value-validation.js";
// ===========================================
// Confirmation Receipts — ask-decision resolved-target rendering
// ===========================================
//
// Item #6 of the May 2026 ask-prompt rollout: when a rule fires
// `decision: "ask"` on a high-blast action, the user-facing prompt should
// echo the resolved targets (specific file, URL, branch) so the human sees
// exactly what will happen — not just the rule description.
//
// This suite pins:
//   - `extractResolvedTargets()` extracts the right shape per tool family
//     (Bash rm/curl/git-push, Write/Edit, WebFetch, MCP tools).
//   - Value truncation + 5-target cap.
//   - Adapter-level rendering: claude-code includes a `Targets:` section in
//     the ask reason; cursor surfaces the same on its user_message + reason;
//     codex / copilot-cli include targets in the deny-collapse fallback.
//   - Decisions without resolved_targets render identically to baseline.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { createClaudeCodeAdapter } from "../adapters/claude-code.js";
import { createCodexAdapter } from "../adapters/codex.js";
import { createCopilotCliAdapter } from "../adapters/copilot-cli.js";
import { createCursorAdapter } from "../adapters/cursor.js";
import { extractResolvedTargets } from "../evaluator/rule-matching.js";
import type { GuardRule, ResolvedTarget } from "../types.js";

// Minimal rule fixture — the extractor signature accepts a rule for
// future rule-specific overrides but is rule-agnostic today, so any
// well-formed rule shape works.
function fakeRule(overrides: Partial<GuardRule> = {}): GuardRule {
	return {
		id: "test-rule",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["*"],
		action: "ask",
		patterns: [],
		reason: "test reason",
		severity: "high",
		...overrides,
	};
}

describe("extractResolvedTargets — Bash rm", () => {
	it("'rm /tmp/foo /tmp/bar' yields 2 file targets", () => {
		const out = extractResolvedTargets(
			"Bash",
			{ command: "rm /tmp/foo /tmp/bar" },
			fakeRule(),
		);
		expect(out).toEqual([
			{ kind: "file", value: "/tmp/foo" },
			{ kind: "file", value: "/tmp/bar" },
		]);
	});

	it("'rm -rf <path>' skips the flag token", () => {
		const out = extractResolvedTargets("Bash", { command: "rm -rf /tmp/cache" }, fakeRule());
		expect(out).toEqual([{ kind: "file", value: "/tmp/cache" }]);
	});

	it("caps at 5 targets when 7 paths are passed", () => {
		const cmd = "rm a b c d e f g";
		const out = extractResolvedTargets("Bash", { command: cmd }, fakeRule());
		expect(out).toHaveLength(5);
		// First 5 in order
		expect(out.map((t) => t.value)).toEqual(["a", "b", "c", "d", "e"]);
	});
});

describe("extractResolvedTargets — Bash git push", () => {
	it("'git push origin main' yields 1 branch target", () => {
		const out = extractResolvedTargets("Bash", { command: "git push origin main" }, fakeRule());
		expect(out).toEqual([{ kind: "branch", value: "main" }]);
	});

	it("'git push --force-with-lease origin feature/x' still finds the branch", () => {
		const out = extractResolvedTargets(
			"Bash",
			{ command: "git push --force-with-lease origin feature/x" },
			fakeRule(),
		);
		expect(out).toEqual([{ kind: "branch", value: "feature/x" }]);
	});

	it("'git push' alone (no remote/branch) emits no targets", () => {
		const out = extractResolvedTargets("Bash", { command: "git push" }, fakeRule());
		expect(out).toEqual([]);
	});
});

describe("extractResolvedTargets — Bash curl/wget", () => {
	it("'curl https://example.com/api' yields 1 url target", () => {
		const out = extractResolvedTargets(
			"Bash",
			{ command: "curl https://example.com/api" },
			fakeRule(),
		);
		expect(out).toEqual([{ kind: "url", value: "https://example.com/api" }]);
	});

	it("'curl -X DELETE https://api.example.com/r/1' captures the URL", () => {
		const out = extractResolvedTargets(
			"Bash",
			{ command: `curl -X DELETE https://api.example.com/r/1 -H "Auth: x"` },
			fakeRule(),
		);
		expect(out).toEqual([{ kind: "url", value: "https://api.example.com/r/1" }]);
	});

	it("'wget http://example.com/file' captures the URL too", () => {
		const out = extractResolvedTargets(
			"Bash",
			{ command: "wget http://example.com/file" },
			fakeRule(),
		);
		expect(out).toEqual([{ kind: "url", value: "http://example.com/file" }]);
	});
});

describe("extractResolvedTargets — Write/Edit family", () => {
	it("Write tool with file_path → 1 file target", () => {
		const out = extractResolvedTargets(
			"Write",
			{ file_path: "/repo/src/main.ts", content: "x" },
			fakeRule(),
		);
		expect(out).toEqual([{ kind: "file", value: "/repo/src/main.ts" }]);
	});

	it("Edit tool with file_path → 1 file target", () => {
		const out = extractResolvedTargets(
			"Edit",
			{ file_path: "/repo/src/a.ts", old_string: "x", new_string: "y" },
			fakeRule(),
		);
		expect(out).toEqual([{ kind: "file", value: "/repo/src/a.ts" }]);
	});

	it("MultiEdit / NotebookEdit work the same way", () => {
		const me = extractResolvedTargets("MultiEdit", { file_path: "/a/b.ts" }, fakeRule());
		const ne = extractResolvedTargets("NotebookEdit", { file_path: "/n.ipynb" }, fakeRule());
		expect(me).toEqual([{ kind: "file", value: "/a/b.ts" }]);
		expect(ne).toEqual([{ kind: "file", value: "/n.ipynb" }]);
	});
});

describe("extractResolvedTargets — WebFetch", () => {
	it("WebFetch with url yields 1 url target", () => {
		const out = extractResolvedTargets(
			"WebFetch",
			{ url: "https://docs.example.com/api" },
			fakeRule(),
		);
		expect(out).toEqual([{ kind: "url", value: "https://docs.example.com/api" }]);
	});

	it("WebFetch with empty url emits nothing", () => {
		const out = extractResolvedTargets("WebFetch", { url: "" }, fakeRule());
		expect(out).toEqual([]);
	});
});

describe("extractResolvedTargets — MCP tools", () => {
	it("mcp__supabase__delete_table with table key → 1 table target", () => {
		const out = extractResolvedTargets(
			"mcp__supabase__delete_table",
			{ table: "orders" },
			fakeRule(),
		);
		expect(out).toEqual([{ kind: "table", value: "orders" }]);
	});

	it("MCP tool with `_url` key → url kind", () => {
		const out = extractResolvedTargets(
			"mcp__example__do_thing",
			{ target_url: "https://example.com/r" },
			fakeRule(),
		);
		expect(out).toContainEqual({ kind: "url", value: "https://example.com/r" });
	});

	it("MCP tool with `_branch` key → branch kind", () => {
		const out = extractResolvedTargets(
			"mcp__github__delete_branch",
			{ branch: "release/2026" },
			fakeRule(),
		);
		expect(out).toContainEqual({ kind: "branch", value: "release/2026" });
	});

	it("MCP tool with `recipient` key → recipient kind", () => {
		const out = extractResolvedTargets(
			"mcp__email__send",
			{ recipient: "ops@example.com" },
			fakeRule(),
		);
		expect(out).toContainEqual({ kind: "recipient", value: "ops@example.com" });
	});
});

describe("extractResolvedTargets — truncation + caps", () => {
	it("truncates a value > 200 chars", () => {
		const long = `https://example.com/${"a".repeat(250)}`;
		const out = extractResolvedTargets(
			"WebFetch",
			{ url: long },
			fakeRule(),
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).value.length).toBeLessThanOrEqual(200);
		// Sanity: ends with the ellipsis sentinel
		expect(nonNull(out[0]).value.endsWith("…")).toBe(true);
	});

	it("returns empty array for an unknown tool family", () => {
		const out = extractResolvedTargets("Grep", { pattern: "x" }, fakeRule());
		expect(out).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Adapter rendering tests
// ---------------------------------------------------------------------------

const TARGETS_TWO_FILES: ResolvedTarget[] = [
	{ kind: "file", value: "src/legacy.ts" },
	{ kind: "file", value: "docs/old.md" },
];

const TARGETS_BRANCH: ResolvedTarget[] = [{ kind: "branch", value: "main" }];

describe("claude-code adapter — ask reason includes Targets section", () => {
	const adapter = createClaudeCodeAdapter();
	const event = adapter.parseHookInput(
		{ session_id: "s", cwd: "/repo", tool_name: "Bash", tool_input: { command: "rm x" } },
		"PreToolUse",
	);

	it("ask with resolved_targets renders a Targets bullet list in the reason", () => {
		const out = adapter.encodeDecision(
			{ decision: "ask", reason: "POTENTIALLY DESTRUCTIVE: rm", resolved_targets: TARGETS_TWO_FILES },
			event,
		);
		// PreToolUse ask lives in hookSpecificOutput.permissionDecision(Reason),
		// not root {decision,reason} (invalid for PreToolUse).
		const parsed = parseWire(JSON.parse(nonNull(out.stdout)), wireObject({ "hookSpecificOutput": wireObject({ "permissionDecision": wireString, "permissionDecisionReason": wireString }) }), "test JSON value");
		const hso = parsed.hookSpecificOutput;
		expect(hso.permissionDecision).toBe("ask");
		expect(hso.permissionDecisionReason).toContain("POTENTIALLY DESTRUCTIVE: rm");
		expect(hso.permissionDecisionReason).toContain("Targets:");
		expect(hso.permissionDecisionReason).toContain("• file: src/legacy.ts");
		expect(hso.permissionDecisionReason).toContain("• file: docs/old.md");
	});

	it("ask without resolved_targets renders unchanged from baseline", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, event);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "ask",
				permissionDecisionReason: "confirm?",
			},
		});
	});
});

describe("cursor adapter — ask reason+user_message include Targets section", () => {
	const adapter = createCursorAdapter();
	const event = adapter.parseHookInput(
		{ session_id: "c", command: "rm x" },
		"beforeShellExecution",
	);

	it("ask on a shell gate (ask-capable) puts targets in BOTH agent_message and user_message", () => {
		const out = adapter.encodeDecision(
			{
				decision: "ask",
				reason: "confirm?",
				system_message: "destructive op",
				resolved_targets: TARGETS_TWO_FILES,
			},
			event,
		);
		const parsed = parseWire(JSON.parse(nonNull(out.stdout)), wireObject({ "permission": wireString, "agent_message": wireString, "user_message": wireString }), "test JSON value");
		expect(parsed.permission).toBe("ask");
		expect(parsed.agent_message).toContain("Targets:");
		expect(parsed.agent_message).toContain("• file: src/legacy.ts");
		expect(parsed.user_message).toContain("Targets:");
		expect(parsed.user_message).toContain("• file: docs/old.md");
	});

	it("ask collapse to deny on preToolUse still surfaces targets in the messages", () => {
		const preEvent = adapter.parseHookInput(
			{ session_id: "c", tool_name: "Edit", tool_input: { file_path: "/a" } },
			"preToolUse",
		);
		const out = adapter.encodeDecision(
			{ decision: "ask", reason: "confirm?", resolved_targets: TARGETS_BRANCH },
			preEvent,
		);
		const parsed = parseWire(JSON.parse(nonNull(out.stdout)), wireObject({ "permission": wireString, "agent_message": wireString }), "test JSON value");
		expect(parsed.permission).toBe("deny");
		expect(parsed.agent_message).toContain("• branch: main");
	});

	it("ask without resolved_targets renders unchanged from baseline", () => {
		const out = adapter.encodeDecision(
			{ decision: "ask", reason: "confirm?", system_message: "destructive op" },
			event,
		);
		const parsed = parseWire(JSON.parse(nonNull(out.stdout)), wireObject({ "permission": wireString, "agent_message": wireString, "user_message": wireString }), "test JSON value");
		expect(parsed).toEqual({
			permission: "ask",
			agent_message: "confirm?",
			user_message: "destructive op",
		});
	});
});

describe("codex adapter — ask→native deny includes Targets", () => {
	const adapter = createCodexAdapter();
	const event = adapter.parseHookInput(
		{ session_id: "c", tool_name: "Bash", tool_input: { command: "rm x" } },
		"PreToolUse",
	);

	it("ask collapses to block on PreToolUse with targets attached to the reason", () => {
		const out = adapter.encodeDecision(
			{ decision: "ask", reason: "confirm?", resolved_targets: TARGETS_TWO_FILES },
			event,
		);
		expect(JSON.parse(out.stdout || "{}")).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: expect.stringMatching(
					/confirm\?[\s\S]*Targets:[\s\S]*• file: src\/legacy\.ts/,
				),
			},
		});
	});

	it("ask without resolved_targets renders unchanged from baseline (regression)", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, event);
		expect(JSON.parse(out.stdout || "{}")).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "confirm?",
			},
		});
	});
});

describe("copilot-cli adapter — ask→deny includes Targets", () => {
	const adapter = createCopilotCliAdapter();
	const event = adapter.parseHookInput(
		{ sessionId: "x", toolName: "shell", toolInput: { command: "rm x" } },
		"preToolUse",
	);

	it("ask collapses to Copilot deny JSON with targets appended to the reason", () => {
		const out = adapter.encodeDecision(
			{ decision: "ask", reason: "confirm?", resolved_targets: TARGETS_TWO_FILES },
			event,
		);
		expect(out.exit_code).toBe(0);
		expect(JSON.parse(out.stdout || "{}")).toEqual({
			permissionDecision: "deny",
			permissionDecisionReason: expect.stringMatching(
				/confirm\?[\s\S]*Targets:[\s\S]*• file: src\/legacy\.ts/,
			),
		});
	});

	it("ask without resolved_targets renders unchanged from baseline (regression)", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, event);
		expect(out.exit_code).toBe(0);
		expect(JSON.parse(out.stdout || "{}")).toEqual({
			permissionDecision: "deny",
			permissionDecisionReason: "confirm?",
		});
	});
});
