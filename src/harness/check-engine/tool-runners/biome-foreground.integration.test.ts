import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckEngine } from "../index.js";
import { runProcessAsync } from "../spawn-async.js";

const binary = resolve("node_modules/.bin/biome");
vi.mock("../spawn-async.js", async original => {
	const actual = await original<typeof import("../spawn-async.js")>();
	return { ...actual, runProcessAsync: vi.fn((command, args, options) => {
		// Exercise the actual scanner without npx package resolution or downloads.
		return command === "npx" && args[0] === "biome"
			? actual.runProcessAsync(binary, args.slice(1), options)
			: actual.runProcessAsync(command, args, options);
	}) };
});
let root: string;
const config = { formatter: { enabled: false }, assist: { enabled: false }, linter: { enabled: true, rules: { recommended: false, suspicious: { noDebugger: "warn" } } } };
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "biome-foreground-")));
	writeFileSync(join(root, "biome.json"), JSON.stringify(config));
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(runProcessAsync).mockClear(); rmSync(root, { recursive: true, force: true }); });

async function check() {
	const engine = new CheckEngine(root);
	vi.spyOn(engine, "discoverTools").mockReturnValue([{ id: "biome", available: true }]);
	return engine.runChecksAsync({ projectRoot: root, mode: "project" }, { tools: ["biome"], admissionAlreadyHeld: true, resourcePolicy: "foreground-verify" });
}

describe.skipIf(!existsSync(binary))("native foreground Biome population", () => {
	it("retains 33 native zero-exit warnings through the actual engine", async () => {
		writeFileSync(join(root, "warnings.js"), "debugger;\n".repeat(33));
		const report = await check();
		expect(report.results).toHaveLength(33);
		expect(report.skipped).toEqual([]);
		expect(vi.mocked(runProcessAsync).mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["--reporter=json", "--max-diagnostics=none"]));
	});
	it("checks a source file beyond the implicit one-MiB native limit", async () => {
		writeFileSync(join(root, "large.js"), "// padding\n".repeat(110000) + "debugger;\n");
		const report = await check();
		expect(report.results.map(row => row.ruleId)).toEqual(["lint/suspicious/noDebugger"]);
		expect(report.skipped).toEqual([]);
	});
	it("preserves configured maximums as unavailable scope with positive findings retained", async () => {
		writeFileSync(join(root, "biome.json"), JSON.stringify({ ...config, files: { maxSize: 128 } }));
		writeFileSync(join(root, "visible.js"), "debugger;\n");
		writeFileSync(join(root, "large.js"), "// padding\n".repeat(100) + "debugger;\n");
		const report = await check();
		expect(report.results.map(row => row.file)).toEqual(["visible.js"]);
		expect(report.skipped).toMatchObject([{ check: "biome", category: "error", reason: expect.stringContaining("large.js") }]);
		expect(report.toolsRun).toEqual([]);
	});
	it("preserves configured file includes without broadening the scanned population", async () => {
		writeFileSync(join(root, "biome.json"), JSON.stringify({ ...config, files: { includes: ["**", "!**/excluded.js"] } }));
		writeFileSync(join(root, "visible.js"), "debugger;\n");
		writeFileSync(join(root, "excluded.js"), "debugger;\n".repeat(33));
		const report = await check();
		expect(report.results.map(row => row.file)).toEqual(["visible.js"]);
		expect(report.skipped).toEqual([]);
	});
});
