// interlinked-tdd: exempt — deterministic test-support fabricators (fixed
// Ed25519 seeds); exercised directly by verify.test.ts, evidence.test.ts,
// and acceptance.test.ts, which pin every behavior reachable through them.
// ===========================================
// Protocol v3 — full-authentication fabricators for tests and the corpus
// ===========================================
// Takes any structurally valid raw envelope, fabricates the SIGNED
// receipts (full production payloads) and structural report its kind
// requires, re-binds every hash, seals (result_hash + attestation
// signature), and returns the complete VerifyInputs. Two keys model the
// purpose separation plus arm-bound results: the CONTROL key signs
// acceptance, terminalization, and terminal-arm results; the RUNNER key
// signs execution receipts and execution-arm results.

import { createHash, createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from "node:crypto";
import { canonicalJson, type V3KeyRegistry } from "./canonical.js";
import { canonicalReceiptHash } from "./receipts.js";
import { buildStructuralReport } from "./report.js";
import type {
	V3ExcludedRow,
	V3JobBinding,
	V3MutantRow,
	V3SourceArtifactBinding,
} from "./types.js";
import { SOURCE_ARTIFACT_FORMAT } from "./types.js";
import { deriveAdmission, type MutationJobRequestV3, parseMutationJobRequestV3 } from "./request.js";
import {
	MUTATION_RESULT_TARGET_CONTENT,
	NOT_MUTATABLE_TARGET_CONTENT,
} from "./test-envelopes.js";
import { attestationPayload, computeResultHash, type ExpectedAdmission, type VerifyInputs } from "./verify.js";

function keyFromSeed(fill: number): KeyObject {
	return createPrivateKey({
		key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, fill)]),
		format: "der",
		type: "pkcs8",
	});
}

function pemOf(key: KeyObject): string {
	return createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
}

const CONTROL_KEY = keyFromSeed(7);
const RUNNER_KEY = keyFromSeed(9);
const CONTROL_PEM = pemOf(CONTROL_KEY);
export const RUNNER_PEM = pemOf(RUNNER_KEY);

export const TEST_REGISTRY: V3KeyRegistry = {
	k_control: { public_key_pem: CONTROL_PEM, purposes: ["acceptance", "terminalization", "result"] },
	k_runner: { public_key_pem: RUNNER_PEM, purposes: ["execution", "result"] },
};
export const TEST_NOW = "2026-08-31T13:00:00.000Z";

/** Sign one receipt payload into its wire text ({payload, signature}). */
export function signReceipt(payload: Record<string, unknown>, keyId: "k_control" | "k_runner" = "k_control"): string {
	const key = keyId === "k_control" ? CONTROL_KEY : RUNNER_KEY;
	// The SIGNED bytes include key_id (sixth-pass P0).
	const value = edSign(null, Buffer.from(canonicalJson({ key_id: keyId, payload }), "utf8"), key).toString("base64");
	return JSON.stringify({ payload, signature: { key_id: keyId, value } });
}

/** Re-seal a mutated envelope under the authority for its arm. Tests may
 *  override the signer to exercise a cryptographically valid cross-arm
 *  attack: execution results belong to the runner; terminal results belong
 *  to control. */
export function seal(
	raw: Record<string, unknown>,
	keyId: "k_control" | "k_runner" = raw.execution_receipt_hash === undefined ? "k_control" : "k_runner",
): Record<string, unknown> {
	const key = keyId === "k_control" ? CONTROL_KEY : RUNNER_KEY;
	// SAFETY: test fabricator — the parser under test re-validates the shape.
	raw.result_hash = computeResultHash(raw as never);
	// key_id must be in place BEFORE the attestation is computed — it is a
	// signed field of the attestation payload.
	const signature = { key_id: keyId, value: "" };
	raw.signature = signature;
	signature.value = edSign(null, Buffer.from(attestationPayload(raw as never), "utf8"), key).toString(
		"base64",
	);
	return raw;
}

interface RawEvidenceView {
	kind: string;
	job: V3JobBinding;
	occurred_at: string;
	attempt_id?: string;
	no_test_policy?: string;
	excluded?: V3ExcludedRow[];
	mutants?: V3MutantRow[];
	runner?: { image_digest: string };
	engine?: { name: string; version: string; config_hash: string };
	scope?: { mode: "import_graph" | "companion_fallback" | "glob_fallback"; test_files: string[] };
	test_run?: { command_hash: string };
	execution_receipt_hash?: string;
	report?: unknown;
	cancellation_reason?: string;
	expiry_reason?: string;
	failure_classification?: string;
}

const DEFAULT_IMAGE = `sha256:${"0".repeat(64)}`;
const DEFAULT_CONFIG_HASH = "f".repeat(64);
const ISSUED_AT = "2026-08-31T11:58:00.000Z";
/** Chronology: acceptance <= execution <= result.occurred_at. */
const EXECUTION_ISSUED_AT = "2026-08-31T11:59:00.000Z";

