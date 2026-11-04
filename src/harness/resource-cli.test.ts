import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { superviseResourceCli, withResourceCliCancellation } from "./resource-cli.js";
import { readResourceBudget } from "./resource-budget.js";
import { runProcessAsync } from "./check-engine/spawn-async.js";
import { currentProcessSignal } from "./check-engine/process-cancellation.js";
import { appendVerifyTiming } from "../commands/verify/check-timing.js";

vi.mock("./resource-budget.js", () => ({ readResourceBudget: vi.fn(), resourceBudgetSnapshot: vi.fn() }));
vi.mock("./check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
vi.mock("../commands/verify/check-timing.js", () => ({ appendVerifyTiming: vi.fn() }));
let directory: string;
const originalExecArgv = process.execArgv;
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "resource-cli-"));
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", join(directory, "stages.jsonl"));
    vi.stubEnv("NODE_OPTIONS", "");
    process.execArgv = [];
});
afterEach(() => {
    vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); process.exitCode = 0;
    rmSync(directory, { recursive: true, force: true });
    process.execArgv = originalExecArgv;
});
const argv = [process.execPath, "/fixture/index.js", "verify", "--json"];

it.each([["status"], ["coverage", "status"], ["metrics", "coverage", "status"], ["coverage", "check"], ["coverage", "check", "--from-index", "--help"]].map(args => ({ args })))("leaves cancellation ownership unchanged for $args", async ({ args }) => {
    const before = process.listenerCount("SIGINT");
    await withResourceCliCancellation([process.execPath, "/fixture/index.js", ...args], async () => {
        expect(currentProcessSignal()).toBeUndefined();
        expect(process.listenerCount("SIGINT")).toBe(before);
    });
    expect(readResourceBudget).not.toHaveBeenCalled();
});
it.each([["coverage", "check", "--from-index"], ["coverage", "--from-index"], ["metrics", "coverage", "warm"]].map(args => ({ args })))("cancels indexed dispatch without adding admission for $args", async ({ args }) => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const before = process.listenerCount("SIGTERM");
    await withResourceCliCancellation([process.execPath, "/fixture/index.js", ...args], async () => {
        expect(currentProcessSignal()).toBeInstanceOf(AbortSignal);
        process.emit("SIGTERM");
        currentProcessSignal()?.throwIfAborted();
    });
    expect(process.exitCode).toBe(75);
    expect(currentProcessSignal()).toBeUndefined();
    expect(process.listenerCount("SIGTERM")).toBe(before);
    expect(readResourceBudget).not.toHaveBeenCalled();
});

it.each([
    { env: "--max-old-space-size=512", args: ["--max-old-space-size=768"], expected: 512 },
    { env: "--max-old-space-size=2048", args: ["--max-old-space-size=256"], expected: 256 },
])("preserves the smaller configured coordinator heap: $expected MiB", async ({ env, args, expected }) => {
    vi.stubEnv("NODE_OPTIONS", env);
    process.execArgv = args;
    vi.mocked(readResourceBudget).mockReturnValue({ maxRssBytes: 4 * 1024 ** 3, reserveBytes: 6 * 1024 ** 3 });
    vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, killed: false, timedOut: false, stdout: "", stderr: "" });
    await superviseResourceCli(argv);
    expect(runProcessAsync).toHaveBeenCalledWith(process.execPath, [...args, `--max-old-space-size=${expected}`, ...argv.slice(1)], expect.any(Object));
});
it.each(["--max-old-space-size-percentage=50", '--max-old-space-size="512"'])("refuses an unverifiable heap override: %s", async options => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.stubEnv("NODE_OPTIONS", options);
    vi.mocked(readResourceBudget).mockReturnValue({ maxRssBytes: 4 * 1024 ** 3, reserveBytes: 6 * 1024 ** 3 });
    await superviseResourceCli(argv);
    expect(runProcessAsync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(75);
});

