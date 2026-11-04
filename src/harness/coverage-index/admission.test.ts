import { beforeEach, describe, expect, it, vi } from "vitest";
import { withProcessCancellation } from "../check-engine/process-cancellation.js";

const projectRelease = vi.fn();
const acquireProjectHeavyProcessLease = vi.fn(async () => projectRelease as (() => void) | null);
vi.mock("../project-heavy-process-lock.js", () => ({ acquireProjectHeavyProcessLease: (...args: unknown[]) => acquireProjectHeavyProcessLease(...(args as [])) }));
const capacityRelease = vi.fn();
const acquireTestCapacity = vi.fn(async () => ({ release: capacityRelease }) as { release: () => void } | null);
vi.mock("../test-capacity.js", () => ({ acquireTestCapacity: (...args: unknown[]) => acquireTestCapacity(...(args as [])) }));
const budget = { reserveBytes: 1, maxRssBytes: 2 ** 31 };
const readResourceBudget = vi.fn((): typeof budget | null => budget);
vi.mock("../resource-budget.js", () => ({ readResourceBudget: () => readResourceBudget() }));

const { admitIndexedRun } = await import("./admission.js");

beforeEach(() => { vi.clearAllMocks(); acquireProjectHeavyProcessLease.mockResolvedValue(projectRelease); acquireTestCapacity.mockResolvedValue({ release: capacityRelease }); readResourceBudget.mockReturnValue(budget); });

describe("admitIndexedRun — positive (must fire)", () => {
    // test-contract: invariant — an indexed run is admitted exactly like a scheduled test run: the project's heavy-process lease first, then the FOREGROUND host slot, then the memory budget the child tree is supervised against; release returns both leases
    it("P1: takes project lease, foreground host capacity and the memory budget, and releases both leases", async () => {
        const admission = await admitIndexedRun("/repo", 5000);
        expect(admission).toMatchObject({ admitted: true, resourceBudget: budget });
        expect(acquireProjectHeavyProcessLease).toHaveBeenCalledWith("/repo", 5000, expect.any(AbortSignal));
        expect(acquireTestCapacity).toHaveBeenCalledWith("foreground", 5000, expect.any(AbortSignal));
        expect(projectRelease).not.toHaveBeenCalled();
        if (admission.admitted) admission.release();
        expect(capacityRelease).toHaveBeenCalledTimes(1);
        expect(projectRelease).toHaveBeenCalledTimes(1);
    });
});

describe("admitIndexedRun — negative (must not fire): no lease means no run", () => {
    // test-contract: regression — cancellation at either admission boundary returns every acquired lease and never reads a launch budget.
    it.each(["before", "project", "capacity"] as const)("releases only acquired leases when cancelled at %s", async boundary => {
        const controller = new AbortController();
        if (boundary === "before") controller.abort();
        if (boundary === "project") acquireProjectHeavyProcessLease.mockImplementationOnce(async () => { controller.abort(); return projectRelease; });
        if (boundary === "capacity") acquireTestCapacity.mockImplementationOnce(async () => { controller.abort(); return { release: capacityRelease }; });
        const admission = await withProcessCancellation(controller.signal, () => admitIndexedRun("/repo", Date.now() + 5000));
        expect(admission).toMatchObject({ admitted: false, reason: "Coverage index cancelled; no verification verdict" });
        expect(readResourceBudget).not.toHaveBeenCalled();
        expect(projectRelease).toHaveBeenCalledTimes(boundary === "before" ? 0 : 1);
        expect(capacityRelease).toHaveBeenCalledTimes(boundary === "capacity" ? 1 : 0);
        expect(acquireTestCapacity).toHaveBeenCalledTimes(boundary === "capacity" ? 1 : 0);
    });
    it("N1: a busy project lane is refused before the host slot is asked", async () => {
        acquireProjectHeavyProcessLease.mockResolvedValue(null);
        expect(await admitIndexedRun("/repo", 5000)).toMatchObject({ admitted: false, reason: "Project check capacity busy; coverage index unavailable" });
        expect(acquireTestCapacity).not.toHaveBeenCalled();
    });
    it("N2: a busy host slot returns the project lease", async () => {
        acquireTestCapacity.mockResolvedValue(null);
        expect(await admitIndexedRun("/repo", 5000)).toMatchObject({ admitted: false, reason: "Host test capacity busy; coverage index unavailable" });
        expect(projectRelease).toHaveBeenCalledTimes(1);
    });
    it("N3: no memory budget after admission releases both leases", async () => {
        readResourceBudget.mockReturnValue(null);
        expect(await admitIndexedRun("/repo", 5000)).toMatchObject({ admitted: false, reason: "Host memory reserve unavailable; coverage index unavailable" });
        expect(capacityRelease).toHaveBeenCalledTimes(1);
        expect(projectRelease).toHaveBeenCalledTimes(1);
    });
});
