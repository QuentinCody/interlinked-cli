// Behavioral unit tests for the cross-client statusline installer.
//
// `node:fs` is fully mocked with an in-memory filesystem so the tests never
// touch the real disk (the production code writes into the user's real
// `~/.interlinked/`). `node:path` is left real — it's pure. The shared
// predicates (`isPlainObject` / `isNonEmptyString`) and `JSON.parse` are NOT
// mocked, so the actual branch logic of `applyStatuslineToSettings` runs.

import { isJsonObject } from "./json-types.js";
import { nonNull } from "./non-null.js";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installStatusLine, writeStatuslineScript } from "./hook-installers-statusline.js";

vi.mock("node:fs");

const mockFs = vi.mocked(fs);

// ---------------------------------------------------------------------------
// In-memory filesystem backing the mocked node:fs surface used by the module.
// Tracks file contents, directory existence, and chmod modes.
// ---------------------------------------------------------------------------
let files: Map<string, string>;
let dirs: Set<string>;
let chmods: Map<string, number>;

function seedFile(path: string, contents: string): void {
	files.set(path, contents);
	// Mark every ancestor directory as existing.
	let d = dirname(path);
	let prev = "";
	while (d && d !== prev) {
		dirs.add(d);
		prev = d;
		d = dirname(d);
	}
}

function seedDir(path: string): void {
	dirs.add(path);
}

function wireMocks(): void {
	mockFs.existsSync.mockImplementation((p) => {
		const key = String(p);
		return files.has(key) || dirs.has(key);
	});
	mockFs.readFileSync.mockImplementation((p) => {
		const key = String(p);
		if (!files.has(key)) {
			throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
		}
		return nonNull(files.get(key));
	});
	mockFs.writeFileSync.mockImplementation((p, data) => {
		seedFile(String(p), String(data));
	});
	mockFs.mkdirSync.mockImplementation((p) => {
		seedDir(String(p));
		return undefined;
	});
	mockFs.chmodSync.mockImplementation((p, mode) => {
		if (typeof mode !== "number") throw new Error("Expected numeric chmod mode");
		chmods.set(String(p), mode);
	});
}

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const HOME = "/home/tester";

beforeEach(() => {
	files = new Map();
	dirs = new Set();
	chmods = new Map();
	wireMocks();
	process.env.HOME = HOME;
	delete process.env.USERPROFILE;
});

