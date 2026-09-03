import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	installHooks,
	installedEventsFor,
	manifestPath,
	readManifest,
	readManifestState,
	uninstallHooks,
} from "./installer.js";
import { mergeSettings, removeJsonPath } from "./installer-merge-engine.js";
import { getAdapter } from "./adapters/index.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-ins-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("installHooks — project scope", () => {
	it("writes Claude Code hook settings + manifest", () => {
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["claude-code"],
			scope: "project",
		});
		expect(result.entries.length).toBe(1);
		expect(nonNull(result.entries[0]).runner).toBe("claude-code");

		const claudeSettings = JSON.parse(
			readFileSync(join(tmp, ".claude", "settings.json"), "utf-8"),
		) as { hooks: Record<string, unknown[]> };
		expect(Array.isArray(claudeSettings.hooks.PreToolUse)).toBe(true);

		const manifest = readManifest(manifestPath(tmp));
		expect(manifest.length).toBe(1);
		expect(nonNull(manifest[0]).added_paths.length).toBeGreaterThan(0);
	});

	it("appends hooks rather than replacing user-owned entries", () => {
		// User already has a hook in place
		const settingsPath = join(tmp, ".claude", "settings.json");
		const userHook = {
			hooks: {
				PreToolUse: [
					{ matcher: "Bash", hooks: [{ type: "command", command: "user-script.sh" }] },
				],
			},
		};
		const { mkdirSync } = require("node:fs");
		mkdirSync(join(tmp, ".claude"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify(userHook));

		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["claude-code"],
		});

		const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			hooks: { PreToolUse: unknown[] };
		};
		expect(after.hooks.PreToolUse.length).toBe(2);
	});

	it("purges canonical adapter and legacy hooks without claiming same-basename user scripts", () => {
		const settingsPath = join(tmp, ".gemini", "settings.json");
		mkdirSync(join(tmp, ".gemini"), { recursive: true });
		const userHooks = [
			{ command: "node /home/user/hook-entry.js" },
			{
				command:
					"node /home/user/hook-entry.js --runner user-runner --event BeforeTool",
			},
			{ command: "node /home/user/interlinked-activity.mjs" },
		];
		writeFileSync(
			settingsPath,
			JSON.stringify({
				hooks: {
					BeforeTool: [
						...userHooks,
						{
							command:
								"node '/old/dist/hook-entry.js' --runner 'gemini-cli' --event 'BeforeTool'",
						},
						{ command: "node .interlinked/hooks/interlinked-activity.mjs" },
					],
				},
			}),
		);

		const result = installHooks({
			cwd: tmp,
			binaryPath: join(tmp, "dist", "hook-entry.js"),
			runners: ["gemini-cli"],
		});

		expect(result.purged).toBe(2);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			hooks: { BeforeTool: Array<{ command?: string }> };
		};
		expect(after.hooks.BeforeTool.slice(0, userHooks.length)).toEqual(userHooks);
		const commands = after.hooks.BeforeTool.map((entry) => entry.command ?? "");
		expect(commands.some((command) => command.includes("/old/dist/hook-entry.js"))).toBe(false);
		expect(
			commands.some((command) => command === "node .interlinked/hooks/interlinked-activity.mjs"),
		).toBe(false);
		expect(commands.filter((command) => command.includes("/dist/hook-entry.js"))).toHaveLength(1);
	});

	it("supports dry-run (does not write files)", () => {
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["claude-code"],
			dryRun: true,
		});
		const { existsSync } = require("node:fs") as { existsSync(p: string): boolean };
		expect(existsSync(join(tmp, ".claude", "settings.json"))).toBe(false);
		expect(existsSync(manifestPath(tmp))).toBe(false);
	});
});

