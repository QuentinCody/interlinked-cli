// test-contract: unit — pure codec helpers (validation, hashing, stable JSON,
// row decoding, and the retry-plan/lease-guard branches the SQLite driver
// delegates to) exercised directly against injected DbRow / SqliteDatabase
// fixtures, without opening a real journal file.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SqliteDatabase } from "./mutation-journal-driver.js";
import {
	ackIdentityMatches,
	assertCommitLease,
	encodeEvaluation,
	leaseExpiry,
	mintAck,
	mutationBaselineIntentField,
	numberField,
	parsedJson,
	scheduleMutationRetry,
	stableJson,
	validateEnqueue,
} from "./mutation-journal-codec.js";
import type {
	CommitMutationEvaluation,
	EnqueueMutationJob,
	JournalFinding,
	JournalRetainedCanonicalJson,
	MutationManifestAuthority,
} from "./mutation-journal-types.js";
import { canonicalJson } from "./protocol-v3/canonical.js";

const AUTHORITY: MutationManifestAuthority = Object.freeze({
	tenant: "tenant-1",
	project: "project-1",
	repository: "github.com/example/repo",
});

function retainedJson(value: unknown): JournalRetainedCanonicalJson {
	const encoded = canonicalJson(value);
	return { canonicalJson: encoded, sha256: createHash("sha256").update(encoded).digest("hex") };
}

/** Minimal SqliteDatabase double: the codec functions under test read a row
 * via one `.get()` call and (on the success path) write via one `.run()`
 * call, and never inspect the SQL text itself — so a stub that returns
 * exactly the row/result the test wants to drive is enough to reach a
 * specific branch without a real sqlite file. */
function fakeDb(options: { get?: () => unknown } = {}): SqliteDatabase {
	return {
		exec: () => {},
		close: () => {},
		prepare: () => ({
			get: options.get ?? (() => undefined),
			run: () => ({ changes: 0, lastInsertRowid: 0 }),
			all: () => [],
		}),
	};
}

function enqueueJob(overrides: Partial<EnqueueMutationJob> = {}): EnqueueMutationJob {
	const targetBytes = Buffer.from("export const answer = 42;\n", "utf8");
	const targetSha256 = "1".repeat(64);
	return {
		jobId: "job-1",
		remoteJobId: "remote-job-1",
		acceptanceReceiptHash: "a".repeat(64),
		expectedJob: {
			tenant: "tenant-1",
			project: "project-1",
			repository: "github.com/example/repo",
			commit: "0123456789abcdef0123456789abcdef01234567",
			target_file: "src/answer.ts",
			target_content_hash: targetSha256,
			job_key: "key-job-1",
		},
		expectedAdmission: {
			request_hash: "d".repeat(64),
			changeset_hash: "e".repeat(64),
			source_artifact: {
				format: "git-archive-tar-v1",
				artifact_id: "src_fixture_bundle_0001",
				sha256: "2".repeat(64),
				bytes: targetBytes.length,
			},
		},
		targetBytes,
		targetSha256,
		baselineIntent: "require_established",
		createdAtMs: 100,
		...overrides,
	};
}

function commitEvaluation(overrides: Partial<CommitMutationEvaluation> = {}): CommitMutationEvaluation {
	return {
		jobId: "job-1",
		leaseToken: "lease-1",
		nowMs: 200,
		manifestAuthority: AUTHORITY,
		expectedManifestVersion: 0,
		acceptanceReceiptHash: "a".repeat(64),
		resultHash: "b".repeat(64),
		authenticatedEvidenceHash: "c".repeat(64),
		evaluatorPolicyVersion: "mutation-policy-v1",
		retainedEvidence: {
			formatVersion: 1,
			envelope: retainedJson({ kind: "mutation_result" }),
			acceptanceReceipt: retainedJson({ payload: { kind: "acceptance" }, signature: "fixture" }),
			executionReceipt: retainedJson({ payload: { kind: "execution" }, signature: "fixture" }),
			terminalizationRecord: null,
			report: null,
		},
		evaluation: { kind: "evaluation" },
		decision: { kind: "decision" },
		manifestSnapshot: { version: 1 },
		receipt: { kind: "receipt" },
		runRow: { kind: "run" },
		findings: [],
		...overrides,
	};
}

