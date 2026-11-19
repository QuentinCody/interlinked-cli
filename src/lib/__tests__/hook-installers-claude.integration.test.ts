import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_HOOK_EVENTS, installAllClaudeHooks, uninstallAllClaudeHooks } from "../hook-installers-claude.js";

describe("Claude hook event list", () => {
	it("includes the supported lifecycle, tool, and permission events", () => {
		expect(CLAUDE_HOOK_EVENTS).toContain("SessionStart");
		expect(CLAUDE_HOOK_EVENTS).toContain("PostToolUse");
		expect(CLAUDE_HOOK_EVENTS).toContain("PermissionRequest");
		expect(CLAUDE_HOOK_EVENTS).toContain("WorktreeCreate");
		// Claude 2.1.325 delivers a failed Bash call ONLY as PostToolUseFailure
		// (see comment on CLAUDE_HOOK_EVENTS).
		expect(CLAUDE_HOOK_EVENTS).toContain("PostToolUseFailure");
	});

	it("install writes a PostToolUseFailure group and uninstall removes it", () => {
		const dir = mkdtempSync(join(tmpdir(), "claude-failure-event-"));
		try {
			execSync("git init", { cwd: dir, stdio: "ignore" });
			const hookPath = ".interlinked/hooks/interlinked-activity.mjs";
			installAllClaudeHooks(dir, hookPath);
			const settingsPath = join(dir, ".claude", "settings.json");
			const installed = JSON.parse(readFileSync(settingsPath, "utf-8"));
			const group = installed.hooks.PostToolUseFailure;
			expect(group).toHaveLength(1);
			expect(group[0].hooks[0].command).toContain("interlinked-activity.mjs");
			expect(uninstallAllClaudeHooks(dir)).toBe(true);
			const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(after.hooks?.PostToolUseFailure).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ===========================================
// Matcher Reconciliation — Claude Code
// ===========================================
// installHookEntry must update stale PostToolUse matchers to "" (all-tool
// capture) when re-running installation. Without this, non-edit tools
// (Read, Bash, Grep, WebFetch) never reach the hook at PostToolUse.

describe("matcher reconciliation — Claude Code", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "matcher-reconcile-"));
		execSync("git init", { cwd: tmp, stdio: "ignore" });
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("rewrites stale PostToolUse matcher from Edit|Write|MultiEdit to empty", () => {
		const settingsDir = join(tmp, ".claude");
		mkdirSync(settingsDir, { recursive: true });
		const staleMatcher = "Edit|Write|MultiEdit";
		const staleSettings = {
			hooks: {
				PostToolUse: [
					{
						matcher: staleMatcher,
						hooks: [{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" }],
					},
				],
			},
		};
		writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(staleSettings, null, 2));

		installAllClaudeHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");

		const updated = JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf-8"));
		const postToolUse = updated.hooks.PostToolUse;
		expect(Array.isArray(postToolUse)).toBe(true);
		expect(postToolUse).toHaveLength(1);
		expect(postToolUse[0].matcher).toBe("");
	});

	it("leaves PreToolUse matcher as empty (no scoped restriction)", () => {
		const settingsDir = join(tmp, ".claude");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "",
							hooks: [{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" }],
						},
					],
				},
			}),
		);

		installAllClaudeHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");

		const updated = JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf-8"));
		expect(updated.hooks.PreToolUse[0].matcher).toBe("");
	});

	it("does not regress PostToolUse matcher back to mutation-only", () => {
		installAllClaudeHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const first = JSON.parse(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8"));
		expect(first.hooks.PostToolUse[0].matcher).toBe("");

		installAllClaudeHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const second = JSON.parse(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8"));
		expect(second.hooks.PostToolUse[0].matcher).toBe("");
	});
});

// ===========================================
// Hook timeout policy — Claude Code (2026-07-17 per-edit-tests directive)
// ===========================================
// PreToolUse must outlast the per-edit coverage overlay and PostToolUse the
// full quality pass; Claude Code's 60s default killed the hook mid-verdict
// after the run's cost was already paid. Fresh installs carry the timeouts;
// re-running installation upgrades entries written before timeouts existed.

describe("hook timeout policy — Claude Code", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hook-timeout-"));
		execSync("git init", { cwd: tmp, stdio: "ignore" });
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("a fresh install grants PreToolUse 240s and PostToolUse 120s", () => {
		installAllClaudeHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const s = JSON.parse(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8"));
		expect(s.hooks.PreToolUse[0].hooks[0].timeout).toBe(240);
		expect(s.hooks.PostToolUse[0].hooks[0].timeout).toBe(120);
	});

	it("events without a policy entry keep the client default (no timeout field)", () => {
		installAllClaudeHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const s = JSON.parse(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8"));
		expect(s.hooks.SessionStart[0].hooks[0].timeout).toBeUndefined();
	});

	it("re-running installation upgrades a pre-timeout-era entry in place", () => {
		const settingsDir = join(tmp, ".claude");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "",
							hooks: [{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" }],
						},
					],
				},
			}),
		);

		installAllClaudeHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");

		const s = JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf-8"));
		expect(s.hooks.PreToolUse).toHaveLength(1);
		expect(s.hooks.PreToolUse[0].hooks[0].timeout).toBe(240);
	});
});
