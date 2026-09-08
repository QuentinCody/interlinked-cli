import { parseWire, wireObject, wireNumber, wireRecord, wireArray, wireAbsentOptional, wireBoolean, wireString } from "../value-validation.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURSOR_FAIL_CLOSED_EVENTS,
	CURSOR_HOOK_EVENTS,
	installCursorHooks,
	uninstallCursorHooks,
} from "../hook-installers-cursor.js";

const REL_SCRIPT = ".interlinked/hooks/interlinked-activity.mjs";

interface CursorEntry {
	command: string;
	type?: string;
	failClosed?: boolean;
}
interface CursorFile {
	version: number;
	hooks: Record<string, CursorEntry[]>;
}

const isCursorFile = wireObject<CursorFile>({
	version: wireNumber,
	hooks: wireRecord(wireArray(wireObject<CursorEntry>({ command: wireString, type: wireAbsentOptional(wireString), failClosed: wireAbsentOptional(wireBoolean) }))),
});

function readConfig(tmp: string): CursorFile {
	const raw = readFileSync(join(tmp, ".cursor", "hooks.json"), "utf-8");
	return parseWire(JSON.parse(raw), isCursorFile, "installed Cursor hooks");
}

function cursorPath(tmp: string): string {
	return join(tmp, ".cursor", "hooks.json");
}

/** Write a raw hooks.json fixture, creating the `.cursor` dir first. */
function seed(tmp: string, contents: string): void {
	mkdirSync(join(tmp, ".cursor"), { recursive: true });
	writeFileSync(cursorPath(tmp), contents);
}

describe("Cursor hook event list", () => {
	it("includes both MCP naming variants", () => {
		expect(CURSOR_HOOK_EVENTS).toContain("beforeMCPExecution");
		expect(CURSOR_HOOK_EVENTS).toContain("beforeMcpToolExecution");
	});
});

