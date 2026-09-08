import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionLiveness } from "../lib/collection/liveness.js";
import { writeGuardDisable } from "../lib/guard-state.js";
import { HOOK_SCRIPT_VERSION } from "../lib/hooks.js";
import { installHooks } from "../harness/installer.js";
import {
	authTokenCheck,
	clientHookChecks,
	collectionLivenessCheck,
	harnessChecks,
	hookVersionChecks,
	legacyConfigCheck,
	localFileChecks,
	metricCapsConfigCheck,
	permissionRuleChecks,
	sessionFileChecks,
} from "./doctor-checks.js";

describe("metricCapsConfigCheck", () => {
	it("warns when max_function_tokens is outside the fixed integer range", () => {
		const dir = mkdtempSync(join(tmpdir(), "doctor-metric-caps-"));
		try {
			mkdirSync(join(dir, ".interlinked"));
			writeFileSync(
				join(dir, ".interlinked", "metric-caps.json"),
				JSON.stringify({ version: 1, max_function_tokens: 512 }),
			);
			const result = metricCapsConfigCheck(dir);
			expect(result.status).toBe("warn");
			expect(result.message).toContain("1 through 500");
			expect(result.message).toContain("using 500");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

vi.mock("./harness.js", () => ({
	isHarnessRunning: vi.fn().mockReturnValue({ running: false }),
}));

describe("collectionLivenessCheck", () => {
	it("returns a pass row for 'live' status", () => {
		const live: CollectionLiveness = {
			status: "live",
			path: "/tmp/collection.jsonl",
			exists: true,
			sizeBytes: 1024,
			mtimeMs: 1_700_000_000_000,
			lastRecordTs: "2026-08-06T00:00:00.000Z",
			lastRecordAgeMs: 1_000,
			reason: "recent event",
		};
		expect(collectionLivenessCheck(live)).toEqual({
			status: "pass",
			message: "collection.jsonl flowing -- recent event",
		});
	});

	it("returns a pass row for 'idle' status", () => {
		const live: CollectionLiveness = {
			status: "idle",
			path: "/tmp/collection.jsonl",
			exists: true,
			sizeBytes: 1024,
			mtimeMs: 1_700_000_000_000,
			lastRecordTs: "2026-08-06T00:00:00.000Z",
			lastRecordAgeMs: 6 * 60_000,
			reason: "no recent tool use",
		};
		expect(collectionLivenessCheck(live)).toEqual({
			status: "pass",
			message: "collection.jsonl -- no recent tool use",
		});
	});

	it("returns a warn row for 'stale' status", () => {
		const live: CollectionLiveness = {
			status: "stale",
			path: "/tmp/collection.jsonl",
			exists: true,
			sizeBytes: 1024,
			mtimeMs: 1_700_000_000_000,
			lastRecordTs: "2026-08-05T00:00:00.000Z",
			lastRecordAgeMs: 60 * 60_000,
			reason: "no writes in 1h",
		};
		expect(collectionLivenessCheck(live)).toEqual({
			status: "warn",
			message:
				"collection.jsonl STALE -- no writes in 1h. Check 'interlinked harness status' + hook wiring ('interlinked enable').",
		});
	});

	it("returns a warn row for 'missing' status", () => {
		const live: CollectionLiveness = {
			status: "missing",
			path: "/tmp/collection.jsonl",
			exists: false,
			sizeBytes: 0,
			mtimeMs: null,
			lastRecordTs: null,
			lastRecordAgeMs: null,
			reason: "not found",
		};
		expect(collectionLivenessCheck(live)).toEqual({
			status: "warn",
			message: "No collection.jsonl yet -- start the daemon and run 'interlinked enable' to begin recording.",
		});
	});

	it("returns a warn row for 'empty' status", () => {
		const live: CollectionLiveness = {
			status: "empty",
			path: "/tmp/collection.jsonl",
			exists: true,
			sizeBytes: 0,
			mtimeMs: 1_700_000_000_000,
			lastRecordTs: null,
			lastRecordAgeMs: null,
			reason: "zero bytes",
		};
		expect(collectionLivenessCheck(live)).toEqual({
			status: "warn",
			message: "collection.jsonl is empty -- no tool events recorded yet.",
		});
	});

	it("returns a warn row for an unreadable collection", () => {
		const live: CollectionLiveness = {
			status: "unreadable", reason: "bad json", path: "/tmp/collection.jsonl", exists: true,
			sizeBytes: 1024, mtimeMs: null, lastRecordTs: null, lastRecordAgeMs: null,
		};
		expect(collectionLivenessCheck(live)).toEqual({
			status: "warn",
			message: "collection.jsonl unreadable -- bad json",
		});
	});
});

describe("harnessChecks — guard stand-down row", () => {
	let dir: string;
	let configDir: string;

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "doctor-checks-")));
		configDir = join(dir, ".interlinked");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("omits the Guard stand-down row when the guard is not disabled", () => {
		const rows = harnessChecks(dir, configDir);
		expect(rows).toEqual([
			{
				name: "Node.js runtime",
				status: "pass",
				message: `${process.version} (${process.execPath})`,
			},
			{
				name: "Harness server",
				status: "warn",
				message:
					"Not running -- guard evaluation uses inline fallback (5 checks vs 20+). Start: 'interlinked harness start'",
			},
			{
				name: "Guard rules",
				status: "warn",
				message: "guard-rules.json not found -- harness uses built-in rules only",
			},
		]);
	});

	it("adds a warn row with by/reason/team scope when disabled by a named team marker", () => {
		writeGuardDisable(
			configDir,
			{ by: "qcody", reason: "incident response", now: "2026-01-01T00:00:00Z" },
			true,
		);
		const rows = harnessChecks(dir, configDir);
		const row = rows.find((r) => r.name === "Guard stand-down");
		expect(row).toEqual({
			name: "Guard stand-down",
			status: "warn",
			message:
				'Harness STOOD DOWN here (committed/team by qcody) — "incident response". Re-arm with \'interlinked enable\'',
		});
	});

	it("adds a warn row with no by/reason suffix and personal scope for a bare local marker", () => {
		writeGuardDisable(configDir, { now: "2026-01-01T00:00:00Z" }, false);
		const rows = harnessChecks(dir, configDir);
		const row = rows.find((r) => r.name === "Guard stand-down");
		expect(row).toEqual({
			name: "Guard stand-down",
			status: "warn",
			message: "Harness STOOD DOWN here (personal). Re-arm with 'interlinked enable'",
		});
	});
});

describe("localFileChecks", () => {
	let dir: string;

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "doctor-local-files-")));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports every missing local artifact without adding phantom rows", () => {
		expect(localFileChecks(dir, {})).toEqual([
			{
				name: "Config directory",
				status: "fail",
				message: ".interlinked/ not found -- run 'interlinked enable'",
				fixable: false,
			},
			{
				name: "Shared config",
				status: "fail",
				message: "config.json not found -- run 'interlinked enable'",
			},
			{
				name: "Local config",
				status: "warn",
				message: "config.local.json not found -- run 'interlinked login' or 'interlinked register'",
			},
			{
				name: "Hook script",
				status: "warn",
				message: "Hook script not found -- run 'interlinked enable' to install",
			},
		]);
	});

	it("does not warn about identity when a named local agent is configured", () => {
		mkdirSync(join(dir, ".interlinked", "hooks"), { recursive: true });
		mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "config.json"), "{}\n");
		writeFileSync(join(dir, ".interlinked", "config.local.json"), "{}\n");
		writeFileSync(join(dir, ".claude", "hooks", "interlinked-activity.mjs"), "hook\n");

		expect(localFileChecks(dir, { agent_name: "luna" })).toEqual([
			{ name: "Config directory", status: "pass", message: ".interlinked/ exists" },
			{ name: "Shared config", status: "pass", message: "config.json exists" },
			{ name: "Local config", status: "pass", message: "config.local.json exists" },
			{ name: "Hook script", status: "pass", message: "interlinked-activity.mjs present" },
		]);
	});
});