describe("installHooks — multi-runner", () => {
	it("installs claude-code + copilot-cli side by side", () => {
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["claude-code", "copilot-cli"],
		});
		expect(result.entries.length).toBe(2);
		const runners = result.entries.map((e) => e.runner).sort();
		expect(runners).toEqual(["claude-code", "copilot-cli"]);
	});

	it("deduplicates an explicit runner selection before writing the manifest", () => {
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["claude-code", "claude-code"],
		});
		expect(result.entries.map((entry) => entry.runner)).toEqual(["claude-code"]);
		expect(readManifestState(manifestPath(tmp))).toMatchObject({
			kind: "valid",
			entries: [{ runner: "claude-code" }],
		});
		expect(() => uninstallHooks({ cwd: tmp, runners: ["claude-code"] })).not.toThrow();
	});

	it("codex install runs the postInstall feature-flag writer", () => {
		// Codex hooks are gated by `[features] hooks = true` in
		// `.codex/config.toml` (legacy `codex_hooks` key still recognized
		// but emits a deprecation warning). The Codex adapter's
		// `postInstall` writes the canonical flag after the JSON merger
		// lands the hooks fragment; without it, Codex would silently
		// ignore the hooks.json we just wrote.
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["codex"],
		});
		expect(result.entries.length).toBe(1);
		expect(nonNull(result.entries[0]).runner).toBe("codex");

		const tomlPath = join(tmp, ".codex", "config.toml");
		const { existsSync } = require("node:fs") as { existsSync(p: string): boolean };
		expect(existsSync(tomlPath)).toBe(true);
		const toml = readFileSync(tomlPath, "utf-8");
		expect(toml).toMatch(/(?<![\w$])hooks\s*=\s*true/);
		expect(toml).not.toMatch(/\bcodex_hooks\s*=\s*true/);
	});

	it("codex dry-run does not write the feature flag", () => {
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["codex"],
			dryRun: true,
		});
		const tomlPath = join(tmp, ".codex", "config.toml");
		const { existsSync } = require("node:fs") as { existsSync(p: string): boolean };
		expect(existsSync(tomlPath)).toBe(false);
	});
});

