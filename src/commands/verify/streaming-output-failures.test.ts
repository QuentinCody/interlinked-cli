import { afterEach, expect, it, vi } from "vitest";
import { runProcessAsync } from "../../harness/check-engine/spawn-async.js";
import { runToolSilent } from "./streaming-output.js";
import { PartialToolReportError } from "../../harness/check-engine/tool-errors.js";

it("runs a composed native workflow without spawning an extra outer command", async () => {
	const finding: import("../../harness/check-engine/types.js").CheckResult = { tool: "gitleaks", severity: "error", file: "a.txt", line: 1, message: "retained" };
	const run = vi.fn().mockRejectedValue(new PartialToolReportError("one selected input unavailable", [finding]));
	const result = await runToolSilent({ cmd: ["scanner"], cwd: "/repo", timeoutMs: 0, parseOutput: () => [], run,
		recoverPartial: error => error instanceof PartialToolReportError ? error.results : undefined });
	expect(run).toHaveBeenCalledOnce();
	expect(result).toMatchObject({ items: [finding], unavailable: expect.stringContaining("selected input unavailable") });
	expect(runProcessAsync).not.toHaveBeenCalled();
});

vi.mock("../../harness/check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("does not report a failed scanner with no parsed findings as clean", async () => {
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 2, killed: false, timedOut: false, stdout: "", stderr: "invalid configuration" });
	const result = await runToolSilent({ cmd: ["scanner"], cwd: "/repo", timeoutMs: 100, parseOutput: () => [] });
	expect(result.items).toEqual([]);
	expect(result.unavailable).toContain("exit 2");
});

it("reports parser failure as unavailable so the tool queue can continue", async () => {
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, killed: false, timedOut: false, stdout: "malformed output", stderr: "" });
	const result = await runToolSilent({ cmd: ["scanner"], cwd: "/repo", timeoutMs: 100, parseOutput: () => { throw new SyntaxError("invalid report"); } });
	expect(result.items).toEqual([]);
	expect(result.unavailable).toContain("invalid report");
});

it.each([0, 1, 2])("preserves parsed findings when an analyzer returns exit %s", async code => {
	vi.mocked(runProcessAsync).mockResolvedValue({ code, killed: false, timedOut: false, stdout: "finding", stderr: "" });
	const result = await runToolSilent({ cmd: ["scanner"], cwd: "/repo", timeoutMs: 100, parseOutput: () => [{ line: 3, message: "diagnostic" }] });
	expect(result.items).toEqual([{ line: 3, message: "diagnostic" }]);
	expect(result.unavailable).toBeUndefined();
});

it("preserves a successful empty scan", async () => {
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, killed: false, timedOut: false, stdout: "[]", stderr: "" });
	const result = await runToolSilent({ cmd: ["scanner"], cwd: "/repo", timeoutMs: 100, parseOutput: () => [] });
	expect(result.items).toEqual([]);
	expect(result.unavailable).toBeUndefined();
});

it("requests complete captured output with an explicitly unbounded verification tool", async () => {
	vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, killed: false, timedOut: false, stdout: "[]", stderr: "" });
	await runToolSilent({ cmd: ["scanner"], cwd: "/repo", timeoutMs: 0, parseOutput: () => [] });
	expect(runProcessAsync).toHaveBeenCalledWith("scanner", [], { cwd: "/repo", timeout: 0, maxBufferBytes: null });
});
