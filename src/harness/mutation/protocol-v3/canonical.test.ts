// ===========================================
// Direct P/N surface for the canonical leaf module — the serialization,
// snapshot, freeze, key-window, and key-REGISTRY primitives every other
// protocol-v3 module trusts. (The chain suites exercise them indirectly;
// this file pins each primitive's own contract.) The registry fail-closed
// cases below use two real key fixtures: a deterministic ed25519 SPKI PEM
// (same from-seed construction as receipts.test.ts, so it PARSES and lets
// the tests reach the purposes/window checks past the key-type gate) and a
// freshly generated RSA SPKI PEM to exercise the "wrong algorithm" branch.
// ===========================================
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	canonicalJson,
	deepFreeze,
	isWellFormedString,
	keyPurposeFailure,
	keyRegistryFailure,
	keyWindowFailure,
	registryRoleConflictFailure,
	safeStructuredClone,
	type V3KeyRecord,
	type V3KeyRegistry,
} from "./canonical.js";

const RECORD: V3KeyRecord = { public_key_pem: "unused", purposes: ["result"] };

const ED25519_SEED = Buffer.alloc(32, 8);
const VALID_PRIVATE_KEY = createPrivateKey({
	key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), ED25519_SEED]),
	format: "der",
	type: "pkcs8",
});
const VALID_PEM = createPublicKey(VALID_PRIVATE_KEY).export({ format: "pem", type: "spki" }).toString();
const RSA_PEM = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).publicKey;

describe("isWellFormedString — positive (must accept)", () => {
	// test-contract: public-api — ASCII, BMP, and a full surrogate pair.
	it("P1: accepts ASCII, BMP, and paired-surrogate strings", () => {
		expect(isWellFormedString("t_dev")).toBe(true);
		expect(isWellFormedString("café")).toBe(true);
		expect(isWellFormedString("\u{1F600}")).toBe(true);
	});
});

describe("isWellFormedString — negative (must reject)", () => {
	// test-contract: security — lone surrogates are the canonicalJson
	// injection surface (JSON.stringify escapes them undetectably).
	it("N1: rejects a lone high surrogate", () => {
		expect(isWellFormedString("t_dev\uD800")).toBe(false);
	});

	it("N2: rejects a lone low surrogate", () => {
		expect(isWellFormedString("\uDC00t_dev")).toBe(false);
	});
});

describe("canonicalJson — positive (must serialize)", () => {
	// test-contract: invariant — recursive lexicographic key sort, no
	// whitespace: two key orders, one byte sequence.
	it("P1: sorts keys recursively and emits identical bytes for reordered input", () => {
		const a = { b: { z: 1, a: 2 }, a: [1, 2] };
		const b = { a: [1, 2], b: { a: 2, z: 1 } };
		expect(canonicalJson(a)).toBe(canonicalJson(b));
		expect(canonicalJson(a)).toBe('{"a":[1,2],"b":{"a":2,"z":1}}');
	});
});

describe("canonicalJson — negative (must throw)", () => {
	it("N1: throws on a lone surrogate anywhere in the tree", () => {
		expect(() => canonicalJson({ deep: ["ok", "bad\uD800"] })).toThrow("lone surrogate");
	});
});

describe("safeStructuredClone — positive (must snapshot)", () => {
	// test-contract: security — tenth-pass P0-3: a getter is read EXACTLY
	// once at clone time; later reads of the clone cannot change.
	it("P1: reads an accessor exactly once and detaches from the source", () => {
		let reads = 0;
		const trap = {
			get value(): string {
				reads += 1;
				return reads === 1 ? "honest" : "swapped";
			},
		};
		const clone = safeStructuredClone(trap);
		expect(clone?.value).toBe("honest");
		expect(clone?.value).toBe("honest");
		expect(reads).toBe(1);
	});

	it("P2: the clone shares no references with the source", () => {
		const source = { rows: [{ status: "killed" }] };
		const clone = safeStructuredClone(source);
		expect(clone?.rows[0]).not.toBe(source.rows[0]);
		expect(clone).toEqual(source);
	});
});

describe("safeStructuredClone — negative (must reject)", () => {
	it("N1: returns null for a non-cloneable value", () => {
		expect(safeStructuredClone({ fn: () => 1 })).toBe(null);
	});
});

describe("deepFreeze — positive (must freeze recursively)", () => {
	it("P1: freezes the root, nested objects, and arrays in place", () => {
		const value = { rows: [{ status: "killed" }] };
		expect(deepFreeze(value)).toBe(value);
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.rows)).toBe(true);
		expect(Object.isFrozen(value.rows[0])).toBe(true);
	});
});

describe("keyWindowFailure — positive (inside the window)", () => {
	it("P1: passes with no bounds and inside both bounds", () => {
		const at = Date.parse("2026-08-15T00:00:00Z");
		expect(keyWindowFailure("k", RECORD, at)).toBe(null);
		const bounded = { ...RECORD, not_before: "2026-08-01T00:00:00Z", revoked_at: "2026-09-01T00:00:00Z" };
		expect(keyWindowFailure("k", bounded, at)).toBe(null);
	});
});

