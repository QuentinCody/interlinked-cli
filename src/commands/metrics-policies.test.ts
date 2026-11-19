import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { metricsPoliciesExportCommand, metricsPoliciesInspectCommand, metricsPoliciesEvaluateCommand } from "./metrics-policies.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); process.exitCode = 0; });
function project() {
	const root = mkdtempSync(join(tmpdir(), "metrics-policies-command-")); roots.push(root);
	mkdirSync(join(root, ".interlinked"));
	writeFileSync(join(root, ".interlinked/check-policy.json"), JSON.stringify({ metrics: { cyclomatic: { mode: "warn", threshold: 10 } } }));
	return root;
}
function capture() {
	let stdout = "", stderr = "";
	vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => { stdout += `${values.map(String).join(" ")}\n`; });
	vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => { stderr += `${values.map(String).join(" ")}\n`; });
	return { stdout: () => stdout, stderr: () => stderr };
}
describe("metrics policies commands", () => {
	it("exports a versioned data-only profile while preserving active settings", () => {
		const root = project(), path = join(root, ".interlinked/check-policy.json"), before = readFileSync(path, "utf8"), io = capture();
		metricsPoliciesExportCommand({ cwd: root, json: true, id: "team-policy" });
		expect(JSON.parse(io.stdout())).toMatchObject({ schemaVersion: 1, id: "team-policy", metrics: { cyclomatic: { mode: "warn", threshold: 10 } } });
		expect(readFileSync(path, "utf8")).toBe(before);
	});
	it("inspects a local profile without running target scripts", () => {
		const root = project(), io = capture();
		writeFileSync(join(root, "policy.json"), JSON.stringify({ schemaVersion: 1, id: "team", metrics: { "file.lines": { mode: "block", threshold: 1 } } }));
		metricsPoliciesInspectCommand("policy.json", { cwd: root, json: true });
		const result = JSON.parse(io.stdout());
		expect(result.metrics[0]).toMatchObject({ id: "file.lines", requestedMode: "block", reportMode: "warn", editPolicy: null,
			advisoryHook: true, reportReading: false, measurementContract: 'content.split("\\n").length', retainedReadingContract: "Physical lines excluding the terminal empty segment" });
		expect(result.modelCalls).toBe(0);
	});
	it("shows distinct AST and canonical token capabilities", () => {
		const root = project(), io = capture();
		writeFileSync(join(root, "policy.json"), JSON.stringify({ schemaVersion: 1, id: "team", metrics: { tokens: { threshold: 100 }, "function-tokens": { threshold: 400 } } }));
		metricsPoliciesInspectCommand("policy.json", { cwd: root, json: true });
		const result = JSON.parse(io.stdout());
		expect(result.metrics.find((row: { id: string }) => row.id === "tokens")).toMatchObject({ editPolicy: null, reportReading: true, measurementContract: "interlinked-ts-ast-v1" });
		expect(result.metrics.find((row: { id: string }) => row.id === "function-tokens")).toMatchObject({ editPolicy: "function-tokens", reportReading: false, measurementContract: "interlinked-code-v2" });
	});
	it("rejects executable profile fields with an explicit error result", () => {
		const root = project(), io = capture();
		writeFileSync(join(root, "policy.json"), JSON.stringify({ schemaVersion: 1, id: "team", command: "echo unsafe" }));
		metricsPoliciesInspectCommand("policy.json", { cwd: root, json: true });
		expect(`${io.stdout()}${io.stderr()}`).toContain("unsupported fields command");
	});
	it("does not export malformed current policy as empty configuration", () => {
		const root = project(), io = capture();
		writeFileSync(join(root, ".interlinked/check-policy.json"), "{broken");
		metricsPoliciesExportCommand({ cwd: root, json: true });
		expect(io.stdout()).toBe("");
		expect(io.stderr()).toContain("Configured check policy");
	});
	it("evaluates configured metrics with all retained project readings", () => {
		const root = project(), io = capture(); writeFileSync(join(root, "index.ts"), "export const value = 1;");
		metricsPoliciesEvaluateCommand(undefined, { cwd: root, json: true });
		const result = JSON.parse(io.stdout());
		expect(result.measurements.metrics).toHaveLength(23);
		expect(result.profile.metrics.cyclomatic.threshold).toBe(10);
		expect(result.actions.modelCalls).toBe(0);
	});
});