describe("installCursorHooks / uninstallCursorHooks", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cursor-hooks-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("writes both Cursor MCP hook event variants", () => {
		installCursorHooks(tmp, REL_SCRIPT);
		const hooksPath = cursorPath(tmp);
		expect(existsSync(hooksPath)).toBe(true);
		const content = readFileSync(hooksPath, "utf-8");
		expect(content).toContain('"beforeMCPExecution"');
		expect(content).toContain('"beforeMcpToolExecution"');
	});

	it("removes Interlinked entries and deletes hooks.json when empty", () => {
		installCursorHooks(tmp, REL_SCRIPT);
		expect(uninstallCursorHooks(tmp)).toBe(true);
		expect(existsSync(cursorPath(tmp))).toBe(false);
	});

	it("registers every declared event exactly once with version 1", () => {
		installCursorHooks(tmp, REL_SCRIPT);
		const config = readConfig(tmp);
		expect(config.version).toBe(1);
		for (const event of CURSOR_HOOK_EVENTS) {
			expect(config.hooks[event]).toHaveLength(1);
			expect(config.hooks[event][0].type).toBe("command");
			expect(config.hooks[event][0].command).toContain("interlinked-activity");
		}
	});

	it("sets failClosed:true only on gate events and leaves lifecycle events fail-open", () => {
		installCursorHooks(tmp, REL_SCRIPT);
		const config = readConfig(tmp);

		// Gate events fail closed.
		for (const event of CURSOR_FAIL_CLOSED_EVENTS) {
			expect(config.hooks[event][0].failClosed).toBe(true);
		}
		// A representative lifecycle/observation event must NOT carry failClosed.
		expect("failClosed" in config.hooks.sessionStart[0]).toBe(false);
		expect("failClosed" in config.hooks.afterFileEdit[0]).toBe(false);
		expect("failClosed" in config.hooks.postToolUse[0]).toBe(false);
	});

	it("bakes the Cursor runner env-prefix into the command (absolute path)", () => {
		const abs = join(tmp, "hooks", "interlinked-activity.mjs");
		installCursorHooks(tmp, abs);
		const config = readConfig(tmp);
		const cmd = config.hooks.beforeShellExecution[0].command;
		expect(cmd).toContain('INTERLINKED_CLIENT="cursor"');
		expect(cmd).toContain('INTERLINKED_RUNNER="cursor"');
		// Gate events get exec (so node's exit code reaches Cursor for failClosed).
		expect(cmd).toContain("exec node");
	});

	// --- re-install / upsert paths (existing-entry branches) ---

	it("rewrites a stale command in place on re-install without duplicating entries", () => {
		const oldAbs = join(tmp, "old", "interlinked-activity.mjs");
		const newAbs = join(tmp, "new", "interlinked-activity.mjs");
		installCursorHooks(tmp, oldAbs);
		const before = readConfig(tmp);
		expect(before.hooks.beforeShellExecution[0].command).toContain("/old/");

		installCursorHooks(tmp, newAbs);
		const after = readConfig(tmp);
		// Still exactly one entry per event — the stale one was mutated, not appended.
		expect(after.hooks.beforeShellExecution).toHaveLength(1);
		expect(after.hooks.beforeShellExecution[0].command).toContain("/new/");
		expect(after.hooks.beforeShellExecution[0].command).not.toContain("/old/");
	});

	it("is idempotent when the command is unchanged (no spurious mutation)", () => {
		installCursorHooks(tmp, REL_SCRIPT);
		const first = readFileSync(cursorPath(tmp), "utf-8");
		installCursorHooks(tmp, REL_SCRIPT);
		const second = readFileSync(cursorPath(tmp), "utf-8");
		expect(second).toBe(first);
		// Re-install must not duplicate entries.
		const config = readConfig(tmp);
		expect(config.hooks.beforeShellExecution).toHaveLength(1);
		expect(config.hooks.sessionStart).toHaveLength(1);
	});

	it("repairs a pre-seeded interlinked entry whose failClosed flag is wrong", () => {
		const cmd = `node ${join(tmp, "interlinked-activity.mjs")}`;
		// beforeShellExecution is a gate event => should end up failClosed:true.
		// sessionStart is lifecycle => should end up with no failClosed (false).
		const seeded: CursorFile = {
			version: 1,
			hooks: {
				beforeShellExecution: [{ command: cmd, type: "command" }], // missing failClosed
				sessionStart: [{ command: cmd, type: "command", failClosed: true }], // wrongly fail-closed
			},
		};
		seed(tmp, `${JSON.stringify(seeded, null, 2)}\n`);

		installCursorHooks(tmp, REL_SCRIPT);
		const config = readConfig(tmp);
		// Gate event: failClosed flipped on.
		expect(config.hooks.beforeShellExecution[0].failClosed).toBe(true);
		// Lifecycle event: failClosed flipped off.
		expect(config.hooks.sessionStart[0].failClosed).toBe(false);
		// And the stale command was updated to the new install path.
		expect(config.hooks.beforeShellExecution[0].command).toContain(REL_SCRIPT);
	});

	it("preserves a user's non-interlinked Cursor hook alongside ours", () => {
		const userEntry: CursorEntry = { command: "echo user-shell-guard", type: "command" };
		const seeded: CursorFile = {
			version: 1,
			hooks: { beforeShellExecution: [userEntry] },
		};
		seed(tmp, `${JSON.stringify(seeded, null, 2)}\n`);

		installCursorHooks(tmp, REL_SCRIPT);
		const config = readConfig(tmp);
		const cmds = config.hooks.beforeShellExecution.map((e) => e.command);
		expect(cmds).toContain("echo user-shell-guard");
		expect(cmds.some((c) => c.includes("interlinked-activity"))).toBe(true);
		expect(config.hooks.beforeShellExecution).toHaveLength(2);
	});

	// --- malformed / odd-shaped config handling ---

	it("starts over from a malformed (non-JSON) hooks.json", () => {
		seed(tmp, "{ this is : not json ]");
		installCursorHooks(tmp, REL_SCRIPT);
		const config = readConfig(tmp);
		expect(config.version).toBe(1);
		expect(config.hooks.beforeShellExecution[0].command).toContain("interlinked-activity");
	});

	it("recovers when hooks.json is a JSON array (not an object)", () => {
		seed(tmp, JSON.stringify(["not", "an", "object"]));
		installCursorHooks(tmp, REL_SCRIPT);
		const config = readConfig(tmp);
		// parseCursorConfigShape returned null -> install falls back to empty config.
		expect(config.hooks.sessionStart).toHaveLength(1);
	});

	it("recovers when hooks.json has a non-object `hooks` field", () => {
		// Object shape passes the isPlainObject(raw) check, but raw.hooks is a
		// string -> the cond-expr false branch defaults hooks to {}.
		seed(tmp, JSON.stringify({ version: 1, hooks: "broken" }));
		installCursorHooks(tmp, REL_SCRIPT);
		const config = readConfig(tmp);
		expect(config.hooks.beforeMCPExecution).toHaveLength(1);
	});

	it("creates the .cursor directory when it does not exist", () => {
		// Fresh tmp has no .cursor dir; install must mkdir it.
		expect(existsSync(join(tmp, ".cursor"))).toBe(false);
		installCursorHooks(tmp, REL_SCRIPT);
		expect(existsSync(join(tmp, ".cursor"))).toBe(true);
		expect(existsSync(cursorPath(tmp))).toBe(true);
	});

	// --- uninstall paths ---

	it("uninstall returns false when hooks.json does not exist", () => {
		expect(uninstallCursorHooks(tmp)).toBe(false);
	});

	it("uninstall returns false on a malformed hooks.json (config unreadable)", () => {
		seed(tmp, "}{ broken");
		// safeReadCursorConfig returns null -> uninstall short-circuits false.
		expect(uninstallCursorHooks(tmp)).toBe(false);
		// File is left untouched (nothing changed).
		expect(readFileSync(cursorPath(tmp), "utf-8")).toBe("}{ broken");
	});

	it("uninstall returns false when no interlinked entries are present", () => {
		const seeded: CursorFile = {
			version: 1,
			hooks: { beforeShellExecution: [{ command: "echo unrelated", type: "command" }] },
		};
		seed(tmp, `${JSON.stringify(seeded, null, 2)}\n`);
		expect(uninstallCursorHooks(tmp)).toBe(false);
	});

	it("uninstall keeps the file and other hooks, dropping only our entries and empty arrays", () => {
		// Install ours into every event...
		installCursorHooks(tmp, REL_SCRIPT);
		// ...then inject a foreign hook into one event so the file survives uninstall.
		const config = readConfig(tmp);
		config.hooks.beforeShellExecution.push({ command: "echo keep-me", type: "command" });
		writeFileSync(cursorPath(tmp), `${JSON.stringify(config, null, 2)}\n`);

		expect(uninstallCursorHooks(tmp)).toBe(true);
		// File must still exist because a foreign hook remained.
		expect(existsSync(cursorPath(tmp))).toBe(true);

		const after = readConfig(tmp);
		// The event with the foreign hook keeps exactly that entry.
		expect(after.hooks.beforeShellExecution).toHaveLength(1);
		expect(after.hooks.beforeShellExecution[0].command).toBe("echo keep-me");
		// Events that only had our entry are pruned entirely (empty arrays dropped).
		expect("sessionStart" in after.hooks).toBe(false);
		expect("beforeMCPExecution" in after.hooks).toBe(false);
		// No interlinked command survives anywhere.
		const allCmds = Object.values(after.hooks)
			.flat()
			.map((e) => e.command);
		expect(allCmds.some((c) => c.includes("interlinked-activity"))).toBe(false);
	});

	it("uninstall skips non-array hook event values without crashing", () => {
		// A hand-edited file where one event maps to a non-array value (must be
		// skipped, not crashed on), an interlinked array (to be removed), and a
		// foreign array (a surviving real hook keeps the file alive so we land
		// in the keep-file branch rather than deleting it).
		const interlinkedCmd = "node .interlinked/hooks/interlinked-activity.mjs";
		const seeded = {
			version: 1,
			hooks: {
				weirdEvent: "not-an-array",
				beforeShellExecution: [{ command: interlinkedCmd, type: "command" }],
				afterFileEdit: [{ command: "echo foreign-observer", type: "command" }],
			},
		};
		seed(tmp, `${JSON.stringify(seeded, null, 2)}\n`);

		expect(uninstallCursorHooks(tmp)).toBe(true);
		expect(existsSync(cursorPath(tmp))).toBe(true);
		const after: unknown = JSON.parse(readFileSync(cursorPath(tmp), "utf-8"));
		// The non-array value is preserved untouched (the loop `continue`d past it).
		expect(after).toHaveProperty("hooks.weirdEvent", "not-an-array");
		// Our entry was removed; its now-empty array dropped.
		expect(after).not.toHaveProperty("hooks.beforeShellExecution");
		// The foreign array hook survived.
		expect(after).toHaveProperty("hooks.afterFileEdit", [
			{ command: "echo foreign-observer", type: "command" },
		]);
	});

	it("round-trips: install then uninstall returns to no hooks.json", () => {
		installCursorHooks(tmp, REL_SCRIPT);
		expect(existsSync(cursorPath(tmp))).toBe(true);
		expect(uninstallCursorHooks(tmp)).toBe(true);
		expect(existsSync(cursorPath(tmp))).toBe(false);
		// A second uninstall is a no-op (file already gone).
		expect(uninstallCursorHooks(tmp)).toBe(false);
	});
});