describe("hookVersionChecks", () => {
	let dir: string;

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "doctor-hook-version-")));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeHook(version: string): void {
		const hookDir = join(dir, ".interlinked", "hooks");
		mkdirSync(hookDir, { recursive: true });
		writeFileSync(join(hookDir, "interlinked-activity.mjs"), `// interlinked-hook-version:${version}\n`);
	}

	it("returns no check when the hook has not been installed", () => {
		expect(hookVersionChecks(dir, false)).toEqual([]);
	});

	it("accepts a version stamp with no whitespace after its delimiter", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "config.json"), JSON.stringify({ mode: "budget" }));
		writeHook(`${HOOK_SCRIPT_VERSION}+mode-budget`);

		expect(hookVersionChecks(dir, false)).toEqual([
			{
				name: "Hook version",
				status: "pass",
				message: `v${HOOK_SCRIPT_VERSION}+mode-budget (current)`,
			},
		]);
	});

	it("reports fix metadata for a missing version stamp", () => {
		const hookDir = join(dir, ".interlinked", "hooks");
		mkdirSync(hookDir, { recursive: true });
		writeFileSync(join(hookDir, "interlinked-activity.mjs"), "// no stamp\n");

		const [row] = hookVersionChecks(dir, false);
		expect(row).toMatchObject({
			name: "Hook version",
			status: "warn",
			fixable: true,
			fixAction: "regenerate",
		});
	});

	it("does not regenerate an already-current hook when --fix is used", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "config.json"), JSON.stringify({ mode: "budget" }));
		const current = `${HOOK_SCRIPT_VERSION}+mode-budget`;
		writeHook(current);

		expect(hookVersionChecks(dir, true)).toEqual([
			{ name: "Hook version", status: "pass", message: `v${current} (current)` },
		]);
		expect(readFileSync(join(dir, ".interlinked", "hooks", "interlinked-activity.mjs"), "utf-8")).toContain(
			`interlinked-hook-version:${current}`,
		);
	});
});

