import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	installOpencode2Hooks,
	isOpencode2PluginInstalled,
	uninstallOpencode2Hooks,
} from "./hook-installers-opencode.js";
import { OPENCODE_PLUGIN_MARKER } from "./opencode-plugin-source.js";

describe("OpenCode plugin installer", () => {
	let dir: string;
	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	function tmp(): string {
		dir = mkdtempSync(join(tmpdir(), "opencode-install-"));
		dirs.push(dir);
		return dir;
	}

	it("P1: writes a marked plugin under .opencode/plugins", () => {
		const cwd = tmp();
		installOpencode2Hooks(cwd, "/unused/hook.mjs");
		const plugin = join(cwd, ".opencode", "plugins", "interlinked-opencode2.ts");
		const body = readFileSync(plugin, "utf-8");
		expect(body.startsWith("// interlinked-provider-bridge:v1\n")).toBe(true);
		expect(body).toContain(OPENCODE_PLUGIN_MARKER);
		expect(body).toContain("execute.before");
		expect(body).toContain("export default");
		expect(body).toContain('id: PLUGIN_ID');
		expect(body).toContain("export const InterlinkedPlugin");
		expect(body).toContain("setup:");
		expect(body).toContain("execute.before");
		expect(body).toContain("session.deleted");
		expect(body).toContain("SessionEnd");
		expect(body).toContain("event.subscribe");
		expect(body).toContain("(?:r[a-zA-Z]*f|f[a-zA-Z]*r)");
		expect(isOpencode2PluginInstalled(cwd)).toBe(true);
	});

	it("P2: uninstall removes our plugin", () => {
		const cwd = tmp();
		installOpencode2Hooks(cwd, "");
		expect(uninstallOpencode2Hooks(cwd)).toBe(true);
		expect(isOpencode2PluginInstalled(cwd)).toBe(false);
	});

	it("N1: uninstall is a no-op when the plugin is absent", () => {
		expect(uninstallOpencode2Hooks(tmp())).toBe(false);
	});

	it("P3: install removes a leftover Interlinked .js plugin", () => {
		const cwd = tmp();
		const dir = join(cwd, ".opencode", "plugins");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "interlinked-opencode2.js"), `// ${OPENCODE_PLUGIN_MARKER}\n`);
		installOpencode2Hooks(cwd, "");
		expect(existsSync(join(dir, "interlinked-opencode2.ts"))).toBe(true);
		expect(existsSync(join(dir, "interlinked-opencode2.js"))).toBe(false);
	});

	it("P4: does not overwrite a v1 managed interlinked.ts", () => {
		const cwd = tmp();
		const dir = join(cwd, ".opencode", "plugins");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "interlinked.ts"), "// interlinked-provider-bridge:v1\nexport const InterlinkedPlugin = async () => ({});\n");
		installOpencode2Hooks(cwd, "");
		expect(readFileSync(join(dir, "interlinked.ts"), "utf-8")).toContain("interlinked-provider-bridge:v1");
		expect(existsSync(join(dir, "interlinked-opencode2.ts"))).toBe(true);
	});
});
