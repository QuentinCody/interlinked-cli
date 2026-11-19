import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runProcessAsync } from "../../harness/check-engine/spawn-async.js";
import { parseDependencyAudit, runVerifyDependencyAudit } from "./dependency-audit.js";
import { resolveDependencyAuditCommandAsync } from "../../harness/quality-checks/dependency-audit.js";
import { withProcessCancellation } from "../../harness/check-engine/process-cancellation.js";

vi.mock("../../harness/check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
vi.mock("../../harness/quality-checks/dependency-audit.js", () => ({ resolveDependencyAuditCommandAsync: vi.fn() }));
const roots: string[] = [];
const clean = JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } });
beforeEach(() => {
	vi.mocked(runProcessAsync).mockReset();
	vi.mocked(resolveDependencyAuditCommandAsync).mockResolvedValue({ parser: "npm-audit", cmd: ["npm", "audit", "--json", "--audit-level=moderate"] });
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(packageFile = true): string {
	const root = mkdtempSync(join(resolve("scratch"), "verify-audit-"));
	roots.push(root);
	if (packageFile) writeFileSync(join(root, "package.json"), "{}");
	return root;
}

it("returns an explicit clean completed audit from a validated zero report", async () => {
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout: clean, stderr: "", timedOut: false, killed: false });
	const report = await runVerifyDependencyAudit(project(), 1000);
	expect(report).toMatchObject({ audit: null });
	expect(report.skipped).toBeUndefined();
	expect(runProcessAsync).toHaveBeenCalledTimes(1);
	expect(resolveDependencyAuditCommandAsync).toHaveBeenCalledWith("package.json", { probeTimeoutMs: 1000 });
});

it("the default audit also removes the hidden OSV availability deadline", async () => {
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout: clean, stderr: "", timedOut: false, killed: false });
	await runVerifyDependencyAudit(project(), 0);
	expect(resolveDependencyAuditCommandAsync).toHaveBeenCalledWith("package.json", { probeTimeoutMs: 0 });
});

it("keeps mixed npm/Cargo coverage unavailable when the actual foreground OSV resolver's version probe exits two", async () => {
	const root = project();
	writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.1.0"\n');
	const actual = await vi.importActual<typeof import("../../harness/quality-checks/dependency-audit.js")>("../../harness/quality-checks/dependency-audit.js");
	vi.mocked(resolveDependencyAuditCommandAsync).mockImplementationOnce(actual.resolveDependencyAuditCommandAsync);
	vi.mocked(runProcessAsync).mockImplementation(async (binary, args) => {
		if (binary === "osv-scanner" && args[0] === "--version") return { code: 2, stdout: "", stderr: "OSV probe failed", timedOut: false, killed: false };
		if (binary === "npm") return { code: 0, stdout: clean, stderr: "", timedOut: false, killed: false };
		throw new Error(`Unexpected process ${binary}`);
	});
	const report = await runVerifyDependencyAudit(root, 0);
	expect(report.audit).toBeNull();
	expect(report.skipped).toMatchObject({ check: "dep-audit", category: "error", reason: expect.stringContaining("OSV availability probe exited 2") });
	expect(runProcessAsync).toHaveBeenCalledExactlyOnceWith("osv-scanner", ["--version"], { timeout: 0 });
});

it.each([
	{ code: 1, stdout: "{\"error\":{\"code\":\"ENOLOCK\"}}", timedOut: false, killed: false },
	{ code: 0, stdout: "malformed", timedOut: false, killed: false },
	{ code: null, stdout: clean, timedOut: true, killed: true },
	{ code: 0, stdout: clean, timedOut: false, killed: false, stdoutTruncated: true },
])("retains unavailable audit evidence for failed/incomplete reports %j", async result => {
	vi.mocked(runProcessAsync).mockResolvedValue({ ...result, stderr: "audit unavailable" });
	const report = await runVerifyDependencyAudit(project(), 1000);
	expect(report.audit).toBeNull();
	expect(report.skipped).toMatchObject({ check: "dep-audit", category: "error" });
});

it("retains positive vulnerability counts from a valid nonzero report", () => {
	const output = JSON.stringify({ metadata: { vulnerabilities: { low: 0, moderate: 0, high: 2, critical: 0, total: 2 } } });
	expect(parseDependencyAudit(output)).toMatchObject({ total: 2, high: 2 });
});

