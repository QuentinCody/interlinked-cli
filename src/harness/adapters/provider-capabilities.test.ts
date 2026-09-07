import { describe, expect, it } from "vitest";
import { buildAllAdapters } from "./index.js";
import {
	CLAUDE_CODE_CAPABILITIES,
	CODEX_CAPABILITIES,
	COPILOT_CLI_CAPABILITIES,
	CURSOR_CAPABILITIES,
	defineCapabilities,
	eventCapability,
	GEMINI_CLI_CAPABILITIES,
	installedEventNames,
	OPENCODE_CAPABILITIES,
	PI_CAPABILITIES,
} from "./provider-capabilities.js";

const catalogs = [
	CLAUDE_CODE_CAPABILITIES,
	CODEX_CAPABILITIES,
	COPILOT_CLI_CAPABILITIES,
	GEMINI_CLI_CAPABILITIES,
	CURSOR_CAPABILITIES,
	OPENCODE_CAPABILITIES,
	PI_CAPABILITIES,
];

const expectedCapabilitiesByRunner = new Map([
	["claude-code", CLAUDE_CODE_CAPABILITIES],
	["codex", CODEX_CAPABILITIES],
	["copilot-cli", COPILOT_CLI_CAPABILITIES],
	["cursor", CURSOR_CAPABILITIES],
	["gemini-cli", GEMINI_CLI_CAPABILITIES],
	["opencode", OPENCODE_CAPABILITIES],
	["pi", PI_CAPABILITIES],
] as const);

describe("provider capability catalog", () => {
	it("drives every adapter's installed native event list", () => {
		const adapters = buildAllAdapters();
		// Bind every public runner id to its own catalog. Checking only
		// nativeEventNames against adapter.capabilities would let a factory use
		// another provider's catalog while remaining internally consistent.
		expect(new Map(adapters.map((adapter) => [adapter.id, adapter.capabilities]))).toEqual(
			expectedCapabilitiesByRunner,
		);
		for (const adapter of adapters) {
			expect(adapter.nativeEventNames).toEqual(installedEventNames(adapter.capabilities));
		}
	});

	it("contains no duplicate native event names", () => {
		for (const catalog of catalogs) {
			const names = catalog.events.map((item) => item.name);
			expect(new Set(names).size).toBe(names.length);
		}
	});

	it("describes the complete Codex native hook surface", () => {
		expect(installedEventNames(CODEX_CAPABILITIES)).toEqual([
			"SessionStart",
			"SessionEnd",
			"UserPromptSubmit",
			"Stop",
			"PreToolUse",
			"PermissionRequest",
			"PostToolUse",
			"PreCompact",
			"PostCompact",
			"SubagentStart",
			"SubagentStop",
			"Interrupt",
		]);
			expect(eventCapability(CODEX_CAPABILITIES, "PermissionRequest")).toMatchObject({
			phase: "permission-request",
			control: "permission",
			missing_runtime: "fail_closed",
		});
		expect(eventCapability(CODEX_CAPABILITIES, "Interrupt")).toMatchObject({
			phase: "other",
			control: "observe",
			model_context: false,
			background: true,
		});
	});

	it("installs Claude PermissionRequest while keeping failure-post compatibility parse-only", () => {
		expect(eventCapability(CLAUDE_CODE_CAPABILITIES, "PermissionRequest")).toMatchObject({
			install: true,
			phase: "permission-request",
			control: "permission",
			model_context: false,
			missing_runtime: "fail_closed",
		});
		expect(eventCapability(CLAUDE_CODE_CAPABILITIES, "PostToolUseFailure")).toMatchObject({
			install: false,
			phase: "post-tool",
		});
		expect(eventCapability(CLAUDE_CODE_CAPABILITIES, "WorktreeCreate")).toMatchObject({
			install: true,
			phase: "worktree-create",
			control: "replace",
			missing_runtime: "fail_closed",
		});
	});

	it("gives every provider a project hook definition path", () => {
		for (const catalog of catalogs) {
			expect(catalog.project_hook_path).toMatch(/^\.[a-z]/);
		}
	});

	it("models OpenCode's hard tool gate and permission interception separately", () => {
		expect(OPENCODE_CAPABILITIES.hook_trust).toBe("implicit");
		expect(eventCapability(OPENCODE_CAPABILITIES, "tool.execute.before")).toMatchObject({
			phase: "pre-tool",
			control: "deny",
			missing_runtime: "fail_closed",
		});
		expect(eventCapability(OPENCODE_CAPABILITIES, "permission.ask")).toMatchObject({
			install: false,
			phase: "permission-request",
			control: "permission",
		});
	});

	it("models Pi's interactive tool gate and direct user shell bypass", () => {
		expect(PI_CAPABILITIES.hook_trust).toBe("definition-review");
		expect(eventCapability(PI_CAPABILITIES, "tool_call")).toMatchObject({
			phase: "pre-tool",
			control: "ask",
			missing_runtime: "fail_closed",
		});
		expect(eventCapability(PI_CAPABILITIES, "user_bash")).toMatchObject({
			phase: "pre-tool",
			control: "ask",
			missing_runtime: "fail_closed",
		});
	});

	it("returns null for an unknown native event", () => {
		expect(eventCapability(CODEX_CAPABILITIES, "FutureEvent")).toBeNull();
	});
});

describe("defineCapabilities — duplicate-name guard", () => {
	it("throws naming the repeated event when two events share a name", () => {
		expect(() =>
			defineCapabilities({
				project_hook_path: ".test/settings.json",
				hook_trust: "implicit",
				status_line: "custom-command",
				events: [
					{
						name: "PreToolUse",
						phase: "pre-tool",
						install: true,
						control: "observe",
						model_context: false,
						missing_runtime: "warn_open",
					},
					{
						name: "PreToolUse",
						phase: "pre-tool",
						install: true,
						control: "deny",
						model_context: false,
						missing_runtime: "warn_open",
					},
				],
			}),
		).toThrowError("duplicate native hook event capability: PreToolUse");
	});
});
