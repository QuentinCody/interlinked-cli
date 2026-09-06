// ===========================================
// Claude Code installer — ancestor-hook refusal
// ===========================================
// Claude Code merges hooks from every `.claude/settings.json` up the directory
// tree, so installing in a subdirectory of a repo that already has our hooks
// would register them twice. `installAllClaudeHooks` refuses in that case; the
// tests below pin the refusal message and the fact that nothing is written.
// The install/uninstall happy paths live in
// `__tests__/hook-installers-claude.integration.test.ts`.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAllClaudeHooks } from "./hook-installers-claude.js";

const HOOK_SCRIPT = ".interlinked/hooks/interlinked-activity.mjs";

function ancestorSettings(): string {
	return JSON.stringify({
		hooks: {
			PostToolUse: [
				{ matcher: "", hooks: [{ type: "command", command: `node ${HOOK_SCRIPT}` }] },
			],
		},
	});
}

describe("installAllClaudeHooks — an ancestor already has Interlinked hooks", () => {
	let repoRoot: string;
	let child: string;
	let errors: string[];

	beforeEach(() => {
		repoRoot = mkdtempSync(join(tmpdir(), "claude-ancestor-"));
		execSync("git init", { cwd: repoRoot, stdio: "ignore" });
		mkdirSync(join(repoRoot, ".claude"), { recursive: true });
		writeFileSync(join(repoRoot, ".claude", "settings.json"), ancestorSettings());
		child = join(repoRoot, "packages", "app");
		mkdirSync(child, { recursive: true });
		errors = [];
		vi.spyOn(console, "error").mockImplementation((message: string) => {
			errors.push(message);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(repoRoot, { recursive: true, force: true });
	});

	it("names the ancestor settings file and the directory to re-run from", () => {
		installAllClaudeHooks(child, HOOK_SCRIPT);

		expect(errors.join("\n")).toContain(
			`hooks already installed at ${repoRoot}/.claude/settings.json`,
		);
		expect(errors.join("\n")).toContain(`Run \`interlinked enable\` from ${repoRoot} instead.`);
	});

	it("writes no settings file in the directory it was asked to install into", () => {
		installAllClaudeHooks(child, HOOK_SCRIPT);

		expect(existsSync(join(child, ".claude", "settings.json"))).toBe(false);
	});

	it("installs normally once the ancestor settings file carries no Interlinked hook", () => {
		writeFileSync(join(repoRoot, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));

		installAllClaudeHooks(child, HOOK_SCRIPT);

		expect(errors).toEqual([]);
		expect(existsSync(join(child, ".claude", "settings.json"))).toBe(true);
	});
});
