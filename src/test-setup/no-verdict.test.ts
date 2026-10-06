import { describe, expect, it, vi } from "vitest";
import { noCapacityReason, skipWithoutCapacity } from "./no-verdict.js";

describe("noCapacityReason", () => {
    // test-contract: invariant — a nested run that got no host capacity produced NO verdict about the code; the case is NOT RUN, and only the harness's own capacity refusals count (H5, 2026-10-02)
    it.each([
        "Error: Host CPU or memory capacity unavailable for a test worker",
        "Host test capacity busy; coverage index unavailable",
        "Host memory reserve unavailable; test request retained",
        "[pre-push] NOT RUN (test scheduler produced no verdict; nothing failed): tests run --all --coverage",
        "[pre-push] NOT RUN (host capacity or memory unavailable; nothing failed): npm run build",
    ])("recognizes %s", (output) => {
        expect(noCapacityReason(output)).not.toBeNull();
    });
    it.each(["AssertionError: expected 1 to be 2", "Tests did not pass: src/a.test.ts", ""])("does not excuse %s", (output) => {
        expect(noCapacityReason(output)).toBeNull();
    });
});

describe("skipWithoutCapacity", () => {
    it("skips with the matched reason, and does nothing when a verdict exists", () => {
        const skip = vi.fn();
        skipWithoutCapacity({ skip }, "Host CPU or memory capacity unavailable for a test worker");
        expect(skip).toHaveBeenCalledWith("NOT RUN: the nested run got no host capacity (Host CPU or memory capacity unavailable)");
        skip.mockClear();
        skipWithoutCapacity({ skip }, "1 passed");
        expect(skip).not.toHaveBeenCalled();
    });
});