it("does not execute an audit against an ancestor package", async () => {
	const root = project();
	const child = join(root, "child");
	mkdirSync(child);
	const report = await runVerifyDependencyAudit(child, 1000);
	expect(report.skipped).toMatchObject({ category: "file_type_mismatch" });
	expect(runProcessAsync).not.toHaveBeenCalled();
});

it.each(["go.mod", "Cargo.lock", "requirements.txt", "pom.xml"])("runs OSV for %s without a Node manifest", async manifest => {
	const root = project(false);
	writeFileSync(join(root, manifest), "fixture");
	vi.mocked(resolveDependencyAuditCommandAsync).mockResolvedValue({ parser: "osv-scanner", cmd: ["osv-scanner"] });
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout: '{"results":[]}', stderr: "", timedOut: false, killed: false });
	const report = await runVerifyDependencyAudit(root, 1000);
	expect(report.skipped).toBeUndefined();
	expect(runProcessAsync).toHaveBeenCalledWith("osv-scanner", ["scan", "source", "--format=json", "--recursive", "."], { cwd: root, timeout: 1000, maxBufferBytes: null });
});

it("preserves non-Node audit unavailability when OSV is absent", async () => {
	const root = project(false);
	writeFileSync(join(root, "go.mod"), "module example.com/fixture");
	const report = await runVerifyDependencyAudit(root, 1000);
	expect(report.skipped).toMatchObject({ category: "error", reason: expect.stringContaining("osv-scanner") });
	expect(runProcessAsync).not.toHaveBeenCalled();
});

it("retains OSV findings across its multi-ecosystem report shape", async () => {
	vi.mocked(resolveDependencyAuditCommandAsync).mockResolvedValue({ parser: "osv-scanner", cmd: ["osv-scanner"] });
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 1, stdout: JSON.stringify({ results: [{ packages: [{ vulnerabilities: [{ id: "GHSA-example" }], groups: [{ ids: ["GHSA-example"], max_severity: "9.8" }] }] }] }), stderr: "", timedOut: false, killed: false });
	expect((await runVerifyDependencyAudit(project(), 1000)).audit).toMatchObject({ tool: "osv-scanner", critical: 1, total: 1 });
});

it("retains the OSV failure and npm fallback findings without a false multi-ecosystem clean verdict", async () => {
	vi.mocked(resolveDependencyAuditCommandAsync).mockResolvedValue({ parser: "osv-scanner", cmd: ["osv-scanner"] });
	vi.mocked(runProcessAsync).mockResolvedValueOnce({ code: 128, stdout: "", stderr: "OSV failed", timedOut: false, killed: false })
		.mockResolvedValueOnce({ code: 1, stdout: JSON.stringify({ metadata: { vulnerabilities: { low: 0, moderate: 0, high: 1, critical: 0, total: 1 } } }), stderr: "", timedOut: false, killed: false });
	const report = await runVerifyDependencyAudit(project(), 1000);
	expect(report.audit).toMatchObject({ tool: "npm audit", total: 1 });
	expect(report.skipped).toMatchObject({ category: "error", reason: expect.stringContaining("OSV") });
	expect(runProcessAsync).toHaveBeenCalledTimes(2);
});

it("cancellation stops before an OSV failure can launch an npm fallback", async () => {
	const controller = new AbortController();
	vi.mocked(resolveDependencyAuditCommandAsync).mockResolvedValue({ parser: "osv-scanner", cmd: ["osv-scanner"] });
	vi.mocked(runProcessAsync).mockImplementationOnce(async () => {
		controller.abort(new Error("Operator cancelled audit"));
		return { code: null, stdout: "", stderr: "", timedOut: false, killed: true };
	});
	await expect(withProcessCancellation(controller.signal, () => runVerifyDependencyAudit(project(), 1000))).rejects.toThrow("Operator cancelled audit");
	expect(runProcessAsync).toHaveBeenCalledTimes(1);
});

it.each(["", '{"results":[null]}', '{"results":[{"packages":[{"vulnerabilities":[{"id":"GHSA-example"}]}]}]}'])("malformed/incomplete successful OSV output retains unavailable evidence %s", async stdout => {
	const root = project(false);
	writeFileSync(join(root, "Cargo.lock"), "fixture");
	vi.mocked(resolveDependencyAuditCommandAsync).mockResolvedValue({ parser: "osv-scanner", cmd: ["osv-scanner"] });
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout, stderr: "", timedOut: false, killed: false });
	expect((await runVerifyDependencyAudit(root, 1000)).skipped).toMatchObject({ category: "error" });
});
