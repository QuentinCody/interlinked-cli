// Malformed corpus, part 4 — staged transport, mirror ingestion, execution
// input (memo §8.1 exit gate: unknown field, unknown version, out-of-range
// id/string/integer, empty-string brand).
//
// The record under real structural pressure here is the finalize STATUS
// response: its two TERMINAL states carry a payload each — a committed version
// or a failure — while every in-flight state is bare, so naming a terminal
// state without its payload is malformed rather than merely incomplete.
//
// The broker-internal records this suite used to cover — the publication state
// machine, the idempotency row, the mirror version record and the job state —
// moved to `interlinked-cloud` with their parsers in the 2026-09-04
// public/private split; their cases moved with them.

import { describe, expect, it } from "vitest";
import { SHADOW_LIMITS_V1 } from "./limits.js";
import type { ShadowParseOutcome } from "./parse-core-entries.js";
import {
	parseCancelAck,
	parseCancelRequest,
	parseManifestUploadInitRequest,
	parseManifestUploadInitResponse,
	parseMirrorFinalizeRequest,
	parseMirrorFinalizeResponse,
	parseMirrorFinalizeStatusResponse,
	parseMirrorPrepareRequest,
	parseMirrorPrepareResponse,
	parseMissingBlobPage,
	parseMissingBlobPageRequest,
	parseMissingBlobPageResponse,
	parseShadowExecutionRequest,
	parseShadowInputFinalizeRequest,
	parseShadowInputFinalizeResponse,
	parseShadowInputPrepareRequest,
	parseShadowInputPrepareResponse,
} from "./parse-transport.js";
import { OBSERVABLE_PUBLICATION_STATES } from "./types-transport.js";

const HEX = "a".repeat(64);
const SHA = "b".repeat(40);
const WHEN = "2026-09-03T12:00:00Z";
const URL = "https://shadow.example/upload/abc";

type Obj = Record<string, unknown>;

function accepted<T>(outcome: ShadowParseOutcome<T>): T {
	if (!outcome.ok) throw new Error(`expected acceptance, got rejection: ${outcome.reason}`);
	return outcome.value;
}

function reasonOf(outcome: ShadowParseOutcome<unknown>): string {
	return outcome.ok ? "<accepted>" : outcome.reason;
}

// ── fixtures ───────────────────────────────────────────────────────────────

const mirrorKey = (): Obj => ({ repository_id: "repo_01", session_id: "sess_01", kind: "synthetic_full_tree" });
const mirrorRef = (): Obj => ({ key: mirrorKey(), version: 4 });

const missingSet = (): Obj => ({ missing_set_id: "set_01", missing_set_digest: HEX, missing_count: 2 });

const missingPage = (): Obj => ({
	missing_set: missingSet(),
	items: [{ blob_digest: HEX, put_url: URL, max_bytes: 1024 }],
	next_page_token: null,
});

const uploadInitRequest = (): Obj => ({
	schema_version: 1,
	scope: { kind: "mirror", mirror_key: mirrorKey() },
	idempotency_key: "idem_01",
	declared_bytes: 4096,
	declared_digest: HEX,
});

const uploadInitResponse = (): Obj => ({ schema_version: 1, upload_id: "up_01", put_url: URL, max_bytes: 4096, expires_at: WHEN });

const finalizeRequest = (): Obj => ({ schema_version: 1, upload_id: "up_01", idempotency_key: "idem_01", expected_version: 5 });

const failure = (): Obj => ({ reason: "secrets", detail: "scanner matched a private key" });

const committedStatus = (): Obj => ({
	schema_version: 1,
	attempt_id: "att_01",
	state: "version_committed",
	version: mirrorRef(),
	base_ref: SHA,
	tree_hash: HEX,
});

const claim = (): Obj => ({
	mirror: mirrorRef(),
	base_ref: SHA,
	tree_algo: "shadow-tree-v1",
	post_image_algo: "shadow-postimages-v1",
	overlay_algo: "shadow-overlay-v1",
	overlay_manifest_hash: HEX,
	overlay_bytes_hash: HEX,
	pre_tree_hash: HEX,
	post_image_set_hash: HEX,
	post_tree_hash: HEX,
	dependencies: { mode: "npm-v1", input_hash: HEX },
});