it("leaves help and lightweight commands in their original process", async () => {
    expect(await superviseResourceCli([process.execPath, "/fixture/index.js", "status"])).toBe(false);
    expect(await superviseResourceCli([process.execPath, "/fixture/index.js", "tests", "status"])).toBe(false);
    expect(await superviseResourceCli([...argv, "--help"])).toBe(false);
    expect(runProcessAsync).not.toHaveBeenCalled();
});
it("consumes the direct-parent marker before execution without recursively supervising", async () => {
    vi.stubEnv("INTERLINKED_RESOURCE_SUPERVISOR_PID", String(process.ppid));
    expect(await superviseResourceCli(argv)).toBe(false);
    expect(process.env.INTERLINKED_RESOURCE_SUPERVISOR_PID).toBeUndefined();
    expect(runProcessAsync).not.toHaveBeenCalled();
});
it("refuses unavailable capacity without starting or certifying a scan", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.mocked(readResourceBudget).mockReturnValue(null);
    expect(await superviseResourceCli([...argv, "--timeout", "1"])).toBe(true);
    expect(process.exitCode).toBe(75);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("no verification verdict"));
    expect(runProcessAsync).not.toHaveBeenCalled();
});
it("waits for heavy memory within the caller deadline, without a light-budget fallback", async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const budget = { maxRssBytes: 4 * 1024 ** 3, reserveBytes: 6 * 1024 ** 3 };
    vi.mocked(readResourceBudget).mockReturnValueOnce(null).mockReturnValue(budget);
    vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, killed: false, timedOut: false, stdout: "", stderr: "" });
    const pending = superviseResourceCli([...argv, "--timeout=1000"]);
    expect(runProcessAsync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBe(true);
    expect(readResourceBudget).toHaveBeenCalledTimes(2);
    expect(readResourceBudget).not.toHaveBeenCalledWith("light");
    expect(runProcessAsync).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ timeout: 500, resourceBudget: budget }));
});

it("bounds default verify admission at 30 seconds without relaxing the memory requirement", async () => {
    vi.useFakeTimers(); vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.mocked(readResourceBudget).mockReturnValue(null);
    const pending = superviseResourceCli(argv);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(true); expect(runProcessAsync).not.toHaveBeenCalled(); expect(process.exitCode).toBe(75);
    expect(readResourceBudget).not.toHaveBeenCalledWith("light");
    expect(appendVerifyTiming).toHaveBeenCalledWith(process.cwd(), expect.objectContaining({
        check: "host_memory_admission", duration_ms: 30_000, status: "deferred", execution_started: false,
    }));
});
it("owns signals while admission waits and never starts after cancellation", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.mocked(readResourceBudget).mockReturnValue(null);
    const before = process.listenerCount("SIGTERM");
    const pending = superviseResourceCli(argv);
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    process.emit("SIGTERM");
    expect(await pending).toBe(true);
    expect(process.listenerCount("SIGTERM")).toBe(before);
    expect(runProcessAsync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(75);
});
it("supervises a real command's arguments and preserves a passing exit code", async () => {
    const budget = { maxRssBytes: 4 * 1024 ** 3, reserveBytes: 6 * 1024 ** 3 };
    vi.mocked(readResourceBudget).mockReturnValue(budget);
    vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, killed: false, timedOut: false, stdout: "", stderr: "" });
    expect(await superviseResourceCli(argv)).toBe(true);
    expect(runProcessAsync).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(["--max-old-space-size=1536", ...argv.slice(1)]),
        expect.objectContaining({ resourceBudget: budget, inheritOutput: true, env: expect.objectContaining({ INTERLINKED_RESOURCE_SUPERVISOR_PID: String(process.pid) }) }));
    expect(process.exitCode).toBe(0);
});
it("does not certify partial output when the supervised CLI is interrupted", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.mocked(readResourceBudget).mockReturnValue({ maxRssBytes: 1024 ** 3, reserveBytes: 2 * 1024 ** 3 });
    vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, killed: true, timedOut: false, stdout: "partial", stderr: "", resourceReason: "memory budget" });
    expect(await superviseResourceCli(argv)).toBe(true);
    expect(process.exitCode).toBe(75);
    expect(stderr).toHaveBeenCalledWith("[resources] memory budget; no verification verdict.\n");
});

