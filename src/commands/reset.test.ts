// ===========================================
// interlinked reset — behavioral coverage
// ===========================================
// Deep behavioral tests for resetCommand. Mocks the module boundaries
// (node:fs, ../lib/formatter, ../harness/installer) so every branch is
// driven deterministically with no real filesystem, network, or wall-clock
// time. Asserts real output strings, file/config removal side-effects, and
// exit codes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- node:fs mock -------------------------------------------------------
// A virtual filesystem: `existing` is the set of paths existsSync() reports
// true for; `files` maps path -> string content for readFileSync(); `rmThrows`
// / `writeThrows` let individual ops throw to exercise catch branches.
interface VFS {
	existing: Set<string>;
	files: Record<string, string>;
	rmThrows: Map<string, unknown>; // path -> thrown value
	writeThrows: Map<string, unknown>;
}

let vfs: VFS;

function freshVfs(): VFS {
	return { existing: new Set(), files: {}, rmThrows: new Map(), writeThrows: new Map() };
}

const removedPaths: Array<{ path: string; opts?: unknown }> = [];
const written: Array<{ path: string; data: string }> = [];

vi.mock("node:fs", () => ({
	existsSync: (p: string) => vfs.existing.has(p),
	readFileSync: (p: string) => {
		const content = vfs.files[p];
		if (content === undefined) throw new Error(`ENOENT read ${p}`);
		return content;
	},
	rmSync: (p: string, opts?: unknown) => {
		if (vfs.rmThrows.has(p)) throw vfs.rmThrows.get(p);
		removedPaths.push({ path: p, opts });
	},
	writeFileSync: (p: string, data: string) => {
		if (vfs.writeThrows.has(p)) throw vfs.writeThrows.get(p);
		written.push({ path: p, data });
	},
}));

// ---- formatter mock: identity colors so output strings are plain --------
// Wrap so we can still distinguish red() output where the command relies on
// it; here identity keeps assertions on literal text.
vi.mock("../lib/formatter.js", () => ({
	c: {
		bold: (s: string) => s,
		dim: (s: string) => s,
		green: (s: string) => s,
		red: (s: string) => s,
		yellow: (s: string) => s,
	},
	divider: () => "----DIVIDER----",
	header: (t: string) => `== ${t} ==`,
}));

// ---- installer manifest mock ---------------------------------------------
// removeManifestArtifacts() consumes readManifestState/manifestPath/
// uninstallHooks as a unit; the real manifest format lives one module away
// (installer-manifest.ts, installer-purge.ts) and is exercised by ITS OWN
// tests, so here the module boundary is mocked directly rather than driving
// it indirectly through fake manifest JSON on the fs mock above. Defaults
// mirror the pre-mock behavior (no manifest file on disk -> "missing").
type MockManifestState =
	| { kind: "missing" }
	| { kind: "corrupt"; reason: string }
	| { kind: "valid"; entries: unknown[] };
interface MockUninstallEntry {
	runner: string;
	settings_path: string;
}
let manifestState: MockManifestState = { kind: "missing" };
let uninstallResult: { removed: MockUninstallEntry[]; remaining: MockUninstallEntry[] } = {
	removed: [],
	remaining: [],
};

vi.mock("../harness/installer.js", () => ({
	manifestPath: (cwd: string) => `${cwd}/.interlinked/installer-manifest.json`,
	readManifestState: () => manifestState,
	uninstallHooks: () => uninstallResult,
}));

import { nonNull } from "../lib/non-null.js";
import { resetCommand } from "./reset.js";

// Canonical absolute paths the command derives from cwd="/repo".
const CONFIG_DIR = "/repo/.interlinked";
const LEGACY_CONFIG = "/repo/.claude/interlinked-session.json";
const LEGACY_HOOK = "/repo/.claude/hooks/interlinked-activity.mjs";
const CLAUDE_SETTINGS = "/repo/.claude/settings.json";
const GEMINI_SETTINGS = "/repo/.gemini/settings.json";
const CODEX_CONFIG = "/repo/.codex/config.toml";

let logs: string[];
let errs: string[];