describe("keyWindowFailure — negative (must fail)", () => {
	it("N1: fails before not_before", () => {
		const record = { ...RECORD, not_before: "2026-08-01T00:00:00Z" };
		expect(keyWindowFailure("k", record, Date.parse("2026-07-31T23:59:59Z"))).toContain("not valid before");
	});

	it("N2: fails at/after revoked_at", () => {
		const record = { ...RECORD, revoked_at: "2026-09-01T00:00:00Z" };
		expect(keyWindowFailure("k", record, Date.parse("2026-09-01T00:00:00Z"))).toContain("revoked");
	});

	// test-contract: security — NaN comparisons are always false; a
	// malformed registry timestamp must fail CLOSED, not read as unbounded.
	it("N3: fails closed on a malformed window timestamp", () => {
		const record = { ...RECORD, revoked_at: "not-a-date" };
		expect(keyWindowFailure("k", record, Date.parse("2026-08-15T00:00:00Z"))).toContain("malformed");
	});
});

describe("keyPurposeFailure — positive/negative", () => {
	it("P1: a declared purpose passes", () => {
		expect(keyPurposeFailure("k", RECORD, "result")).toBe(null);
	});

	it("N1: an undeclared purpose names the key and purpose", () => {
		expect(keyPurposeFailure("k", RECORD, "acceptance")).toContain('not trusted for purpose "acceptance"');
	});
});

describe("keyRegistryFailure — positive (must accept)", () => {
	it("P1: accepts a well-formed single-key registry", () => {
		const registry = { k1: { public_key_pem: VALID_PEM, purposes: ["result"] } };
		expect(keyRegistryFailure(registry)).toBe(null);
	});
});

describe("keyRegistryFailure — negative (must fail closed)", () => {
	it("N1: rejects a non-object registry container", () => {
		expect(keyRegistryFailure("not-an-object")).toBe("key registry must be an object of key records");
	});

	it("N2: rejects an empty registry", () => {
		expect(keyRegistryFailure({})).toBe("key registry must carry 1..64 keys — failing closed");
	});

	it("N3: rejects a registry over the 64-key cap", () => {
		const oversized = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, {}]));
		expect(keyRegistryFailure(oversized)).toBe("key registry must carry 1..64 keys — failing closed");
	});

	it("N4: rejects an empty key id", () => {
		expect(keyRegistryFailure({ "": {} })).toBe("key ids must be 1..128 characters — failing closed");
	});

	it("N4b: rejects a key id over the 128-character cap", () => {
		expect(keyRegistryFailure({ [`x`.repeat(129)]: {} })).toBe(
			"key ids must be 1..128 characters — failing closed",
		);
	});

	it("N5: rejects a key record that is not an object", () => {
		expect(keyRegistryFailure({ k1: "not-a-record" })).toBe('key "k1" must be a record');
	});

	it("N6: rejects a key record carrying an unknown property", () => {
		const registry = { k1: { public_key_pem: VALID_PEM, purposes: ["result"], extra: 1 } };
		expect(keyRegistryFailure(registry)).toBe('key "k1" carries unknown property "extra" — failing closed');
	});

	it("N7: rejects an unparseable public key string", () => {
		const registry = { k1: { public_key_pem: "not a pem at all", purposes: ["result"] } };
		expect(keyRegistryFailure(registry)).toBe('key "k1" has no parseable SPKI public key — failing closed');
	});

	it("N8: rejects a non-ed25519 key type", () => {
		const registry = { k1: { public_key_pem: RSA_PEM, purposes: ["result"] } };
		expect(keyRegistryFailure(registry)).toBe(
			'key "k1" is "rsa" but the contract requires ed25519 — failing closed',
		);
	});

	it("N9: rejects an empty purposes array", () => {
		const registry = { k1: { public_key_pem: VALID_PEM, purposes: [] } };
		expect(keyRegistryFailure(registry)).toBe(
			'key "k1" must declare unique purposes from acceptance|terminalization|execution|result — failing closed',
		);
	});

	it("N10: rejects a malformed not_before timestamp", () => {
		const registry = { k1: { public_key_pem: VALID_PEM, purposes: ["result"], not_before: "not-a-date" } };
		expect(keyRegistryFailure(registry)).toBe(
			'key "k1" not_before must be a valid RFC3339 timestamp — failing closed',
		);
	});

	// test-contract: pins the RFC3339_RE conjunct specifically — Date.parse
	// alone accepts a bare date, so a regex-only rejection proves the pattern
	// (not just the NaN fallback) is doing the work.
	it("N10b: rejects a date-only string that Date.parse would accept but the RFC3339 pattern requires a time component for", () => {
		const registry = { k1: { public_key_pem: VALID_PEM, purposes: ["result"], not_before: "2026-09-04" } };
		expect(keyRegistryFailure(registry)).toBe(
			'key "k1" not_before must be a valid RFC3339 timestamp — failing closed',
		);
	});
});

describe("registryRoleConflictFailure — negative (must fail closed)", () => {
	it("N1: rejects an unparseable public key when fingerprinting", () => {
		const registry: V3KeyRegistry = { k1: { public_key_pem: "not a pem at all", purposes: ["execution"] } };
		expect(registryRoleConflictFailure(registry)).toBe(
			'key "k1" has no parseable SPKI public key — failing closed',
		);
	});
});
