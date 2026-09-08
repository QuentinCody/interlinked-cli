import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CODEX_HOOK_EVENTS,
	installCodexHooks,
	uninstallCodexHooks,
} from "../hook-installers-codex.js";

describe("Codex hook event list", () => {
	it("uses Claude-compatible PascalCase names", () => {
		// Codex CLI shipped its hook contract using Claude Code's
		// vocabulary, so we keep PascalCase event names. PermissionRequest
		// is its own event type, separate from PreToolUse.
		expect(CODEX_HOOK_EVENTS).toEqual([
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
	});
});

describe("installCodexHooks / uninstallCodexHooks", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "codex-hooks-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("writes .codex/hooks.json with all twelve PascalCase events", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const hooksPath = join(tmp, ".codex", "hooks.json");
		expect(existsSync(hooksPath)).toBe(true);

		const content = readFileSync(hooksPath, "utf-8");
		for (const ev of CODEX_HOOK_EVENTS) {
			expect(content).toContain(`"${ev}"`);
		}
	});

	it("tags installed commands with INTERLINKED_CLIENT=codex", () => {
		// Codex's hook payload mirrors Claude's so the .mjs needs an
		// out-of-band signal to know which client it's serving — that
		// signal is the env prefix on the installed command.
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const content = readFileSync(join(tmp, ".codex", "hooks.json"), "utf-8");
		expect(content).toContain('INTERLINKED_CLIENT=\\"codex\\"');
		expect(content).toContain('INTERLINKED_RUNNER=\\"codex\\"');
	});

	it("walks up from subdirectories to find the hook script", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const content = readFileSync(join(tmp, ".codex", "hooks.json"), "utf-8");
		expect(content).toContain('HOOK_DIR=\\"$PWD\\"');
		expect(content).toContain('dirname \\"$HOOK_DIR\\"');
		expect(content).toContain('.interlinked/hooks/interlinked-activity.mjs');
	});

	it("registers PostToolUse with empty matcher (all-tool capture)", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const hooks = JSON.parse(
			readFileSync(join(tmp, ".codex", "hooks.json"), "utf-8"),
		);
		// Per-tool matcher is empty — every tool's result is captured;
		// the .mjs hook fast-paths non-mutation tools internally so the
		// harness round-trip only happens for Edit/Write/MultiEdit/apply_patch.
		const postToolUse = hooks.hooks?.PostToolUse;
		expect(Array.isArray(postToolUse)).toBe(true);
		// Some Codex builds emit a flat object instead of {matcher, hooks}.
		// Both shapes are acceptable as long as the matcher is empty.
		const reg = postToolUse[0];
		const matcher = "matcher" in reg ? reg.matcher : "";
		expect(matcher).toBe("");
	});

	it("sets Codex status, context, and SessionEnd deadline metadata", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const hooks = JSON.parse(readFileSync(join(tmp, ".codex", "hooks.json"), "utf-8")).hooks;
		const preHandler = hooks.PreToolUse[0].hooks[0];
		expect(preHandler).toMatchObject({
			statusMessage: "Interlinked policy check",
			additionalContextLimit: 2_500,
		});
		const endHandler = hooks.SessionEnd[0].hooks[0];
		expect(endHandler).toMatchObject({
			timeout: 3,
			statusMessage: "Interlinked lifecycle check",
		});
		expect(endHandler.additionalContextLimit).toBeUndefined();
		const interruptHandler = hooks.Interrupt[0].hooks[0];
		expect(interruptHandler).toMatchObject({
			async: true,
			timeout: 3,
			statusMessage: "Interlinked lifecycle check",
		});
		expect(interruptHandler.additionalContextLimit).toBeUndefined();
	});

	it("removes stale context limits only from managed handlers during reinstall", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const path = join(tmp, ".codex", "hooks.json");
		const settings = JSON.parse(readFileSync(path, "utf8"));
		const unsupported = ["PermissionRequest", "PreCompact", "PostCompact", "SubagentStop", "Stop", "SessionEnd", "Interrupt"];
		for (const name of unsupported) {
			settings.hooks[name][0].hooks[0].additionalContextLimit = 2500;
		}
		const foreign = { type: "command", command: "echo user-hook", additionalContextLimit: 900 };
		settings.hooks.Stop[0].hooks.push(foreign);
		writeFileSync(path, JSON.stringify(settings));
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const repaired = JSON.parse(readFileSync(path, "utf8")).hooks;
		for (const name of unsupported) expect(repaired[name][0].hooks[0].additionalContextLimit).toBeUndefined();
		expect(repaired.Stop[0].hooks[1]).toEqual(foreign);
		for (const name of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart"]) {
			expect(repaired[name][0].hooks[0].additionalContextLimit).toBe(2500);
		}
		const once = readFileSync(path, "utf8");
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		expect(readFileSync(path, "utf8")).toBe(once);
	});

	it("creates .codex/config.toml with canonical `hooks = true` when absent", () => {
		// Codex requires the feature flag in `[features]` for hooks to
		// fire. The installer writes the canonical `hooks = true` key
		// idempotently. Legacy `codex_hooks` is still recognized by Codex
		// but emits a deprecation warning — see codex-feature-flag.ts.
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const tomlPath = join(tmp, ".codex", "config.toml");
		expect(existsSync(tomlPath)).toBe(true);
		const toml = readFileSync(tomlPath, "utf-8");
		expect(toml).toMatch(/\[features\]/);
		expect(toml).toMatch(/(?<![\w$])hooks\s*=\s*true/);
		expect(toml).not.toMatch(/\bcodex_hooks\s*=\s*true/);
	});

	it("migrates legacy `codex_hooks = true` to canonical `hooks = true` in place", () => {
		// Codex deprecated `codex_hooks` in favor of `hooks`. We rewrite
		// existing legacy entries on every install so the deprecation
		// warning silently goes away after the next `interlinked enable`.
		const tomlPath = join(tmp, ".codex", "config.toml");
		const existing = "# user-managed\n[features]\ncodex_hooks = true\nfoo = 42\n";
		const fs = require("node:fs");
		fs.mkdirSync(join(tmp, ".codex"), { recursive: true });
		fs.writeFileSync(tomlPath, existing);

		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const toml = readFileSync(tomlPath, "utf-8");
		expect(toml).toMatch(/(?<![\w$])hooks\s*=\s*true/);
		expect(toml).not.toMatch(/\bcodex_hooks\s*=\s*true/);
		expect(toml).toContain("foo = 42");
	});

	it("appends [features] block with canonical `hooks` key when none exists", () => {
		const tomlPath = join(tmp, ".codex", "config.toml");
		const existing = "[model]\nname = \"synthetic-model-v5\"\n";
		const fs = require("node:fs");
		fs.mkdirSync(join(tmp, ".codex"), { recursive: true });
		fs.writeFileSync(tomlPath, existing);

		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const toml = readFileSync(tomlPath, "utf-8");
		expect(toml).toContain("[model]");
		expect(toml).toMatch(/(?<![\w$])hooks\s*=\s*true/);
		expect(toml).not.toMatch(/\bcodex_hooks\s*=\s*true/);
	});

	it("reuses an existing [features] block when installing Codex hooks", () => {
		const tomlPath = join(tmp, ".codex", "config.toml");
		const existing =
			"[model]\nname = \"synthetic-model-v5\"\n\n[features]\nfoo = true\n[profiles.default]\napproval_policy = \"never\"\n";
		const fs = require("node:fs");
		fs.mkdirSync(join(tmp, ".codex"), { recursive: true });
		fs.writeFileSync(tomlPath, existing);

		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const toml = readFileSync(tomlPath, "utf-8");
		expect((toml.match(/\[features\]/g) || []).length).toBe(1);
		expect(toml).toContain("[features]\nfoo = true\nhooks = true\n[profiles.default]");
	});

	it("throws when .codex/config.toml has duplicate [features] tables", () => {
		// A duplicate [features] table is invalid TOML — Codex rejects the
		// whole file, so the writer refuses to touch it rather than report a
		// successful install over a config that will never actually fire.
		const tomlPath = join(tmp, ".codex", "config.toml");
		const existing = "[features]\nhooks = false\nfoo = 1\n\n[features]\ncodex_hooks = true\n";
		const fs = require("node:fs");
		fs.mkdirSync(join(tmp, ".codex"), { recursive: true });
		fs.writeFileSync(tomlPath, existing);

		expect(() => installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs")).toThrow(
			"Codex rejects the whole file, so hooks cannot fire",
		);
	});

	it("does not rewrite .codex/hooks.json when rerun with identical settings", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const hooksPath = join(tmp, ".codex", "hooks.json");
		const tomlPath = join(tmp, ".codex", "config.toml");
		const sentinel = new Date("2001-01-01T00:00:00.000Z");
		utimesSync(hooksPath, sentinel, sentinel);
		utimesSync(tomlPath, sentinel, sentinel);

		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		expect(statSync(hooksPath).mtimeMs).toBe(sentinel.getTime());
		expect(statSync(tomlPath).mtimeMs).toBe(sentinel.getTime());
	});

	it("removes Codex interlinked entries on uninstall", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const changed = uninstallCodexHooks(tmp);
		expect(changed).toBe(true);

		// cleanJsonHookFile preserves the file but strips our entries —
		// so the file still exists, just without any reference to us.
		const hooksPath = join(tmp, ".codex", "hooks.json");
		const content = readFileSync(hooksPath, "utf-8");
		expect(content).not.toContain("interlinked-activity");
	});

	it("uninstall leaves config.toml untouched (avoid clobbering user config)", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const tomlBefore = readFileSync(join(tmp, ".codex", "config.toml"), "utf-8");
		uninstallCodexHooks(tmp);
		const tomlAfter = readFileSync(join(tmp, ".codex", "config.toml"), "utf-8");
		expect(tomlAfter).toBe(tomlBefore);
	});

	it("Codex uninstall is a no-op when file is missing", () => {
		expect(uninstallCodexHooks(tmp)).toBe(false);
	});
});

// ===========================================
// Matcher Reconciliation — Codex
// ===========================================
// installHookEntry must update stale PostToolUse matchers to "" (all-tool
// capture) when re-running installation. Without this, non-edit tools
// (Read, Bash, Grep, WebFetch) never reach the hook at PostToolUse.

describe("matcher reconciliation — Codex", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "matcher-reconcile-codex-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("rewrites stale Codex PostToolUse matcher to empty", () => {
		const codexDir = join(tmp, ".codex");
		mkdirSync(codexDir, { recursive: true });
		const staleHooks = {
			hooks: {
				PostToolUse: [
					{
						matcher: "Edit|Write|MultiEdit|apply_patch",
						hooks: [{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" }],
					},
				],
			},
		};
		writeFileSync(join(codexDir, "hooks.json"), JSON.stringify(staleHooks, null, 2));

		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");

		const updated = JSON.parse(readFileSync(join(codexDir, "hooks.json"), "utf-8"));
		const postToolUse = updated.hooks.PostToolUse;
		expect(Array.isArray(postToolUse)).toBe(true);
		expect(postToolUse[0].matcher).toBe("");
	});
});
