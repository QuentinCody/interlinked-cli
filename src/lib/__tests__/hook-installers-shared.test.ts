import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildHookCommand,
	cleanJsonHookFile,
	findParentWithHooks,
	hookEventEntries,
	hookSettingsObject,
	installHookEntry,
	readJsonFile,
} from "../hook-installers-shared.js";

describe("hook configuration boundaries", () => {
	it.each([
		{ label: "null", entry: null },
		{ label: "number", entry: 42 },
		{ label: "array", entry: [] },
		{ label: "missing handlers", entry: {} },
		{ label: "non-array handlers", entry: { hooks: "invalid" } },
		{ label: "non-object handler", entry: { hooks: [null] } },
	])("preserves a malformed $label entry while adding the managed hook", ({ entry }) => {
		const hooks = { PreToolUse: [entry] };
		const command = "node .interlinked/hooks/interlinked-activity.mjs";

		installHookEntry(hooks, "PreToolUse", command);

		expect(hooks.PreToolUse).toEqual([
			entry,
			{ matcher: "", hooks: [{ type: "command", command, timeout: 240 }] },
		]);
	});

	it("rejects a non-array event without overwriting the user's configuration", () => {
		const hooks = { PreToolUse: { command: "echo user-hook" } };
		const before = structuredClone(hooks);

		expect(() => hookEventEntries(hooks, "PreToolUse")).toThrow(
			"Invalid hooks.PreToolUse: expected an array",
		);
		expect(hooks).toEqual(before);
	});

	it("rejects a non-object hooks setting without overwriting the user's configuration", () => {
		const settings = { hooks: ["echo user-hook"] };
		const before = structuredClone(settings);

		expect(() => hookSettingsObject(settings)).toThrow("Invalid hooks: expected an object");
		expect(settings).toEqual(before);
	});
});

describe("readJsonFile", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hook-shared-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns null when the file contains malformed JSON", () => {
		const path = join(tmp, "settings.json");
		writeFileSync(path, "{ not valid json");
		expect(readJsonFile(path)).toBeNull();
	});

	it("returns null when the parsed JSON is not a plain object", () => {
		const path = join(tmp, "settings.json");
		writeFileSync(path, JSON.stringify([1, 2, 3]));
		expect(readJsonFile(path)).toBeNull();
	});

	it("returns the parsed object when the JSON is a plain object", () => {
		const path = join(tmp, "settings.json");
		writeFileSync(path, JSON.stringify({ foo: "bar" }));
		expect(readJsonFile(path)).toEqual({ foo: "bar" });
	});
});

describe("buildHookCommand", () => {
	it("builds a fail-open snippet for an absolute path with no client", () => {
		const cmd = buildHookCommand("/abs/path/interlinked-activity.mjs");
		expect(cmd).toBe(
			'test -f "/abs/path/interlinked-activity.mjs" && node "/abs/path/interlinked-activity.mjs" || true',
		);
	});

	it("prefixes INTERLINKED_CLIENT/RUNNER for claude-code", () => {
		const cmd = buildHookCommand("/abs/interlinked-activity.mjs", "claude");
		expect(cmd).toBe(
			'test -f "/abs/interlinked-activity.mjs" && INTERLINKED_CLIENT="claude" INTERLINKED_RUNNER="claude-code" node "/abs/interlinked-activity.mjs" || true',
		);
	});

	it("resolves the copilot-cli runner", () => {
		const cmd = buildHookCommand("/abs/interlinked-activity.mjs", "copilot");
		expect(cmd).toContain('INTERLINKED_RUNNER="copilot-cli"');
	});

	it("resolves the gemini-cli runner", () => {
		const cmd = buildHookCommand("/abs/interlinked-activity.mjs", "gemini");
		expect(cmd).toContain('INTERLINKED_RUNNER="gemini-cli"');
	});

	it("resolves the codex runner", () => {
		const cmd = buildHookCommand("/abs/interlinked-activity.mjs", "codex");
		expect(cmd).toContain('INTERLINKED_RUNNER="codex"');
	});

	it("resolves the cursor runner and fails closed for absolute paths", () => {
		const cmd = buildHookCommand("/abs/interlinked-activity.mjs", "cursor");
		expect(cmd).toBe(
			'if test -f "/abs/interlinked-activity.mjs"; then INTERLINKED_CLIENT="cursor" INTERLINKED_RUNNER="cursor" exec node "/abs/interlinked-activity.mjs"; else exit 1; fi',
		);
	});

	it("builds a fail-open walk-up snippet for a relative path with no client", () => {
		const cmd = buildHookCommand(".interlinked/hooks/interlinked-activity.mjs");
		expect(cmd).toBe(
			'HOOK_SCRIPT_REL=".interlinked/hooks/interlinked-activity.mjs"; ' +
				'HOOK_DIR="$PWD"; ' +
				"while :; do " +
				'if test -f "$HOOK_DIR/$HOOK_SCRIPT_REL"; then ' +
				'node "$HOOK_DIR/$HOOK_SCRIPT_REL" || true; ' +
				"break; " +
				"fi; " +
				'NEXT_HOOK_DIR=$(dirname "$HOOK_DIR"); ' +
				'test "$NEXT_HOOK_DIR" = "$HOOK_DIR" && break; ' +
				'HOOK_DIR="$NEXT_HOOK_DIR"; ' +
				"done",
		);
	});

	it("builds a fail-closed walk-up snippet for a relative path when client is cursor", () => {
		const cmd = buildHookCommand(".interlinked/hooks/interlinked-activity.mjs", "cursor");
		expect(cmd).toBe(
			'HOOK_SCRIPT_REL=".interlinked/hooks/interlinked-activity.mjs"; ' +
				'HOOK_DIR="$PWD"; ' +
				"while :; do " +
				'if test -f "$HOOK_DIR/$HOOK_SCRIPT_REL"; then ' +
				'INTERLINKED_CLIENT="cursor" INTERLINKED_RUNNER="cursor" exec node "$HOOK_DIR/$HOOK_SCRIPT_REL"; ' +
				"fi; " +
				'NEXT_HOOK_DIR=$(dirname "$HOOK_DIR"); ' +
				'test "$NEXT_HOOK_DIR" = "$HOOK_DIR" && exit 1; ' +
				'HOOK_DIR="$NEXT_HOOK_DIR"; ' +
				"done",
		);
	});
});

