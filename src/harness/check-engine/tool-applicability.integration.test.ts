import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CheckEngine } from "./index.js";
import { runProcessAsync } from "./spawn-async.js";
import { streamExternalTools } from "../../commands/verify/verify-tools.js";
import type { CheckReport, ToolId } from "./types.js";
import { runBatchDependencyAudit } from "../../commands/verify/dependency-audit.js";
import * as auditCommands from "../quality-checks/dependency-audit.js";

vi.mock("./spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
const roots: string[] = [];
const originalExit = process.exitCode;
afterEach(() => { vi.restoreAllMocks(); vi.mocked(runProcessAsync).mockReset(); process.exitCode = originalExit; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(): string {
	const root = mkdtempSync(join(resolve("scratch"), "applicability-engine-"));
	roots.push(root);
	return root;
}
function engine(root: string, ids: ToolId[]): CheckEngine {
	const result = new CheckEngine(root);
	vi.spyOn(result, "discoverTools").mockReturnValue(ids.map(id => ({ id, available: true })));
	return result;
}
async function human(root: string, checks: CheckEngine, only?: string): Promise<string> {
	let text = "";
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { text += String(chunk); return true; });
	try {
		await streamExternalTools({ engine: checks, cwd: root, opts: only ? { only } : {}, skipChecks: new Set(), summary: [], allFlaggedFiles: new Set(), details: false });
		return text;
	} finally { stderr.mockRestore(); }
}

it("JavaScript-only input gives applicability evidence in JSON and human modes without executing tools", async () => {
	process.exitCode = undefined;
	const root = project();
	writeFileSync(join(root, "index.js"), "export const answer = 42;\n");
	const checks = engine(root, ["rustfmt", "c-compile", "docs-check", "dep-audit"]);
	const report = await checks.runChecksAsync({ projectRoot: root, mode: "project" }, { admissionAlreadyHeld: true });
	expect(report.skipped).toHaveLength(4);
	expect(report.skipped.every(row => row.category === "file_type_mismatch")).toBe(true);
	expect(report.toolsRun).toEqual([]);
	const output = await human(root, checks);
	expect(output).toContain("rustfmt: NOT APPLICABLE");
	expect(output).toContain("c-compile: NOT APPLICABLE");
	expect(output).not.toContain("NOT CHECKED");
	expect(runProcessAsync).not.toHaveBeenCalled();
	expect(process.exitCode).toBeUndefined();
});

it("fixture Rust crates inside a non-Rust project retain intentional scope exclusions", async () => {
	const root = project();
	mkdirSync(join(root, "fixtures/crate/src"), { recursive: true });
	writeFileSync(join(root, "fixtures/crate/Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n');
	writeFileSync(join(root, "fixtures/crate/src/lib.rs"), "pub fn value()->u8{1}\n");
	const checks = engine(root, ["rustfmt"]);
	const report = await checks.runChecksAsync({ projectRoot: root, mode: "project" }, { admissionAlreadyHeld: true, resourcePolicy: "foreground-verify" });
	expect(report.skipped).toEqual([{ check: "rustfmt", category: "config_disabled", reason: expect.stringContaining("fixture") }]);
	expect(report.toolsRun).toEqual([]);
	expect(runProcessAsync).not.toHaveBeenCalled();
});

it.each([{ id: "c-compile" as const, file: "main.c" }])("relevant $id inputs retain unsupported capability evidence", async ({ id, file }) => {
	process.exitCode = undefined;
	const root = project();
	writeFileSync(join(root, file), "fixture\n");
	const checks = engine(root, [id]);
	const report = await checks.runChecksAsync({ projectRoot: root, mode: "project" }, { admissionAlreadyHeld: true });
	expect(report.skipped).toEqual([{ check: id, category: "error", reason: expect.stringContaining("async runner unavailable") }]);
	expect(await human(root, checks, id)).toContain(`${id}: NOT CHECKED`);
	expect(await human(root, checks)).toContain(`${id}: NOT CHECKED`);
	expect(process.exitCode).toBe(75);
	expect(runProcessAsync).not.toHaveBeenCalled();
});

it("root Rust sources reach the managed rustfmt runner in JSON and human modes", async () => {
	process.exitCode = undefined;
	const root = project(), file = join(root, "lib.rs");
	writeFileSync(file, "pub fn value()->u8{1}\n");
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 1, stdout: `Diff in ${file}:1:\n`, stderr: "", timedOut: false, killed: false });
	const checks = engine(root, ["rustfmt"]);
	const report = await checks.runChecksAsync({ projectRoot: root, mode: "project" }, { admissionAlreadyHeld: true, resourcePolicy: "foreground-verify", timeoutMs: 0 });
	expect(report.toolsRun.map(tool => tool.id)).toEqual(["rustfmt"]);
	expect(report.results).toMatchObject([{ tool: "rustfmt", file: "lib.rs", line: 1 }]);
	expect(report.skipped).toEqual([]);
	const output = await human(root, checks, "rustfmt");
	expect(output).toContain("formatting differences");
	expect(output).not.toContain("async runner unavailable");
	expect(process.exitCode).toBeUndefined();
});

it("does not execute an ancestor documentation script from a selected child", async () => {
	const root = project();
	mkdirSync(join(root, "scripts"));
	writeFileSync(join(root, "scripts/check-docs.mjs"), "throw new Error('unrelated target script');");
	const child = join(root, "child");
	mkdirSync(child);
	const checks = engine(child, ["docs-check"]);
	const report = await checks.runChecksAsync({ projectRoot: child, mode: "project" }, { admissionAlreadyHeld: true });
	expect(report.skipped).toEqual([{ check: "docs-check", category: "file_type_mismatch", reason: "No project-local scripts/check-docs.mjs" }]);
	await human(child, checks, "docs-check");
	expect(runProcessAsync).not.toHaveBeenCalled();
});

it("human and JSON dedicated audits retain Go dependency scope without a Node manifest", async () => {
	process.exitCode = undefined;
	const root = project();
	writeFileSync(join(root, "go.mod"), "module example.com/fixture\n");
	vi.spyOn(auditCommands, "resolveDependencyAuditCommandAsync").mockResolvedValue({ parser: "osv-scanner", cmd: ["osv-scanner"] });
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout: '{"results":[]}', stderr: "", timedOut: false, killed: false });
	const report: CheckReport = { results: [], toolsRun: [], toolsSkipped: [], skipped: [], elapsedMs: 0, metrics: [], deduplicatedCount: 0 };
	expect(await runBatchDependencyAudit(report, root, "dep-audit", new Set())).toBeNull();
	expect(report.toolsRun).toEqual([{ id: "dep-audit", available: true }]);
	expect(report.skipped).toEqual([]);
	const output = await human(root, engine(root, ["dep-audit"]), "dep-audit");
	expect(output).toContain("no known vulnerabilities");
	expect(output).not.toContain("NOT CHECKED");
	expect(runProcessAsync).toHaveBeenCalledTimes(2);
	expect(vi.mocked(runProcessAsync).mock.calls.every(([command]) => command === "osv-scanner")).toBe(true);
	expect(process.exitCode).toBeUndefined();
});