describe("clientHookChecks", () => {
	let dir: string;

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "doctor-client-hooks-")));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns no rows when no supported client directory exists", () => {
		expect(clientHookChecks(dir)).toEqual([]);
	});

	// The predecessor of these cases wrote the hook command into
	// `.codex/config.toml` and expected a pass — it pinned the DEFECT. Codex
	// reads hook commands from `.codex/hooks.json`; config.toml only carries
	// the `[features] hooks = true` gate. Against a real install (hooks.json
	// present, no command in config.toml) doctor therefore warned that hooks
	// were missing and told the user to re-run `enable`, which could not
	// change the outcome — the same false-negative class as audit F3, one
	// layer over.
	it("P: recognizes the hook command in .codex/hooks.json (the real location)", () => {
		mkdirSync(join(dir, ".codex"), { recursive: true });
		writeFileSync(join(dir, ".codex", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" }] }] } }));
		writeFileSync(join(dir, ".codex", "config.toml"), "[features]\nhooks = true\n");

		expect(clientHookChecks(dir)).toEqual([
			{ name: "OpenAI Codex CLI hooks", status: "pass", message: "Hooks installed" },
			{ name: "OpenAI Codex CLI feature flag", status: "pass", message: "[features] hooks = true" },
			{
				name: "OpenAI Codex CLI hook execution",
				status: "warn",
				message:
					"No verified execution for current hooks.json -- open /hooks in Codex, review the definition, then run any hooked action",
			},
		]);
	});

	it("N: a hook command in config.toml alone is NOT an install (hooks.json is the contract)", () => {
		mkdirSync(join(dir, ".codex"), { recursive: true });
		writeFileSync(join(dir, ".codex", "config.toml"), "notify = 'interlinked-activity'\n");

		const rows = clientHookChecks(dir);
		expect(rows[0]).toEqual({
			name: "OpenAI Codex CLI hooks",
			status: "warn",
			message: "hooks.json not found",
		});
	});

	it("N: installed hooks with the feature flag off are named as inert, not as missing", () => {
		mkdirSync(join(dir, ".codex"), { recursive: true });
		writeFileSync(join(dir, ".codex", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" }] }] } }));
		writeFileSync(join(dir, ".codex", "config.toml"), "[features]\nhooks = false\n");

		const rows = clientHookChecks(dir);
		expect(rows[0]?.status).toBe("pass");
		expect(rows[1]?.status).toBe("warn");
		expect(rows[1]?.message).toContain("never fire");
	});

	it("P: covers every registry client, not a hardcoded three", () => {
		for (const d of [".claude", ".gemini", ".cursor", join(".github", "hooks")]) {
			mkdirSync(join(dir, d), { recursive: true });
		}
		const names = clientHookChecks(dir).map((r) => r.name);
		expect(names).toContain("Claude Code hooks");
		expect(names).toContain("Google Gemini CLI hooks");
		expect(names).toContain("Cursor IDE hooks");
		expect(names).toContain("GitHub Copilot CLI hooks");
	});

	// -----------------------------------------------------------------------
	// Installer ↔ doctor agreement (audit F3). The check used to grep for the
	// literal "interlinked-activity", which `enable`'s hook commands never
	// contain — a confirmed false-negative on a correct install, telling the
	// user to re-run a command that could not change the outcome. Driving the
	// REAL installer is the only way to keep the two from drifting again.
	// -----------------------------------------------------------------------

	// P: settings written by the canonical adapter installer are detected.
	it("detects hooks in a settings file written by the real Claude installer", () => {
		const hookScript = join(dir, "dist", "hook-entry.js");
		mkdirSync(join(dir, "dist"), { recursive: true });
		writeFileSync(hookScript, "// hook entry\n");
		const installed = installHooks({
			cwd: dir,
			binaryPath: hookScript,
			runners: ["claude-code"],
			scope: "project",
		});
		expect(installed.ok).toBe(true);

		const settings = readFileSync(join(dir, ".claude", "settings.json"), "utf-8");
		// The literal the old check looked for is genuinely absent; ownership
		// comes from the adapter's runner/event arguments instead.
		expect(settings).not.toContain("interlinked-activity");
		expect(settings).toContain("hook-entry.js");
		expect(clientHookChecks(dir)).toEqual([
			{ name: "Claude Code hooks", status: "pass", message: "Hooks installed" },
		]);
	});

	// P: the legacy generated `.mjs` hook is still recognized (the marker the
	// old check used remains one of several, not the only one).
	it("still detects the legacy interlinked-activity.mjs hook command", () => {
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(
			join(dir, ".claude", "settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{ hooks: [{ command: 'node ".interlinked/hooks/interlinked-activity.mjs"' }] },
					],
				},
			}),
		);
		expect(clientHookChecks(dir)).toEqual([
			{ name: "Claude Code hooks", status: "pass", message: "Hooks installed" },
		]);
	});

	// N: a settings file with someone else's hooks must still warn — the fix
	// must not turn the check into "a settings file exists".
	it("warns when the settings file has hooks but none are Interlinked's", () => {
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(
			join(dir, ".claude", "settings.json"),
			JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "node other-tool.js" }] }] } }),
		);
		expect(clientHookChecks(dir)).toEqual([
			{
				name: "Claude Code hooks",
				status: "warn",
				message: "Settings file exists but no Interlinked CLI hooks -- run 'interlinked enable'",
			},
		]);
	});
});