const USTAR = {
	blockBytes: 512,
	pathOffset: 0,
	pathBytes: 100,
	modeOffset: 100,
	uidOffset: 108,
	gidOffset: 116,
	idWidth: 8,
	sizeOffset: 124,
	mtimeOffset: 136,
	longNumberWidth: 12,
	checksumOffset: 148,
	checksumEnd: 156,
	checksumWidth: 8,
	typeOffset: 156,
	magicOffset: 257,
	versionOffset: 263,
	fileMode: 0o644,
	trailerBlocks: 2,
} as const;

function writeTarOctal(header: Buffer, offset: number, width: number, value: number): void {
	header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
}

/** One deterministic POSIX ustar file entry. The shared bytes are a real tar,
 *  not an opaque stand-in that merely claims the protocol format. */
function tarEntry(path: string, content: string): Buffer {
	const data = Buffer.from(content, "utf8");
	const header = Buffer.alloc(USTAR.blockBytes);
	header.write(path, USTAR.pathOffset, USTAR.pathBytes, "ascii");
	writeTarOctal(header, USTAR.modeOffset, USTAR.idWidth, USTAR.fileMode);
	writeTarOctal(header, USTAR.uidOffset, USTAR.idWidth, 0);
	writeTarOctal(header, USTAR.gidOffset, USTAR.idWidth, 0);
	writeTarOctal(header, USTAR.sizeOffset, USTAR.longNumberWidth, data.length);
	writeTarOctal(header, USTAR.mtimeOffset, USTAR.longNumberWidth, 0);
	header.fill(0x20, USTAR.checksumOffset, USTAR.checksumEnd);
	header.write("0", USTAR.typeOffset, 1, "ascii");
	header.write("ustar\0", USTAR.magicOffset, 6, "ascii");
	header.write("00", USTAR.versionOffset, 2, "ascii");
	const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
	header.write(
		`${checksum.toString(8).padStart(6, "0")}\0 `,
		USTAR.checksumOffset,
		USTAR.checksumWidth,
		"ascii",
	);
	const padding = Buffer.alloc((USTAR.blockBytes - (data.length % USTAR.blockBytes)) % USTAR.blockBytes);
	return Buffer.concat([header, data, padding]);
}

/** Deterministic out-of-band git-archive-tar-v1 bundle used by shared
 * fixtures. Both fixture targets are present. It is deliberately NOT embedded
 * in the request or terminal envelope; only its format/id/hash/length binding
 * travels there. The legacy TEXT export remains byte-preserving because this
 * tar contains only ASCII and NUL bytes. */
const TEST_SOURCE_ARTIFACT_BYTES = Buffer.concat([
	tarEntry("src/lib/example.ts", MUTATION_RESULT_TARGET_CONTENT),
	tarEntry("src/lib/constants.ts", NOT_MUTATABLE_TARGET_CONTENT),
	Buffer.alloc(USTAR.blockBytes * USTAR.trailerBlocks),
]);
export const TEST_SOURCE_ARTIFACT_TEXT = TEST_SOURCE_ARTIFACT_BYTES.toString("latin1");
export const TEST_SOURCE_ARTIFACT: V3SourceArtifactBinding = {
	format: SOURCE_ARTIFACT_FORMAT,
	artifact_id: "src_fixture_bundle_0001",
	sha256: createHash("sha256").update(TEST_SOURCE_ARTIFACT_BYTES).digest("hex"),
	bytes: TEST_SOURCE_ARTIFACT_BYTES.length,
};

