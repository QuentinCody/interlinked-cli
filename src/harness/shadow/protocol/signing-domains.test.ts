import { describe, expect, it } from "vitest";
import { DOMAIN_PURPOSE, keyMaySign, keySigningFailure, purposeForDomain } from "./signing-domains.js";
import type { ShadowKeyRecordV1, ShadowSigningDomain } from "./types-attestation.js";
import type { Rfc3339 } from "./types-core.js";

/** SAFETY: test fixture — RFC3339 is a nominal brand on a string, and these
 *  literals are well-formed timestamps that never leave the test file. */
function ts(value: string): Rfc3339 {
	// SAFETY: RFC3339 is a nominal brand on a string; these fixture literals
	// are well-formed timestamps that never leave the test file.
	return value as Rfc3339;
}

const AUTHORING: ShadowSigningDomain = "interlinked-shadow-authoring";
const ADMISSION: ShadowSigningDomain = "interlinked-shadow-admission";

function key(overrides: Partial<ShadowKeyRecordV1> = {}): ShadowKeyRecordV1 {
	return {
		schema_version: 1,
		key_id: "k1",
		public_key_pem: "-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----\n",
		purposes: ["shadow-authoring"],
		not_before: ts("2026-08-01T00:00:00Z"),
		revoked_at: null,
		...overrides,
	};
}

describe("DOMAIN_PURPOSE — positive (must accept)", () => {
	it("P1: every signing domain maps to a distinct purpose", () => {
		const purposes = Object.values(DOMAIN_PURPOSE);
		expect(purposes).toHaveLength(new Set(purposes).size);
		expect(Object.keys(DOMAIN_PURPOSE).sort()).toEqual(["interlinked-shadow-admission", "interlinked-shadow-authoring"]);
	});

	it("P2: purposeForDomain returns the mapped purpose", () => {
		expect(purposeForDomain(AUTHORING)).toBe("shadow-authoring");
		expect(purposeForDomain(ADMISSION)).toBe("shadow-admission");
	});
});

describe("keyMaySign — positive (must accept)", () => {
	it("P1: a key declaring the domain's purpose, inside its window, may sign", () => {
		expect(keySigningFailure(key(), AUTHORING, ts("2026-08-15T00:00:00Z"))).toBeNull();
		expect(keyMaySign(key(), AUTHORING, ts("2026-08-15T00:00:00Z"))).toBe(true);
	});

	it("P2: a multi-purpose key may sign in either domain", () => {
		const both = key({ purposes: ["shadow-authoring", "shadow-admission"] });
		expect(keyMaySign(both, AUTHORING, ts("2026-08-15T00:00:00Z"))).toBe(true);
		expect(keyMaySign(both, ADMISSION, ts("2026-08-15T00:00:00Z"))).toBe(true);
	});

	it("P3: signing exactly at not_before is inside the window", () => {
		expect(keyMaySign(key(), AUTHORING, ts("2026-08-01T00:00:00Z"))).toBe(true);
	});

	it("P4: a revocation strictly after the signing instant leaves the key valid", () => {
		const revoked = key({ revoked_at: ts("2026-08-20T00:00:00Z") });
		expect(keyMaySign(revoked, AUTHORING, ts("2026-08-19T23:59:59Z"))).toBe(true);
	});
});

describe("keyMaySign — negative (must reject)", () => {
	it("N1: a key without the domain's purpose is refused (cross-purpose signing)", () => {
		const failure = keySigningFailure(key(), ADMISSION, ts("2026-08-15T00:00:00Z"));
		expect(failure).toContain("shadow-admission");
		expect(keyMaySign(key(), ADMISSION, ts("2026-08-15T00:00:00Z"))).toBe(false);
	});

	it("N2: signing before not_before is refused", () => {
		expect(keySigningFailure(key(), AUTHORING, ts("2026-07-31T23:59:59Z"))).toContain("not valid before");
	});

	it("N3: signing at or after revoked_at is refused", () => {
		const revoked = key({ revoked_at: ts("2026-08-20T00:00:00Z") });
		expect(keySigningFailure(revoked, AUTHORING, ts("2026-08-20T00:00:00Z"))).toContain("revoked");
	});

	it("N4: a malformed not_before fails CLOSED rather than reading as unbounded validity", () => {
		const bad = key({ not_before: ts("whenever") });
		expect(keySigningFailure(bad, AUTHORING, ts("2026-08-15T00:00:00Z"))).toContain("malformed");
	});

	it("N5: a malformed revoked_at fails CLOSED", () => {
		const bad = key({ revoked_at: ts("soon") });
		expect(keySigningFailure(bad, AUTHORING, ts("2026-08-15T00:00:00Z"))).toContain("malformed");
	});

	it("N6: a malformed signing instant fails CLOSED", () => {
		expect(keySigningFailure(key(), AUTHORING, ts("not-a-time"))).toContain("malformed");
	});

	it("N7: a key with no declared purposes signs nothing", () => {
		// SAFETY: the public key-purpose gate must reject an untrusted registry
		// key with no authorized purpose before any signature can be accepted.
		const empty = { ...key(), purposes: [] } as unknown as ShadowKeyRecordV1;
		expect(keyMaySign(empty, AUTHORING, ts("2026-08-15T00:00:00Z"))).toBe(false);
	});
});
