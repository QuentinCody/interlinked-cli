import { describe, expect, it } from "vitest";
import { parseReceiptFixture, signReceipt } from "./test-authentication.js";

describe("receipt fixture decoding", () => {
	it.each(["null", "[]", "{}", '{"payload":null}', '{"payload":[]}'])("rejects a non-editable receipt shell: %s", (wire) => {
		expect(() => parseReceiptFixture(wire)).toThrow("fixture receipt must contain an object payload");
	});
	it("preserves the signed payload for deliberate field mutation", () => {
		const receipt = parseReceiptFixture(signReceipt({ job_id: "job-1", sequence: 0 }));
		expect(receipt.payload).toEqual({ job_id: "job-1", sequence: 0 });
		expect(receipt.signature).toMatchObject({ key_id: "k_control", value: expect.any(String) });
	});
});
