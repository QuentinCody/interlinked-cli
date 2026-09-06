// ===========================================
// Shadow protocol v1 — `ManifestDigest` over the EXACT uploaded bytes
// ===========================================
// `ManifestUploadInitRequestV1.declared_digest` (types-transport.ts) was a
// BRAND with no grammar. It has exactly one job: the client declares what it
// is about to PUT, and the broker, after the object lands in R2, hashes what
// it stored and compares. So the grammar is the narrowest one possible —
//
//   manifest_digest = hex(sha256(bytes))
//
// over the octets of the object AS RECEIVED. No domain envelope, no length
// field, no framing: unlike a set digest, there is nothing here to separate
// domains between, because the bytes are opaque to this function and the
// comparison is byte-for-byte against a single stored object.
//
// NEVER re-canonicalize before hashing. A canonical re-encoding (sorting the
// manifest's keys, dropping insignificant whitespace) would hash something
// the client never sent: the broker would then be comparing its own
// re-rendering of the upload against the client's declaration, and a stored
// object that differs from the declared one in exactly the ways the
// canonicalizer erases would pass. The whole point of `declared_digest` is
// that it pins the transferred bytes, so whitespace, key order, and a
// trailing newline are all SIGNIFICANT here.
//
// This is why the function takes `Uint8Array` and not a parsed value or a
// string: a string re-encoding would silently pick an encoding, and there is
// no failure mode — any byte sequence is digestible, so the result is
// returned bare rather than as a `ShadowHashResult`.

import { sha256Hex } from "./canonical.js";
import type { ManifestDigest } from "./types-core.js";

/**
 * `ManifestDigest` of a manifest upload — sha-256 over the exact bytes the
 * client PUTs and the broker stores. Callers hash the buffer they are about
 * to send, never a re-serialization of the value it came from.
 */
export function manifestDigestOf(bytes: Uint8Array): ManifestDigest {
	// SAFETY: this function is the ONE mint site for the snapshot-manifest
	// digest brand, and the hash above is the grammar the brand names.
	return sha256Hex(bytes) as ManifestDigest;
}
