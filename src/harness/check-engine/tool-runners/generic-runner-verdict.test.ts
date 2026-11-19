import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProcessAsync } from "../spawn-async.js";
import { runAsyncTool } from "../index-runtime.js";

vi.mock("../spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
const scope = { projectRoot: "/repo", mode: "project" as const };
const finding = { path: "/repo/a.ts", start: { line: 3, col: 1 }, check_id: "fixture", extra: { message: "retained finding" } };
beforeEach(() => vi.mocked(runProcessAsync).mockReset());
afterEach(() => vi.restoreAllMocks());

describe("actual generic async runner completion", () => {
	it("keeps positive findings and an unavailable scope from a partial Semgrep report", async () => {
		vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout: JSON.stringify({ results: [finding], errors: [{ message: "rule timed out" }] }), stderr: "", killed: false, timedOut: false });
		const run = await runAsyncTool({ id: "semgrep", available: true }, scope, 0, { resourcePolicy: "foreground-verify" });
		expect(run.results.map(result => result.ruleId)).toEqual(["fixture"]);
		expect(run.skipped).toMatchObject({ category: "error", reason: expect.stringContaining("rule timed out") });
	});
	it.each(["semgrep", "gitleaks", "oxlint", "knip"] as const)("retains failed %s execution as unavailable", async id => {
		vi.mocked(runProcessAsync).mockResolvedValue({ code: null, stdout: "", stderr: "failed start", killed: false, timedOut: false });
		const run = await runAsyncTool({ id, available: true }, scope, 0, { resourcePolicy: "foreground-verify" });
		expect(run.skipped).toMatchObject({ category: "error" });
	});
	it("removes hidden Semgrep time and target-size limits only for foreground verification", async () => {
		vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, stdout: '{"results":[],"errors":[]}', stderr: "", killed: false, timedOut: false });
		await runAsyncTool({ id: "semgrep", available: true }, scope, 0, { resourcePolicy: "foreground-verify" });
		expect(vi.mocked(runProcessAsync).mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["--timeout", "0", "--timeout-threshold", "0", "--max-target-bytes", "0"]));
		expect(vi.mocked(runProcessAsync).mock.calls[0]?.[1]).not.toContain("--no-git-ignore");
		await runAsyncTool({ id: "semgrep", available: true }, scope, 1000);
		expect(vi.mocked(runProcessAsync).mock.calls[1]?.[1]).not.toContain("--max-target-bytes");
		expect(vi.mocked(runProcessAsync).mock.calls[1]?.[1]).toContain("--no-git-ignore");
		await runAsyncTool({ id: "semgrep", available: true }, { ...scope, mode: "file", targetFile: "/repo/ignored.js" }, 0, { resourcePolicy: "foreground-verify" });
		expect(vi.mocked(runProcessAsync).mock.calls[2]?.[1]).toContain("--no-git-ignore");
	});
});
