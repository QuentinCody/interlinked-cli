import { describe, expect, it } from "vitest";
import { sha256Hex } from "./canonical.js";
import { computeMissingSetDigestV1, MISSING_SET_DOMAIN_V1 } from "./missing-set.js";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function digestOf(content: string): string {
	return sha256Hex(Buffer.from(content, "utf8"));
}

const A = digestOf("a");
const B = digestOf("b");
const C = digestOf("c");

/** The envelope, re-implemented from the module header's prose in the TEST:
 *  domain ‖ 0x00 ‖ ascii(count) ‖ 0x00 ‖ digest32_1 ‖ … ‖ digest32_n,
 *  digests bytewise ascending. Two implementations, one answer. */
function envelope(digests: readonly string[]): string {
	const sorted = [...digests].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	return sha256Hex(
		Buffer.concat([
			Buffer.from("interlinked-shadow-missing-set-v1", "ascii"),
			Buffer.from([0x00]),
			Buffer.from(String(sorted.length), "ascii"),
			Buffer.from([0x00]),
			...sorted.map((hex) => Buffer.from(hex, "hex")),
		]),
	);
}

function hashOf(digests: readonly string[]): string {
	const result = computeMissingSetDigestV1(digests);
	return result.ok ? result.hash : `rejected(${result.reason})`;
}

/** The failure a set earns, or a thrown error when it was wrongly admitted.
 *  The branch lives HERE so no `it()` body carries a conditional. */
function rejectionOf(digests: readonly string[]): { reason: string; detail: string } {
	const result = computeMissingSetDigestV1(digests);
	if (result.ok) throw new Error(`expected a rejection, got ${result.hash}`);
	return { reason: result.reason, detail: result.detail };
}

describe("missing-set digest — positive (must hold)", () => {
	it("P1: a three-digest set reproduces the independently computed envelope", () => {
		expect(hashOf([A, B, C])).toBe(envelope([A, B, C]));
	});

	it("P2: input order cannot change the digest — the grammar sorts bytewise", () => {
		expect(hashOf([C, A, B])).toBe(hashOf([A, B, C]));
	});

	it("P3: the empty set is admitted and commits to a count of zero", () => {
		const result = computeMissingSetDigestV1([]);
		expect(result.ok).toBe(true);
		expect(hashOf([])).toBe(envelope([]));
		// It is an ENVELOPE, never the bare sha-256 of zero bytes: an empty
		// missing set must not collide with "hashed nothing at all".
		expect(hashOf([])).not.toBe(EMPTY_SHA256);
	});

	it("P4: one digest added changes the digest — the set is committed to, not summarized", () => {
		expect(hashOf([A, B])).not.toBe(hashOf([A, B, C]));
	});

	it("P5: the count is inside the envelope, so the domain constant is the pinned one", () => {
		expect(MISSING_SET_DOMAIN_V1).toBe("interlinked-shadow-missing-set-v1");
		expect(hashOf([A])).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("missing-set digest — negative (must not hold)", () => {
	it("N1: a duplicate digest is REJECTED, never silently deduplicated", () => {
		const failure = rejectionOf([A, B, A]);
		expect(failure.reason).toBe("mirror_integrity");
		expect(failure.detail).toContain(A);
	});

	it("N2: an uppercase hex digest is REJECTED — one spelling per digest", () => {
		const failure = rejectionOf([A.toUpperCase()]);
		expect(failure.reason).toBe("mirror_integrity");
		expect(failure.detail).toContain("digests[0]");
	});

	it("N3: a short (non-64-hex) digest is REJECTED", () => {
		expect(hashOf(["abc"])).toBe("rejected(mirror_integrity)");
	});

	it("N4: a `sha256:`-prefixed digest is REJECTED — the envelope embeds raw bytes", () => {
		expect(hashOf([`sha256:${A}`])).toBe("rejected(mirror_integrity)");
	});

	it("N5: a permutation of the same digests is NOT a different set", () => {
		expect(hashOf([B, A])).toBe(hashOf([A, B]));
	});
});
