// interlinked-tdd: exempt
// Plan §8.3 — assert Claude and Codex UserPromptSubmit envelopes both end up
// producing identical MetacoderInputContext through the prompt-builder. The
// adapter normalization layer already converges them onto `event.prompt` in
// the legacy HarnessEvent shape; this test pins that contract end-to-end so a
// future adapter change can't drift one client away from the other without a
// failing test.

import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClaudeCodeAdapter } from "../adapters/claude-code.js";
import { createCodexAdapter } from "../adapters/codex.js";
import { toLegacyHarnessEvent } from "../legacy-client.js";
import { buildMetacoderContext } from "./prompt-builder.js";
import { DEFAULT_METACODER_CONFIG } from "./types.js";

const SESSION = "multiclient-abc12345";
const PROMPT = "Refactor the payment service.";

describe("Claude vs Codex UserPromptSubmit envelopes", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "metacoder-multiclient-"));
	});

	it("both adapters normalize UserPromptSubmit onto event.prompt", () => {
		const claudeAdapter = createClaudeCodeAdapter();
		const codexAdapter = createCodexAdapter();

		const claudeUnified = claudeAdapter.parseHookInput(
			{ session_id: SESSION, prompt: PROMPT, cwd },
			"UserPromptSubmit",
		);
		const codexUnified = codexAdapter.parseHookInput(
			{ session_id: SESSION, prompt: PROMPT, cwd, turn_id: "t1" },
			"UserPromptSubmit",
		);

		const claudeLegacy = toLegacyHarnessEvent(claudeUnified);
		const codexLegacy = toLegacyHarnessEvent(codexUnified);

		expect(claudeLegacy.prompt).toBe(PROMPT);
		expect(codexLegacy.prompt).toBe(PROMPT);
		expect(claudeLegacy.hook_event).toBe("UserPromptSubmit");
		expect(codexLegacy.hook_event).toBe("UserPromptSubmit");
	});

	it("phase mapping reflects the per-adapter PHASE_MAP (Claude → user-prompt, Codex → user-prompt)", () => {
		// Plan §7: both adapters map UserPromptSubmit to phase "user-prompt".
		const claudeAdapter = createClaudeCodeAdapter();
		const codexAdapter = createCodexAdapter();

		const claudeUnified = claudeAdapter.parseHookInput(
			{ session_id: SESSION, prompt: PROMPT },
			"UserPromptSubmit",
		);
		const codexUnified = codexAdapter.parseHookInput(
			{ session_id: SESSION, prompt: PROMPT },
			"UserPromptSubmit",
		);

		expect(claudeUnified.phase).toBe("user-prompt");
		expect(codexUnified.phase).toBe("user-prompt");
	});

	it("metacoder prompt-builder produces identical core fields for Claude and Codex", () => {
		const claudeCtx = buildMetacoderContext({
			prompt: PROMPT,
			client: "claude",
			sessionId: SESSION,
			cwd,
			floorRuleIds: ["block_rm_rf"],
			config: DEFAULT_METACODER_CONFIG,
		});
		const codexCtx = buildMetacoderContext({
			prompt: PROMPT,
			client: "codex",
			sessionId: SESSION,
			cwd,
			floorRuleIds: ["block_rm_rf"],
			config: DEFAULT_METACODER_CONFIG,
		});

		// Core fields should match identically. `client` differs by design
		// (the metacoder routes by client), so we compare the rest.
		expect(claudeCtx.prompt).toBe(codexCtx.prompt);
		expect(claudeCtx.session_id).toBe(codexCtx.session_id);
		expect(claudeCtx.cwd).toBe(codexCtx.cwd);
		expect(claudeCtx.project_instructions).toBe(codexCtx.project_instructions);
		expect(claudeCtx.floor_rule_ids).toEqual(codexCtx.floor_rule_ids);
	});
});

describe("Codex turn_id surfaces on UnifiedHookEvent.parent_event_id", () => {
	it("preserves Codex's turn_id as parent_event_id", () => {
		const codexAdapter = createCodexAdapter();
		const codexUnified = codexAdapter.parseHookInput(
			{ session_id: SESSION, prompt: PROMPT, turn_id: "turn-xyz" },
			"UserPromptSubmit",
		);
		expect(codexUnified.parent_event_id).toBe("turn-xyz");
	});

	it("Claude has no turn_id field (parent_event_id undefined on UserPromptSubmit)", () => {
		const claudeAdapter = createClaudeCodeAdapter();
		const claudeUnified = claudeAdapter.parseHookInput(
			{ session_id: SESSION, prompt: PROMPT },
			"UserPromptSubmit",
		);
		expect(claudeUnified.parent_event_id).toBeUndefined();
	});
});

describe("Recursion guard sentinel propagation", () => {
	it("toLegacyHarnessEvent copies metacoder_subprocess from UnifiedHookEvent", () => {
		const claudeAdapter = createClaudeCodeAdapter();
		const event = claudeAdapter.parseHookInput(
			{ session_id: SESSION, prompt: PROMPT },
			"UserPromptSubmit",
		);
		event.metacoder_subprocess = true;
		const legacy = toLegacyHarnessEvent(event);
		expect(legacy.metacoder_subprocess).toBe(true);
	});

	it("toLegacyHarnessEvent does not set metacoder_subprocess when unset", () => {
		const claudeAdapter = createClaudeCodeAdapter();
		const event = claudeAdapter.parseHookInput(
			{ session_id: SESSION, prompt: PROMPT },
			"UserPromptSubmit",
		);
		const legacy = toLegacyHarnessEvent(event);
		expect(legacy.metacoder_subprocess).toBeUndefined();
	});
});
