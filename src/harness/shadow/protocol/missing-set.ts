// ===========================================
// Shadow protocol v1 — the `shadow-missing-set-v1` byte grammar
// ===========================================
// `MissingSetRef.missing_set_digest` (types-transport.ts) was a BRAND with no
// grammar: nothing said which bytes it is computed over, so two
// implementations could both claim to produce it and disagree. Plan 01 needs
// it to mean one thing — that every page of `MissingBlobPageV1` walked ONE
// frozen set. A client re-fetching a later page compares this digest; if the
// broker recomputed the set after an upload, the digest moves and the client
// refuses the page instead of silently skipping the entries a shifted offset
// stepped over.
//
//   missing_set_digest = hex(sha256(
//       domain ‖ 0x00 ‖ ascii(count) ‖ 0x00 ‖ digest32_1 ‖ … ‖ digest32_n ))
//   domain = "interlinked-shadow-missing-set-v1"   (ASCII)
//
// `count` is the decimal entry count in ASCII, and each `digest32_i` is the
// RAW 32 bytes of a blob digest — fixed width, so the concatenation needs no
// separator. The domain and the count are what make this an ENVELOPE rather
// than a bare hash: the domain keeps a missing-set digest from ever equalling
// a tree or post-image digest over the same bytes, and the count commits to
// the LENGTH, so no reader can be handed a truncated set that hashes like a
// shorter one it was expecting.
//
// Digests are sorted BYTEWISE ascending, so page order, insertion order, and
// the broker's storage order cannot change the answer. They must also be
// UNIQUE: a duplicate is REJECTED, never deduplicated, because a set that
// silently absorbs a repeat would hash identically to a genuinely smaller
// set, and the count would then be a claim about a different collection than
// the digests are.
//
// Rejections are RETURNED, never thrown — this protocol must be able to say
// `shadow: unavailable`. The reason is `mirror_integrity`: a malformed or
// repeated digest in an upload set is the mirror's ingestion state being
// internally inconsistent, not a tree the grammar refuses.

import { sha256Hex } from "./canonical.js";
import { checkSha256Hex } from "./field-checks.js";
import { hashFailure, type ShadowHashFailure } from "./tree-hash.js";
import type { Digest } from "./types-core.js";

/** The ASCII domain separator the envelope opens with. Exported so a second
 *  implementation pins the literal rather than re-typing it. */
export const MISSING_SET_DOMAIN_V1 = "interlinked-shadow-missing-set-v1";

export type MissingSetDigest = Digest<"missing-set">;
export type MissingSetDigestResult = { readonly ok: true; readonly hash: MissingSetDigest } | ShadowHashFailure;

const NUL = 0x00;

/** Bytewise ascending over lowercase hex. Hex is ASCII, so code-unit order IS
 *  byte order here — no Unicode case can separate the two. */
function compareHex(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

/** The first digest that appears twice, or null when every entry is unique.
 *  Order-independent: the input is already sorted when this runs. */
function duplicateDigest(sorted: readonly string[]): string | null {
	for (let index = 1; index < sorted.length; index += 1) {
		const current = sorted[index];
		if (current !== undefined && current === sorted[index - 1]) return current;
	}
	return null;
}

/**
 * `shadow-missing-set-v1` over the blob digests of ONE frozen missing set.
 *
 * Every entry must be a lowercase 64-hex sha-256 (the `BlobDigest` spelling
 * the wire uses everywhere else — no `sha256:` prefix, no uppercase) and must
 * appear exactly once. The empty set is admitted and hashes the envelope with
 * a count of zero, which is deliberately NOT the sha-256 of zero bytes.
 */
export function computeMissingSetDigestV1(digests: readonly string[]): MissingSetDigestResult {
	for (const [index, digest] of digests.entries()) {
		const reason = checkSha256Hex(digest, `digests[${index}]`);
		if (reason !== null) return hashFailure("mirror_integrity", reason);
	}
	const sorted = [...digests].sort(compareHex);
	const duplicate = duplicateDigest(sorted);
	if (duplicate !== null) {
		return hashFailure("mirror_integrity", `duplicate blob digest in missing set: "${duplicate}"`);
	}
	const envelope = Buffer.concat([
		Buffer.from(MISSING_SET_DOMAIN_V1, "ascii"),
		Buffer.from([NUL]),
		Buffer.from(String(sorted.length), "ascii"),
		Buffer.from([NUL]),
		...sorted.map((hex) => Buffer.from(hex, "hex")),
	]);
	// SAFETY: this function is the ONE mint site for the missing-set digest
	// brand; the bytes above are the grammar the brand names.
	return { ok: true, hash: sha256Hex(envelope) as MissingSetDigest };
}
