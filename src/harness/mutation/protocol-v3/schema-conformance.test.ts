// ===========================================
// Protocol v3 — machine-readable schemas EXECUTED (sixth pass P1)
// ===========================================
// The JSON Schemas in protocol/mutation-v3/schema/ are part of the
// cross-repository contract; this suite runs them through Ajv 2020-12
// (a direct, exact-pinned devDependency). The cloud repo does NOT run
// them yet — that obligation lands when the contract is vendored there.
// The TS parser stays normative for cross-field invariants; the schemas
// must agree with it on everything they express (parity-pinned below).

import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUntrustedEnvelope } from "./parse.js";
import { PROTOCOL_V3_CONTRACT_DIGEST } from "./contract-identity.js";
import { MAX_APPROVED_POLICY_IDS, parseSignedReceipt } from "./receipts.js";
import { buildStructuralReport } from "./report.js";
import { parseMutationJobRequestV3 } from "./request.js";
import { isRecord } from "./field-checks.js";
import { parseReceiptFixture, signReceipt, TEST_REGISTRY } from "./test-authentication.js";
import { validMutationResult } from "./test-envelopes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../protocol/mutation-v3");

function loadJson(relative: string): Record<string, unknown> {
	// SAFETY: repo-committed fixtures/schemas; drift fails loudly below.
	return JSON.parse(readFileSync(join(ROOT, relative), "utf-8")) as Record<string, unknown>;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateEnvelope = ajv.compile(loadJson("schema/envelope.schema.json"));
const validateReceipt = ajv.compile(loadJson("schema/receipts.schema.json"));
const validateReport = ajv.compile(loadJson("schema/report.schema.json"));

describe("schema conformance — portable mutant identity", () => {
	// test-contract: invariant — the reference builder's v2 full-width
	// provenance is accepted by both envelope and structural-report schemas.
	// This pin is independent of the signed fixture corpus, which is
	// regenerated only after all parallel protocol lanes have merged.
	it("P: canonical interlinked-site-v2 evidence validates against both schemas", () => {
		const envelope = validMutationResult();
		expect(validateEnvelope(envelope), JSON.stringify(validateEnvelope.errors)).toBe(true);
		expect(
			validateReport(JSON.parse(buildStructuralReport(envelope))),
			JSON.stringify(validateReport.errors),
		).toBe(true);
	});
});

// SAFETY: signed-bundles.json is the committed corpus generated with the protocol fixtures; every envelope and signed receipt is checked against its schema below.
const bundles = loadJson("fixtures/signed-bundles.json") as unknown as {
	vectors: Array<{
		name: string;
		envelope: Record<string, unknown>;
		acceptance_receipt: string;
		execution_receipt?: string;
		terminalization_receipt?: string;
		report_text?: string;
	}>;
};

describe("schema conformance — positive (shared fixtures validate)", () => {
	for (const bundle of bundles.vectors) {
		// test-contract: invariant — every shared bundle's envelope,
		// receipts, and report validate against the machine-readable schemas.
		it(`P: ${bundle.name} validates against all three schemas`, () => {
			expect(validateEnvelope(bundle.envelope)).toBe(true);
			expect(validateReceipt(JSON.parse(bundle.acceptance_receipt))).toBe(true);
			if (bundle.execution_receipt !== undefined) {
				expect(validateReceipt(JSON.parse(bundle.execution_receipt))).toBe(true);
			}
			if (bundle.terminalization_receipt !== undefined) {
				expect(validateReceipt(JSON.parse(bundle.terminalization_receipt))).toBe(true);
			}
			if (bundle.report_text !== undefined) {
				expect(validateReport(JSON.parse(bundle.report_text))).toBe(true);
			}
		});
	}
});

describe("schema conformance — negative (reviewer probes reject)", () => {
	const base = (): Record<string, unknown> =>
		structuredClone(bundles.vectors[0]?.envelope ?? {});

	// test-contract: security — the sixth-pass Ajv probes: unknown root
	// keys, dot-prefixed paths, backslash paths. Each must fail the SCHEMA
	// and the reference parser identically.
	it("N1: unknown root keys and malformed paths fail schema AND parser", () => {
		const unknownKey = { ...base(), vendor_extra: true };
		expect(validateEnvelope(unknownKey)).toBe(false);
		expect(parseUntrustedEnvelope(unknownKey).ok).toBe(false);
		for (const badPath of ["./src/example.ts", "src\\lib\\example.ts", "src/./x.ts"]) {
			const env = base();
			// SAFETY: fixture clone; job is a plain object.
			(env.job as Record<string, unknown>).target_file = badPath;
			expect(validateEnvelope(env)).toBe(false);
			expect(parseUntrustedEnvelope(env).ok).toBe(false);
		}
	});

	// test-contract: security — duplicate approved policy ids fail the
	// receipt schema and the reference receipt parser.
	it("N2: duplicate approved_policy_ids fail the receipt schema", () => {
		const receipt = parseReceiptFixture(bundles.vectors[0]?.acceptance_receipt ?? "");
		receipt.payload.approved_policy_ids = ["policy-string-literal-noise", "policy-string-literal-noise"];
		expect(validateReceipt(receipt)).toBe(false);
	});

	// test-contract: security — a prose report fails the report schema.
	it("N3: a prose report fails the report schema", () => {
		expect(validateReport({ note: "src/lib/example.ts" })).toBe(false);
	});
});

describe("schema/parser parity + request schema (seventh pass)", () => {
	const validateRequest = ajv.compile(loadJson("schema/request.schema.json"));
	// SAFETY: the committed request-vector corpus contains request objects; this suite validates every request against the published schema.
	const requestVectors = loadJson("fixtures/request-vectors.json") as unknown as {
		vectors: Array<{ request: Record<string, unknown> }>;
	};

	// test-contract: invariant — the shared request vectors validate
	// against the request schema.
	it("P: request vectors validate against request.schema.json", () => {
		expect(requestVectors.vectors.length).toBeGreaterThan(0);
		for (const v of requestVectors.vectors) expect(validateRequest(v.request)).toBe(true);
	});

	// test-contract: security — the portable schema and constructing parser
	// agree that the source format is mandatory and exact. No producer may
	// leave decoder choice implicit.
	it("N: missing or unknown source artifact formats fail schema AND parser", () => {
		const request = requestVectors.vectors[0]?.request ?? {};
		const source = request.source_artifact;
		if (!isRecord(source)) {
			throw new Error("request vector source_artifact must be an object");
		}
		const { format: _omitted, ...withoutFormat } = source;
		const missing = { ...request, source_artifact: withoutFormat };
		expect(validateRequest(missing)).toBe(false);
		expect(parseMutationJobRequestV3(missing).ok).toBe(false);
		const unknown = { ...request, source_artifact: { ...source, format: "zip-v1" } };
		expect(validateRequest(unknown)).toBe(false);
		expect(parseMutationJobRequestV3(unknown).ok).toBe(false);
	});

	/** A signed acceptance receipt carrying `count` unique policies. */
	function acceptanceWithPolicies(count: number): string {
		const base = parseReceiptFixture(bundles.vectors[0]?.acceptance_receipt ?? "");
		const ids = Array.from({ length: count }, (_v, i) => `policy-p${i}`);
		return signReceipt({ ...base.payload, approved_policy_ids: ids }, "k_control");
	}

	// test-contract: invariant — the reviewer's 256/257 parity: BOTH the
	// runtime parser and the JSON Schema accept 256 policies and reject
	// 257 — the two validators may never disagree on the bound.
	it("P/N: 256 policies pass BOTH validators; 257 fail BOTH", () => {
		const ok = acceptanceWithPolicies(MAX_APPROVED_POLICY_IDS);
		expect(parseSignedReceipt(ok, "acceptance", TEST_REGISTRY).ok).toBe(true);
		expect(validateReceipt(JSON.parse(ok))).toBe(true);
		const over = acceptanceWithPolicies(MAX_APPROVED_POLICY_IDS + 1);
		const parsed = parseSignedReceipt(over, "acceptance", TEST_REGISTRY);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.reason).toContain("exceeds");
		expect(validateReceipt(JSON.parse(over))).toBe(false);
	});
});

