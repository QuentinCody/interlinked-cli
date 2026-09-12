// ===========================================
// Protocol v3 — signed receipt schemas (unit pins)
// ===========================================
// Fifth pass 2026-08-31: receipts carry the full production bindings, a
// SIGNED timestamp for key-window checks, and verify under key PURPOSES.

import { createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, type V3KeyRegistry } from "./canonical.js";
import { canonicalReceiptHash, parseSignedReceipt } from "./receipts.js";
import { PROTOCOL_V3_VERSION, SOURCE_ARTIFACT_FORMAT } from "./types.js";

const SEED = Buffer.alloc(32, 7);
const PRIVATE_KEY = createPrivateKey({
	key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), SEED]),
	format: "der",
	type: "pkcs8",
});
const PUBLIC_PEM = createPublicKey(PRIVATE_KEY).export({ format: "pem", type: "spki" }).toString();
const REGISTRY: V3KeyRegistry = {
	k1: { public_key_pem: PUBLIC_PEM, purposes: ["acceptance", "execution", "terminalization", "result"] },
};

function signedReceiptText(payload: Record<string, unknown>, keyId = "k1"): string {
	// The SIGNED bytes include key_id (sixth-pass P0).
	const value = edSign(null, Buffer.from(canonicalJson({ key_id: keyId, payload }), "utf8"), PRIVATE_KEY).toString(
		"base64",
	);
	return JSON.stringify({ payload, signature: { key_id: keyId, value } });
}

const EXECUTION_PAYLOAD = {
	receipt_version: "1",
	kind: "execution",
	issued_at: "2026-08-31T11:59:00.000Z",
	acceptance_receipt_hash: "b".repeat(64),
	source_artifact: {
		format: SOURCE_ARTIFACT_FORMAT,
		artifact_id: "src_fixture_bundle_0001",
		sha256: "9".repeat(64),
		bytes: 1024,
	},
	job_key: "job_0001",
	attempt_id: "attempt_0001",
	image_digest: `sha256:${"0".repeat(64)}`,
	engine_name: "stryker",
	engine_version: "8.2.0",
	engine_config_hash: "f".repeat(64),
	lockfile_hash: "a".repeat(64),
	runtime_identity: "node-22.22.0",
	package_manager_identity: "npm-10.9.4",
	test_command_hash: "5".repeat(64),
	test_selection_algorithm: "import-graph-v2",
	selected_test_hash: "6".repeat(64),
	selected_test_count: 12,
};

const ACCEPTANCE_PAYLOAD = {
	receipt_version: "1",
	kind: "acceptance",
	protocol_version: PROTOCOL_V3_VERSION,
	issued_at: "2026-08-31T11:59:00.000Z",
	job: {
		tenant: "tenant_0001",
		project: "proj_0001",
		repository: "repo_0001",
		commit: "c".repeat(40),
		target_file: "src/a.ts",
		target_content_hash: "d".repeat(64),
		job_key: "job_0001",
	},
	approved_policy_ids: ["policy-a1", "policy-b2"],
	policy_version: "v1",
	request_hash: "e".repeat(64),
	test_scope_hash: "1".repeat(64),
	quota_reservation_id: "quota_0001",
	changeset_hash: "2".repeat(64),
	source_artifact: {
		format: SOURCE_ARTIFACT_FORMAT,
		artifact_id: "src_fixture_bundle_0002",
		sha256: "3".repeat(64),
		bytes: 2048,
	},
	intended_image_digest: `sha256:${"4".repeat(64)}`,
	intended_engine_config_hash: "5".repeat(64),
	intended_scope_mode: "import_graph",
};

describe("parseSignedReceipt — signed malformed payloads", () => {
	it.each([
		[{ job: null }, "acceptance.job must be an object"],
		[{ approved_policy_ids: "policy-a1" }, "acceptance.approved_policy_ids must be an array"],
		[{ receipt_version: "2" }, 'acceptance receipt_version must be "1"'],
		[{ protocol_version: "unsupported" }, `acceptance.protocol_version must be exactly "${PROTOCOL_V3_VERSION}"`],
	])("rejects malformed acceptance fields even with a valid signature: %j", (fields, reason) => {
		const text = signedReceiptText({ ...ACCEPTANCE_PAYLOAD, ...fields });
		expect(parseSignedReceipt(text, "acceptance", REGISTRY)).toEqual({ ok: false, reason });
	});
});

describe("parseSignedReceipt — positive (must accept)", () => {
	// test-contract: public-api — a well-formed signed execution receipt
	// parses, verifies, and exposes its canonical payload hash.
	it("P1: a signed execution receipt parses and verifies", () => {
		const text = signedReceiptText(EXECUTION_PAYLOAD);
		const outcome = parseSignedReceipt(text, "execution", REGISTRY);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.payload.attempt_id).toBe("attempt_0001");
		expect(outcome.canonical_hash).toBe(canonicalReceiptHash(EXECUTION_PAYLOAD));
		expect(outcome.signing_key_id).toBe("k1");
	});
});

