// ===========================================
// Shadow protocol v1 — signing domains and the key-purpose gate (memo §2)
// ===========================================
// A signature is not verification. Before a signature check means anything,
// the key must be REGISTERED for the purpose the domain names, and the
// signing instant must fall inside the key's validity window. The domain →
// purpose map is STRICT and total: a key trusted for authoring signs nothing
// in the admission domain, and vice versa.
//
// The window check reuses `keyWindowFailure` from `mutation/protocol-v3`
// rather than re-deriving it — one implementation, one fail-closed rule for
// a malformed registry timestamp (a NaN comparison is always false, which
// would read a bad window as unbounded validity).

import { keyWindowFailure, type V3KeyRecord } from "../../mutation/protocol-v3/canonical.js";
import type { ShadowKeyPurpose, ShadowKeyRecordV1, ShadowSigningDomain } from "./types-attestation.js";
import type { Rfc3339 } from "./types-core.js";

/** The ONE domain→purpose map. Total by `satisfies`, so a new signing domain
 *  without a declared purpose fails the typecheck. */
export const DOMAIN_PURPOSE = {
	"interlinked-shadow-authoring": "shadow-authoring",
	"interlinked-shadow-admission": "shadow-admission",
} as const satisfies Record<ShadowSigningDomain, ShadowKeyPurpose>;

export function purposeForDomain(domain: ShadowSigningDomain): ShadowKeyPurpose {
	return DOMAIN_PURPOSE[domain];
}

/** The window check reads only the two boundaries; shadow purposes are
 *  gated separately below, so the adapter declares none. */
function windowRecord(record: ShadowKeyRecordV1): V3KeyRecord {
	// `exactOptionalPropertyTypes` — an absent revocation is an ABSENT key,
	// never a present `undefined`.
	const window: V3KeyRecord = { public_key_pem: record.public_key_pem, purposes: [], not_before: record.not_before };
	if (record.revoked_at !== null) window.revoked_at = record.revoked_at;
	return window;
}

/**
 * Why this key may NOT sign in this domain, or null when it may.
 * Fails CLOSED on a malformed `occurred_at`, `not_before`, or `revoked_at` —
 * an unparseable instant is never treated as "no constraint".
 */
export function keySigningFailure(record: ShadowKeyRecordV1, domain: ShadowSigningDomain, occurredAt: Rfc3339): string | null {
	const purpose = purposeForDomain(domain);
	if (!record.purposes.includes(purpose)) {
		return `signing key "${record.key_id}" is not registered for purpose "${purpose}" (domain "${domain}")`;
	}
	const occurredAtMs = Date.parse(occurredAt);
	if (!Number.isFinite(occurredAtMs)) {
		return `signing key "${record.key_id}" was presented with a malformed occurred_at — failing closed`;
	}
	return keyWindowFailure(record.key_id, windowRecord(record), occurredAtMs);
}

/** Boolean form of `keySigningFailure` for call sites that only branch. */
export function keyMaySign(record: ShadowKeyRecordV1, domain: ShadowSigningDomain, occurredAt: Rfc3339): boolean {
	return keySigningFailure(record, domain, occurredAt) === null;
}
