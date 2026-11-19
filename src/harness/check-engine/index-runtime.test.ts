import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readResourceBudget } from "../resource-budget.js";
import { runProcessAsync } from "./spawn-async.js";
import { runAsyncTool } from "./index-runtime.js";
import { CheckEngine } from "./index.js";
import { withProcessCancellation } from "./process-cancellation.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../resource-budget.js", () => ({ readResourceBudget: vi.fn() }));
vi.mock("./spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
let root: string;

beforeEach(() => {
	vi.resetAllMocks();
	root = mkdtempSync(join(process.cwd(), "scratch/index-runtime-gitleaks-"));
	writeFileSync(join(root, "app.ts"), "export {};\n");
	vi.mocked(readResourceBudget).mockReturnValue(null);
	vi.mocked(runProcessAsync).mockImplementation(async command => command === "git"
		? { code: 128, killed: false, timedOut: false, stderr: "not a git repository", stdout: "" }
		: { code: 1, killed: false, timedOut: false, stderr: "", stdout: JSON.stringify([{ File: "app.ts", StartLine: 7, RuleID: "test-rule", Description: "Redacted finding" }]) });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

// Exercise the real tool registry, policy forwarding and result parser together.
it("retains scanner findings in foreground verify when memory telemetry admits no budget", async () => {
	const result = await runAsyncTool({ id: "gitleaks", available: true },
		{ projectRoot: root, mode: "project" }, 1000, { resourcePolicy: "foreground-verify" });
	expect(result.skipped).toBeUndefined();
	expect(result.results).toEqual([expect.objectContaining({ file: "app.ts", line: 7, ruleId: "test-rule" })]);
	expect(readResourceBudget).not.toHaveBeenCalled();
	expect(vi.mocked(runProcessAsync).mock.calls[0]?.[2]).not.toHaveProperty("resourceBudget");
});

it("keeps memory admission for callers that did not request foreground verification", async () => {
	const result = await runAsyncTool({ id: "gitleaks", available: true }, { projectRoot: "/repo", mode: "project" }, 1000);
	expect(result.skipped).toMatchObject({ check: "gitleaks", category: "error", reason: expect.stringContaining("lacks memory headroom") });
	expect(runProcessAsync).not.toHaveBeenCalled();
});

it.each([
	{ policy: "foreground-verify" as const, expected: 0 },
	{ policy: undefined, expected: 30_000 },
])("resolves an omitted project timeout for policy $policy to $expected", async ({ policy, expected }) => {
	vi.mocked(readResourceBudget).mockReturnValue({ maxRssBytes: 4 * 1024 ** 3, reserveBytes: 6 * 1024 ** 3 });
	const engine = new CheckEngine("/repo");
	vi.spyOn(engine, "discoverTools").mockReturnValue([{ id: "gitleaks", available: true }]);
	await engine.runChecksAsync({ projectRoot: "/repo", mode: "project" }, { admissionAlreadyHeld: true, ...(policy ? { resourcePolicy: policy } : {}) });
	expect(vi.mocked(runProcessAsync).mock.calls[0]?.[2]?.timeout).toBe(expected);
});

it("preserves an explicit foreground per-tool deadline", async () => {
	const engine = new CheckEngine("/repo");
	vi.spyOn(engine, "discoverTools").mockReturnValue([{ id: "gitleaks", available: true }]);
	await engine.runChecksAsync({ projectRoot: "/repo", mode: "project" }, { admissionAlreadyHeld: true, resourcePolicy: "foreground-verify", timeoutMs: 1200 });
	expect(vi.mocked(runProcessAsync).mock.calls[0]?.[2]?.timeout).toBe(1200);
});

it("stops a cancelled verification batch before starting the next tool", async () => {
	const controller = new AbortController();
	const engine = new CheckEngine("/repo");
	vi.spyOn(engine, "discoverTools").mockReturnValue([{ id: "gitleaks", available: true }, { id: "semgrep", available: true }]);
	vi.mocked(runProcessAsync).mockImplementationOnce(async () => {
		controller.abort(new Error("Operator cancelled verification"));
		return { code: null, killed: true, timedOut: false, stdout: "", stderr: "" };
	});
	await expect(withProcessCancellation(controller.signal, () => engine.runChecksAsync(
		{ projectRoot: "/repo", mode: "project" }, { admissionAlreadyHeld: true, resourcePolicy: "foreground-verify" },
	))).rejects.toThrow("Operator cancelled verification");
	expect(runProcessAsync).toHaveBeenCalledTimes(1);
});

it("does not start an unlimited availability probe after cancellation", async () => {
	const controller = new AbortController();
	controller.abort(new Error("Already cancelled"));
	const engine = new CheckEngine("/repo", { discoveryTimeoutMs: 0 });
	const discovery = vi.spyOn(engine, "discoverTools").mockReturnValue([]);
	await expect(withProcessCancellation(controller.signal, () => engine.runChecksAsync(
		{ projectRoot: "/repo", mode: "project" }, { admissionAlreadyHeld: true, resourcePolicy: "foreground-verify" },
	))).rejects.toThrow("Already cancelled");
	expect(discovery).not.toHaveBeenCalled();
	expect(runProcessAsync).not.toHaveBeenCalled();
});