describe("permissionRuleChecks", () => {
	let dir: string;

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "doctor-permission-rules-")));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeSettings(rule: string): string {
		const settingsPath = join(dir, ".claude", "settings.json");
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [rule] } }));
		return settingsPath;
	}

	it("returns no rows when there are no settings files to inspect", () => {
		expect(permissionRuleChecks(dir, false)).toEqual([]);
	});

	it("reports a short malformed rule without an ellipsis and with fix metadata", () => {
		writeSettings("Bash(");

		const [row] = permissionRuleChecks(dir, false);
		expect(row).toEqual({
			name: "Permission rules (.claude/settings.json)",
			status: "warn",
			message:
				'1 malformed rule(s) -- e.g. "Bash(". Run \'interlinked doctor --fix\' to strip.',
			fixable: true,
			fixAction: "strip-permission-rules",
		});
	});

	it("marks exactly 60 characters with an ellipsis", () => {
		const rule = `Bash(${"x".repeat(55)}`;
		expect(rule).toHaveLength(60);
		writeSettings(rule);

		expect(permissionRuleChecks(dir, false)[0]?.message).toContain(`e.g. ${JSON.stringify(rule)}...`);
	});

	it("strips malformed rules when --fix is used", () => {
		const settingsPath = writeSettings("Bash(");

		expect(permissionRuleChecks(dir, true)).toEqual([
			{
				name: "Permission rules (.claude/settings.json)",
				status: "pass",
				message: "Stripped 1 malformed rule(s) from .claude/settings.json",
			},
		]);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ permissions: { allow: [] } });
	});
});

