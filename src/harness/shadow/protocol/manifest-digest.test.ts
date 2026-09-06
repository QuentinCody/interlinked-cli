import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalValue } from "./canonical.js";
import { manifestDigestOf } from "./manifest-digest.js";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** sha-256 over the exact bytes, re-implemented in the TEST from the module
 *  header's prose — no canonicalization, no envelope, no framing. */
function expected(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function utf8(text: string): Uint8Array {
	return new Uint8Array(Buffer.from(text, "utf8"));
}

describe("manifest digest — positive (must hold)", () => {
	it("P1: the digest is the sha-256 of the exact uploaded bytes", () => {
		const bytes = utf8('{"schema_version":1,"entries":[]}');
		expect(manifestDigestOf(bytes)).toBe(expected(bytes));
	});

	it("P2: zero bytes hash the empty sha-256 — no envelope is added", () => {
		expect(manifestDigestOf(new Uint8Array(0))).toBe(EMPTY_SHA256);
	});

	it("P3: a plain Buffer and an equal Uint8Array agree", () => {
		const text = '{"a":1}';
		expect(manifestDigestOf(Buffer.from(text, "utf8"))).toBe(manifestDigestOf(utf8(text)));
	});

	it("P4: arbitrary (non-JSON, non-UTF-8) bytes are digestible", () => {
		const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x0a]);
		expect(manifestDigestOf(bytes)).toBe(expected(bytes));
	});

	it("P5: the result is lowercase 64-hex", () => {
		expect(manifestDigestOf(utf8("x"))).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("manifest digest — negative (must not hold)", () => {
	it("N1: the bytes are NOT re-canonicalized — key order changes the digest", () => {
		const asSent = utf8('{"b":2,"a":1}');
		const canonical = utf8(canonicalValue({ b: 2, a: 1 }));
		expect(Buffer.compare(Buffer.from(asSent), Buffer.from(canonical))).not.toBe(0);
		expect(manifestDigestOf(asSent)).not.toBe(manifestDigestOf(canonical));
	});

	it("N2: insignificant whitespace is NOT normalized away", () => {
		expect(manifestDigestOf(utf8('{"a": 1}'))).not.toBe(manifestDigestOf(utf8('{"a":1}')));
	});

	it("N3: a trailing newline changes the digest — the R2 object is hashed verbatim", () => {
		expect(manifestDigestOf(utf8('{"a":1}\n'))).not.toBe(manifestDigestOf(utf8('{"a":1}')));
	});

	it("N4: one flipped byte changes the digest", () => {
		expect(manifestDigestOf(new Uint8Array([1, 2, 3]))).not.toBe(manifestDigestOf(new Uint8Array([1, 2, 4])));
	});
});
