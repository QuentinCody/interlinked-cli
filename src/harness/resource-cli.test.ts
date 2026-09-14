import { afterEach, expect, it, vi } from "vitest";
import { superviseResourceCli } from "./resource-cli.js";
import { readResourceBudget } from "./resource-budget.js";
import { runProcessAsync } from "./check-engine/spawn-async.js";

vi.mock("./resource-budget.js", () => ({ readResourceBudget: vi.fn() }));
vi.mock("./check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; });
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
