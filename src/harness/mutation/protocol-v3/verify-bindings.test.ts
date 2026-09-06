// ===========================================
// Protocol v3 — caller-held admission anchor comparisons
// ===========================================
// sourceArtifactMismatch / authorityFailure / jobEchoMismatch and
// admissionAnchorFailure's request_hash arm are already exercised end-to-end
// through verify.ts's trust-boundary tests (verify.test.ts drives them on
// every fixture). This file pins the ONE arm those fixtures never reach:
// admissionAnchorFailure's changeset_hash rejection, which needs an
// acceptance whose request_hash MATCHES the submitted request while its
// changeset_hash does not — a shape the shared fixtures re-bind in lockstep.

import { describe, expect, it } from "vitest";
import type { AcceptanceReceiptPayload } from "./receipts.js";
import {
	PROTOCOL_V3_VERSION,
	SOURCE_ARTIFACT_FORMAT,
	type V3SourceArtifactBinding,
} from "./types.js";
import { admissionAnchorFailure, type ExpectedAdmission } from "./verify-bindings.js";

const SOURCE_ARTIFACT: V3SourceArtifactBinding = {
	format: SOURCE_ARTIFACT_FORMAT,
	artifact_id: "src_fixture_bundle_0002",
	sha256: "3".repeat(64),
	bytes: 2048,
};

const ACCEPTANCE: AcceptanceReceiptPayload = {
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
	approved_policy_ids: ["policy-a1"],
	policy_version: "v1",
	request_hash: "e".repeat(64),
	test_scope_hash: "1".repeat(64),
	quota_reservation_id: "quota_0001",
	changeset_hash: "2".repeat(64),
	source_artifact: SOURCE_ARTIFACT,
	intended_image_digest: `sha256:${"4".repeat(64)}`,
	intended_engine_config_hash: "5".repeat(64),
	intended_scope_mode: "import_graph",
};

describe("admissionAnchorFailure — negative (must reject)", () => {
	// test-contract: security — an acceptance that anchors the right request
	// but a DIFFERENT change set would let a server swap the overlay set the
	// CLI is billed and judged on. The rejection must name changeset_hash so
	// the operator sees which anchor drifted, and must fire even though the
	// request_hash and source_artifact anchors both match.
	it("N1: rejects an acceptance whose changeset_hash differs while every other anchor matches", () => {
		const expected: ExpectedAdmission = {
			request_hash: ACCEPTANCE.request_hash,
			changeset_hash: "9".repeat(64),
			source_artifact: SOURCE_ARTIFACT,
		};

		expect(admissionAnchorFailure(ACCEPTANCE, expected)).toBe(
			"acceptance changeset_hash does not match the change set the CLI submitted",
		);
	});
});