describe("parseSignedReceipt — negative (must reject)", () => {
	// test-contract: security — the fourth-pass repro: a receipt with the
	// attempt id buried in a DIFFERENT field must not parse (strict schema).
	it("N1: the not_attempt_id smuggle rejects", () => {
		// SAFETY: widened deliberately to swap a field name for the probe.
		const smuggled = { ...EXECUTION_PAYLOAD } as Record<string, unknown>;
		delete smuggled.attempt_id;
		smuggled.not_attempt_id = "prefix-attempt_0001-suffix";
		const outcome = parseSignedReceipt(signedReceiptText(smuggled), "execution", REGISTRY);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain("attempt_id");
	});

	// test-contract: security — wrong kind, tampered payload, forged
	// signature, unknown key, and unparseable text all reject.
	it("N2: kind/signature/tamper failures reject", () => {
		const wrongKind = parseSignedReceipt(signedReceiptText(EXECUTION_PAYLOAD), "acceptance", REGISTRY);
		expect(wrongKind.ok).toBe(false);
		const forged = JSON.stringify({
			payload: { ...EXECUTION_PAYLOAD, attempt_id: "attempt_9999" },
			// SAFETY: parse of our own just-built JSON string.
			signature: (JSON.parse(signedReceiptText(EXECUTION_PAYLOAD)) as { signature: unknown }).signature,
		});
		const tampered = parseSignedReceipt(forged, "execution", REGISTRY);
		expect(tampered.ok).toBe(false);
		if (!tampered.ok) expect(tampered.reason).toContain("signature");
		expect(parseSignedReceipt("not json", "execution", REGISTRY).ok).toBe(false);
		const unknownKey = signedReceiptText(EXECUTION_PAYLOAD).replace('"k1"', '"k9"');
		expect(parseSignedReceipt(unknownKey, "execution", REGISTRY).ok).toBe(false);
	});

	// test-contract: security — fifth-pass P0: key PURPOSES separate the
	// signer roles, and the key window applies to the receipt's own SIGNED
	// timestamp (a receipt signed by a key revoked before issuance fails).
	it("N3: purpose separation and receipt key windows enforce", () => {
		const resultOnly: V3KeyRegistry = { k1: { public_key_pem: PUBLIC_PEM, purposes: ["result"] } };
		const purpose = parseSignedReceipt(signedReceiptText(EXECUTION_PAYLOAD), "execution", resultOnly);
		expect(purpose.ok).toBe(false);
		if (!purpose.ok) expect(purpose.reason).toContain('purpose "execution"');
		const revoked: V3KeyRegistry = {
			k1: { public_key_pem: PUBLIC_PEM, purposes: ["execution"], revoked_at: "2026-08-01T00:00:00Z" },
		};
		const window = parseSignedReceipt(signedReceiptText(EXECUTION_PAYLOAD), "execution", revoked);
		expect(window.ok).toBe(false);
		if (!window.ok) expect(window.reason).toContain("revoked");
	});

	// test-contract: security — sixth-pass P0: key_id is INSIDE the signed
	// bytes, so relabeling a signature to a same-key alias with a different
	// purpose breaks the signature.
	it("N4: a relabeled key_id fails the signature", () => {
		const aliasRegistry: V3KeyRegistry = {
			k1: { public_key_pem: PUBLIC_PEM, purposes: ["execution"] },
			k_alias: { public_key_pem: PUBLIC_PEM, purposes: ["execution"] },
		};
		const signedAsK1 = signedReceiptText(EXECUTION_PAYLOAD, "k1");
		const relabeled = signedAsK1.replace('"key_id":"k1"', '"key_id":"k_alias"');
		const outcome = parseSignedReceipt(relabeled, "execution", aliasRegistry);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain("signature");
	});

	// test-contract: security — format is part of the signed source binding,
	// not out-of-band decoder configuration.
	it("N5: a missing or unknown source artifact format rejects", () => {
		const { format: _omitted, ...missing } = EXECUTION_PAYLOAD.source_artifact;
		const withoutFormat = parseSignedReceipt(
			signedReceiptText({ ...EXECUTION_PAYLOAD, source_artifact: missing }),
			"execution",
			REGISTRY,
		);
		expect(withoutFormat.ok).toBe(false);
		if (!withoutFormat.ok) expect(withoutFormat.reason).toContain("source_artifact.format");
		const wrongFormat = parseSignedReceipt(
			signedReceiptText({
				...EXECUTION_PAYLOAD,
				source_artifact: { ...EXECUTION_PAYLOAD.source_artifact, format: "zip-v1" },
			}),
			"execution",
			REGISTRY,
		);
		expect(wrongFormat.ok).toBe(false);
		if (!wrongFormat.ok) expect(wrongFormat.reason).toContain(`exactly "${SOURCE_ARTIFACT_FORMAT}"`);
	});

	// test-contract: security — approved_policy_ids is the AUTHORIZATION list;
	// a duplicate would let one approval be double-counted against a quota.
	it("N6: acceptance approved_policy_ids containing a duplicate rejects", () => {
		const duplicated = {
			...ACCEPTANCE_PAYLOAD,
			approved_policy_ids: ["policy-a1", "policy-a1"],
		};
		const outcome = parseSignedReceipt(signedReceiptText(duplicated), "acceptance", REGISTRY);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe("acceptance.approved_policy_ids must not contain duplicates");
		}
	});

	// test-contract: boundary — the outer envelope shape check rejects a
	// non-object `signature` field before any key/purpose/crypto check runs.
	it("N7: an envelope whose signature field is not an object rejects", () => {
		const text = JSON.stringify({ payload: ACCEPTANCE_PAYLOAD, signature: "not-an-object" });
		const outcome = parseSignedReceipt(text, "acceptance", REGISTRY);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe("acceptance receipt must be {payload, signature}");
	});

	// test-contract: security — a malformed registry public key must ERROR the
	// signature check (rejected), never silently read as "verification passed".
	it("N8: a malformed registry public key errors the signature check", () => {
		const brokenKeyRegistry: V3KeyRegistry = {
			k1: { public_key_pem: "not a pem", purposes: ["execution"] },
		};
		const outcome = parseSignedReceipt(signedReceiptText(EXECUTION_PAYLOAD), "execution", brokenKeyRegistry);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe('receipt signature by "k1" errored — malformed key or signature encoding');
		}
	});
});