function lastJson(): Record<string, unknown> {
	return JSON.parse(logs.at(-1) as string) as Record<string, unknown>;
}
function allOut(): string {
	return logs.join("\n");
}
function allErr(): string {
	return errs.join("\n");
}

beforeEach(() => {
	vfs = freshVfs();
	removedPaths.length = 0;
	written.length = 0;
	logs = [];
	errs = [];
	manifestState = { kind: "missing" };
	uninstallResult = { removed: [], remaining: [] };
	process.exitCode = undefined;
	vi.spyOn(process, "cwd").mockReturnValue("/repo");
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		errs.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
	});
});

afterEach(() => {
	process.exitCode = undefined;
	vi.restoreAllMocks();
});

// ===========================================
// Confirmation gate — no --force
// ===========================================

describe("reset — confirmation gate (no --force)", () => {
	it("normal mode: prints the warning + confirm hint, removes nothing, no exit code", async () => {
		await resetCommand({});
		const out = allOut();
		expect(out).toContain("This will remove ALL Interlinked CLI local state.");
		expect(out).toContain("    - .interlinked/ directory (config, hooks, sessions)");
		expect(out).toContain("    - Hook entries from client settings (.claude, .github/hooks)");
		expect(out).toContain("Run with --force to confirm:");
		expect(out).toContain("  interlinked reset --force");
		// pure preview: no filesystem mutation, no summary, no header
		expect(removedPaths).toEqual([]);
		expect(written).toEqual([]);
		expect(out).not.toContain("== Resetting Interlinked CLI ==");
		expect(process.exitCode).toBeUndefined();
	});

	it("json mode: emits a structured error payload and sets exitCode=1", async () => {
		await resetCommand({ json: true });
		// exactly one console.log (the JSON), nothing else
		expect(logs).toHaveLength(1);
		const payload = lastJson();
		expect(payload).toEqual({
			ok: false,
			error: "--force is required",
			usage: "interlinked reset --force",
		});
		expect(process.exitCode).toBe(1);
		expect(removedPaths).toEqual([]);
	});

	it("json mode does NOT print the human warning text", async () => {
		await resetCommand({ json: true });
		expect(allOut()).not.toContain("This will remove ALL");
	});
});

// ===========================================
// --force, empty tree — nothing present
// ===========================================

describe("reset --force — nothing present", () => {
	it("normal mode: header + .interlinked skip line + 'already clean' summary, no exit code", async () => {
		await resetCommand({ force: true });
		const out = allOut();
		expect(out).toContain("== Resetting Interlinked CLI ==");
		expect(out).toContain("skip    .interlinked/ (not found)");
		expect(out).toContain("----DIVIDER----");
		expect(out).toContain("Nothing to remove. Already clean.");
		expect(out).not.toContain("Reset complete.");
		expect(removedPaths).toEqual([]);
		expect(written).toEqual([]);
		expect(process.exitCode).toBeUndefined();
	});

	it("json mode: ok=true, zero counts, empty arrays, no exit code", async () => {
		await resetCommand({ force: true, json: true });
		expect(logs).toHaveLength(1);
		const payload = lastJson();
		expect(payload).toEqual({
			ok: true,
			removed_count: 0,
			removed: [],
			failed_count: 0,
			failed: [],
		});
		expect(process.exitCode).toBeUndefined();
	});

	it("json mode prints no human skip/header lines", async () => {
		await resetCommand({ force: true, json: true });
		const out = allOut();
		expect(out).not.toContain("Resetting Interlinked CLI");
		expect(out).not.toContain("not found");
	});
});

// ===========================================
// 1. .interlinked/ directory
// ===========================================

