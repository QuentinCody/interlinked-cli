import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	COPILOT_HOOK_EVENTS,
	installCopilotHooks,
	uninstallCopilotHooks,
} from "../hook-installers-copilot.js";

describe("Copilot hook event list", () => {
	it("uses camelCase naming", () => {
		expect(COPILOT_HOOK_EVENTS).toContain("sessionStart");
		expect(COPILOT_HOOK_EVENTS).toContain("postToolUse");
	});
});

describe("installCopilotHooks / uninstallCopilotHooks", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "copilot-hooks-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("writes .github/hooks/hooks.json with Copilot event entries", () => {
		installCopilotHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const hooksPath = join(tmp, ".github", "hooks", "hooks.json");
		expect(existsSync(hooksPath)).toBe(true);

		const content = readFileSync(hooksPath, "utf-8");
		expect(content).toContain('"sessionStart"');
		expect(content).toContain('"postToolUse"');
		expect(content).toContain("interlinked-activity");
		expect(content).toContain("INTERLINKED_CLIENT");
	});

	it("removes interlinked entries and deletes file when no hooks remain", () => {
		installCopilotHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const changed = uninstallCopilotHooks(tmp);
		expect(changed).toBe(true);

		const hooksPath = join(tmp, ".github", "hooks", "hooks.json");
		expect(existsSync(hooksPath)).toBe(false);
	});

	it("uninstall is a no-op when file is missing", () => {
		expect(uninstallCopilotHooks(tmp)).toBe(false);
	});

	it("starts fresh when hooks.json contains malformed JSON", () => {
		const dir = join(tmp, ".github", "hooks");
		mkdirSync(dir, { recursive: true });
		const hooksPath = join(dir, "hooks.json");
		writeFileSync(hooksPath, "{ this is not valid json");

		installCopilotHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");

		const content = JSON.parse(readFileSync(hooksPath, "utf-8"));
		expect(content.version).toBe(1);
		expect(content.hooks.sessionStart).toHaveLength(1);
	});

	it("starts fresh when hooks.json top-level is not a plain object", () => {
		const dir = join(tmp, ".github", "hooks");
		mkdirSync(dir, { recursive: true });
		const hooksPath = join(dir, "hooks.json");
		writeFileSync(hooksPath, JSON.stringify([1, 2, 3]));

		installCopilotHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");

		const content = JSON.parse(readFileSync(hooksPath, "utf-8"));
		expect(content.hooks.sessionStart).toHaveLength(1);
	});

	it("coerces a non-object hooks field to an empty record", () => {
		const dir = join(tmp, ".github", "hooks");
		mkdirSync(dir, { recursive: true });
		const hooksPath = join(dir, "hooks.json");
		writeFileSync(hooksPath, JSON.stringify({ version: 1, hooks: "not-an-object" }));

		installCopilotHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");

		const content = JSON.parse(readFileSync(hooksPath, "utf-8"));
		expect(content.hooks.sessionStart).toHaveLength(1);
	});

	it("does not recreate the hooks dir when it already exists", () => {
		const dir = join(tmp, ".github", "hooks");
		mkdirSync(dir, { recursive: true });
		expect(existsSync(dir)).toBe(true);

		installCopilotHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");

		const hooksPath = join(dir, "hooks.json");
		expect(existsSync(hooksPath)).toBe(true);
	});

	it("leaves an up-to-date interlinked entry untouched on reinstall", () => {
		const scriptPath = ".interlinked/hooks/interlinked-activity.mjs";
		installCopilotHooks(tmp, scriptPath);
		const hooksPath = join(tmp, ".github", "hooks", "hooks.json");
		const before = readFileSync(hooksPath, "utf-8");

		installCopilotHooks(tmp, scriptPath);

		const after = readFileSync(hooksPath, "utf-8");
		expect(after).toBe(before);
	});

	it("updates a stale interlinked entry's bash command on reinstall", () => {
		installCopilotHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const hooksPath = join(tmp, ".github", "hooks", "hooks.json");

		installCopilotHooks(tmp, ".interlinked/hooks/interlinked-activity-v2.mjs");

		const content: unknown = JSON.parse(readFileSync(hooksPath, "utf-8"));
		expect(content).toHaveProperty("hooks.sessionStart", [
			{ type: "command", bash: expect.stringContaining("interlinked-activity-v2.mjs") },
		]);
	});

	it("skips array-valued events that already have a populated entries array", () => {
		const dir = join(tmp, ".github", "hooks");
		mkdirSync(dir, { recursive: true });
		const hooksPath = join(dir, "hooks.json");
		writeFileSync(
			hooksPath,
			JSON.stringify({
				version: 1,
				hooks: { sessionStart: [{ type: "command", bash: "echo user-hook" }] },
			}),
		);

		installCopilotHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");

		const content: unknown = JSON.parse(readFileSync(hooksPath, "utf-8"));
		expect(content).toHaveProperty("hooks.sessionStart", [
			{ type: "command", bash: "echo user-hook" },
			{ type: "command", bash: expect.stringContaining("interlinked-activity") },
		]);
	});

	it("uninstall skips a non-array event value and returns false when nothing changes", () => {
		const dir = join(tmp, ".github", "hooks");
		mkdirSync(dir, { recursive: true });
		const hooksPath = join(dir, "hooks.json");
		writeFileSync(
			hooksPath,
			JSON.stringify({
				version: 1,
				hooks: { sessionStart: "not-an-array", postToolUse: [{ type: "command", bash: "echo keep" }] },
			}),
		);

		const changed = uninstallCopilotHooks(tmp);

		expect(changed).toBe(false);
		expect(existsSync(hooksPath)).toBe(true);
	});

	it("uninstall preserves non-interlinked entries and rewrites the file (does not delete)", () => {
		const dir = join(tmp, ".github", "hooks");
		mkdirSync(dir, { recursive: true });
		const hooksPath = join(dir, "hooks.json");
		writeFileSync(
			hooksPath,
			JSON.stringify({
				version: 1,
				hooks: {
					sessionStart: [
						{ type: "command", bash: "echo user-hook" },
						{ type: "command", bash: "node .interlinked/hooks/interlinked-activity.mjs" },
					],
				},
			}),
		);

		const changed = uninstallCopilotHooks(tmp);

		expect(changed).toBe(true);
		expect(existsSync(hooksPath)).toBe(true);
		const content = JSON.parse(readFileSync(hooksPath, "utf-8"));
		expect(content.hooks.sessionStart).toEqual([{ type: "command", bash: "echo user-hook" }]);
	});
});
