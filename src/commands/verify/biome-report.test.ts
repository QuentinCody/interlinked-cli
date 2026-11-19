import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { streamExternalTools } from "./verify-tools.js";
import type { CheckResult } from "../../harness/check-engine/types.js";

const effects = vi.hoisted(() => ({ output: "", status: 0, calls: vi.fn() }));
vi.mock("./check-timing.js", () => ({ measureVerifyCheckAsync: async (_id: string, work: () => Promise<unknown>) => work(), recordVerifyInputDeferral: vi.fn() }));
vi.mock("./streaming-output.js", () => {
	async function run(args: { parseOutput: (output: string, status: number) => CheckResult[]; recoverPartial: (error: unknown) => CheckResult[] | undefined }) {
		effects.calls(args);
		try { return { items: args.parseOutput(effects.output, effects.status), elapsedMs: "0.0s" }; }
		catch (error) { return { items: args.recoverPartial(error) ?? [], elapsedMs: "0.0s", unavailable: error instanceof Error ? error.message : String(error) }; }
	}
	return { runToolSilent: run, runToolWithSpinner: run, SPINNER_FRAMES: ["."] };
});
let root: string;
let stderr: string[];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "human-biome-report-"));
	writeFileSync(join(root, "biome.json"), "{}");
	effects.output = ""; effects.status = 0; effects.calls.mockClear();
	stderr = [];
	vi.spyOn(process.stderr, "write").mockImplementation(chunk => { stderr.push(String(chunk)); return true; });
	process.exitCode = 0;
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; rmSync(root, { recursive: true, force: true }); });
function report(extra: Record<string, unknown> = {}) {
	return JSON.stringify({ summary: { errors: 0, warnings: 33, infos: 0, skipped: 0, diagnosticsNotPrinted: 0, ...extra }, diagnostics: Array.from({ length: 33 }, (_, index) => ({ severity: "warning", category: "lint/suspicious/noDebugger", message: "fixture warning", location: { path: "a.js", start: { line: index + 1, column: 1 } } })) });
}
async function run() {
	const summary: Array<{ label: string; count: number; color: string }> = [];
	await streamExternalTools({ engine: { discoverTools: () => [{ id: "biome", available: true }] }, cwd: root, opts: { only: "biome" }, skipChecks: new Set(), summary, allFlaggedFiles: new Set(), details: false });
	return summary;
}
it("retains native-shaped zero-exit warning population in human verification", async () => {
	effects.output = report();
	expect(await run()).toMatchObject([{ count: 33 }]);
	expect(effects.calls.mock.calls[0]?.[0]).toMatchObject({ cmd: expect.arrayContaining(["--reporter=json", "--max-diagnostics=none"]), reportStream: "stdout" });
	expect(process.exitCode).toBe(0);
});
it("keeps positive findings alongside unavailable coverage in human verification", async () => {
	effects.output = report({ diagnosticsNotPrinted: 13 });
	expect(await run()).toMatchObject([{ count: 33 }]);
	expect(stderr.join("")).toContain("NOT CHECKED");
	expect(process.exitCode).toBe(75);
});
it("rejects malformed successful Biome output as unavailable", async () => {
	effects.output = "{ malformed";
	expect(await run()).toEqual([]);
	expect(stderr.join("")).toContain("NOT CHECKED");
	expect(process.exitCode).toBe(75);
});