it("records externally terminated children as deferred while preserving a child's own exit 75", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.mocked(readResourceBudget).mockReturnValue({ maxRssBytes: 1024 ** 3, reserveBytes: 2 * 1024 ** 3 });
    const result = { code: 75 as number | null, killed: false, timedOut: false, stdout: "", stderr: "" };
    vi.mocked(runProcessAsync).mockResolvedValue(result);
    await superviseResourceCli(argv);
    expect(process.exitCode).toBe(75);
    expect(stderr).not.toHaveBeenCalled();
    expect(existsSync(join(directory, "stages.jsonl"))).toBe(false);
    vi.mocked(runProcessAsync).mockResolvedValue({ ...result, code: null });
    await superviseResourceCli(argv);
    expect(process.exitCode).toBe(75);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("no verification verdict"));
    const rows = readFileSync(join(directory, "stages.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "deferred", reuse_denied_reason: "interrupted", identity: null, reused: false });
});

// test-contract: regression — the outer supervisor keeps the interrupted tree's sampled peak even when its child
// cannot finish its ledger row; an unavailable sample stays absent, never a fabricated zero or a passing verdict.
it.each([4 * 1024 ** 3 + 23_000_000, undefined])("retains interruption memory diagnostics with peak %s", async peakRssBytes => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const budget = { maxRssBytes: 4 * 1024 ** 3, reserveBytes: 6 * 1024 ** 3 };
    vi.stubEnv("INTERLINKED_STAGE", "push");
    vi.mocked(readResourceBudget).mockReturnValue(budget);
    vi.mocked(runProcessAsync).mockResolvedValue({ code: null, killed: true, timedOut: false, stdout: "", stderr: "",
        resourceReason: "Runner process tree exceeded its memory budget", ...(peakRssBytes === undefined ? {} : { peakRssBytes }) });
    await superviseResourceCli([process.execPath, "/fixture/index.js", "tests", "run", "--all"]);
    expect(process.exitCode).toBe(75);
    expect(stderr).toHaveBeenCalledWith(`[resources] MEMORY: peak_rss_bytes=${peakRssBytes ?? "unavailable"} rss_budget_bytes=4294967296 reserve_bytes=6442450944 heap_limit_mb=1536.\n`);
    const rows = readFileSync(join(directory, "stages.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "push", check: "cli:tests", identity: null, status: "deferred", reused: false,
        reuse_denied_reason: "interrupted", rss_budget_bytes: budget.maxRssBytes, heap_limit_mb: 1536, exec_ms: expect.any(Number) });
    if (peakRssBytes === undefined) expect(rows[0]).not.toHaveProperty("peak_rss_bytes");
    else expect(rows[0].peak_rss_bytes).toBe(peakRssBytes);
});

// test-contract: regression — interruption telemetry follows tests --cwd, while an explicit shared ledger still wins.
it.each(["separate", "equals", "override"])("records interruption in the selected project (%s)", async form => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(process, "cwd").mockReturnValue(join(directory, "caller"));
    const selected = join(directory, "selected");
    const shared = join(directory, "stages.jsonl");
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", form === "override" ? shared : "");
    vi.mocked(readResourceBudget).mockReturnValue({ maxRssBytes: 4 * 1024 ** 3, reserveBytes: 6 * 1024 ** 3 });
    vi.mocked(runProcessAsync).mockResolvedValue({ code: null, killed: true, timedOut: false, stdout: "", stderr: "" });
    const args = form === "equals" ? [`--cwd=${selected}`] : ["--cwd", selected];
    await superviseResourceCli([process.execPath, "/fixture/index.js", "tests", "run", ...args]);
    expect(existsSync(form === "override" ? shared : join(selected, ".interlinked", "verification-stages.jsonl"))).toBe(true);
    expect(existsSync(join(directory, "caller", ".interlinked", "verification-stages.jsonl"))).toBe(false);
    if (form === "override") expect(existsSync(join(selected, ".interlinked", "verification-stages.jsonl"))).toBe(false);
});
