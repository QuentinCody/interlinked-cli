import { expect, it } from "vitest";
import { verifyInputExclusion } from "./input-budget.js";

// test-contract: boundary — foreground scans retain the former admission boundary.
it("keeps an input of exactly the former 256KiB budget in scope", () => {
    expect(verifyInputExclusion("a".repeat(256 * 1024))).toBeNull();
});

// test-contract: boundary — passing the former budget must preserve the whole body.
it("keeps an input one byte over the former budget in scope", () => {
    expect(verifyInputExclusion("a".repeat(256 * 1024 + 1))).toBeNull();
});