afterEach(() => {
	vi.resetAllMocks();
	if (ORIGINAL_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = ORIGINAL_HOME;
	if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
});

const SCRIPT_PATH = join(HOME, ".interlinked", "statusline-interlinked.sh");
const CLAUDE_SETTINGS = join(HOME, ".claude", "settings.json");
// Copilot reads user settings from settings.json (config.json became
// auto-managed internal state when Copilot CLI split the two in 2026-05).
const COPILOT_CONFIG = join(HOME, ".copilot", "settings.json");

function readSettings(path: string): Record<string, unknown> {
	const value: unknown = JSON.parse(nonNull(files.get(path)));
	if (!isJsonObject(value)) throw new Error("Expected installed settings object");
	return value;
}

function readStatusLine(path: string): Record<string, unknown> {
	const value = readSettings(path).statusLine;
	if (!isJsonObject(value)) throw new Error("Expected installed statusLine object");
	return value;
}

// ===========================================
// installStatusLine — HOME / USERPROFILE resolution
// ===========================================

describe("installStatusLine — home directory resolution", () => {
	it("returns null when neither HOME nor USERPROFILE is set", () => {
		delete process.env.HOME;
		delete process.env.USERPROFILE;
		expect(installStatusLine(["claude"])).toBeNull();
		// Nothing should have been written without a home directory.
		expect(mockFs.writeFileSync).not.toHaveBeenCalled();
	});

	it("falls back to USERPROFILE when HOME is empty", () => {
		process.env.HOME = "";
		process.env.USERPROFILE = "/winhome/tester";
		const expectedScript = join("/winhome/tester", ".interlinked", "statusline-interlinked.sh");

		const result = installStatusLine(["claude"]);

		expect(result).toBe(expectedScript);
		expect(files.has(expectedScript)).toBe(true);
	});

	it("treats an empty USERPROFILE alongside empty HOME as no home", () => {
		process.env.HOME = "";
		process.env.USERPROFILE = "";
		expect(installStatusLine(["claude"])).toBeNull();
	});
});

// ===========================================
// installStatusLine — script writing + chmod
// ===========================================

describe("installStatusLine — script generation", () => {
	it("writes the statusline script to ~/.interlinked and marks it executable", () => {
		installStatusLine(["claude"]);

		expect(files.has(SCRIPT_PATH)).toBe(true);
		const script = nonNull(files.get(SCRIPT_PATH));
		expect(script.startsWith("#!/bin/bash")).toBe(true);
		// A few load-bearing anchors from the generated bash.
		expect(script).toContain("◆ interlinked");
		expect(script).toContain("statusline.snapshot");
		expect(script).toContain("read_snap");
		expect(chmods.get(SCRIPT_PATH)).toBe(0o755);
	});

	// test-contract: public-api — writeStatuslineScript is the direct writer
	// (consumed by reload.ts and statusline-snapshot.ts, not only via
	// installStatusLine); the script it emits must carry the extracted row-3
	// chain, mutation-loop row included, and be executable
	it("writeStatuslineScript emits the row-3 chain to the given path", () => {
		writeStatuslineScript("/anywhere/status.sh");
		// SAFETY: the mocked writeFileSync stored a string one line above; a
		// miss would fail the toContain assertions immediately.
		const script = nonNull(files.get("/anywhere/status.sh"));
		expect(script).toContain("⟳ mut");
		expect(script).toContain("mutation-24x7.status");
		expect(script).toContain("hardened");
		expect(mockFs.chmodSync).toHaveBeenCalledWith("/anywhere/status.sh", 0o755);
	});

	it("renders the opt-in sponsor row from sponsor.status with a freshness gate", () => {
		installStatusLine(["claude"]);
		const script = nonNull(files.get(SCRIPT_PATH));
		// Row 3 anchors: the daemon-written kv file, the visible label, and
		// the 30-minute staleness cutoff that ages a dead daemon's ad out.
		expect(script).toContain("sponsor.status");
		expect(script).toContain("♥ sponsor");
		expect(script).toContain("1800");
		expect(script).toContain('SP_EN" = "1');
	});

	it("caps the stale last-check row at 24 hours", () => {
		installStatusLine(["claude"]);
		const script = nonNull(files.get(SCRIPT_PATH));
		expect(script).toContain('"$LAST_AGE" -lt 86400');
	});

	// The generated statusline is the daemon's only idle-time heartbeat: the
	// runner re-executes it every few seconds (refreshInterval) even when no
	// tools run. Before 2026-07-28 the down-branch only ALARMED — a daemon
	// killed during idle (jetsam on a swap-pinned box) stayed dead for hours,
	// statusline red, until the next tool call fired a hook. These pins hold
	// the down-branch to its revival duty.
	// 2026-08-16: the statusline is DISPLAY-ONLY. It used to be a second,
	// unmutexed supervisor — every render raced a raw `node server.js` against
	// the hook supervisor, losers overwrote harness.pid on the way out, and the
	// stale pid made the next render spawn again (perpetual "restarting" next
	// to a healthy daemon). One daemon, ONE supervisor: the hook's.
	describe("down branch — positive (must display honestly)", () => {
		it("P1: renders the hook-supervisor down row first, alarms only past the threshold", () => {
			installStatusLine(["claude"]);
			const script = nonNull(files.get(SCRIPT_PATH));
			expect(script).toContain("REVIVE_ALARM_SECS=45");
			expect(script).toContain("harness down — hook recovery active");
			expect(script).toContain("harness offline");
		});

		it("P2: discovers the first LIVE pid across raw AND framed/session pid files", () => {
			installStatusLine(["claude"]);
			const script = nonNull(files.get(SCRIPT_PATH));
			expect(script).toContain('"$IL"/harness.pid "$IL"/harness-*.pid');
			expect(script).toContain('if ps -p "$CAND" > /dev/null 2>&1; then PID="$CAND"; break; fi');
		});
	});

	describe("down branch — negative (must never manage processes)", () => {
		it("N1: the generated script spawns no daemon (display-only contract)", () => {
			installStatusLine(["claude"]);
			const script = nonNull(files.get(SCRIPT_PATH));
			expect(script).not.toContain("REVIVE_SERVER");
			expect(script).not.toContain("REVIVE_NODE");
			expect(script).not.toContain("--expose-gc");
			expect(script).not.toContain("REVIVE_THROTTLE_SECS");
		});

		it("N2: a stale raw pid file next to a live framed pid must not read as dead", () => {
			// The pure-bash guarantee is pinned structurally: the loop prefers a
			// live candidate (break) and only falls back to the first pid file.
			installStatusLine(["claude"]);
			const script = nonNull(files.get(SCRIPT_PATH));
			const loopStart = script.indexOf('for PF in "$IL"/harness.pid');
			const loopEnd = script.indexOf("done", loopStart);
			const loop = script.slice(loopStart, loopEnd);
			expect(loop).toContain('[ -z "$PID" ] && PID="$CAND"');
			expect(loop.indexOf('[ -z "$PID" ]')).toBeLessThan(loop.indexOf("ps -p"));
		});
	});

	it("creates the ~/.interlinked directory when it does not exist", () => {
		installStatusLine(["claude"]);
		expect(mockFs.mkdirSync).toHaveBeenCalledWith(join(HOME, ".interlinked"), {
			recursive: true,
		});
	});

	it("does not recreate ~/.interlinked when it already exists", () => {
		seedDir(join(HOME, ".interlinked"));
		installStatusLine(["claude"]);
		const mkdirTargets = mockFs.mkdirSync.mock.calls.map((c) => String(c[0]));
		expect(mkdirTargets).not.toContain(join(HOME, ".interlinked"));
	});
});

// ===========================================
// installStatusLine — client routing (statuslineSettingsPath)
// ===========================================

describe("installStatusLine — client routing", () => {
	it("configures Claude via ~/.claude/settings.json", () => {
		const result = installStatusLine(["claude"]);
		expect(result).toBe(SCRIPT_PATH);
		const settings = readSettings(CLAUDE_SETTINGS);
		expect(settings.statusLine).toEqual({
			type: "command",
			command: SCRIPT_PATH,
			refreshInterval: 5,
		});
	});

	it("configures Copilot via ~/.copilot/settings.json", () => {
		const result = installStatusLine(["copilot"]);
		expect(result).toBe(SCRIPT_PATH);
		const cfg = readSettings(COPILOT_CONFIG);
		expect(cfg.statusLine).toEqual({
			type: "command",
			command: SCRIPT_PATH,
			refreshInterval: 5,
		});
	});

	it("skips unsupported clients (settings path is null) and returns null when none configured", () => {
		// gemini/codex/cursor have no statusline settings path → continue.
		const result = installStatusLine(["gemini", "codex", "cursor"]);
		expect(result).toBeNull();
		// Script is still written even when no client gets configured.
		expect(files.has(SCRIPT_PATH)).toBe(true);
		// No client settings file was created.
		expect(files.has(CLAUDE_SETTINGS)).toBe(false);
		expect(files.has(COPILOT_CONFIG)).toBe(false);
	});

	it("configures multiple clients in one call and OR-folds the configured flag", () => {
		const result = installStatusLine(["claude", "copilot"]);
		expect(result).toBe(SCRIPT_PATH);
		expect(files.has(CLAUDE_SETTINGS)).toBe(true);
		expect(files.has(COPILOT_CONFIG)).toBe(true);
	});

	it("returns the script path when at least one of mixed clients configures (OR-fold true||false)", () => {
		// claude configures (true); the unsupported client contributes false.
		const result = installStatusLine(["gemini", "claude"]);
		expect(result).toBe(SCRIPT_PATH);
		expect(files.has(CLAUDE_SETTINGS)).toBe(true);
	});

	it("returns null for an empty client list", () => {
		const result = installStatusLine([]);
		expect(result).toBeNull();
		// Script still written.
		expect(files.has(SCRIPT_PATH)).toBe(true);
	});
});

// ===========================================
// applyStatuslineToSettings — branches (exercised via installStatusLine)
// ===========================================

describe("applyStatuslineToSettings — fresh settings (no statusLine key)", () => {
	it("creates the settings directory when missing and writes statusLine", () => {
		// .claude dir not seeded → mkdirSync for it.
		installStatusLine(["claude"]);
		expect(mockFs.mkdirSync).toHaveBeenCalledWith(join(HOME, ".claude"), { recursive: true });
		const settings = readSettings(CLAUDE_SETTINGS);
		expect(settings.statusLine).toBeDefined();
	});

	it("does not recreate the settings directory when it already exists", () => {
		seedDir(join(HOME, ".claude"));
		installStatusLine(["claude"]);
		const mkdirTargets = mockFs.mkdirSync.mock.calls.map((c) => String(c[0]));
		expect(mkdirTargets).not.toContain(join(HOME, ".claude"));
	});

	it("merges statusLine into an existing settings object, preserving other keys", () => {
		seedFile(CLAUDE_SETTINGS, JSON.stringify({ theme: "dark", hooks: { x: 1 } }));
		const result = installStatusLine(["claude"]);
		expect(result).toBe(SCRIPT_PATH);
		const settings = readSettings(CLAUDE_SETTINGS);
		expect(settings.theme).toBe("dark");
		expect(settings.hooks).toEqual({ x: 1 });
		expect(settings.statusLine).toEqual({
			type: "command",
			command: SCRIPT_PATH,
			refreshInterval: 5,
		});
	});

	it("ignores a non-object settings file (array) and writes statusLine onto a fresh object", () => {
		// JSON.parse yields an array → isPlainObject false → settings stays {}.
		seedFile(CLAUDE_SETTINGS, JSON.stringify([1, 2, 3]));
		const result = installStatusLine(["claude"]);
		expect(result).toBe(SCRIPT_PATH);
		const settings = readSettings(CLAUDE_SETTINGS);
		// The array was discarded; only statusLine remains.
		expect(Array.isArray(settings)).toBe(false);
		expect(settings.statusLine).toBeDefined();
	});

	it("ignores a primitive (string) settings file and writes statusLine onto a fresh object", () => {
		seedFile(CLAUDE_SETTINGS, JSON.stringify("just a string"));
		const result = installStatusLine(["claude"]);
		expect(result).toBe(SCRIPT_PATH);
		expect(readSettings(CLAUDE_SETTINGS).statusLine).toBeDefined();
	});
});

describe("applyStatuslineToSettings — existing statusLine key", () => {
	it("rewrites an existing interlinked statusLine command + refreshInterval (returns true)", () => {
		seedFile(
			CLAUDE_SETTINGS,
			JSON.stringify({
				statusLine: {
					type: "command",
					command: "/old/path/statusline-interlinked.sh",
					refreshInterval: 99,
				},
			}),
		);
		const result = installStatusLine(["claude"]);
		expect(result).toBe(SCRIPT_PATH);
		const sl = readStatusLine(CLAUDE_SETTINGS);
		expect(sl.command).toBe(SCRIPT_PATH);
		expect(sl.refreshInterval).toBe(5);
		// type is preserved from the existing object (only command/refresh updated).
		expect(sl.type).toBe("command");
	});

	it("leaves a foreign statusLine untouched and returns null (not configured)", () => {
		const foreign = {
			statusLine: { type: "command", command: "/usr/bin/my-custom-statusline", refreshInterval: 3 },
		};
		seedFile(CLAUDE_SETTINGS, JSON.stringify(foreign));
		const result = installStatusLine(["claude"]);
		expect(result).toBeNull();
		// Untouched: command not overwritten.
		const sl = readStatusLine(CLAUDE_SETTINGS);
		expect(sl.command).toBe("/usr/bin/my-custom-statusline");
		expect(sl.refreshInterval).toBe(3);
	});

	it("does not touch a foreign statusLine even though the script file is still written", () => {
		seedFile(
			CLAUDE_SETTINGS,
			JSON.stringify({ statusLine: { type: "command", command: "/other/tool" } }),
		);
		installStatusLine(["claude"]);
		expect(files.has(SCRIPT_PATH)).toBe(true);
	});

	it("returns null when statusLine.command is an empty string (isNonEmptyString false)", () => {
		seedFile(
			CLAUDE_SETTINGS,
			JSON.stringify({ statusLine: { type: "command", command: "" } }),
		);
		const result = installStatusLine(["claude"]);
		expect(result).toBeNull();
		// Empty command left as-is (no overwrite).
		const sl = readStatusLine(CLAUDE_SETTINGS);
		expect(sl.command).toBe("");
	});

	it("returns null when statusLine.command is missing entirely", () => {
		seedFile(CLAUDE_SETTINGS, JSON.stringify({ statusLine: { type: "command" } }));
		const result = installStatusLine(["claude"]);
		expect(result).toBeNull();
	});

	it("returns null when statusLine.command is a non-string value", () => {
		seedFile(CLAUDE_SETTINGS, JSON.stringify({ statusLine: { command: 42 } }));
		const result = installStatusLine(["claude"]);
		expect(result).toBeNull();
	});

	it("returns null when statusLine is a non-object (string) — neither branch fires", () => {
		// settings.statusLine is truthy (string) so the !statusLine branch is
		// skipped, and isPlainObject(string) is false so the rewrite branch is
		// skipped too → falls through to return false.
		seedFile(CLAUDE_SETTINGS, JSON.stringify({ statusLine: "a-string-statusline" }));
		const result = installStatusLine(["claude"]);
		expect(result).toBeNull();
		// The string statusLine was preserved (not overwritten).
		expect(readSettings(CLAUDE_SETTINGS).statusLine).toBe("a-string-statusline");
	});

	it("returns null when statusLine is an array (truthy, non-plain-object)", () => {
		seedFile(CLAUDE_SETTINGS, JSON.stringify({ statusLine: ["x"] }));
		const result = installStatusLine(["claude"]);
		expect(result).toBeNull();
	});
});

// ===========================================
// applyStatuslineToSettings — catch path
// ===========================================

describe("applyStatuslineToSettings — error handling", () => {
	it("returns null (skips the client) when the settings file is malformed JSON", () => {
		seedFile(CLAUDE_SETTINGS, "{ this is not: valid json ");
		const result = installStatusLine(["claude"]);
		expect(result).toBeNull();
		// Malformed content untouched (write skipped by the catch).
		expect(files.get(CLAUDE_SETTINGS)).toBe("{ this is not: valid json ");
	});

	it("returns null when reading the settings file throws (non-ENOENT I/O error)", () => {
		// existsSync says present, but readFileSync throws — exercises the catch.
		dirs.add(join(HOME, ".claude"));
		mockFs.existsSync.mockImplementation((p) => {
			const key = String(p);
			if (key === CLAUDE_SETTINGS) return true;
			return files.has(key) || dirs.has(key);
		});
		mockFs.readFileSync.mockImplementation((p) => {
			if (String(p) === CLAUDE_SETTINGS) {
				throw Object.assign(new Error("EIO: read error"), { code: "EIO" });
			}
			return nonNull(files.get(String(p)));
		});

		const result = installStatusLine(["claude"]);
		expect(result).toBeNull();
	});

	it("one client throwing does not prevent another client from configuring", () => {
		// Claude settings malformed (catch → false), Copilot clean (true).
		seedFile(CLAUDE_SETTINGS, "}{ broken");
		const result = installStatusLine(["claude", "copilot"]);
		expect(result).toBe(SCRIPT_PATH);
		expect(readSettings(COPILOT_CONFIG).statusLine).toBeDefined();
	});
});

// ===========================================
// installStatusLine — idempotency
// ===========================================

describe("installStatusLine — idempotency", () => {
	it("is stable across repeated runs (second run still returns the script path)", () => {
		const first = installStatusLine(["claude"]);
		const second = installStatusLine(["claude"]);
		expect(first).toBe(SCRIPT_PATH);
		expect(second).toBe(SCRIPT_PATH);
		const sl = readStatusLine(CLAUDE_SETTINGS);
		expect(sl.command).toBe(SCRIPT_PATH);
		expect(sl.refreshInterval).toBe(5);
	});
});
