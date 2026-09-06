// interlinked-tdd: exempt — type-only module (no runtime surface); the
// domain→purpose map that governs it lives in `signing-domains.ts`, which
// carries its own test.
// ===========================================
// Shadow protocol v1 — signed envelopes, attestations, key registry
// ===========================================
// public API — the authoring lane's attestation is the only one Plans 00–04
// produce, and the only one this package still declares. The Workstream 06
// ADMISSION seam (`AdmissionJobV1`, the nonce state, the admission request and
// its attestation) moved to `interlinked-cloud` in the 2026-09-04 public/private
// split: admission runs on the broker, so its types are the cloud's to own. What
// stays is what a CLIENT needs — the envelope shape, the authoring payload, and
// the key registry it verifies signatures against.

import type {
	ShadowExecutionBinding,
	ShadowFreshnessBinding,
} from "./types-binding.js";
import type {
	Digest,
	OpaqueId,
	ResultHash,
	Rfc3339,
	ShadowChangeSetV1,
} from "./types-core.js";
import type { NonEmpty } from "./types-outcome.js";

export interface SignedEnvelope<Domain extends string, Payload> {
	signed: {
		domain: Domain;
		protocol_version: 1;
		key_id: string;
		occurred_at: Rfc3339;
		result_hash: ResultHash;
		payload: Payload;
	};
	signature: string;
}

/** The authoring lane signs EXECUTION FACTS and the ECHOED freshness claim.
 *  It never attests that the claim matches local disk — that is
 *  `LocalFreshnessCheckV1`, made by the daemon and never sent (memo I4). */
export interface AuthoringAttestationPayloadV1 {
	scope: "authoring";
	tenant: OpaqueId;
	project: OpaqueId;
	repository_id: OpaqueId;
	session_id: OpaqueId;
	measured_execution: ShadowExecutionBinding;
	freshness_claim_echo: ShadowFreshnessBinding;
	changeset: ShadowChangeSetV1;
	request_nonce: OpaqueId;
	command_hash: Digest<"command">;
	command_display: string;
	verifier_kind: "tsc";
	ruleset_hash: Digest<"ruleset">;
	key_purpose: "shadow-authoring";
}
export type AuthoringAttestationV1 = SignedEnvelope<"interlinked-shadow-authoring", AuthoringAttestationPayloadV1>;

export type ShadowKeyPurpose = "shadow-authoring" | "shadow-admission";
export type ShadowSigningDomain = "interlinked-shadow-authoring" | "interlinked-shadow-admission";

/** Shadow keys get their own record — the shared `V3KeyPurpose` has no
 *  shadow purposes — and a key signs nothing outside its declared ones. */
export interface ShadowKeyRecordV1 {
	schema_version: 1;
	key_id: string;
	public_key_pem: string; // SPKI PEM, Ed25519
	purposes: NonEmpty<ShadowKeyPurpose>;
	not_before: Rfc3339;
	revoked_at: Rfc3339 | null;
}

export type VerifiedAuthoringAttestation = AuthoringAttestationV1 & { readonly __verified: "authoring" };