describe("uninstallHooks — round-trip", () => {
	it("removes exactly what install added", () => {
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook-round",
			runners: ["claude-code"],
		});
		const settings = join(tmp, ".claude", "settings.json");
		const before = readFileSync(settings, "utf-8");
		expect(before).toContain("interlinked-hook-round");

		const removal = uninstallHooks({ cwd: tmp, runners: ["claude-code"] });
		expect(removal.removed.length).toBe(1);
		expect(removal.remaining.length).toBe(0);

		const after = readFileSync(settings, "utf-8");
		expect(after).not.toContain("interlinked-hook-round");
	});

	// test-contract: bug — review 2026-08-30, release-blocking repro: install
	// recorded index 0, the user PREPENDED their own hook, and positional
	// uninstall deleted the USER's hook while leaving ours behind. Removal is
	// now owned-entry recognition; the user's hook must survive verbatim.
	it("a user hook prepended after install survives uninstall; ours is removed", () => {
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook-prepend",
			runners: ["gemini-cli"],
		});
		const settingsPath = join(tmp, ".gemini", "settings.json");
		const doc = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			hooks: Record<string, unknown[]>;
		};
		const userHook = { command: "/home/user/my-precious-hook.sh" };
		for (const key of Object.keys(doc.hooks)) doc.hooks[key] = [userHook, ...(doc.hooks[key] ?? [])];
		writeFileSync(settingsPath, JSON.stringify(doc, null, 2));

		uninstallHooks({ cwd: tmp, runners: ["gemini-cli"] });

		const after = readFileSync(settingsPath, "utf-8");
		expect(after).toContain("my-precious-hook.sh");
		expect(after).not.toContain("interlinked-hook-prepend");
	});

	// test-contract: security — review 2026-08-30 final pass: user hooks
	// whose text merely PRINTS or comments on an Interlinked invocation (or
	// echoes the exact recorded binary — the removed substring fallback) must
	// survive uninstall; real current AND stale Interlinked hooks must go.
	it("user hooks that mention (but do not invoke) our binary survive uninstall", () => {
		const binary = "/usr/bin/interlinked-hook-mention";
		installHooks({ cwd: tmp, binaryPath: binary, runners: ["gemini-cli"] });
		const settingsPath = join(tmp, ".gemini", "settings.json");
		const doc = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			hooks: Record<string, unknown[]>;
		};
		const userHooks = [
			{ command: "echo node /repo/dist/hook-entry.js" },
			{ command: "echo ok # node /repo/dist/hook-entry.js" },
			{ command: "printf '%s\\n' 'node /repo/dist/hook-entry.js'" },
			{ command: "node --require /tmp/hook-entry.js app.js" },
			{ command: "node --loader /tmp/hook-entry.js app.js" },
			{ command: "node -r /tmp/hook-entry.js app.js" },
			{ command: "node /home/user/hook-entry.js" },
			{
				command:
					"node /home/user/hook-entry.js --runner user-runner --event BeforeTool",
			},
			{ command: "node /home/user/hook-entry.js --runner gemini-cli" },
			{ command: "node /home/user/interlinked-activity.mjs" },
			{ command: `echo ${binary}` }, // the exact recorded binary, echoed
		];
		// A stale REAL Interlinked hook (old binary, invocation position).
		const stale = { command: "node '/old/dist/hook-entry.js' --runner 'gemini-cli' --event 'BeforeTool'" };
		for (const key of Object.keys(doc.hooks)) {
			doc.hooks[key] = [...userHooks, stale, ...(doc.hooks[key] ?? [])];
		}
		writeFileSync(settingsPath, JSON.stringify(doc, null, 2));

		uninstallHooks({ cwd: tmp, runners: ["gemini-cli"] });

		const after = readFileSync(settingsPath, "utf-8");
		expect(after).toContain("echo node /repo/dist/hook-entry.js");
		expect(after).toContain("echo ok # node /repo/dist/hook-entry.js");
		expect(after).toContain("printf");
		expect(after).toContain("node --require /tmp/hook-entry.js app.js");
		expect(after).toContain("node --loader /tmp/hook-entry.js app.js");
		expect(after).toContain("node -r /tmp/hook-entry.js app.js");
		expect(after).toContain("node /home/user/hook-entry.js");
		expect(after).toContain("--runner user-runner --event BeforeTool");
		expect(after).toContain("node /home/user/interlinked-activity.mjs");
		expect(after).toContain(`echo ${binary}`);
		// The current install and the stale invocation are both gone.
		expect(after).not.toContain(`'${binary}'`);
		expect(after).not.toContain("/old/dist/hook-entry.js");
	});

	// test-contract: security — review 2026-08-31: identity is the EXACT
	// basename. A user's look-alike scripts whose names merely end with ours
	// must survive uninstall while the real install is removed.
	it("look-alike user hooks (my-hook-entry.js et al.) survive uninstall", () => {
		const binary = "/usr/bin/interlinked-hook-lookalike";
		installHooks({ cwd: tmp, binaryPath: binary, runners: ["gemini-cli"] });
		const settingsPath = join(tmp, ".gemini", "settings.json");
		const doc = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			hooks: Record<string, unknown[]>;
		};
		const lookalikes = [
			{ command: "node /home/u/my-hook-entry.js" },
			{ command: "node /home/u/myinterlinked-activity.mjs" },
			{ command: "/usr/local/bin/my-interlinked-hook --event pre" },
		];
		for (const key of Object.keys(doc.hooks)) {
			doc.hooks[key] = [...lookalikes, ...(doc.hooks[key] ?? [])];
		}
		writeFileSync(settingsPath, JSON.stringify(doc, null, 2));

		uninstallHooks({ cwd: tmp, runners: ["gemini-cli"] });

		const after = readFileSync(settingsPath, "utf-8");
		expect(after).toContain("my-hook-entry.js");
		expect(after).toContain("myinterlinked-activity.mjs");
		expect(after).toContain("my-interlinked-hook");
		expect(after).not.toContain(`'${binary}'`);
	});

	// test-contract: invariant — an entry already removed by hand makes
	// uninstall a no-op for that array, never an adjacent-element deletion.
	it("uninstall of an already-removed hook deletes nothing else", () => {
		installHooks({ cwd: tmp, binaryPath: "/usr/bin/ih-gone", runners: ["gemini-cli"] });
		const settingsPath = join(tmp, ".gemini", "settings.json");
		const doc = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			hooks: Record<string, unknown[]>;
		};
		// Hand-remove ours everywhere; leave one user hook per event.
		for (const key of Object.keys(doc.hooks)) doc.hooks[key] = [{ command: "user-kept.sh" }];
		writeFileSync(settingsPath, JSON.stringify(doc, null, 2));
		uninstallHooks({ cwd: tmp, runners: ["gemini-cli"] });
		expect(readFileSync(settingsPath, "utf-8")).toContain("user-kept.sh");
	});

	// test-contract: bug — review 2026-08-30: uninstall over a CORRUPT
	// manifest used to write `{entries: []}` over the evidence. It must
	// refuse and preserve the exact bytes.
	it("uninstall refuses a corrupt manifest and preserves its bytes", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(manifestPath(tmp), "{ corrupt bytes");
		expect(() => uninstallHooks({ cwd: tmp, runners: [] })).toThrow(/corrupt/);
		expect(readFileSync(manifestPath(tmp), "utf-8")).toBe("{ corrupt bytes");
	});

	it("does not disturb other runners", () => {
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["claude-code", "copilot-cli"],
		});
		uninstallHooks({ cwd: tmp, runners: ["claude-code"] });

		const { existsSync } = require("node:fs") as { existsSync(p: string): boolean };
		expect(existsSync(join(tmp, ".github", "hooks", "hooks.json"))).toBe(true);
		const manifest = readManifest(manifestPath(tmp));
		expect(manifest.length).toBe(1);
		expect(nonNull(manifest[0]).runner).toBe("copilot-cli");
	});
});

