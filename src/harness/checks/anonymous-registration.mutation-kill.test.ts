import { describe, expect, it } from "vitest";
import { checkAnonymousRegistration } from "./anonymous-registration.js";

function entryWithGap(gap: number): string {
	return ['{ id: "my_check",', ...Array.from({ length: gap - 1 }, (_, i) => `  note${i}: 1,`), "  fn: () => [],", "}"].join("\n");
}

// Census fault: `i - lastKeyLine > ENTRY_WINDOW_LINES` → `>=` survived the
// companion test (docs/reviews/kill-proof-census-harness.md).
describe("checkAnonymousRegistration — entry window boundary", () => {
	// test-contract: boundary — an anonymous impl exactly 12 lines after its id is still inside the entry window
	it("fires when the anonymous impl sits exactly 12 lines below the id", () => {
		expect(checkAnonymousRegistration(entryWithGap(12), "src/registry.ts")).toEqual([{ line: 13, text: "fn: () => []," }]);
	});

	// test-contract: boundary — 13 lines below the id is outside the window
	it("does not fire 13 lines below the id", () => {
		expect(checkAnonymousRegistration(entryWithGap(13), "src/registry.ts")).toEqual([]);
	});
});
