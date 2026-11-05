import { expect, it } from "vitest";
import { VERIFY_INLINE_MAX_BYTES, verifyInputExclusion } from "./input-budget.js";

// test-contract: boundary — an input of exactly the budget still fits; only a byte beyond it is oversized
it("keeps an input of exactly VERIFY_INLINE_MAX_BYTES bytes in scope", () => {
    expect(verifyInputExclusion("a".repeat(VERIFY_INLINE_MAX_BYTES))).toBeNull();
});

// test-contract: boundary — the first byte past the budget is excluded as oversized
it("excludes an input one byte over the budget as oversized", () => {
    expect(verifyInputExclusion("a".repeat(VERIFY_INLINE_MAX_BYTES + 1))).toBe("oversized");
});