describe("mergeSettings — merge engine", () => {
	it("appends array items and records their paths", () => {
		const target: Record<string, unknown> = { hooks: { PreToolUse: [{ matcher: "X" }] } };
		const added: string[] = [];
		mergeSettings(
			target,
			{ hooks: { PreToolUse: [{ matcher: "Y" }] } },
			"array-append",
			"",
			added,
		);
		const pre = (target as { hooks: { PreToolUse: unknown[] } }).hooks.PreToolUse;
		expect(pre.length).toBe(2);
		expect(added[0]).toBe("hooks.PreToolUse[1]");
	});

	it("does not overwrite existing scalars", () => {
		const target: Record<string, unknown> = { log_level: "info" };
		const added: string[] = [];
		mergeSettings(target, { log_level: "debug", extra: 1 }, "deep-merge", "", added);
		expect(target.log_level).toBe("info");
		expect(target.extra).toBe(1);
		expect(added).toEqual(["extra"]);
	});
});

describe("installHooks — skips a runner whose settings file is malformed JSON", () => {
	it("reports the runner as skipped instead of clobbering the file", () => {
		const settingsPath = join(tmp, ".claude", "settings.json");
		mkdirSync(join(tmp, ".claude"), { recursive: true });
		writeFileSync(settingsPath, "{ not valid json");

		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["claude-code"],
		});

		expect(result.entries).toEqual([]);
		expect(result.skipped.length).toBe(1);
		expect(nonNull(result.skipped[0]).runner).toBe("claude-code");
		expect(nonNull(result.skipped[0]).reason).toContain("malformed JSON");
		// The unreadable file is left untouched, not overwritten.
		expect(readFileSync(settingsPath, "utf-8")).toBe("{ not valid json");
	});

	it("refuses an array-root settings document instead of claiming a successful install", () => {
		const settingsPath = join(tmp, ".claude", "settings.json");
		mkdirSync(join(tmp, ".claude"), { recursive: true });
		writeFileSync(settingsPath, "[]\n");

		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["claude-code"],
		});

		expect(result.entries).toEqual([]);
		expect(result.skipped[0]?.reason).toContain("malformed JSON");
		expect(readFileSync(settingsPath, "utf-8")).toBe("[]\n");
	});
});

// NOTE: the CONTRACT is `ok: false` on postInstall failure (see the describes
// at the bottom of this file). This block pins only the narrower property that
// the hooks-file fragment still lands — partial artifacts are not rolled back.
describe("installHooks — postInstall failure still writes the hooks fragment (ok:false is pinned below)", () => {
	it("codex postInstall error is caught and the JSON-fragment entry still lands", () => {
		// `.codex/config.toml` exists as a DIRECTORY (not a file), so
		// `ensureCodexFeatureFlag`'s `readFileSync(tomlPath, ...)` throws
		// EISDIR — exercising the postInstall try/catch. `.codex/hooks.json`
		// (a different filename in the same, real, directory) still writes
		// fine, so the JSON-fragment install itself succeeds.
		mkdirSync(join(tmp, ".codex", "config.toml"), { recursive: true });

		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["codex"],
		});

		expect(result.entries.length).toBe(1);
		expect(nonNull(result.entries[0]).runner).toBe("codex");
	});
});

describe("installHooks — cross-scope stale cleanup keeps unrelated entries", () => {
	let homeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDir;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("removes only this project's user-scope entry, leaving a third-party hook in the array", () => {
		const binaryPath = join(tmp, "dist", "hook-entry.js");
		const projectOwnedCommand =
			`if test -f '${binaryPath}' ; then node '${binaryPath}' --runner 'claude-code' --event 'UserPromptSubmit' ; fi`;
		const userClaudeSettings = join(homeDir, ".claude", "settings.json");
		mkdirSync(join(homeDir, ".claude"), { recursive: true });
		writeFileSync(
			userClaudeSettings,
			JSON.stringify({
				hooks: {
					UserPromptSubmit: [
						{ matcher: "", hooks: [{ type: "command", command: projectOwnedCommand }] },
						{ matcher: "", hooks: [{ type: "command", command: "echo third-party-hook" }] },
					],
				},
			}),
		);

		// A project-scope install triggers the unconditional cross-scope
		// cleanup (scope !== "user") against the shared user-scope file.
		installHooks({ cwd: tmp, binaryPath, runners: ["claude-code"] });

		const after = JSON.parse(readFileSync(userClaudeSettings, "utf-8")) as {
			hooks: { UserPromptSubmit: Array<{ hooks?: Array<{ command?: string }> }> };
		};
		expect(after.hooks.UserPromptSubmit.length).toBe(1);
		expect(after.hooks.UserPromptSubmit[0]?.hooks?.[0]?.command).toBe("echo third-party-hook");
	});

	it("preserves a customized user-scope managed provider bridge without a manifest hash", () => {
		const binaryPath = join(tmp, "dist", "hook-entry.js");
		const userFragment = nonNull(getAdapter("opencode")).renderSettingsFragment(
			binaryPath,
			"user",
		);
		const userPlugin = join(homeDir, ".config", "opencode", "plugins", "interlinked.ts");
		mkdirSync(join(homeDir, ".config", "opencode", "plugins"), { recursive: true });
		const customized = `${userFragment.fileContent}\n// user customization\n`;
		writeFileSync(userPlugin, customized);

		installHooks({ cwd: tmp, binaryPath, runners: ["opencode"] });

		expect(readFileSync(userPlugin, "utf-8")).toBe(customized);
	});
});