function sha(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function testListHash(files: readonly string[]): string {
	return sha(canonicalJson(files));
}

function acceptancePayloadFor(view: RawEvidenceView, image: string, configHash: string): Record<string, unknown> {
	return {
		receipt_version: "1",
		kind: "acceptance",
		protocol_version: "interlinked-mutation/3.0",
		issued_at: ISSUED_AT,
		job: view.job,
		approved_policy_ids: [
			...(view.no_test_policy === undefined ? [] : [view.no_test_policy]),
			...(view.excluded ?? []).map((row) => row.policy_id),
		],
		policy_version: "policy-set-2026-08",
		request_hash: admissionOf(view).request_hash,
		test_scope_hash: testListHash(view.scope?.test_files ?? []),
		quota_reservation_id: `quota_${view.job.job_key}`,
		changeset_hash: admissionOf(view).changeset_hash,
		source_artifact: TEST_SOURCE_ARTIFACT,
		intended_image_digest: image,
		intended_engine_config_hash: configHash,
		intended_scope_mode: view.scope?.mode ?? "import_graph",
	};
}

function executionPayloadFor(
	view: RawEvidenceView,
	image: string,
	configHash: string,
	acceptanceReceiptHash: string,
): Record<string, unknown> {
	return {
		receipt_version: "1",
		kind: "execution",
		issued_at: EXECUTION_ISSUED_AT,
		acceptance_receipt_hash: acceptanceReceiptHash,
		source_artifact: TEST_SOURCE_ARTIFACT,
		job_key: view.job.job_key,
		attempt_id: view.attempt_id ?? "attempt_0001",
		image_digest: image,
		engine_name: view.engine?.name ?? "stryker",
		engine_version: view.engine?.version ?? "8.2.0",
		engine_config_hash: configHash,
		lockfile_hash: sha("lockfile:fixture"),
		runtime_identity: "node-22.22.0",
		package_manager_identity: "npm-10.9.4",
		test_command_hash: view.test_run?.command_hash ?? "5".repeat(64),
		test_selection_algorithm: "import-graph-v2",
		selected_test_hash: testListHash(view.scope?.test_files ?? []),
		selected_test_count: view.scope?.test_files.length ?? 0,
	};
}

/** The CANONICAL admission for one fixture view — derived from the
 *  request the CLI would have submitted (request.ts), never placeholder
 *  hashing (seventh pass P0-3). */
function requestOf(view: RawEvidenceView): MutationJobRequestV3 {
	return {
		request_version: "1",
		protocol_version: "interlinked-mutation/3.0",
		job: view.job,
		source_artifact: TEST_SOURCE_ARTIFACT,
		scope_mode: view.scope?.mode ?? "import_graph",
		test_files: view.scope?.test_files ?? [],
		changeset: [{ path: view.job.target_file, content_hash: view.job.target_content_hash }],
	};
}

function admissionOf(view: RawEvidenceView): ExpectedAdmission {
	const parsed = parseMutationJobRequestV3(requestOf(view));
	if (!parsed.ok) throw new Error(`fixture request must parse: ${parsed.reason}`);
	return deriveAdmission(parsed.request);
}

function terminalReasonOf(view: RawEvidenceView): string {
	return view.cancellation_reason ?? view.expiry_reason ?? view.failure_classification ?? "fixture";
}

/** Fabricate receipts + report for one raw envelope, re-bind its hashes,
 *  seal it, and return the envelope with its full VerifyInputs. */
export function authenticateFixture(rawInput: Record<string, unknown>): {
	raw: Record<string, unknown>;
	inputs: VerifyInputs;
} {
	const raw = { ...rawInput };
	// SAFETY: test fabricator over structurally valid corpus envelopes.
	const view = raw as unknown as RawEvidenceView;
	const image = view.runner?.image_digest ?? DEFAULT_IMAGE;
	const configHash = view.engine?.config_hash ?? DEFAULT_CONFIG_HASH;
	const acceptancePayload = acceptancePayloadFor(view, image, configHash);
	raw.acceptance_receipt_hash = canonicalReceiptHash(acceptancePayload);
	const receipts: VerifyInputs["receipts"] = { acceptance: signReceipt(acceptancePayload, "k_control") };
	if (view.execution_receipt_hash !== undefined) {
		// SAFETY: the acceptance hash was just written as a string above.
		const executionPayload = executionPayloadFor(view, image, configHash, raw.acceptance_receipt_hash as string);
		raw.execution_receipt_hash = canonicalReceiptHash(executionPayload);
		receipts.execution = signReceipt(executionPayload, "k_runner");
	} else {
		const terminalizationPayload = {
			receipt_version: "1",
			kind: "terminalization",
			job_key: view.job.job_key,
			acceptance_receipt_hash: raw.acceptance_receipt_hash,
			terminal_state: view.kind,
			actor: "operator",
			authority: "control-plane",
			reason_code: terminalReasonOf(view),
			occurred_at: view.occurred_at,
			policy_version: "policy-set-2026-08",
		};
		raw.terminalization_record_hash = canonicalReceiptHash(terminalizationPayload);
		receipts.terminalization = signReceipt(terminalizationPayload, "k_control");
	}
	const inputs: VerifyInputs = {
		expectedJob: view.job,
		serverAuthority: { tenant: view.job.tenant, project: view.job.project },
		// The CALLER-side admission the fabricated acceptance was issued for
		// (sixth-pass P0: never derived from the response).
		expectedAdmission: admissionOf(view),
		keyRegistry: TEST_REGISTRY,
		now: TEST_NOW,
		receipts,
	};
	if (view.report !== undefined) {
		// SAFETY: the builder only reads job/mutants/excluded.
		const text = buildStructuralReport(raw as never);
		const hash = sha(text);
		raw.report = { r2_sha256: hash, bytes: Buffer.byteLength(text, "utf8"), content_hash: hash };
		inputs.report = Buffer.from(text, "utf8");
	}
	seal(raw);
	return { raw, inputs };
}
