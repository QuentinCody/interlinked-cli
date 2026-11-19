import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { withRequestCancellation } from "../server/request-cancellation.js";
import { runAdmittedCommitSuite } from "./commit-gate-admission.js";

const mocks = vi.hoisted(() => ({
	project: vi.fn(), host: vi.fn(), workers: vi.fn(), budget: vi.fn(), run: vi.fn(),
}));
vi.mock("../project-heavy-process-lock.js", () => ({ tryAcquireProjectHeavyProcessLease: mocks.project }));
vi.mock("../test-capacity.js", () => ({ tryAcquireForegroundCapacity: mocks.host }));
vi.mock("../test-execution.js", () => ({ testWorkerBudget: mocks.workers }));
vi.mock("../resource-budget.js", () => ({ readResourceBudget: mocks.budget }));
vi.mock("../check-engine/spawn-async.js", () => ({ runProcessAsync: mocks.run }));

const options = { projectRoot: "/repo/.interlinked/.commit-snapshot-a", runtimeRoot: "/repo", coverageDir: "/repo/reports", timeoutMs: 1000 };
const releaseProject = vi.fn(), releaseHost = vi.fn();
const budget = { reserveBytes: 10, maxRssBytes: 20 };
beforeEach(() => {
	vi.resetAllMocks();
	mocks.project.mockReturnValue(releaseProject);
	mocks.host.mockReturnValue({ release: releaseHost });
	mocks.workers.mockReturnValue(1);
	mocks.budget.mockReturnValue(budget);
	mocks.run.mockResolvedValue({ code: null, stdout: "", stderr: "", killed: true, timedOut: false, resourceReason: "memory reserve" });
});

it("uses the runner's parsed coverage and observed status after successful admission", async () => {
	const directory = mkdtempSync(join(tmpdir(), "commit-coverage-admission-"));
	try {
		writeFileSync(join(directory, "coverage-final.json"), "{}");
		mocks.run.mockResolvedValue({ code: 0, stdout: "", stderr: "", killed: false, timedOut: false });
		expect(await runAdmittedCommitSuite("ts", { ...options, coverageDir: directory }))
			.toMatchObject({ ok: true, testsPassed: true });
		expect(releaseProject).toHaveBeenCalledOnce();
		expect(releaseHost).toHaveBeenCalledOnce();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it("owns the real checkout and caps the full instrumented suite before it starts", async () => {
	const result = await runAdmittedCommitSuite("ts", options);
	expect(mocks.project).toHaveBeenCalledWith("/repo");
	expect(mocks.host).toHaveBeenCalledWith({ allowAncestor: false });
	expect(mocks.workers).toHaveBeenCalledWith(1);
	expect(mocks.run).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["run", "--maxWorkers=1"]), expect.objectContaining({
		cwd: options.projectRoot, resourceBudget: budget, reapDescendantGroups: true,
	}));
	expect(result).toEqual({ deferred: expect.stringContaining("memory reserve") });
	expect(releaseHost).toHaveBeenCalledOnce();
	expect(releaseProject).toHaveBeenCalledOnce();
});

it("keeps an overlapping checkout unmeasured while the first snapshot owns the host", async () => {
	let started!: () => void, finish!: () => void;
	const running = new Promise<void>(resolve => { started = resolve; });
	mocks.host.mockReturnValueOnce({ release: releaseHost }).mockReturnValueOnce(null);
	mocks.run.mockImplementationOnce(async () => {
		started();
		await new Promise<void>(resolve => { finish = resolve; });
		return { code: null, stdout: "", stderr: "", killed: true, timedOut: true };
	});
	const first = runAdmittedCommitSuite("ts", options);
	await running;
	expect(await runAdmittedCommitSuite("js", { ...options, runtimeRoot: "/other" })).toEqual({ deferred: expect.stringContaining("host") });
	expect(mocks.run).toHaveBeenCalledTimes(1);
	expect(releaseHost).not.toHaveBeenCalled();
	finish();
	expect(await first).toEqual({ deferred: expect.stringContaining("timed out") });
	expect(releaseProject).toHaveBeenCalledTimes(2);
	expect(releaseHost).toHaveBeenCalledOnce();
});

it("does not start a suite when host worker capacity is unavailable", async () => {
	mocks.workers.mockReturnValue(0);
	expect(await runAdmittedCommitSuite("python", options)).toEqual({ deferred: expect.stringContaining("worker") });
	expect(mocks.run).not.toHaveBeenCalled();
	expect(releaseHost).toHaveBeenCalledOnce();
});

it("cancels only the disconnected hook's process tree and discards its outcome", async () => {
	const owner = new AbortController();
	mocks.run.mockImplementation(async (_command, _args, opts) => {
		owner.abort();
		expect(opts.signal.aborted).toBe(true);
		return { code: 0, stdout: "", stderr: "", killed: false, timedOut: false };
	});
	const result = await withRequestCancellation(owner.signal, () => runAdmittedCommitSuite("ts", options));
	expect(result).toEqual({ deferred: expect.stringContaining("interrupted") });
	expect(releaseHost).toHaveBeenCalledOnce();
});
