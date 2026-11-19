import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runProcessAsync } from "../../harness/check-engine/spawn-async.js";
import { runAsyncTool } from "../../harness/check-engine/index-runtime.js";
import { currentVerifyTimings, withVerifyTimings } from "./check-timing.js";
import { streamExternalTools, TOOLS_TO_RUN } from "./verify-tools.js";

vi.mock("../../harness/check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks(); vi.resetAllMocks(); process.exitCode = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([{ errors: [] }, { errors: [{ message: "another.ts: parser unavailable" }] }])("retains Semgrep findings and separates incomplete scopes: $errors", async ({ errors }) => {
	const root = mkdtempSync(join(process.cwd(), "scratch/semgrep-verdict-")); roots.push(root);
	const writes = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const report = { results: [{ check_id: "example", path: "source.ts", start: { line: 9, col: 1 }, extra: { message: "Review source", severity: "WARNING" } }], errors };
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout: JSON.stringify(report), stderr: "Scanning files...\n", killed: false, timedOut: false });
	const flagged = new Set<string>();
	const summary: { label: string; count: number; color: string }[] = [];
	await withVerifyTimings(root, async () => {
		await streamExternalTools({ engine: { discoverTools: () => [{ id: "semgrep", available: true }] }, cwd: root,
			opts: { only: "semgrep" }, skipChecks: new Set(), summary, allFlaggedFiles: flagged, details: true });
		expect(currentVerifyTimings().find(row => row.check === "semgrep")?.skipped ?? 0).toBe(errors.length ? 1 : 0);
	});
	expect(flagged.has("source.ts")).toBe(true);
	expect(summary).toEqual([expect.objectContaining({ count: 1 })]);
	const output = writes.mock.calls.map(([text]) => text).join("");
	expect(output).not.toContain("no findings");
	if (errors.length) { expect(output).toContain("NOT CHECKED"); expect(process.exitCode).toBe(75); }
	else expect(output).not.toContain("NOT CHECKED");
});

it("disables Semgrep's implicit per-rule timeout, skip threshold and target size cutoff", () => {
	const command = TOOLS_TO_RUN.find(tool => tool.id === "semgrep")?.cmd;
	expect(command).toEqual(expect.arrayContaining(["--timeout", "0", "--timeout-threshold", "0", "--max-target-bytes", "0"]));
	for (const flag of ["--timeout", "--timeout-threshold", "--max-target-bytes"]) {
		expect(command?.[command.indexOf(flag) + 1]).toBe("0");
	}
});

it.each([
	{ label: "deadline expired", status: { code: null, timedOut: true, killed: true }, report: "", findings: 0 },
	{ label: "deadline expired", status: { code: null, timedOut: true, killed: true }, report: "positive", findings: 1 },
	{ label: "stdout was truncated", status: { code: 0, stdoutTruncated: true }, report: "{", findings: 0 },
	{ label: "process was interrupted", status: { code: null, killed: true }, report: "", findings: 0 },
	{ label: "report is malformed", status: { code: 0 }, report: "{", findings: 0 },
])("records $label and keeps $findings positives in both verify modes", async ({ label, status, report, findings }) => {
	const root = mkdtempSync(join(process.cwd(), "scratch/semgrep-execution-")); roots.push(root);
	const stdout = report === "positive" ? JSON.stringify({ results: [{ check_id: "sample", path: "source.ts", start: { line: 3 }, extra: { message: "positive finding" } }] }) : report;
	vi.mocked(runProcessAsync).mockResolvedValue({ stdout, stderr: "private scanner diagnostic", killed: false, timedOut: false, ...status });
	const tool = { id: "semgrep", available: true } as const;
	const json = await runAsyncTool(tool, { projectRoot: root, mode: "project" }, 10, { resourcePolicy: "foreground-verify" });
	expect(json.skipped).toMatchObject({ category: label === "deadline expired" ? "timeout" : "error", reason: expect.stringContaining(label) });
	expect(json.results).toHaveLength(findings);
	const writes = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const flagged = new Set<string>();
	await streamExternalTools({ engine: { discoverTools: () => [tool] }, cwd: root, opts: { only: "semgrep", toolTimeout: 10 }, skipChecks: new Set(), summary: [], allFlaggedFiles: flagged, details: true });
	const text = writes.mock.calls.map(([chunk]) => chunk).join("");
	expect(text).toContain(label);
	expect(text).not.toContain("private scanner diagnostic");
	expect(flagged.size).toBe(findings);
	expect(process.exitCode).toBe(75);
});

it.each([{ valid: [] }, { valid: [{ check_id: "retained", path: "source.ts", start: { line: 2, col: 1 }, extra: { message: "retained positive" } }] }])("retains malformed-row coverage in human verify without claiming an empty scan: %j", async ({ valid }) => {
	const root = mkdtempSync(join(process.cwd(), "scratch/semgrep-invalid-row-")); roots.push(root);
	const writes = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout: JSON.stringify({ results: [...valid, null], errors: [] }), stderr: "", killed: false, timedOut: false });
	const flagged = new Set<string>();
	await withVerifyTimings(root, () => streamExternalTools({ engine: { discoverTools: () => [{ id: "semgrep", available: true }] }, cwd: root,
		opts: { only: "semgrep" }, skipChecks: new Set(), summary: [], allFlaggedFiles: flagged, details: true }));
	expect(process.exitCode).toBe(75);
	const output = writes.mock.calls.map(([chunk]) => chunk).join("");
	expect(output).toContain("NOT CHECKED");
	expect(output).toContain("invalid result rows");
	expect(output).not.toContain("no findings");
	expect(flagged.has("source.ts")).toBe(valid.length > 0);
});

it.each(["not-json", "{}", '[{"invalid":true}]'])("does not certify an unusable successful Gitleaks report: %s", async stdout => {
	const root = mkdtempSync(join(process.cwd(), "scratch/gitleaks-verdict-")); roots.push(root);
	writeFileSync(join(root, "source.txt"), "Harmless report validation input.\n");
	const writes = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout, stderr: "", killed: false, timedOut: false });
	await withVerifyTimings(root, () => streamExternalTools({
		engine: { discoverTools: () => [{ id: "gitleaks", available: true }] }, cwd: root, opts: { only: "gitleaks" },
		skipChecks: new Set(), summary: [], allFlaggedFiles: new Set(), details: false,
	}));
	expect(process.exitCode).toBe(75);
	const output = writes.mock.calls.map(([text]) => text).join("");
	expect(output).toContain("NOT CHECKED");
	expect(output).not.toContain("no secrets detected");
});

it("uses Gitleaks' supported stdout report transport with redaction", () => {
	const command = TOOLS_TO_RUN.find(tool => tool.id === "gitleaks")?.cmd;
	expect(command?.[command.indexOf("--report-path") + 1]).toBe("-");
	expect(command).toContain("--redact");
});
