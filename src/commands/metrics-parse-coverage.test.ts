import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as parser from "../harness/checks/cyclomatic-ast.js";
import { metricsCommand } from "./metrics.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(files: Record<string, string>) {
	const root = mkdtempSync(join(process.cwd(), "scratch", "main-metrics-parser-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
	return root;
}
async function capture(root: string) {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	await metricsCommand({ cwd: root, json: true });
	expect(process.exitCode ?? 0).toBe(0);
	return JSON.parse(String(log.mock.calls[0]?.[0]));
}

describe("main metrics parser coverage", () => {
	// test-contract: public-api — an exact-source report must retain parser failure beside valid measurements.
	it("retains valid measurements and names malformed source instead of measuring its recovery tree", async () => {
		const root = fixture({ "valid.ts": "export function valid(value: boolean) { return value ? 1 : 0; }",
			"broken.ts": "export function broken(value: boolean) { if (value) return 1;" });
		const report = await capture(root);
		expect(report.scope).toMatchObject({ files: 1, functions: 1 });
		expect(report.files.map((file: { file: string }) => file.file)).toEqual(["valid.ts"]);
		expect(report.functions.map((fn: { name: string }) => fn.name)).toEqual(["valid"]);
		expect(report.sourceInventory.notMeasured).toContainEqual(expect.objectContaining({ file: "broken.ts", reason: expect.stringContaining("recovery") }));
		expect(report.actions.actions.some((action: { classification: string; file: string }) => action.classification === "evidence_gap" && action.file === "broken.ts")).toBe(true);
	});

	it("reports absent optional parser coverage without a regex-derived complexity verdict", async () => {
		const root = fixture({ "valid.ts": "export function valid(value: boolean) { return value ? 1 : 0; }" });
		vi.spyOn(parser, "parseTsSource").mockReturnValue(null);
		const report = await capture(root);
		expect(report.scope).toMatchObject({ files: 0, functions: 0 });
		expect(report.functions).toEqual([]);
		expect(report.sourceInventory.notMeasured).toContainEqual(expect.objectContaining({ file: "valid.ts", reason: expect.stringContaining("parser unavailable") }));
	});

	it("keeps an exact module with zero function implementations in the measured file scope", async () => {
		const report = await capture(fixture({ "values.ts": "export const value = 1;" }));
		expect(report.scope).toMatchObject({ files: 1, functions: 0 });
		expect(report.sourceInventory.notMeasured).toEqual([]);
		expect(report.files[0]).toMatchObject({ file: "values.ts", functions: 0, maxCyclomatic: 0 });
	});
});