const freshness = (): Obj => ({
	base_local_head: SHA,
	local_head: SHA,
	input_hash: HEX,
	local_pre_tree_hash: HEX,
	local_overlay_manifest_hash: HEX,
	local_post_image_set_hash: HEX,
});

const executionRequest = (): Obj => ({
	schema_version: 1,
	request_id: "req_01",
	idempotency_key: "idem_01",
	bundle_id: "bundle_01",
	expected_bundle_hash: HEX,
	execution_claim: claim(),
	freshness_claim: freshness(),
	changeset: { schema_version: 1, pre_tree_hash: HEX, post_image_set_hash: HEX, touched_paths: ["src/a.ts"] },
	tool_input: {
		schema: "shadow-tool-input-v1",
		client: "claude-code",
		tool: "Write",
		semantics_version: 1,
		file_path: "src/a.ts",
		content: "hello",
	},
	execution_profile_id: "shadow-typecheck-v1",
	lane: "sync-probe",
	deadline_at: WHEN,
});

// ── positive ───────────────────────────────────────────────────────────────

describe("parse-transport — positive (must accept)", () => {
	it("P1: accepts the manifest-upload init request in both scopes, and its response", () => {
		const raw = uploadInitRequest();
		const value = accepted(parseManifestUploadInitRequest(raw));
		expect(Object.isFrozen(value)).toBe(true);
		raw.declared_bytes = 1;
		expect(value.declared_bytes).toBe(4096);
		const inputScope = { ...uploadInitRequest(), scope: { kind: "input", mirror: mirrorRef() } };
		expect(reasonOf(parseManifestUploadInitRequest(inputScope))).toBe("<accepted>");
		expect(parseManifestUploadInitResponse(uploadInitResponse()).ok).toBe(true);
	});

	it("P2: accepts a missing-blob page, its request and its response envelope", () => {
		expect(accepted(parseMissingBlobPage(missingPage())).missing_set.missing_count).toBe(2);
		expect(parseMissingBlobPage({ ...missingPage(), next_page_token: "cursor_02" }).ok).toBe(true);
		expect(parseMissingBlobPageRequest({ schema_version: 1, upload_id: "up_01", page_token: "cursor_02" }).ok).toBe(true);
		expect(parseMissingBlobPageResponse({ schema_version: 1, upload_id: "up_01", page: missingPage() }).ok).toBe(true);
	});

	it("P3: accepts the mirror prepare request and response", () => {
		const request = {
			schema_version: 1,
			upload_id: "up_01",
			idempotency_key: "idem_01",
			base_local_head: SHA,
			declared_tree_hash: HEX,
			entry_count: 12,
			client_scanner_policy_digest: HEX,
		};
		expect(parseMirrorPrepareRequest(request).ok).toBe(true);
		expect(parseMirrorPrepareResponse({ schema_version: 1, upload_id: "up_01", first_page: missingPage(), expires_at: WHEN }).ok).toBe(true);
	});

	it("P4: accepts all three mirror-finalize response shapes", () => {
		expect(parseMirrorFinalizeRequest(finalizeRequest()).ok).toBe(true);
		expect(parseMirrorFinalizeResponse({ schema_version: 1, accepted: true, attempt_id: "att_01", status_url: URL }).ok).toBe(true);
		expect(parseMirrorFinalizeResponse({ schema_version: 1, accepted: false, reason: "version_conflict", current_version: 4 }).ok).toBe(true);
		expect(parseMirrorFinalizeResponse({ schema_version: 1, accepted: false, reason: "expired" }).ok).toBe(true);
	});

	it("P5: accepts every finalize STATUS shape — in-flight, committed, failed", () => {
		// Driven by the tuple itself, so a state added to it must parse: the
		// public type, the parser table and this case are one declaration.
		expect([...OBSERVABLE_PUBLICATION_STATES]).toEqual(["prepared", "blobs_verified", "publication_reserved", "objects_created", "ref_updated"]);
		for (const state of OBSERVABLE_PUBLICATION_STATES) {
			expect(reasonOf(parseMirrorFinalizeStatusResponse({ schema_version: 1, attempt_id: "att_01", state }))).toBe("<accepted>");
		}
		expect(accepted(parseMirrorFinalizeStatusResponse(committedStatus())).state).toBe("version_committed");
		expect(parseMirrorFinalizeStatusResponse({ schema_version: 1, attempt_id: "att_01", state: "failed", failure: failure() }).ok).toBe(true);
	});

	it("P9: accepts the execution-input prepare and finalize round trip", () => {
		const prepare = { schema_version: 1, upload_id: "up_01", idempotency_key: "idem_01", client_scanner_policy_digest: HEX };
		expect(reasonOf(parseShadowInputPrepareRequest(prepare))).toBe("<accepted>");
		expect(parseShadowInputPrepareResponse({ schema_version: 1, upload_id: "up_01", first_page: missingPage(), expires_at: WHEN }).ok).toBe(true);
		expect(parseShadowInputFinalizeRequest({ schema_version: 1, upload_id: "up_01", idempotency_key: "idem_01" }).ok).toBe(true);
		const ok = { schema_version: 1, ok: true, bundle_id: "bundle_01", bundle_hash: HEX, expires_at: WHEN };
		expect(reasonOf(parseShadowInputFinalizeResponse(ok))).toBe("<accepted>");
		expect(parseShadowInputFinalizeResponse({ schema_version: 1, ok: false, reason: "secrets" }).ok).toBe(true);
	});

	it("P10: accepts the execution request in both lanes, plus cancel and its ack", () => {
		expect(accepted(parseShadowExecutionRequest(executionRequest())).lane).toBe("sync-probe");
		expect(parseShadowExecutionRequest({ ...executionRequest(), lane: "async" }).ok).toBe(true);
		expect(parseCancelRequest({ schema_version: 1, request_id: "req_01", reason: "hook_deadline" }).ok).toBe(true);
		expect(parseCancelAck({ schema_version: 1, request_id: "req_01", state: "already_completed" }).ok).toBe(true);
	});
});

