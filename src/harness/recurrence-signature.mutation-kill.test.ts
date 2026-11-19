// Mutation-kill tests for recurrence-signature.ts — kill-proof census row 30
// (docs/reviews/kill-proof-census-harness.md): the signatureless tool_failure message cap.
import { describe, expect, it } from "vitest";
import { deriveSignature } from "./recurrence-signature.js";

describe("deriveSignature — tool_failure message cap", () => {
	// test-contract: boundary — a message of exactly 120 characters stays readable and unhashed; 121 characters gets a hash suffix
	it("keeps a 120-character message verbatim and hashes a 121-character one", () => {
		const at = "a".repeat(120);
		expect(deriveSignature({ ts: "t", kind: "tool_failure", check_id: "c", message: at })).toBe(`tool_failure:c:${at}`);
		const over = "a".repeat(121);
		const sig = deriveSignature({ ts: "t", kind: "tool_failure", check_id: "c", message: over });
		expect(sig).toMatch(/^tool_failure:c:a{120}#[0-9a-f]{32}$/);
	});
});