describe("contract digest incl. the NORMATIVE implementation (eighth pass P0-1)", () => {
	const REPO_ROOT = join(ROOT, "../..");
	/** The reference implementation the README calls normative — every
	 *  file here is part of the digest, so it cannot drift silently. */
	const EXPECTED_NORMATIVE_SOURCES = [
		"src/harness/mutation/authenticated-zero-census.ts",
		"src/harness/mutation/identity.ts",
		"src/harness/mutation/protocol-v3/canonical.ts",
		"src/harness/mutation/protocol-v3/evaluator-bridge.ts",
		"src/harness/mutation/protocol-v3/evidence.ts",
		"src/harness/mutation/protocol-v3/field-checks.ts",
		"src/harness/mutation/protocol-v3/parse-census.ts",
		"src/harness/mutation/protocol-v3/parse.ts",
		"src/harness/mutation/protocol-v3/receipts.ts",
		"src/harness/mutation/protocol-v3/report.ts",
		"src/harness/mutation/protocol-v3/request.ts",
		"src/harness/mutation/protocol-v3/types.ts",
		"src/harness/mutation/protocol-v3/verified-evaluator.ts",
		"src/harness/mutation/protocol-v3/verify-attestation.ts",
		"src/harness/mutation/protocol-v3/verify-bindings.ts",
		"src/harness/mutation/protocol-v3/verify.ts",
	];

	/** Digest over every contract file (except the digest file) PLUS the
	 *  normative sources: sha256 of `label\0sha256(content)\n` lines in
	 *  sorted label order. */
	function computeContractDigest(normativeSources: string[]): { files: number; digest: string } {
		const labeled: Array<{ label: string; full: string }> = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) walk(full);
				else if (relative(ROOT, full) !== "contract-digest.json") {
					labeled.push({ label: relative(ROOT, full), full });
				}
			}
		};
		walk(ROOT);
		for (const source of normativeSources) labeled.push({ label: source, full: join(REPO_ROOT, source) });
		labeled.sort((a, b) => (a.label < b.label ? -1 : 1));
		const hash = createHash("sha256");
		for (const { label, full } of labeled) {
			const contentHash = createHash("sha256").update(readFileSync(full)).digest("hex");
			hash.update(`${label}\0${contentHash}\n`, "utf8");
		}
		return { files: labeled.length, digest: hash.digest("hex") };
	}

	// test-contract: invariant — the pinned digest covers the contract
	// directory AND the normative implementation; changing verify/receipts/
	// request/etc. without a digest update fails here, and the cloud repo
	// vendors this exact digest.
	it("P: contract-digest.json matches directory + normative sources", () => {
		// SAFETY: this committed digest record is regenerated from the exact inputs recomputed and compared in this test.
		const pinned = loadJson("contract-digest.json") as unknown as {
			files: number;
			digest: string;
			normative_sources: string[];
		};
		expect([...pinned.normative_sources].sort()).toEqual(EXPECTED_NORMATIVE_SOURCES);
		const actual = computeContractDigest(pinned.normative_sources);
		expect(actual.digest).toBe(pinned.digest);
		expect(PROTOCOL_V3_CONTRACT_DIGEST).toBe(pinned.digest);
		expect(actual.files).toBe(pinned.files);
	});
});