// ── negative ───────────────────────────────────────────────────────────────

describe("parse-transport — negative (must reject)", () => {
	it("N1: rejects an unknown field at the top level", () => {
		expect(reasonOf(parseMirrorFinalizeRequest({ ...finalizeRequest(), extra: 1 }))).toContain("unknown field(s): extra");
	});

	it("N2: rejects an unknown field NESTED in the mirror key and in a page item", () => {
		const nested = { ...uploadInitRequest(), scope: { kind: "mirror", mirror_key: { ...mirrorKey(), rogue: 1 } } };
		expect(reasonOf(parseManifestUploadInitRequest(nested))).toContain("unknown field(s): rogue");
		const item = { ...missingPage(), items: [{ blob_digest: HEX, put_url: URL, max_bytes: 1, sneak: true }] };
		expect(reasonOf(parseMissingBlobPage(item))).toContain("unknown field(s): sneak");
	});

	it("N3: rejects an unknown version", () => {
		expect(reasonOf(parseMirrorFinalizeRequest({ ...finalizeRequest(), schema_version: 2 }))).toContain("schema_version must be 1");
		expect(reasonOf(parseManifestUploadInitResponse({ ...uploadInitResponse(), schema_version: 0 }))).toContain("schema_version must be 1");
	});

	it("N4: rejects out-of-range integers", () => {
		expect(reasonOf(parseMirrorFinalizeRequest({ ...finalizeRequest(), expected_version: -1 }))).toContain("non-negative integer");
		expect(reasonOf(parseMirrorFinalizeStatusResponse({ ...committedStatus(), version: { key: mirrorKey(), version: -1 } }))).toContain("non-negative integer");
		const overPage = { ...missingSet(), missing_count: SHADOW_LIMITS_V1.entries + 1 };
		expect(reasonOf(parseMissingBlobPage({ ...missingPage(), missing_set: overPage }))).toContain("exceeds");
		const overBytes = { ...uploadInitRequest(), declared_bytes: SHADOW_LIMITS_V1.manifest_object_bytes + 1 };
		expect(reasonOf(parseManifestUploadInitRequest(overBytes))).toContain("exceeds");
	});

	it("N5: rejects an empty-string brand", () => {
		expect(reasonOf(parseCancelRequest({ schema_version: 1, request_id: "", reason: "user" }))).toContain("opaque URL-safe id");
		expect(reasonOf(parseManifestUploadInitResponse({ ...uploadInitResponse(), put_url: "" }))).toContain("non-empty string");
	});

	it("N10: rejects an unknown state and an unknown lane", () => {
		expect(reasonOf(parseCancelAck({ schema_version: 1, request_id: "req_01", state: "vibing" }))).toContain("state must be one of");
		expect(reasonOf(parseShadowExecutionRequest({ ...executionRequest(), lane: "turbo" }))).toContain("lane must be one of");
	});

	it("N11: rejects a version_conflict finalize response with no current_version, and an unknown reason", () => {
		expect(reasonOf(parseMirrorFinalizeResponse({ schema_version: 1, accepted: false, reason: "version_conflict" }))).toContain("current_version");
		expect(reasonOf(parseMirrorFinalizeResponse({ schema_version: 1, accepted: false, reason: "nope" }))).toContain("reason must be one of");
		const extra = { schema_version: 1, accepted: false, reason: "expired", current_version: 4 };
		expect(reasonOf(parseMirrorFinalizeResponse(extra))).toContain("unknown field(s): current_version");
	});

	it("N12: rejects a finalize STATUS that names a terminal state without its payload", () => {
		expect(reasonOf(parseMirrorFinalizeStatusResponse({ schema_version: 1, attempt_id: "att_01", state: "version_committed" }))).toContain("version");
		expect(reasonOf(parseMirrorFinalizeStatusResponse({ schema_version: 1, attempt_id: "att_01", state: "failed" }))).toContain("failure");
	});

	it("N13: rejects an execution request whose embedded claim or tool input is malformed", () => {
		const badClaim = { ...executionRequest(), execution_claim: { ...claim(), dependencies: { mode: "npm-v1", input_hash: HEX, tree_hash: HEX } } };
		expect(reasonOf(parseShadowExecutionRequest(badClaim))).toContain("unknown field(s): tree_hash");
		// SAFETY: the fixture literal above declares `tool_input` as an object.
		const badTool = { ...executionRequest(), tool_input: { ...(executionRequest().tool_input as Obj), tool: "Bash" } };
		expect(reasonOf(parseShadowExecutionRequest(badTool))).toContain("supported client/tool shapes");
	});

	it("N14: rejects an unknown execution profile and a non-RFC3339 deadline", () => {
		expect(reasonOf(parseShadowExecutionRequest({ ...executionRequest(), execution_profile_id: "shadow-anything-v9" }))).toContain("execution_profile_id must be");
		expect(reasonOf(parseShadowExecutionRequest({ ...executionRequest(), deadline_at: "yesterday" }))).toContain("RFC3339");
	});

	it("N15: rejects an over-long missing-blob page and a non-null, non-id cursor", () => {
		const items = Array.from({ length: SHADOW_LIMITS_V1.missing_blobs_page_size + 1 }, () => ({ blob_digest: HEX, put_url: URL, max_bytes: 1 }));
		expect(reasonOf(parseMissingBlobPage({ ...missingPage(), items }))).toContain("exceeds");
		expect(reasonOf(parseMissingBlobPage({ ...missingPage(), next_page_token: 7 }))).toContain("opaque URL-safe id");
	});

	it("N16: rejects a bad publication-failure reason inside the finalize status", () => {
		const bad = { schema_version: 1, attempt_id: "att_01", state: "failed", failure: { reason: "cosmic_rays", detail: "x" } };
		expect(reasonOf(parseMirrorFinalizeStatusResponse(bad))).toContain("reason must be one of");
	});

	it("N17: rejects an execution request carrying a bundle id with no expected_bundle_hash, or a hash that is not sha-256", () => {
		const { expected_bundle_hash: _omitted, ...withoutHash } = executionRequest();
		expect(reasonOf(parseShadowExecutionRequest(withoutHash))).toContain("expected_bundle_hash");
		expect(reasonOf(parseShadowExecutionRequest({ ...executionRequest(), expected_bundle_hash: "not-a-digest" }))).toContain("sha-256");
	});

	it("N18: rejects an in-flight status state that is not one of OBSERVABLE_PUBLICATION_STATES", () => {
		const bad = { schema_version: 1, attempt_id: "att_01", state: "objects_deleted" };
		expect(reasonOf(parseMirrorFinalizeStatusResponse(bad))).toContain("state must be one of");
	});
});
