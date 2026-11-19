import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metricsDiagnosticsCommand } from "./metrics-diagnostics.js";
import { metricsPoliciesEvaluateCommand } from "./metrics-policies.js";
import { metricsScoreCommand } from "./metrics-score.js";
import { metricsStandardsCommand } from "./metrics-standards.js";
import { metricsCommand } from "./metrics.js";

let root: string;
let original: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(process.cwd(), "scratch", "metrics-full-input-")));
	original = `/* ${"x".repeat(2 * 1024 * 1024)} */\nexport function surveyedTail(value: number) { if (value > 0) return value; return 0; }\n`;
	writeFileSync(join(root, "index.ts"), original);
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "touch EXECUTED" } }));
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
	rmSync(root, { recursive: true, force: true });
});

// User requirement: explicit surveys must measure the selected whole source;
// a function after 2 MiB is still source, while an unreadable input stays unknown.
async function capture(run: () => void | Promise<void>) {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	await run();
	expect(error.mock.calls).toEqual([]);
	expect(process.exitCode ?? 0).toBe(0);
	expect(readFileSync(join(root, "index.ts"), "utf8")).toBe(original);
	expect(existsSync(join(root, "EXECUTED"))).toBe(false);
	return JSON.parse(String(log.mock.calls[0]?.[0]));
}

describe("foreground metric surveys retain code beyond former input limits", () => {
	it("measures the tail function in the composite score without a model", async () => {
		const report = await capture(() => metricsScoreCommand({ cwd: root, json: true }));
		expect(report.scope).toMatchObject({ measuredFiles: 1, functions: 1, notMeasured: [], discoveryIssues: [] });
		expect(report.modelCalls).toBe(0);
	});

	it("measures the tail function in legacy structural scoring", async () => {
		const report = await capture(() => metricsScoreCommand({ cwd: root, profile: "structure-v1", json: true }));
		expect(report.scope).toMatchObject({ measuredFiles: 1, functions: 1, notMeasured: [], discoveryIssues: [] });
		expect(report.files[0].functions.some((fn: { name: string }) => fn.name === "surveyedTail")).toBe(true);
		expect(report.measurement).toMatchObject({ modelCalls: 0, repositoryCodeExecuted: false });
	});

	it("retains diagnostic functions instead of reporting a large source as unavailable", async () => {
		const report = await capture(() => metricsDiagnosticsCommand({ cwd: root, json: true }));
		expect(report.scope).toMatchObject({ measuredFiles: 1, notMeasured: [], discoveryIssues: [] });
		expect(report.functions.some((fn: { name: string }) => fn.name === "surveyedTail")).toBe(true);
		expect(report.modelCalls).toBe(0);
	});

	it("uses the same complete inventory for policy rules and metric readings", async () => {
		const report = await capture(() => metricsPoliciesEvaluateCommand(undefined, { cwd: root, json: true }));
		expect(report.scope.gaps).toEqual([]);
		expect(report.scope.inputHash).toBe(report.scope.metricInputHash);
		expect(report.measurements.scope).toMatchObject({ measuredFiles: 1, functions: 1 });
		expect(report.modelCalls).toBe(0);
	});

	it("retains standards source units and compares the same full snapshot afterward", async () => {
		const report = await capture(() => metricsStandardsCommand({ cwd: root, json: true }));
		expect(report.inventory).toMatchObject({ selectedFiles: 1, gaps: [], issues: [] });
		expect(report.units.some((unit: { name: string }) => unit.name === "surveyedTail")).toBe(true);
		expect(report.provenance.sourceConsistency).toMatchObject({ state: "stable_selected_snapshot", selectedFilesChecked: 1, discoveryIssues: [] });
		expect(report.modelCalls).toBe(0);
	});

	it("main metrics retains the large-file function and an unreadable discovered input", async () => {
		symlinkSync("absent.ts", join(root, "unreadable.ts"));
		const report = await capture(() => metricsCommand({ cwd: root, json: true }));
		expect(report.scope).toMatchObject({ files: 1, functions: 1 });
		expect(report.functions.some((fn: { name: string }) => fn.name === "surveyedTail")).toBe(true);
		expect(report.sourceInventory.notMeasured).toContainEqual(expect.objectContaining({ file: "unreadable.ts", reason: expect.stringContaining("ENOENT") }));
	});
});
