import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectClients } from "./settings.js";
import { isOpenCodeV2Env, opencodeUserPluginDir, opencodeUserPluginRelPath } from "./opencode-runtime.js";

describe("isOpenCodeV2Env", () => {
	it("P1: OPENCODE2 or INTERLINKED_CLIENT=opencode2", () => {
		expect(isOpenCodeV2Env({ OPENCODE2: "1" })).toBe(true);
		expect(isOpenCodeV2Env({ INTERLINKED_CLIENT: "opencode2" })).toBe(true);
	});
	it("N1: argv/XDG substrings and v1 client are not v2", () => {
		expect(isOpenCodeV2Env({ XDG_CONFIG_HOME: "/tmp/opencode-v2" })).toBe(false);
		expect(isOpenCodeV2Env({ INTERLINKED_CLIENT: "opencode" })).toBe(false);
		expect(isOpenCodeV2Env({ OPENCODE: "1" })).toBe(false);
	});
});

describe("opencode user plugin path", () => {
	it("honors XDG_CONFIG_HOME", () => {
		expect(opencodeUserPluginDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/opencode/plugins");
		expect(opencodeUserPluginRelPath("interlinked-opencode2.ts", { XDG_CONFIG_HOME: "/xdg" })).toBe(
			"/xdg/opencode/plugins/interlinked-opencode2.ts",
		);
	});
	it("defaults to ~/.config/opencode/plugins", () => {
		expect(opencodeUserPluginRelPath("interlinked-opencode2.ts", { HOME: "/home/u" })).toBe(
			"~/.config/opencode/plugins/interlinked-opencode2.ts",
		);
	});
});

describe("detectClients OpenCode mutual exclusion", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});
	it("directory .opencode detects v1 only", () => {
		const cwd = mkdtempSync(join(tmpdir(), "oc-detect-"));
		dirs.push(cwd);
		mkdirSync(join(cwd, ".opencode"));
		const names = detectClients(cwd, {}).filter((c) => c.exists).map((c) => c.name);
		expect(names).toContain("opencode");
		expect(names).not.toContain("opencode2");
	});
	it("OPENCODE2 env detects v2 and not v1 from the shared directory", () => {
		const cwd = mkdtempSync(join(tmpdir(), "oc-detect-"));
		dirs.push(cwd);
		mkdirSync(join(cwd, ".opencode"));
		const names = detectClients(cwd, { OPENCODE2: "1" }).filter((c) => c.exists).map((c) => c.name);
		expect(names).toContain("opencode2");
		expect(names).not.toContain("opencode");
	});
});
