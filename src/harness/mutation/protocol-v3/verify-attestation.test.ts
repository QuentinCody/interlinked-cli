// ===========================================
// Protocol v3 — result identity, clock, and Ed25519 attestation checks
// ===========================================
// computeResultHash / timeFailure / signatureFailure are already exercised
// end-to-end through verify.ts's trust-boundary tests (verify.test.ts calls
// them indirectly on every fixture). This file pins the ONE branch that
// requires a genuinely malformed key, which the shared fixtures never
// produce: signatureFailure's catch arm when the registered public key is
// not valid PEM/DER and node:crypto's verify() throws instead of returning
// false.

import { describe, expect, it } from "vitest";
import type { V3KeyRegistry } from "./canonical.js";
import { validMutationResult } from "./test-envelopes.js";
import type { V3Envelope } from "./types.js";
import { signatureFailure } from "./verify-attestation.js";

describe("signatureFailure — malformed key material", () => {
	// test-contract: security — a registered key whose PEM/DER is unparsable
	// must fail closed with the malformed-key reason, not throw uncaught or
	// report a bare "signature verification failed" that hides the real
	// cause from an operator diagnosing a bad key registration.
	it("N1: a registered key with unparsable PEM fails closed with the malformed-key reason", () => {
		// SAFETY: validMutationResult() already returns a V3MutationResult,
		// which is one arm of the V3Envelope union; signatureFailure only
		// reads the shared signature/occurred_at fields common to every arm.
		const envelope = validMutationResult() as unknown as V3Envelope;
		const registry: V3KeyRegistry = {
			[envelope.signature.key_id]: {
				public_key_pem: "not-a-valid-pem",
				purposes: ["result"],
			},
		};
		expect(signatureFailure(envelope, registry)).toBe(
			"signature verification errored — malformed key or signature encoding",
		);
	});
});