describe("reset --force — .interlinked/ directory", () => {
	it("removes the dir recursively+force and records it", async () => {
		vfs.existing.add(CONFIG_DIR);
		await resetCommand({ force: true });
		expect(removedPaths).toEqual([{ path: CONFIG_DIR, opts: { recursive: true, force: true } }]);
		const out = allOut();
		expect(out).toContain("removed .interlinked/");
		expect(out).toContain("Reset complete. Removed 1 item(s).");
		expect(out).toContain("Run 'interlinked enable' to set up again.");
		expect(process.exitCode).toBeUndefined();
	});

	it("json mode lists it in `removed`", async () => {
		vfs.existing.add(CONFIG_DIR);
		await resetCommand({ force: true, json: true });
		const payload = lastJson();
		expect(payload.removed).toEqual([".interlinked/"]);
		expect(payload.removed_count).toBe(1);
		expect(payload.ok).toBe(true);
	});

	it("rmSync throwing an Error: records failure, prints to stderr, exitCode=1", async () => {
		vfs.existing.add(CONFIG_DIR);
		vfs.rmThrows.set(CONFIG_DIR, new Error("EACCES rmdir"));
		await resetCommand({ force: true });
		// nothing recorded as removed
		expect(removedPaths).toEqual([]);
		expect(allErr()).toContain("failed .interlinked/: EACCES rmdir");
		const out = allOut();
		expect(out).toContain("Nothing to remove. Already clean.");
		expect(process.exitCode).toBe(1);
	});

	it("rmSync throwing a non-Error (string): String(e) used in failed[], e in stderr", async () => {
		vfs.existing.add(CONFIG_DIR);
		vfs.rmThrows.set(CONFIG_DIR, "boom-string");
		await resetCommand({ force: true, json: true });
		const payload = lastJson();
		expect(payload.failed).toEqual([".interlinked/: boom-string"]);
		expect(payload.failed_count).toBe(1);
		expect(payload.ok).toBe(false);
		expect(payload.removed_count).toBe(0);
		expect(process.exitCode).toBe(1);
	});

	it("non-Error throw in normal mode: stderr renders the raw value (e branch of ternary)", async () => {
		vfs.existing.add(CONFIG_DIR);
		vfs.rmThrows.set(CONFIG_DIR, "raw-val");
		await resetCommand({ force: true });
		expect(allErr()).toContain("failed .interlinked/: raw-val");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// 2. Legacy session config
// ===========================================

describe("reset --force — legacy .claude/interlinked-session.json", () => {
	it("removes it (no rm options) and records the relative path", async () => {
		vfs.existing.add(LEGACY_CONFIG);
		await resetCommand({ force: true, json: true });
		expect(removedPaths).toEqual([{ path: LEGACY_CONFIG, opts: undefined }]);
		const payload = lastJson();
		expect(payload.removed).toEqual([".claude/interlinked-session.json"]);
	});

	it("normal-mode removal line", async () => {
		vfs.existing.add(LEGACY_CONFIG);
		await resetCommand({ force: true });
		expect(allOut()).toContain("removed .claude/interlinked-session.json");
	});

	it("rmSync Error -> failed[] + stderr + exitCode=1", async () => {
		vfs.existing.add(LEGACY_CONFIG);
		vfs.rmThrows.set(LEGACY_CONFIG, new Error("locked"));
		await resetCommand({ force: true, json: true });
		expect((lastJson().failed as string[])[0]).toBe(".claude/interlinked-session.json: locked");
		expect(process.exitCode).toBe(1);
	});

	it("rmSync non-Error -> stderr uses raw value", async () => {
		vfs.existing.add(LEGACY_CONFIG);
		vfs.rmThrows.set(LEGACY_CONFIG, 42);
		await resetCommand({ force: true });
		expect(allErr()).toContain(".claude/interlinked-session.json: 42");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// 3. Legacy hook script
// ===========================================

describe("reset --force — legacy .claude/hooks/interlinked-activity.mjs", () => {
	it("removes it and records relative path", async () => {
		vfs.existing.add(LEGACY_HOOK);
		await resetCommand({ force: true, json: true });
		expect(removedPaths).toEqual([{ path: LEGACY_HOOK, opts: undefined }]);
		expect(lastJson().removed).toEqual([".claude/hooks/interlinked-activity.mjs"]);
	});

	it("normal-mode removal line", async () => {
		vfs.existing.add(LEGACY_HOOK);
		await resetCommand({ force: true });
		expect(allOut()).toContain("removed .claude/hooks/interlinked-activity.mjs");
	});

	it("rmSync Error -> failed[] + stderr + exitCode=1", async () => {
		vfs.existing.add(LEGACY_HOOK);
		vfs.rmThrows.set(LEGACY_HOOK, new Error("denied"));
		await resetCommand({ force: true, json: true });
		expect((lastJson().failed as string[])[0]).toBe(
			".claude/hooks/interlinked-activity.mjs: denied",
		);
		expect(process.exitCode).toBe(1);
	});

	it("rmSync non-Error -> stderr uses raw value", async () => {
		vfs.existing.add(LEGACY_HOOK);
		vfs.rmThrows.set(LEGACY_HOOK, { code: "X" });
		await resetCommand({ force: true });
		expect(allErr()).toContain(".claude/hooks/interlinked-activity.mjs: [object Object]");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// 4. Claude Code settings.json
// ===========================================

describe("reset --force — Claude Code settings.json hook cleanup", () => {
	it("filters interlinked hooks, keeps others, records cleaned entry", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		const settings = {
			hooks: {
				PreToolUse: [
					{ hooks: [{ command: "node x/interlinked-activity.mjs" }] },
					{ hooks: [{ command: "node other.mjs" }] },
				],
			},
			otherKey: 1,
		};
		vfs.files[CLAUDE_SETTINGS] = JSON.stringify(settings);
		await resetCommand({ force: true, json: true });

		expect(written).toHaveLength(1);
		const out = JSON.parse(nonNull(written[0]).data);
		expect(out.hooks.PreToolUse).toEqual([{ hooks: [{ command: "node other.mjs" }] }]);
		expect(out.otherKey).toBe(1);
		expect(nonNull(written[0]).data.endsWith("\n")).toBe(true); // trailing newline
		expect(lastJson().removed).toEqual([".claude/settings.json (hook entries)"]);
	});

	it("normal-mode cleaned line", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = JSON.stringify({
			hooks: { Stop: [{ hooks: [{ command: "interlinked-activity" }] }, { hooks: [{}] }] },
		});
		await resetCommand({ force: true });
		expect(allOut()).toContain("cleaned .claude/settings.json (removed hook entries)");
	});

	it("when ALL hook events become empty, the entire `hooks` key is deleted", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = JSON.stringify({
			hooks: { PreToolUse: [{ hooks: [{ command: "node interlinked-activity.mjs" }] }] },
			keep: true,
		});
		await resetCommand({ force: true, json: true });
		const out = JSON.parse(nonNull(written[0]).data);
		expect(out.hooks).toBeUndefined();
		expect("hooks" in out).toBe(false);
		expect(out.keep).toBe(true);
	});

	it("content WITHOUT the marker: not parsed, not written, not recorded", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "x" }] }] } });
		await resetCommand({ force: true, json: true });
		expect(written).toEqual([]);
		expect(lastJson().removed).toEqual([]);
	});

	it("marker present but no interlinked hook entry matches: changed stays false, no write", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		// marker is in a non-hook field so content.includes passes but filter removes nothing
		vfs.files[CLAUDE_SETTINGS] = JSON.stringify({
			note: "interlinked-activity ran here",
			hooks: { Stop: [{ hooks: [{ command: "node other.mjs" }] }] },
		});
		await resetCommand({ force: true, json: true });
		expect(written).toEqual([]);
		expect(lastJson().removed).toEqual([]);
	});

	it("settings has the marker but no `hooks` object: skips the loop, no write", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = JSON.stringify({ misc: "interlinked-activity" });
		await resetCommand({ force: true, json: true });
		expect(written).toEqual([]);
		expect(lastJson().removed).toEqual([]);
	});

	it("non-array hook event value is skipped (continue branch), array sibling still cleaned", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = JSON.stringify({
			hooks: {
				BadShape: { not: "an-array" },
				PreToolUse: [{ hooks: [{ command: "node interlinked-activity.mjs" }] }],
			},
		});
		await resetCommand({ force: true, json: true });
		const out = JSON.parse(nonNull(written[0]).data);
		// PreToolUse emptied -> undefined, BadShape untouched -> hooks NOT deleted
		expect(out.hooks.PreToolUse).toBeUndefined();
		expect(out.hooks.BadShape).toEqual({ not: "an-array" });
		expect(lastJson().removed).toEqual([".claude/settings.json (hook entries)"]);
	});

	it("entry whose hooks array lacks a command field: optional-chain false, kept (no removal)", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		// marker in a comment-ish field; the only hook entry has no command -> not matched
		vfs.files[CLAUDE_SETTINGS] = JSON.stringify({
			tag: "interlinked-activity",
			hooks: { Stop: [{ hooks: [{ notCommand: "x" }] }, { noHooksKey: true }] },
		});
		await resetCommand({ force: true, json: true });
		expect(written).toEqual([]);
		expect(lastJson().removed).toEqual([]);
	});

	it("invalid JSON with the marker: parse throws -> failed[] populated, swallowed (no crash)", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = "{ this is not json but mentions interlinked-activity";
		await resetCommand({ force: true, json: true });
		const payload = lastJson();
		expect((payload.failed as string[]).some((f) => f.startsWith(".claude/settings.json:"))).toBe(
			true,
		);
		expect(payload.failed_count).toBe(1);
		expect(process.exitCode).toBe(1);
		// no human stderr line for this branch (parse errors are intentionally quiet)
		expect(written).toEqual([]);
	});

	it("writeFileSync throwing is captured into failed[] (write inside try)", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = JSON.stringify({
			hooks: { PreToolUse: [{ hooks: [{ command: "node interlinked-activity.mjs" }] }] },
		});
		vfs.writeThrows.set(CLAUDE_SETTINGS, new Error("disk full"));
		await resetCommand({ force: true, json: true });
		const payload = lastJson();
		expect(payload.failed).toEqual([".claude/settings.json: disk full"]);
		expect(payload.removed).toEqual([]);
		expect(process.exitCode).toBe(1);
	});

	it("non-Error thrown inside the try: String(e) used for message (else arm of ternary)", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = JSON.stringify({
			hooks: { PreToolUse: [{ hooks: [{ command: "node interlinked-activity.mjs" }] }] },
		});
		vfs.writeThrows.set(CLAUDE_SETTINGS, "claude-nonerror"); // bare string, not an Error
		await resetCommand({ force: true, json: true });
		const payload = lastJson();
		expect(payload.failed).toEqual([".claude/settings.json: claude-nonerror"]);
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// 5. Gemini settings.json
// ===========================================

describe("reset --force — Gemini settings.json hook cleanup", () => {
	it("filters interlinked hooks and records cleaned entry", async () => {
		vfs.existing.add(GEMINI_SETTINGS);
		vfs.files[GEMINI_SETTINGS] = JSON.stringify({
			hooks: {
				PreToolUse: [
					{ hooks: [{ command: "node interlinked-activity.mjs" }] },
					{ hooks: [{ command: "node keep.mjs" }] },
				],
			},
		});
		await resetCommand({ force: true, json: true });
		const out = JSON.parse(nonNull(written[0]).data);
		expect(out.hooks.PreToolUse).toEqual([{ hooks: [{ command: "node keep.mjs" }] }]);
		expect(lastJson().removed).toEqual([".gemini/settings.json (hook entries)"]);
	});

	it("normal-mode cleaned line", async () => {
		vfs.existing.add(GEMINI_SETTINGS);
		vfs.files[GEMINI_SETTINGS] = JSON.stringify({
			hooks: { Stop: [{ hooks: [{ command: "interlinked-activity" }] }] },
		});
		await resetCommand({ force: true });
		expect(allOut()).toContain("cleaned .gemini/settings.json (removed hook entries)");
	});

	it("Gemini does NOT delete an emptied `hooks` key (no cleanup block, unlike Claude)", async () => {
		vfs.existing.add(GEMINI_SETTINGS);
		vfs.files[GEMINI_SETTINGS] = JSON.stringify({
			hooks: { PreToolUse: [{ hooks: [{ command: "node interlinked-activity.mjs" }] }] },
		});
		await resetCommand({ force: true, json: true });
		const out = JSON.parse(nonNull(written[0]).data);
		// key retained, value set to undefined -> serialized away, but `hooks` itself stays as {}
		expect(out.hooks).toEqual({});
	});

	it("content without marker: not touched", async () => {
		vfs.existing.add(GEMINI_SETTINGS);
		vfs.files[GEMINI_SETTINGS] = JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "z" }] }] } });
		await resetCommand({ force: true, json: true });
		expect(written).toEqual([]);
		expect(lastJson().removed).toEqual([]);
	});

	it("marker present, no `hooks` object: skipped, no write", async () => {
		vfs.existing.add(GEMINI_SETTINGS);
		vfs.files[GEMINI_SETTINGS] = JSON.stringify({ misc: "interlinked-activity" });
		await resetCommand({ force: true, json: true });
		expect(written).toEqual([]);
	});

	it("non-array hook value skipped (continue)", async () => {
		vfs.existing.add(GEMINI_SETTINGS);
		vfs.files[GEMINI_SETTINGS] = JSON.stringify({
			hooks: {
				Weird: 7,
				PreToolUse: [{ hooks: [{ command: "node interlinked-activity.mjs" }] }],
			},
		});
		await resetCommand({ force: true, json: true });
		const out = JSON.parse(nonNull(written[0]).data);
		expect(out.hooks.PreToolUse).toBeUndefined();
		expect(out.hooks.Weird).toBe(7);
	});

	it("invalid JSON with marker: parse throws -> failed[] + exitCode=1, swallowed", async () => {
		vfs.existing.add(GEMINI_SETTINGS);
		vfs.files[GEMINI_SETTINGS] = "not json :: interlinked-activity";
		await resetCommand({ force: true, json: true });
		const payload = lastJson();
		expect((payload.failed as string[]).some((f) => f.startsWith(".gemini/settings.json:"))).toBe(
			true,
		);
		expect(process.exitCode).toBe(1);
	});

	it("marker present but no entry matches: changed stays false, no write", async () => {
		vfs.existing.add(GEMINI_SETTINGS);
		vfs.files[GEMINI_SETTINGS] = JSON.stringify({
			tag: "interlinked-activity",
			hooks: { Stop: [{ hooks: [{ command: "node nope.mjs" }] }] },
		});
		await resetCommand({ force: true, json: true });
		expect(written).toEqual([]);
		expect(lastJson().removed).toEqual([]);
	});

	it("non-Error thrown inside the try: String(e) used for message (else arm of ternary)", async () => {
		vfs.existing.add(GEMINI_SETTINGS);
		vfs.files[GEMINI_SETTINGS] = JSON.stringify({
			hooks: { PreToolUse: [{ hooks: [{ command: "node interlinked-activity.mjs" }] }] },
		});
		vfs.writeThrows.set(GEMINI_SETTINGS, 99); // numeric non-Error
		await resetCommand({ force: true, json: true });
		expect(lastJson().failed).toEqual([".gemini/settings.json: 99"]);
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// 6. Codex config.toml
// ===========================================

describe("reset --force — Codex config.toml notify cleanup", () => {
	it("strips the interlinked notify line and records the cleaned entry", async () => {
		vfs.existing.add(CODEX_CONFIG);
		vfs.files[CODEX_CONFIG] = [
			"[features]",
			"hooks = true",
			'notify = ["node", "x/interlinked-activity.mjs"]',
			"other = 1",
		].join("\n");
		await resetCommand({ force: true, json: true });
		expect(written).toHaveLength(1);
		expect(nonNull(written[0]).data).not.toContain("notify =");
		expect(nonNull(written[0]).data).toContain("[features]");
		expect(nonNull(written[0]).data).toContain("other = 1");
		expect(lastJson().removed).toEqual([".codex/config.toml (notify entry)"]);
	});

	it("normal-mode cleaned line", async () => {
		vfs.existing.add(CODEX_CONFIG);
		vfs.files[CODEX_CONFIG] = 'notify = "interlinked-activity"\n';
		await resetCommand({ force: true });
		expect(allOut()).toContain("cleaned .codex/config.toml (removed notify entry)");
	});

	it("file has the marker but NOT as a notify line: still rewritten + recorded (includes-guard only)", async () => {
		// content.includes(marker) is true, regex matches nothing -> content unchanged but
		// still written and recorded. This pins the includes-guard / regex-noop interaction.
		vfs.existing.add(CODEX_CONFIG);
		vfs.files[CODEX_CONFIG] = "# comment mentioning interlinked-activity\nfoo = 1\n";
		await resetCommand({ force: true, json: true });
		expect(written).toHaveLength(1);
		expect(nonNull(written[0]).data).toBe("# comment mentioning interlinked-activity\nfoo = 1\n");
		expect(lastJson().removed).toEqual([".codex/config.toml (notify entry)"]);
	});

	it("no marker: untouched", async () => {
		vfs.existing.add(CODEX_CONFIG);
		vfs.files[CODEX_CONFIG] = "notify = []\n";
		await resetCommand({ force: true, json: true });
		expect(written).toEqual([]);
		expect(lastJson().removed).toEqual([]);
	});

	it("readFileSync throwing is captured into failed[] (Error branch) + exitCode=1", async () => {
		vfs.existing.add(CODEX_CONFIG);
		// no entry in vfs.files -> readFileSync throws Error
		await resetCommand({ force: true, json: true });
		const payload = lastJson();
		expect((payload.failed as string[]).some((f) => f.startsWith(".codex/config.toml:"))).toBe(true);
		expect(process.exitCode).toBe(1);
	});

	it("non-Error thrown during codex handling: String(e) recorded in failed[]", async () => {
		vfs.existing.add(CODEX_CONFIG);
		vfs.files[CODEX_CONFIG] = "notify = interlinked-activity\n";
		vfs.writeThrows.set(CODEX_CONFIG, "codex-string-error");
		await resetCommand({ force: true, json: true });
		expect((lastJson().failed as string[])[0]).toBe(".codex/config.toml: codex-string-error");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// Manifest-owned artifacts (gate before .interlinked/ removal)
// ===========================================

describe("reset --force — installer manifest state gates .interlinked/ removal", () => {
	it("corrupt manifest: records the failure and never reaches uninstallHooks", async () => {
		manifestState = { kind: "corrupt", reason: "bad json" };
		await resetCommand({ force: true, json: true });
		const payload = lastJson();
		expect(payload.failed).toEqual(["installer manifest: bad json"]);
		expect(payload.ok).toBe(false);
		expect(process.exitCode).toBe(1);
		expect(removedPaths).toEqual([]);
	});

	it("corrupt manifest, normal mode: prints the failure line to stderr", async () => {
		manifestState = { kind: "corrupt", reason: "unexpected token" };
		await resetCommand({ force: true });
		expect(allErr()).toContain("failed installer manifest: unexpected token");
		expect(process.exitCode).toBe(1);
	});

	it("valid manifest, hooks fully uninstalled: each removed entry is reported, then .interlinked/ is removed", async () => {
		vfs.existing.add(CONFIG_DIR);
		manifestState = { kind: "valid", entries: [] };
		uninstallResult = {
			removed: [{ runner: "claude", settings_path: "/repo/.claude/settings.json" }],
			remaining: [],
		};
		await resetCommand({ force: true });
		const out = allOut();
		expect(out).toContain("removed claude hook artifact");
		expect(removedPaths).toEqual([{ path: CONFIG_DIR, opts: { recursive: true, force: true } }]);
		expect(process.exitCode).toBeUndefined();
	});

	it("valid manifest, a managed provider file was modified: reports the conflict and preserves .interlinked/", async () => {
		vfs.existing.add(CONFIG_DIR);
		manifestState = { kind: "valid", entries: [] };
		uninstallResult = {
			removed: [],
			remaining: [{ runner: "gemini", settings_path: "/repo/.gemini/settings.json" }],
		};
		await resetCommand({ force: true, json: true });
		const payload = lastJson();
		expect(payload.failed).toEqual([
			"gemini managed provider file was modified; preserved /repo/.gemini/settings.json",
		]);
		expect(payload.ok).toBe(false);
		expect(process.exitCode).toBe(1);
		// preserved, not removed: rmSync never called on .interlinked/
		expect(removedPaths).toEqual([]);
	});

	it("valid manifest, a managed provider file was modified, normal mode: prints the 'kept' line", async () => {
		vfs.existing.add(CONFIG_DIR);
		manifestState = { kind: "valid", entries: [] };
		uninstallResult = {
			removed: [],
			remaining: [{ runner: "codex", settings_path: "/repo/.codex/config.toml" }],
		};
		await resetCommand({ force: true });
		expect(allOut()).toContain("kept .interlinked/ (needed to track preserved hook artifacts)");
		expect(allErr()).toContain(
			"failed codex managed provider file was modified; preserved /repo/.codex/config.toml",
		);
	});
});

// ===========================================
// Aggregation + summary across many targets
// ===========================================

describe("reset --force — combined targets and summary", () => {
	it("removes everything present and reports the aggregate count (normal mode)", async () => {
		vfs.existing.add(CONFIG_DIR);
		vfs.existing.add(LEGACY_CONFIG);
		vfs.existing.add(LEGACY_HOOK);
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = JSON.stringify({
			hooks: { PreToolUse: [{ hooks: [{ command: "node interlinked-activity.mjs" }] }] },
		});
		vfs.existing.add(GEMINI_SETTINGS);
		vfs.files[GEMINI_SETTINGS] = JSON.stringify({
			hooks: { Stop: [{ hooks: [{ command: "interlinked-activity" }] }] },
		});
		vfs.existing.add(CODEX_CONFIG);
		vfs.files[CODEX_CONFIG] = 'notify = "x/interlinked-activity.mjs"\n';

		await resetCommand({ force: true });
		const out = allOut();
		// 3 rmSync removals + 3 settings cleanups = 6 items
		expect(out).toContain("Reset complete. Removed 6 item(s).");
		expect(removedPaths.map((r) => r.path)).toEqual([CONFIG_DIR, LEGACY_CONFIG, LEGACY_HOOK]);
		expect(written.map((w) => w.path)).toEqual([CLAUDE_SETTINGS, GEMINI_SETTINGS, CODEX_CONFIG]);
		expect(process.exitCode).toBeUndefined();
	});

	it("json mode aggregates removed[] in order with ok=true", async () => {
		vfs.existing.add(CONFIG_DIR);
		vfs.existing.add(CODEX_CONFIG);
		vfs.files[CODEX_CONFIG] = 'notify = "interlinked-activity"\n';
		await resetCommand({ force: true, json: true });
		const payload = lastJson();
		expect(payload.removed).toEqual([".interlinked/", ".codex/config.toml (notify entry)"]);
		expect(payload.removed_count).toBe(2);
		expect(payload.failed_count).toBe(0);
		expect(payload.ok).toBe(true);
		expect(process.exitCode).toBeUndefined();
	});

	it("mixed success + failure: ok=false, both arrays populated, exitCode=1", async () => {
		vfs.existing.add(CONFIG_DIR); // succeeds
		vfs.existing.add(LEGACY_CONFIG); // fails
		vfs.rmThrows.set(LEGACY_CONFIG, new Error("nope"));
		await resetCommand({ force: true, json: true });
		const payload = lastJson();
		expect(payload.removed).toEqual([".interlinked/"]);
		expect(payload.failed).toEqual([".claude/interlinked-session.json: nope"]);
		expect(payload.ok).toBe(false);
		expect(payload.removed_count).toBe(1);
		expect(payload.failed_count).toBe(1);
		expect(process.exitCode).toBe(1);
	});

	it("normal mode with a removal AND a failure: prints both summary line + stderr, exitCode=1", async () => {
		vfs.existing.add(CONFIG_DIR); // succeeds -> removed.length > 0 branch
		vfs.existing.add(LEGACY_HOOK); // fails
		vfs.rmThrows.set(LEGACY_HOOK, new Error("hook-locked"));
		await resetCommand({ force: true });
		const out = allOut();
		expect(out).toContain("Reset complete. Removed 1 item(s).");
		expect(allErr()).toContain("failed .claude/hooks/interlinked-activity.mjs: hook-locked");
		expect(process.exitCode).toBe(1);
	});
});