describe("cleanJsonHookFile", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hook-shared-clean-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns false when the settings file does not exist", () => {
		const path = join(tmp, "missing.json");
		expect(cleanJsonHookFile(path)).toBe(false);
	});

	it("returns false when the settings object has no hooks field", () => {
		const path = join(tmp, "settings.json");
		writeFileSync(path, JSON.stringify({ other: true }));
		expect(cleanJsonHookFile(path)).toBe(false);
	});

	it("returns false when hooks is not a plain object", () => {
		const path = join(tmp, "settings.json");
		writeFileSync(path, JSON.stringify({ hooks: [1, 2, 3] }));
		expect(cleanJsonHookFile(path)).toBe(false);
	});

	it("skips a non-array event value and returns false when nothing else changes", () => {
		const path = join(tmp, "settings.json");
		writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: "not-an-array" } }));
		expect(cleanJsonHookFile(path)).toBe(false);
	});

	it("removes interlinked entries, deletes the hooks field entirely when empty, and writes the file", () => {
		const path = join(tmp, "settings.json");
		writeFileSync(
			path,
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

		const changed = cleanJsonHookFile(path);

		expect(changed).toBe(true);
		const written = JSON.parse(readFileSync(path, "utf-8"));
		expect(written).toEqual({});
	});

	it("keeps other events' entries and the hooks field when some hooks remain", () => {
		const path = join(tmp, "settings.json");
		writeFileSync(
			path,
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "",
							hooks: [{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" }],
						},
					],
					PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "echo user-hook" }] }],
				},
			}),
		);

		const changed = cleanJsonHookFile(path);

		expect(changed).toBe(true);
		const written = JSON.parse(readFileSync(path, "utf-8"));
		expect(written.hooks.PreToolUse).toBeUndefined();
		expect(written.hooks.PostToolUse).toEqual([
			{ matcher: "", hooks: [{ type: "command", command: "echo user-hook" }] },
		]);
	});

	it("preserves same-basename user scripts while removing exact legacy path forms", () => {
		const path = join(tmp, "settings.json");
		const userLegacyBasename = { command: "node /home/user/interlinked-activity.mjs" };
		const userAdapterBasename = {
			command: "node /home/user/hook-entry.js --runner user-runner --event PreToolUse",
		};
		const generatedAssignment =
			'HOOK_SCRIPT_REL=".interlinked/hooks/interlinked-activity.mjs"; ' +
			'HOOK_DIR="$PWD"; if test -f "$HOOK_DIR/$HOOK_SCRIPT_REL"; then ' +
			'node "$HOOK_DIR/$HOOK_SCRIPT_REL"; fi';
		writeFileSync(
			path,
			JSON.stringify({
				hooks: {
					PreToolUse: [
						userLegacyBasename,
						userAdapterBasename,
						{ command: "node .interlinked/hooks/interlinked-activity.mjs" },
						{ command: generatedAssignment },
					],
				},
			}),
		);

		expect(cleanJsonHookFile(path)).toBe(true);
		const written: unknown = JSON.parse(readFileSync(path, "utf-8"));
		expect(written).toHaveProperty("hooks.PreToolUse", [userLegacyBasename, userAdapterBasename]);
	});
});

describe("findParentWithHooks", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hook-shared-parent-"));
		mkdirSync(join(tmp, ".git"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns null when no ancestor has the settings file", () => {
		const nested = join(tmp, "a", "b");
		mkdirSync(nested, { recursive: true });
		expect(findParentWithHooks(nested, ".claude/settings.json")).toBeNull();
	});

	it("returns the ancestor directory when it has an interlinked hook command", () => {
		const nested = join(tmp, "a", "b");
		mkdirSync(nested, { recursive: true });
		const settingsDir = join(tmp, "a", ".claude");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [{ command: "node .interlinked/hooks/interlinked-activity.mjs" }],
				},
			}),
		);

		expect(findParentWithHooks(nested, ".claude/settings.json")).toBe(join(tmp, "a"));
	});

	it("ignores an ancestor user hook with only the legacy basename", () => {
		const nested = join(tmp, "a", "b");
		mkdirSync(nested, { recursive: true });
		const settingsDir = join(tmp, "a", ".claude");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({
				hooks: { PreToolUse: [{ command: "node /home/user/interlinked-activity.mjs" }] },
			}),
		);

		expect(findParentWithHooks(nested, ".claude/settings.json")).toBeNull();
	});

	it("keeps walking up when the ancestor's settings file has no interlinked command", () => {
		const nested = join(tmp, "a", "b");
		mkdirSync(nested, { recursive: true });
		const settingsDir = join(tmp, "a", ".claude");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ hooks: { PreToolUse: [{ command: "echo unrelated" }] } }),
		);

		expect(findParentWithHooks(nested, ".claude/settings.json")).toBeNull();
	});
});
