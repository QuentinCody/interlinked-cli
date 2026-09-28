import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runResourceCommand } from "./resource-command.js";
import { acquireTestCapacity } from "./test-capacity.js";
import { readResourceBudget } from "./resource-budget.js";
import { runProcessAsync } from "./check-engine/spawn-async.js";

vi.mock("./test-capacity.js", () => ({ acquireTestCapacity: vi.fn() }));
vi.mock("./resource-budget.js", () => ({ readResourceBudget: vi.fn() }));
vi.mock("./check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
const temps: string[] = [];
/** Reads the rows of this test's private stage ledger. */
let readRows: () => Array<Record<string, unknown>>;
// Every test gets a private ledger: runResourceCommand writes rows to <cwd>/.interlinked otherwise, i.e. into the real repo.
// The pre-push hook also exports INTERLINKED_STAGE; an inherited value would change the default stage these rows assert.
beforeEach(() => {
    vi.stubEnv("INTERLINKED_STAGE", "");
    readRows = ledger();
});
afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Points the stage ledger at a private file and returns a reader for its rows. */
function ledger(): () => Array<Record<string, unknown>> {
    const dir = mkdtempSync(join(tmpdir(), "resource-command-")), path = join(dir, "stages.jsonl");
    temps.push(dir);
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", path);
    // SAFETY: the file is written only by recordVerificationStage, one JSON object per line.
    return () => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [];
}
const budget = { reserveBytes: 1024 ** 3, maxRssBytes: 2 * 1024 ** 3 };

describe("stage ledger rows", () => {
    // test-contract: public-api — an expired capacity wait is recorded as capacity-timeout with the wait measured, never as a failed check
    it("records capacity-timeout when the host lane never opens", async () => {
        const rows = readRows;
        vi.mocked(acquireTestCapacity).mockResolvedValue(null);
        expect(await runResourceCommand("npm", ["run", "typecheck:stable"], new AbortController().signal)).toBeNull();
        expect(rows()).toMatchObject([{ check: "npm run typecheck:stable", stage: "cli", status: "deferred", reused: false, reuse_denied_reason: "capacity-timeout", identity: null }]);
        expect(typeof rows()[0]?.wait_capacity_ms).toBe("number");
        expect(rows()[0]?.exec_ms).toBeUndefined();
    });

    // test-contract: public-api — a missing memory budget after admission is its own reason
    it("records memory-budget-unavailable when admission succeeds but the budget is gone", async () => {
        const rows = readRows;
        vi.mocked(acquireTestCapacity).mockResolvedValue({ release: vi.fn() });
        vi.mocked(readResourceBudget).mockReturnValue(null);
        expect(await runResourceCommand("node", [], new AbortController().signal)).toBeNull();
        expect(rows()).toMatchObject([{ status: "deferred", reuse_denied_reason: "memory-budget-unavailable" }]);
    });

    // test-contract: public-api — a completed command records its exit as passed/failed with exec_ms, and the stage comes from INTERLINKED_STAGE
    it.each([[0, "passed"], [1, "failed"]] as const)("records exit %i as %s with exec_ms under the declared stage", async (code, status) => {
        const rows = readRows;
        vi.stubEnv("INTERLINKED_STAGE", "push");
        vi.mocked(acquireTestCapacity).mockResolvedValue({ release: vi.fn() });
        vi.mocked(readResourceBudget).mockReturnValue(budget);
        vi.mocked(runProcessAsync).mockResolvedValue({ code, killed: false, timedOut: false, stdout: "", stderr: "" });
        await runResourceCommand("node", ["--version"], new AbortController().signal);
        expect(rows()).toMatchObject([{ stage: "push", check: "node --version", status, reused: false }]);
        expect(rows()[0]?.reuse_denied_reason).toBeUndefined();
        expect(typeof rows()[0]?.exec_ms).toBe("number");
    });

    // test-contract: public-api — a killed or timed-out child is deferred/interrupted, not failed
    it("records an interrupted child as deferred with reason interrupted", async () => {
        const rows = readRows;
        vi.mocked(acquireTestCapacity).mockResolvedValue({ release: vi.fn() });
        vi.mocked(readResourceBudget).mockReturnValue(budget);
        vi.mocked(runProcessAsync).mockResolvedValue({ code: null, killed: true, timedOut: false, stdout: "", stderr: "", resourceReason: "budget" });
        await runResourceCommand("node", [], new AbortController().signal);
        expect(rows()).toMatchObject([{ status: "deferred", reuse_denied_reason: "interrupted" }]);
    });
});

it.each([["heavy", 600_000], ["light", 5000]] as const)("bounds %s admission waiting without overlapping the existing owner", async (profile, waitMs) => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    vi.mocked(acquireTestCapacity).mockResolvedValue(null);
    const signal = new AbortController().signal;
    expect(await runResourceCommand("node", [], signal, profile)).toBeNull();
    expect(acquireTestCapacity).toHaveBeenCalledWith("foreground", 1000 + waitMs, signal);
    expect(runProcessAsync).not.toHaveBeenCalled();
});

it("does not spawn when another project owns the host lane", async () => {
    vi.mocked(acquireTestCapacity).mockResolvedValue(null);
    expect(await runResourceCommand("node", [], new AbortController().signal)).toBeNull();
    expect(runProcessAsync).not.toHaveBeenCalled();
});
it("rechecks memory after admission and releases a deferred lane", async () => {
    const release = vi.fn();
    vi.mocked(acquireTestCapacity).mockResolvedValue({ release });
    vi.mocked(readResourceBudget).mockReturnValue(null);
    expect(await runResourceCommand("node", [], new AbortController().signal)).toBeNull();
    expect(runProcessAsync).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
});
it("keeps the lease until an interrupted command is reaped and propagates its result", async () => {
    const release = vi.fn();
    const budget = { reserveBytes: 1024 ** 3, maxRssBytes: 2 * 1024 ** 3 };
    vi.mocked(acquireTestCapacity).mockResolvedValue({ release });
    vi.mocked(readResourceBudget).mockReturnValue(budget);
    const interrupted = { code: null, killed: true, timedOut: false, stdout: "", stderr: "", resourceReason: "budget" };
    vi.mocked(runProcessAsync).mockImplementation(async (_file, _args, options) => {
        expect(release).not.toHaveBeenCalled();
        expect(options).toMatchObject({ resourceBudget: budget, inheritOutput: true });
        return interrupted;
    });
    expect(await runResourceCommand("node", ["--version"], new AbortController().signal)).toEqual(interrupted);
    expect(release).toHaveBeenCalledOnce();
});
