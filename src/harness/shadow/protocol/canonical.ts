// ===========================================
// Shadow protocol v1 — canonical hashing (memo I5)
// ===========================================
// ONE canonical profile: every hashed or signed STRUCTURE uses the
// `mutation/protocol-v3` canonical JSON profile (recursive lexicographic key
// sort, no whitespace, lone surrogates rejected). Shadow does not fork it —
// a second profile is a second set of bytes for the same object, which is
// exactly the class of drift I5 exists to prevent.
//
// Domain separation comes from the SHAPES, not from a prefix: every hashed
// structure carries its own literal discriminator (`schema`, `schema_version`,
// `result_schema`), so two different records can never canonicalize to the
// same bytes. The memo's equations — `input_hash = H(canonical(...))`,
// `env_digest = H(canonical(ShadowEnvV1))` — are therefore implemented
// literally, with no extra framing.
//
// BYTE-level hashes (`shadow-tree-v1`, `shadow-postimages-v1`,
// `shadow-overlay-v1`, `shadow-dependency-tree-v1`) are NOT canonical-JSON
// hashes; they have their own grammars in `tree-hash.ts` / `tagged-set.ts`.

import { createHash } from "node:crypto";
import { canonicalJson } from "../../mutation/protocol-v3/canonical.js";
import type { CanonicalJson, Digest } from "./types-core.js";

/** Lowercase hex sha-256 of raw bytes. */
export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Raw 32-byte sha-256 — the fixed-width digest the byte grammars embed
 *  (fixed width, so the grammars need no framing around it). */
export function sha256Raw(bytes: Uint8Array): Buffer {
	return createHash("sha256").update(bytes).digest();
}

export function hexOfBytes(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

/** H(canonical(value)) — throws on content the canonical profile refuses
 *  (lone surrogates), so an unhashable value can never be silently hashed. */
export function canonicalDigest<P extends string>(value: unknown): Digest<P> {
	// SAFETY: the digest brand is a purpose label on a hex string; the caller's
	// type argument names the purpose, and this is its only mint site.
	return sha256Hex(Buffer.from(canonicalJson(value), "utf8")) as Digest<P>;
}

/** A value rendered as canonical JSON — the transport for mismatch reporting,
 *  where any field type (numbers included) must be representable. */
export function canonicalValue(value: unknown): CanonicalJson {
	// SAFETY: canonicalJson IS the definition of the CanonicalJson brand.
	return canonicalJson(value) as CanonicalJson;
}
