import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamExternalTools } from "./verify-tools.js";

const binary = resolve("node_modules/.bin/biome");
vi.mock("../../harness/check-engine/spawn-async.js", async original => {
	const actual = await original<typeof import("../../harness/check-engine/spawn-async.js")>();
	return { ...actual, runProcessAsync: (command: string, args: string[], options: import("../../harness/check-engine/spawn-async.js").RunProcessOptions) => {
		const executable = args.indexOf("biome");
		// Keep the real managed runner and scanner while avoiding npx downloads.
		return command === "npx" && executable >= 0
			? actual.runProcessAsync(binary, args.slice(executable + 1), options)
			: actual.runProcessAsync(command, args, options);
	} };
});
vi.mock("./check-timing.js", () => ({ measureVerifyCheckAsync: async (_id: string, work: () => Promise<unknown>) => work(), recordVerifyInputDeferral: vi.fn() }));
let root: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "human-native-biome-")));
	writeFileSync(join(root, "biome.json"), JSON.stringify({ formatter: { enabled: false }, assist: { enabled: false }, linter: { enabled: true, rules: { recommended: false, suspicious: { noDebugger: "warn" } } } }));
	vi.stubEnv("BIOME_CONFIG_PATH", join(root, "biome.json"));
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
	process.exitCode = 0;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!existsSync(binary))("human verification with native Biome", () => {
	it.each([{ name: "33 warnings", count: 33, source: "debugger;\n".repeat(33) },
		{ name: "source beyond one MiB", count: 1, source: "// padding\n".repeat(110000) + "debugger;\n" }])("retains $name through the actual managed process and human parser", async ({ count, source }) => {
		writeFileSync(join(root, "source.js"), source);
		const summary: Array<{ label: string; count: number; color: string }> = [];
		const flagged = new Set<string>();
		await streamExternalTools({ engine: { discoverTools: () => [{ id: "biome", available: true }] }, cwd: root,
			opts: { only: "biome" }, skipChecks: new Set(), summary, allFlaggedFiles: flagged, details: false });
		expect(summary).toMatchObject([{ count }]);
		expect(flagged).toEqual(new Set(["source.js"]));
		expect(process.exitCode).toBe(0);
		expect(readFileSync(join(root, "source.js"), "utf8")).toBe(source);
	});
});