describe("installHooks — scope switch cleans the stale manifest entry", () => {
	let homeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home2-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDir;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("project→user switch purges the manifest-recorded project file via the stale-install loop", () => {
		const binaryPath = join(tmp, "dist", "hook-entry.js");
		installHooks({ cwd: tmp, binaryPath, runners: ["claude-code"], scope: "project" });
		const projectSettings = join(tmp, ".claude", "settings.json");
		expect(readFileSync(projectSettings, "utf-8")).toContain("hook-entry.js");

		const result = installHooks({
			cwd: tmp,
			binaryPath,
			runners: ["claude-code"],
			scope: "user",
		});

		// The manifest-driven stale-install loop (selectedIds has the runner,
		// newFiles does NOT contain the old project file) purged it.
		expect(result.orphans_cleaned).toContain(projectSettings);
		const after = JSON.parse(readFileSync(projectSettings, "utf-8")) as {
			hooks?: Record<string, unknown[]>;
		};
		expect(after.hooks ?? {}).toEqual({});
	});

	it("codex postInstall runs against homedir at user scope (ternary true branch)", () => {
		const binaryPath = join(tmp, "dist", "hook-entry.js");
		const result = installHooks({
			cwd: tmp,
			binaryPath,
			runners: ["codex"],
			scope: "user",
		});
		expect(result.entries.length).toBe(1);
		const tomlPath = join(homeDir, ".codex", "config.toml");
		expect(readFileSync(tomlPath, "utf-8")).toMatch(/hooks\s*=\s*true/);
	});
});

describe("installHooks — selectAdapters skips an unrecognized runner id", () => {
	it("installs the known runner and silently drops the unmatched one (getAdapter returns null)", () => {
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			// "unknown" is a real RunnerId value but has no registered adapter —
			// exercises selectAdapters' `if (a) out.push(a)` false arm.
			runners: ["claude-code", "unknown"],
		});
		expect(result.entries.length).toBe(1);
		expect(nonNull(result.entries[0]).runner).toBe("claude-code");
		expect(result.skipped).toEqual([]);
	});
});

