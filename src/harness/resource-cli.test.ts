import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { superviseResourceCli } from "./resource-cli.js";
import { readResourceBudget } from "./resource-budget.js";
import { runProcessAsync } from "./check-engine/spawn-async.js";

vi.mock("./resource-budget.js", () => ({ readResourceBudget: vi.fn() }));
vi.mock("./check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
let directory: string;
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "resource-cli-"));
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", join(directory, "stages.jsonl"));
});
afterEach(() => {
    vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0;
    rmSync(directory, { recursive: true, force: true });
});
const argv = [process.execPath, "/fixture/index.js", "verify", "--json"];

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
    expect(await superviseResourceCli(argv)).toBe(true);
    expect(process.exitCode).toBe(75);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("no verification verdict"));
    expect(runProcessAsync).not.toHaveBeenCalled();
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