describe("authTokenCheck", () => {
	it("returns the complete pass row when a token is present", () => {
		expect(authTokenCheck("token", false)).toEqual({
			name: "Auth token",
			status: "pass",
			message: "Token available",
		});
	});
});

describe("legacyConfigCheck", () => {
	let dir: string;

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "doctor-legacy-config-")));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns no rows when the legacy file is absent", () => {
		expect(legacyConfigCheck(dir, false)).toEqual([]);
	});

	it("reports a successful migration when --fix is used", () => {
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(
			join(dir, ".claude", "interlinked-session.json"),
			JSON.stringify({ server_url: "https://example.test", agent_name: "luna" }),
		);

		expect(legacyConfigCheck(dir, true)).toEqual([
			{
				name: "Legacy config",
				status: "pass",
				message: "Migrated .claude/interlinked-session.json to .interlinked/",
			},
		]);
	});
});

describe("sessionFileChecks", () => {
	let dir: string;

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "doctor-session-files-")));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns no rows when neither session directory exists", () => {
		expect(sessionFileChecks(dir)).toEqual([]);
	});

	it("keeps a recently touched session active", () => {
		const sessionsDir = join(dir, ".interlinked", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const sessionPath = join(sessionsDir, "active.json");
		writeFileSync(sessionPath, "{}\n");
		const recent = new Date(Date.now() - 5_000);
		utimesSync(sessionPath, recent, recent);

		expect(sessionFileChecks(dir)).toEqual([
			{ name: "Session files", status: "pass", message: "1 active session file(s)" },
		]);
	});

	it("reports stale sessions with the cleanup action", () => {
		const sessionsDir = join(dir, ".interlinked", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const sessionPath = join(sessionsDir, "old.json");
		writeFileSync(sessionPath, "{}\n");
		const old = new Date(Date.now() - 26 * 60 * 60 * 1_000);
		utimesSync(sessionPath, old, old);

		expect(sessionFileChecks(dir)).toEqual([
			{
				name: "Session files",
				status: "warn",
				message: "1 stale session file(s) in .interlinked/sessions -- run 'interlinked clean'",
				fixable: true,
				fixAction: "clean",
			},
		]);
	});

	it("treats a file exactly at the 24-hour threshold as active", () => {
		const now = 1_900_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const sessionsDir = join(dir, ".interlinked", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const sessionPath = join(sessionsDir, "boundary.json");
		writeFileSync(sessionPath, "{}\n");
		const boundary = new Date(now - 24 * 60 * 60 * 1_000);
		utimesSync(sessionPath, boundary, boundary);

		expect(sessionFileChecks(dir)).toEqual([
			{ name: "Session files", status: "pass", message: "1 active session file(s)" },
		]);
	});
});
