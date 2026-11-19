import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runProcessAsync } from "../spawn-async.js";
import { withProcessCancellation } from "../process-cancellation.js";
import { PartialToolReportError } from "../tool-errors.js";
import { runGitleaksForeground } from "./gitleaks-foreground.js";

vi.mock("../spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
let root: string;
const success = { code: 0, stdout: "[]", stderr: "", killed: false, timedOut: false };
beforeEach(() => {
	root = mkdtempSync(join(process.cwd(), "scratch/gitleaks-foreground-"));
	writeFileSync(join(root, "a.txt"), "harmless\n"); writeFileSync(join(root, "-b.txt"), "harmless\n");
	vi.stubEnv("GITLEAKS_CONFIG", ""); vi.stubEnv("GITLEAKS_CONFIG_TOML", "");
	vi.mocked(runProcessAsync).mockImplementation(async command => command === "git" ? { ...success, code: 128, stdout: "", stderr: "not a git repository" } : success);
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it("runs one literal relative target at a time with full capture and no default deadline", async () => {
	await expect(runGitleaksForeground(root, 0)).resolves.toEqual([]);
	const calls = vi.mocked(runProcessAsync).mock.calls.filter(([command]) => command === "gitleaks");
	expect(calls).toHaveLength(2);
	for (const [, args, options] of calls) {
		expect(args.slice(-2)).toEqual(["--", expect.any(String)]);
		expect(options).toMatchObject({ cwd: root, timeout: 0, maxBufferBytes: null });
		expect(args).toEqual(expect.arrayContaining(["--redact", "--report-path", "-"]));
	}
});

it("freezes the effective native configuration environment across all targets", async () => {
	const environments: NodeJS.ProcessEnv[] = [];
	vi.mocked(runProcessAsync).mockImplementation(async (command, _args, options) => {
		if (command === "git") return { ...success, code: 128 };
		environments.push(options?.exactEnv ?? {});
		vi.stubEnv("GITLEAKS_CONFIG", "later-environment-change.toml");
		return success;
	});
	await expect(runGitleaksForeground(root, 0)).resolves.toEqual([]);
	expect(environments).toHaveLength(2);
	for (const env of environments) {
		expect(env.GITLEAKS_CONFIG).toBe("");
		expect(env.GITLEAKS_CONFIG_TOML).toBe("[extend]\nuseDefault=true\n");
	}
});

it("retains prior findings when a later selected scope fails", async () => {
	let scan = 0;
	vi.mocked(runProcessAsync).mockImplementation(async command => command === "git" ? { ...success, code: 128 } : ++scan === 1
		? { ...success, code: 1, stdout: JSON.stringify([{ File: "-b.txt", RuleID: "audit", StartLine: 1 }]) }
		: { ...success, stderr: "WRN skipping file: permission denied" });
	try { await runGitleaksForeground(root, 0); throw new Error("expected partial report"); }
	catch (error) {
		expect(error).toBeInstanceOf(PartialToolReportError);
		if (!(error instanceof PartialToolReportError)) throw error;
		expect(error.results).toHaveLength(1);
		expect(error.message).toContain("incomplete");
	}
});

it("detects a selected file changing during the native scan", async () => {
	vi.mocked(runProcessAsync).mockImplementation(async command => {
		if (command === "git") return { ...success, code: 128 };
		writeFileSync(join(root, "a.txt"), "changed\n"); return success;
	});
	await expect(runGitleaksForeground(root, 0)).rejects.toThrow("changed");
});

it("does not start another target after cancellation", async () => {
	const controller = new AbortController();
	vi.mocked(runProcessAsync).mockImplementation(async command => {
		if (command === "git") return { ...success, code: 128 };
		controller.abort(new Error("operator cancelled")); return success;
	});
	await expect(withProcessCancellation(controller.signal, () => runGitleaksForeground(root, 0))).rejects.toThrow("operator cancelled");
	expect(vi.mocked(runProcessAsync).mock.calls.filter(([command]) => command === "gitleaks")).toHaveLength(1);
});

it("uses one explicit deadline across sequential targets", async () => {
	vi.mocked(runProcessAsync).mockImplementation(async command => {
		if (command === "git") return { ...success, code: 128 };
		await new Promise(resolve => setTimeout(resolve, 40)); return success;
	});
	await expect(runGitleaksForeground(root, 20)).rejects.toThrow("deadline");
	expect(vi.mocked(runProcessAsync).mock.calls.filter(([command]) => command === "gitleaks")).toHaveLength(1);
});

it("retains completed target findings when the explicit deadline interrupts a later target", async () => {
	let scans = 0;
	vi.mocked(runProcessAsync).mockImplementation(async command => {
		if (command === "git") return { ...success, code: 128 };
		if (++scans === 1) return { ...success, code: 1, stdout: JSON.stringify([{ File: "-b.txt", RuleID: "audit", StartLine: 1 }]) };
		await new Promise(resolve => setTimeout(resolve, 100)); return success;
	});
	try { await runGitleaksForeground(root, 60); throw new Error("expected deadline"); }
	catch (error) {
		expect(error).toBeInstanceOf(PartialToolReportError);
		if (!(error instanceof PartialToolReportError)) throw error;
		expect(error.results).toHaveLength(1); expect(error.message).toContain("deadline");
	}
});

it("records unsupported symbolic inputs alongside retained native findings", async () => {
	symlinkSync("a.txt", join(root, "alias.txt"));
	const scopes: import("../types.js").ToolInputScope[] = [];
	await expect(runGitleaksForeground(root, 0, scope => scopes.push(scope))).rejects.toThrow("symbolic");
	expect(scopes).toMatchObject([{ unavailableInputs: [{ file: "alias.txt" }] }]);
});
