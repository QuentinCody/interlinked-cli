import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../mutation/protocol-v3/canonical.js";
import { canonicalDigest, canonicalValue, hexOfBytes, sha256Hex } from "./canonical.js";

describe("canonical — positive (must hold)", () => {
	it("P1: canonicalDigest is sha-256 over the protocol-v3 canonical profile", () => {
		const value = { b: 1, a: { d: 2, c: 3 } };
		const expected = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
		expect(canonicalDigest(value)).toBe(expected);
	});

	it("P2: key order and object identity do not change the digest", () => {
		expect(canonicalDigest({ a: 1, b: 2 })).toBe(canonicalDigest({ b: 2, a: 1 }));
	});

	it("P3: a different value gives a different digest", () => {
		expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: 2 }));
	});

	it("P4: canonicalValue renders a value as canonical JSON for mismatch reporting", () => {
		expect(canonicalValue({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
		expect(canonicalValue(7)).toBe("7");
		expect(canonicalValue(null)).toBe("null");
	});

	it("P5: sha256Hex and hexOfBytes agree on raw bytes", () => {
		const bytes = Buffer.from("abc", "utf8");
		expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(hexOfBytes(Buffer.from([0x00, 0xff]))).toBe("00ff");
	});
});

describe("canonical — negative (must reject)", () => {
	it("N1: a lone surrogate is refused rather than hashed", () => {
		expect(() => canonicalDigest({ a: "\uD800" })).toThrow();
		expect(() => canonicalValue("\uDC00")).toThrow();
	});
});