describe("installHooks — stale-install loop: mixed selected/non-selected prior runners", () => {
	it("cleans the reinstalled runner's old file but leaves the non-reinstalled runner's manifest entry untouched", () => {
		// Round 1: install both runners at project scope. Binary path must
		// contain an Interlinked marker (see hook-ownership.ts) so the
		// orphan-cleanup verdict recognizes these entries as ours.
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["claude-code", "copilot-cli"],
			scope: "project",
		});

		// Round 2: reinstall ONLY claude-code, switching its scope so its old
		// project-scope file becomes stale (newFiles won't contain it).
		const homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home3-"));
		const originalHome = process.env.HOME;
		process.env.HOME = homeDir;
		try {
			const result = installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "user",
			});
			// claude-code's old project file was selected + orphaned => cleaned
			// (L135 false arm: selectedIds.has("claude-code") === true).
			const oldClaudeSettings = join(tmp, ".claude", "settings.json");
			expect(result.orphans_cleaned).toContain(oldClaudeSettings);

			// copilot-cli was NOT selected this round, so the stale-install loop
			// skips it entirely (L135 true arm: `continue`) — its manifest entry
			// survives untouched.
			const manifest = readManifest(manifestPath(tmp));
			const copilot = manifest.find((e) => e.runner === "copilot-cli");
			expect(copilot).toBeDefined();
			expect(nonNull(copilot).settings_path).toBe(join(tmp, ".github", "hooks", "hooks.json"));
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	it("does not record an orphan when the stale prior settings file was already deleted", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home4-"));
		const originalHome = process.env.HOME;
		process.env.HOME = homeDir;
		try {
			installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "project",
			});
			// Manually delete the settings file the prior install wrote, so the
			// orphan-cleanup pass for it finds nothing to remove.
			rmSync(join(tmp, ".claude", "settings.json"));

			const result = installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "user",
			});
			// cleanProjectOwnedHooks returns 0 (existsSync false) => `removed > 0`
			// is false => orphans_cleaned must NOT contain the vanished path.
			expect(result.orphans_cleaned).toEqual([]);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	it("skips (does not throw on) a stale settings file containing malformed JSON", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home5-"));
		const originalHome = process.env.HOME;
		process.env.HOME = homeDir;
		try {
			installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "project",
			});
			const staleSettings = join(tmp, ".claude", "settings.json");
			writeFileSync(staleSettings, "{ not valid json");

			const result = installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "user",
			});
			// cleanProjectOwnedHooks's `readJson` returns null for malformed JSON
			// => early `return 0` => left untouched, not counted as an orphan.
			expect(result.orphans_cleaned).toEqual([]);
			expect(readFileSync(staleSettings, "utf-8")).toBe("{ not valid json");
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	it("skips a non-array value under a hook event key without crashing", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home6-"));
		const originalHome = process.env.HOME;
		process.env.HOME = homeDir;
		try {
			installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "project",
			});
			const staleSettings = join(tmp, ".claude", "settings.json");
			const before = JSON.parse(readFileSync(staleSettings, "utf-8")) as {
				hooks: Record<string, unknown>;
			};
			// Inject a malformed sibling key alongside the real (array) hook
			// arrays — exercises the `!Array.isArray(arr)` continue branch.
			before.hooks.SomeMalformedKey = "not-an-array";
			writeFileSync(staleSettings, JSON.stringify(before));

			const result = installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "user",
			});
			expect(result.orphans_cleaned).toContain(staleSettings);
			const after = JSON.parse(readFileSync(staleSettings, "utf-8")) as {
				hooks?: Record<string, unknown>;
			};
			// The malformed key survives (never touched); the real hook arrays
			// were emptied and their event keys dropped, leaving only the junk
			// key — this pins that the malformed-value branch doesn't crash or
			// silently drop unrelated keys.
			expect(after.hooks).toEqual({ SomeMalformedKey: "not-an-array" });
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	it("dry-run scope switch computes orphans but does not write the stale file", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home7-"));
		const originalHome = process.env.HOME;
		process.env.HOME = homeDir;
		try {
			installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "project",
			});
			const staleSettings = join(tmp, ".claude", "settings.json");
			const before = readFileSync(staleSettings, "utf-8");

			const result = installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "user",
				dryRun: true,
			});
			// removed > 0 is still computed (in-memory), so it's reported...
			expect(result.orphans_cleaned).toContain(staleSettings);
			// ...but dryRun suppresses the actual write.
			expect(readFileSync(staleSettings, "utf-8")).toBe(before);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});

describe("uninstallHooks — settings file already gone", () => {
	it("removeEntry no-ops instead of throwing when the settings file no longer exists", () => {
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["claude-code"],
		});
		rmSync(join(tmp, ".claude", "settings.json"));

		const result = uninstallHooks({ cwd: tmp, runners: ["claude-code"] });
		// Still reported as removed (manifest entry dropped) even though the
		// underlying file write was a no-op.
		expect(result.removed.length).toBe(1);
		expect(result.remaining.length).toBe(0);
		expect(readManifest(manifestPath(tmp))).toEqual([]);
	});
});