describe("scheduleMutationRetry", () => {
	it("rejects a journal row whose persisted retry_failure_count is negative", () => {
		const db = fakeDb({
			get: () => ({
				status: "pending",
				lease_token: "lease-1",
				retry_failure_count: -1,
				dead_lettered_at_ms: null,
			}),
		});
		expect(() =>
			scheduleMutationRetry(db, { jobId: "job-1", leaseToken: "lease-1", nowMs: 1_000, kind: "failure", error: "boom" }),
		).toThrow("mutation retry failure count is invalid");
	});
});

describe("assertCommitLease", () => {
	it("throws when the committed acceptanceReceiptHash differs from the enqueued job", () => {
		const job = { acceptance_receipt_hash: "hash-enqueued" };
		const input = commitEvaluation({ acceptanceReceiptHash: "hash-different" });
		expect(() => assertCommitLease(job, input)).toThrow(
			"evaluation acceptanceReceiptHash differs from the enqueued job",
		);
	});
});

describe("stableJson", () => {
	it("rejects a non-plain object (a Map survives structuredClone but is not JSON-shaped)", () => {
		expect(() => stableJson({ nested: new Map([["a", 1]]) })).toThrow(
			"journal value.nested contains a non-plain object",
		);
	});

	it("rejects a value structuredClone itself cannot detach (a function)", () => {
		expect(() => stableJson({ handler: () => {} })).toThrow(
			"journal value must be detached structured-clone data",
		);
	});
});

describe("parsedJson", () => {
	it("wraps a JSON.parse failure with the corrupt-JSON message", () => {
		expect(() => parsedJson("{not valid json")).toThrow("mutation journal contains corrupt JSON");
	});
});

describe("leaseExpiry", () => {
	it("rejects a non-positive leaseMs", () => {
		expect(() => leaseExpiry(1_000, 0)).toThrow("leaseMs must be a positive safe integer");
	});
});

describe("numberField", () => {
	it("throws naming the offending key when the stored value is not a number", () => {
		expect(() => numberField({ retry_failure_count: "3" }, "retry_failure_count")).toThrow(
			"mutation journal row has invalid retry_failure_count",
		);
	});
});

describe("mutationBaselineIntentField", () => {
	it("throws naming the offending key when the stored value is not a known intent", () => {
		expect(() => mutationBaselineIntentField({ baseline_intent: "bogus" }, "baseline_intent")).toThrow(
			"mutation journal row has invalid baseline_intent",
		);
	});
});

describe("validateEnqueue", () => {
	it("throws when expectedJob.target_content_hash does not match the recomputed targetSha256", () => {
		const targetBytes = Buffer.from("export const answer = 42;\n", "utf8");
		const targetSha256 = createHash("sha256").update(targetBytes).digest("hex");
		const input = enqueueJob({
			targetBytes,
			targetSha256,
			expectedJob: {
				...enqueueJob().expectedJob,
				target_content_hash: "0".repeat(64),
			},
		});
		expect(() => validateEnqueue(input)).toThrow(
			"expectedJob.target_content_hash does not match targetSha256",
		);
	});
});

describe("encodeEvaluation", () => {
	it("sorts findings by findingId regardless of input order", () => {
		const findings: JournalFinding[] = [
			{ findingId: "b-finding", payload: { note: "second" } },
			{ findingId: "a-finding", payload: { note: "first" } },
		];
		const encoded = encodeEvaluation(commitEvaluation({ findings }));
		expect(encoded.findings.map((finding) => finding.findingId)).toEqual(["a-finding", "b-finding"]);
	});
});

describe("ackIdentityMatches", () => {
	it("returns false when the stored result_hash differs from the minted ack", () => {
		const row = {
			acceptance_receipt_hash: "a".repeat(64),
			result_hash: "b".repeat(64),
			evaluator_policy_version: "mutation-policy-v1",
		};
		const ack = mintAck({
			jobId: "job-1",
			leaseToken: "lease-1",
			acceptanceReceiptHash: "a".repeat(64),
			resultHash: "different-hash",
			evaluatorPolicyVersion: "mutation-policy-v1",
		});
		expect(ackIdentityMatches(row, ack)).toBe(false);
	});

	it("returns true when every acked field matches the stored row", () => {
		const row = {
			acceptance_receipt_hash: "a".repeat(64),
			result_hash: "b".repeat(64),
			evaluator_policy_version: "mutation-policy-v1",
		};
		const ack = mintAck({
			jobId: "job-1",
			leaseToken: "lease-1",
			acceptanceReceiptHash: "a".repeat(64),
			resultHash: "b".repeat(64),
			evaluatorPolicyVersion: "mutation-policy-v1",
		});
		expect(ackIdentityMatches(row, ack)).toBe(true);
	});
});