describe("readManifest — malformed manifest content", () => {
	it("returns [] for a manifest file containing invalid JSON", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(join(tmp, ".interlinked", "installer-manifest.json"), "{ not json");
		expect(readManifest(manifestPath(tmp))).toEqual([]);
	});

	it("returns [] when the manifest's top level parses to a non-object (e.g. a bare number)", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(join(tmp, ".interlinked", "installer-manifest.json"), "42");
		expect(readManifest(manifestPath(tmp))).toEqual([]);
	});

	it("returns [] when `entries` is missing or not an array", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "installer-manifest.json"),
			JSON.stringify({ schema_version: "1" }),
		);
		expect(readManifest(manifestPath(tmp))).toEqual([]);
	});

	// test-contract: bug — review 2026-08-30: the lenient coercer silently
	// dropped malformed rows and returned a smaller VALID manifest, so a
	// damaged manifest could read as empty and later writes clobbered the
	// evidence. STRICT contract: one bad row corrupts the whole manifest.
	it("a malformed row makes the WHOLE manifest corrupt (strict parsing)", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "installer-manifest.json"),
			JSON.stringify({
				schema_version: "1",
				entries: [
					{
						runner: "claude-code",
						scope: "project",
						settings_path: join(tmp, ".claude", "settings.json"),
						added_paths: ["hooks.PreToolUse[0]"],
						binary_path: "/b.js",
						installed_at: "2026-08-30T00:00:00.000Z",
					},
					{ runner: "claude-code" }, // missing settings_path
				],
			}),
		);
		const state = readManifestState(manifestPath(tmp));
		expect(state).toMatchObject({ kind: "corrupt" });
		expect(readManifest(manifestPath(tmp))).toEqual([]);
	});

	// test-contract: invariant — strict validation rejects unknown runners,
	// invalid scopes (no silent rewrite to "project"), wrong schema versions,
	// duplicate runner/scope rows, and invalid post_install values.
	it("rejects unknown runner, invalid scope, bad schema version, and duplicates", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		const p = join(tmp, ".interlinked", "installer-manifest.json");
		const valid = {
			runner: "claude-code",
			scope: "project",
			// Adapter-derived path for claude-code at project scope: anything
			// else is corrupt under the 2026-08-30 binding rule.
			settings_path: join(tmp, ".claude", "settings.json"),
			added_paths: [],
			binary_path: "/b.js",
			installed_at: "2026-08-30T00:00:00.000Z",
		};
		const cases: Array<[object, string]> = [
			[{ schema_version: "2", entries: [valid] }, "schema_version"],
			[{ schema_version: "1", entries: [{ ...valid, runner: "not-a-runner" }] }, "unknown runner"],
			[{ schema_version: "1", entries: [{ ...valid, scope: "global" }] }, "invalid scope"],
			[{ schema_version: "1", entries: [valid, valid] }, "duplicate"],
			[{ schema_version: "1", entries: [{ ...valid, post_install: "maybe" }] }, "post_install"],
		];
		for (const [body, reasonPart] of cases) {
			writeFileSync(p, JSON.stringify(body));
			const state = readManifestState(p);
			expect(state.kind).toBe("corrupt");
			// SAFETY: asserted corrupt on the previous line.
			expect((state as { reason: string }).reason).toContain(reasonPart);
		}
	});

	// test-contract: public-api — a fully valid manifest still round-trips; a
	// pre-post_install row (field absent) stays readable as "ok".
	it("a valid manifest parses; absent post_install reads as ok", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "installer-manifest.json"),
			JSON.stringify({
				schema_version: "1",
				entries: [
					{
						runner: "claude-code",
						scope: "project",
						settings_path: join(tmp, ".claude", "settings.json"),
						added_paths: ["hooks.PreToolUse[0]"],
						binary_path: "/b.js",
						installed_at: "2026-08-30T00:00:00.000Z",
					},
				],
			}),
		);
		expect(readManifest(manifestPath(tmp))).toEqual([
			{
				runner: "claude-code",
				scope: "project",
				settings_path: join(tmp, ".claude", "settings.json"),
				added_paths: ["hooks.PreToolUse[0]"],
				binary_path: "/b.js",
				installed_at: "2026-08-30T00:00:00.000Z",
				post_install: "ok",
				schema_version: "1",
			},
		]);
	});
});

describe("removeJsonPath — targeted removal", () => {
	it("removes an array element by index", () => {
		const obj = { a: { b: [10, 20, 30] } };
		expect(removeJsonPath(obj, "a.b[1]")).toBe(true);
		expect(obj.a.b).toEqual([10, 30]);
	});

	it("removes an object key", () => {
		const obj: { a: { b?: number; c: number } } = { a: { b: 1, c: 2 } };
		expect(removeJsonPath(obj, "a.b")).toBe(true);
		expect(obj.a).toEqual({ c: 2 });
	});

	it("returns false for missing paths", () => {
		expect(removeJsonPath({ a: 1 }, "b.c")).toBe(false);
	});
});

/**
 * A failed `postInstall` must not report success.
 *
 * An adapter declares `postInstall` only when the JSON fragment alone leaves
 * the install INERT — Codex ignores `.codex/hooks.json` until `[features]
 * hooks = true` sits in `.codex/config.toml`. The installer used to catch that
 * throw, write one stderr line and return `ok: true`, so an installation that
 * fires no hooks was recorded in the manifest as a healthy one.
 *
 * The failure is forced for real rather than mocked: `config.toml` is created
 * as a DIRECTORY, so the feature-flag writer's read throws EISDIR while the
 * `.codex/hooks.json` fragment still lands normally.
 */
// Review 2026-08-28 (final round, P1): success reporting must come from the
// adapter that performed the install — the legacy per-client lists drifted
// (Gemini reported 8/installed 4, Cursor 15/18). One parity case per client,
// with the measured counts pinned so silent list growth/shrink is visible.
describe("installedEventsFor — five-client parity with the adapters", () => {
	const EXPECTED: Array<[Parameters<typeof installedEventsFor>[0], number]> = [
		["claude-code", 14],
		["codex", 12],
		["cursor", 18],
		["copilot-cli", 6],
		["gemini-cli", 9],
	];

	for (const [runner, count] of EXPECTED) {
		it(`P: ${runner} reports exactly the adapter's ${count} registered events`, () => {
			const events = installedEventsFor(runner);
			expect(events).toEqual([...nonNull(getAdapter(runner)).nativeEventNames]);
			expect(events).toHaveLength(count);
		});
	}

	it("N: an unknown runner id yields an empty list, never a fabricated one", () => {
		// SAFETY: deliberately invalid id to exercise the resolve-miss branch.
		expect(installedEventsFor("no-such-runner" as Parameters<typeof installedEventsFor>[0])).toEqual([]);
	});
});

describe("installHooks — failed postInstall (must not report success)", () => {
	function breakCodexConfigToml(): void {
		mkdirSync(join(tmp, ".codex", "config.toml"), { recursive: true });
	}

	// test-contract: invariant — Grok 2026-08-28 issue 5: a `"refused"`
	// feature-flag write (duplicate [features] tables → Codex rejects the whole
	// TOML, no hook fires) is an install FAILURE, and the poisoned file is left
	// for the human to merge, not "repaired" into a still-broken shape.
	it("P0: duplicate [features] tables ⇒ ok:false and the file is untouched", () => {
		const tomlPath = join(tmp, ".codex", "config.toml");
		mkdirSync(join(tmp, ".codex"), { recursive: true });
		const poisoned = "[features]\nhooks = false\n\n[features]\nother = 1\n";
		writeFileSync(tomlPath, poisoned);
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["codex"],
			scope: "project",
		});
		expect(result.ok).toBe(false);
		expect(nonNull(result.post_install_failures[0]).reason).toContain("duplicate [features]");
		expect(readFileSync(tomlPath, "utf-8")).toBe(poisoned);
	});

	it("P1: reports ok:false and names the runner + reason", () => {
		breakCodexConfigToml();
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["codex"],
			scope: "project",
		});
		expect(result.ok).toBe(false);
		expect(result.post_install_failures.length).toBe(1);
		expect(nonNull(result.post_install_failures[0]).runner).toBe("codex");
		expect(nonNull(result.post_install_failures[0]).reason.length).toBeGreaterThan(0);
	});

	it("P2: marks the entry post_install: failed and records the error", () => {
		breakCodexConfigToml();
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["codex"],
			scope: "project",
		});
		expect(nonNull(result.entries[0]).post_install).toBe("failed");
		expect(nonNull(result.entries[0]).post_install_error).toBeDefined();
	});

	it("P3: the failure survives into the manifest a later run reads", () => {
		breakCodexConfigToml();
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["codex"],
			scope: "project",
		});
		const manifest = readManifest(manifestPath(tmp));
		expect(nonNull(manifest[0]).post_install).toBe("failed");
	});

	it("P4: the settings fragment that DID land is still recorded (uninstall needs it)", () => {
		breakCodexConfigToml();
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["codex"],
			scope: "project",
		});
		expect(result.entries.length).toBe(1);
		expect(nonNull(result.entries[0]).added_paths.length).toBeGreaterThan(0);
		const hooks = JSON.parse(readFileSync(join(tmp, ".codex", "hooks.json"), "utf-8")) as {
			hooks: Record<string, unknown[]>;
		};
		expect(Array.isArray(hooks.hooks.PreToolUse)).toBe(true);
	});

	it("N1: a healthy Codex install reports ok:true with no failures", () => {
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["codex"],
			scope: "project",
		});
		expect(result.ok).toBe(true);
		expect(result.post_install_failures).toEqual([]);
		expect(nonNull(result.entries[0]).post_install).toBe("ok");
		expect(nonNull(result.entries[0]).post_install_error).toBeUndefined();
	});

	it("N2: an adapter with no postInstall at all is 'ok', never 'failed'", () => {
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["claude-code"],
			scope: "project",
		});
		expect(result.ok).toBe(true);
		expect(nonNull(result.entries[0]).post_install).toBe("ok");
	});

	it("N3: a broken Codex does not drag a healthy sibling runner's entry down", () => {
		breakCodexConfigToml();
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["claude-code", "codex"],
			scope: "project",
		});
		// The overall result is not ok, but per-entry accounting stays honest.
		expect(result.ok).toBe(false);
		const claude = result.entries.find((e) => e.runner === "claude-code");
		expect(nonNull(claude).post_install).toBe("ok");
	});

	it("N4: a manifest written before the field existed reads as 'ok', not 'failed'", () => {
		// Inventing a failure for every historical entry would make every
		// pre-existing install look broken.
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			manifestPath(tmp),
			JSON.stringify({
				schema_version: "1",
				entries: [
					{
						runner: "codex",
						scope: "project",
						settings_path: join(tmp, ".codex", "hooks.json"),
						added_paths: ["hooks.PreToolUse[0]"],
						binary_path: "/usr/bin/interlinked-hook",
						installed_at: "2026-04-23T00:00:00.000Z",
						schema_version: "1",
					},
				],
			}),
		);
		expect(nonNull(readManifest(manifestPath(tmp))[0]).post_install).toBe("ok");
	});
});
