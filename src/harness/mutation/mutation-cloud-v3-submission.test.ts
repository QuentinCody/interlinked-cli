// test-contract: integration — cloud acceptance is authenticated and bound
// before one durable SQLite job becomes visible to the processor. Most cases
// inject a fake `MutationCloudSubmissionFetch`; a few stub the real global
// `fetch` (via `vi.stubGlobal`, reverted in `afterEach`) to exercise the
// module's own default fetch adapter and its request-body encoding path,
// which no injected fetchImpl ever reaches.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MutationCloudV3Submitter,
	type MutationCloudSubmissionFetch,
	type MutationCloudV3SubmissionConfig,
} from "./mutation-cloud-v3-submission.js";
import { openMutationJournal } from "./mutation-journal-sqlite.js";
import type { MutationJournal } from "./mutation-journal-types.js";
import { canonicalJson } from "./protocol-v3/canonical.js";
import { PROTOCOL_V3_CONTRACT_DIGEST as CONTRACT_DIGEST } from "./protocol-v3/contract-identity.js";
import { canonicalReceiptHash } from "./protocol-v3/receipts.js";
import {
	deriveAdmission,
	parseMutationJobRequestV3,
	type ValidMutationJobRequest,
} from "./protocol-v3/request.js";
import {
	signReceipt,
	TEST_NOW,
	TEST_REGISTRY,
	TEST_SOURCE_ARTIFACT,
	TEST_SOURCE_ARTIFACT_TEXT,
} from "./protocol-v3/test-authentication.js";

const TARGET_BYTES = Buffer.from("export const answer = 42;\n", "utf8");
const SOURCE_BYTES = Buffer.from(TEST_SOURCE_ARTIFACT_TEXT, "utf8");

function sha(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function request(): ValidMutationJobRequest {
	const targetHash = sha(TARGET_BYTES);
	const parsed = parseMutationJobRequestV3({
		request_version: "1",
		protocol_version: "interlinked-mutation/3.0",
		job: {
			tenant: "tenant-1",
			project: "project-1",
			repository: "github.com/example/interlinked-cli",
			commit: "0123456789abcdef0123456789abcdef01234567",
			target_file: "src/answer.ts",
			target_content_hash: targetHash,
			job_key: "job_local_1",
		},
		source_artifact: TEST_SOURCE_ARTIFACT,
		scope_mode: "import_graph",
		test_files: ["src/answer.test.ts"],
		changeset: [{ path: "src/answer.ts", content_hash: targetHash }],
	});
	if (!parsed.ok) throw new Error(parsed.reason);
	return parsed.request;
}

function multiSourceRequest(): ValidMutationJobRequest {
	const first = request();
	const parsed = parseMutationJobRequestV3({
		...first,
		changeset: [
			...first.changeset,
			{ path: "src/second.ts", content_hash: "f".repeat(64) },
		],
	});
	if (!parsed.ok) throw new Error(parsed.reason);
	return parsed.request;
}

function acceptancePayload(
	jobRequest: ValidMutationJobRequest,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const admission = deriveAdmission(jobRequest);
	return {
		receipt_version: "1",
		kind: "acceptance",
		protocol_version: "interlinked-mutation/3.0",
		issued_at: "2026-08-31T12:00:00.000Z",
		job: jobRequest.job,
		approved_policy_ids: [],
		policy_version: "policy-v1",
		request_hash: admission.request_hash,
		test_scope_hash: sha(canonicalJson(jobRequest.test_files)),
		quota_reservation_id: "quota-job-1",
		changeset_hash: admission.changeset_hash,
		source_artifact: jobRequest.source_artifact,
		intended_image_digest: `sha256:${"0".repeat(64)}`,
		intended_engine_config_hash: "e".repeat(64),
		intended_scope_mode: jobRequest.scope_mode,
		...overrides,
	};
}

function signedAcceptance(payload: Record<string, unknown>): Record<string, unknown> {
	const parsed: unknown = JSON.parse(signReceipt(payload));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("test acceptance receipt must be an object");
	}
	return parsed as Record<string, unknown>; // SAFETY: guarded non-null, non-array object.
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function config(overrides: Partial<MutationCloudV3SubmissionConfig> = {}): MutationCloudV3SubmissionConfig {
	return {
		baseUrl: "https://mutation.example",
		token: "test-token",
		projectRef: "project-1",
		repository: "github.com/example/interlinked-cli",
		timeoutMs: 5_000,
		contractDigest: CONTRACT_DIGEST,
		keyRegistry: TEST_REGISTRY,
		serverAuthority: { tenant: "tenant-1", project: "project-1" },
		...overrides,
	};
}

function acceptedResponse(jobRequest: ValidMutationJobRequest, payload: Record<string, unknown>): Record<string, unknown> {
	const admission = deriveAdmission(jobRequest);
	return {
		job_key: jobRequest.job.job_key,
		project_ref: jobRequest.job.project,
		execution_state: "accepted",
		execution_instance_id: "workflow-1",
		request_hash: admission.request_hash,
		changeset_hash: admission.changeset_hash,
		acceptance_receipt: signedAcceptance(payload),
		idempotent_replay: false,
	};
}

interface RequestCall {
	url: string;
	init: Parameters<MutationCloudSubmissionFetch>[1];
}

function successfulFetch(
	jobRequest: ValidMutationJobRequest,
	payload: Record<string, unknown>,
	calls: RequestCall[],
): MutationCloudSubmissionFetch {
	return async (url, init) => {
		calls.push({ url, init });
		if (init.method === "GET") {
			return response({
				protocol_version: "interlinked-mutation/3.0",
				contract_digest: CONTRACT_DIGEST,
				keys: TEST_REGISTRY,
			});
		}
		if (init.method === "PUT") {
			return response({ ...jobRequest.source_artifact, idempotent_replay: false }, 201);
		}
		return response(acceptedResponse(jobRequest, payload), 202);
	};
}

/** Stubs the real global `fetch` (not a `MutationCloudSubmissionFetch`) so a
 * submitter built with no injected fetchImpl exercises its own default
 * adapter, including the request-body encoding it applies before the call. */
function stubGlobalFetch(
	jobRequest: ValidMutationJobRequest,
	payload: Record<string, unknown>,
	calls: RequestCall[],
): void {
	vi.stubGlobal("fetch", async (url: string, init: Parameters<MutationCloudSubmissionFetch>[1]) => {
		calls.push({ url, init });
		if (init.method === "GET") {
			return response({
				protocol_version: "interlinked-mutation/3.0",
				contract_digest: CONTRACT_DIGEST,
				keys: TEST_REGISTRY,
			});
		}
		if (init.method === "PUT") {
			return response({ ...jobRequest.source_artifact, idempotent_replay: false }, 201);
		}
		return response(acceptedResponse(jobRequest, payload), 202);
	});
}

let root = "";
let journal: MutationJournal | null = null;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-v3-submit-"));
	journal = openMutationJournal(root);
});

afterEach(() => {
	journal?.close();
	journal = null;
	rmSync(root, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

describe("MutationCloudV3Submitter", () => {
	it("rejects a caller-configured contract different from this CLI before any network call", () => {
		const fetchImpl = vi.fn<MutationCloudSubmissionFetch>();
		expect(() => new MutationCloudV3Submitter(config({ contractDigest: "a".repeat(64) }), fetchImpl)).toThrow(
			"must match this CLI build",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("uploads exact bytes, authenticates acceptance, then journals caller-held bindings", async () => {
		const jobRequest = request();
		const payload = acceptancePayload(jobRequest);
		const calls: RequestCall[] = [];
		const submitter = new MutationCloudV3Submitter(
			config(),
			successfulFetch(jobRequest, payload, calls),
			() => Date.parse(TEST_NOW),
		);
		if (journal === null) throw new Error("journal fixture is missing");

		const outcome = await submitter.submit({
			request: jobRequest,
			sourceArtifactBytes: SOURCE_BYTES,
			targetBytes: TARGET_BYTES,
			journal,
			createdAtMs: 100,
		});

		expect(outcome).toEqual({
			kind: "enqueued",
			jobId: "job_local_1",
			remoteJobId: "job_local_1",
			acceptanceReceiptHash: canonicalReceiptHash(payload),
			idempotentReplay: false,
			journalReplay: false,
		});
		expect(calls.map((call) => call.init.method)).toEqual(["GET", "PUT", "POST"]);
		expect(calls.every((call) => call.init.redirect === "error")).toBe(true);
		expect(calls[1]?.init.body).toEqual(SOURCE_BYTES);
		expect(calls[2]?.init.body).toBe(JSON.stringify(jobRequest));
		const claimed = journal.claimNext({
			authority: {
				tenant: jobRequest.job.tenant,
				project: jobRequest.job.project,
				repository: jobRequest.job.repository,
			},
			owner: "test",
			nowMs: 110,
			leaseMs: 1_000,
		});
		expect(claimed?.expectedJob).toEqual(jobRequest.job);
		expect(claimed?.expectedAdmission).toEqual(deriveAdmission(jobRequest));
		expect(claimed?.targetBytes === undefined ? null : Buffer.from(claimed.targetBytes)).toEqual(TARGET_BYTES);
		expect(claimed?.baselineIntent).toBe("require_established");
	});

	it("rejects local source bytes before any network request or journal write", async () => {
		const jobRequest = request();
		let fetchCalls = 0;
		const submitter = new MutationCloudV3Submitter(config(), async () => {
			fetchCalls += 1;
			return response({});
		});
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: Buffer.from("foreign"),
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("source artifact bytes differ");
		expect(fetchCalls).toBe(0);
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("refuses a multi-source request before any upload can imply whole-change-set clean", async () => {
		const jobRequest = multiSourceRequest();
		const fetchImpl = vi.fn<MutationCloudSubmissionFetch>();
		const submitter = new MutationCloudV3Submitter(config(), fetchImpl);
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("touches 2 eligible source files");
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("rejects a foreign tenant before probing the service or uploading bytes", async () => {
		const original = request();
		const parsed = parseMutationJobRequestV3({
			...original,
			job: { ...original.job, tenant: "foreign-tenant" },
		});
		if (!parsed.ok) throw new Error(parsed.reason);
		const fetchImpl = vi.fn<MutationCloudSubmissionFetch>();
		const submitter = new MutationCloudV3Submitter(config(), fetchImpl);
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: parsed.request,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("authenticated local authority");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects a foreign repository identity before any remote call", async () => {
		const original = request();
		const parsed = parseMutationJobRequestV3({
			...original,
			job: { ...original.job, repository: "github.com/foreign/repo" },
		});
		if (!parsed.ok) throw new Error(parsed.reason);
		const fetchImpl = vi.fn<MutationCloudSubmissionFetch>();
		const submitter = new MutationCloudV3Submitter(config(), fetchImpl);
		if (journal === null) throw new Error("journal fixture is missing");
		await expect(submitter.submit({
			request: parsed.request,
			sourceArtifactBytes: SOURCE_BYTES,
			targetBytes: TARGET_BYTES,
			journal,
			createdAtMs: 100,
		})).rejects.toThrow("immutable repository identity");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects a service whose contract digest differs before uploading source", async () => {
		const jobRequest = request();
		const calls: RequestCall[] = [];
		const submitter = new MutationCloudV3Submitter(config(), async (url, init) => {
			calls.push({ url, init });
			return response({
				protocol_version: "interlinked-mutation/3.0",
				contract_digest: "d".repeat(64),
				keys: TEST_REGISTRY,
			});
		});
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("service contract or trust registry differs");
		expect(calls).toHaveLength(1);
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("rejects a validly signed acceptance for a foreign admission and journals nothing", async () => {
		const jobRequest = request();
		const payload = acceptancePayload(jobRequest, { request_hash: "f".repeat(64) });
		const calls: RequestCall[] = [];
		const admission = deriveAdmission(jobRequest);
		const fetchImpl = successfulFetch(jobRequest, payload, calls);
		const submitter = new MutationCloudV3Submitter(config(), async (url, init) => {
			if (init.method !== "POST") return fetchImpl(url, init);
			return response({
				...acceptedResponse(jobRequest, payload),
				request_hash: admission.request_hash,
			}, 202);
		}, () => Date.parse(TEST_NOW));
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("receipt request_hash differs");
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("rejects a signed acceptance timestamp beyond the verifier skew", async () => {
		const jobRequest = request();
		const payload = acceptancePayload(jobRequest, { issued_at: "2099-01-01T00:00:00.000Z" });
		const calls: RequestCall[] = [];
		const submitter = new MutationCloudV3Submitter(
			config(),
			successfulFetch(jobRequest, payload, calls),
			() => Date.parse(TEST_NOW),
		);
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("unreasonably in the future");
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("rejects a signed acceptance whose changeset_hash differs from the submitted request", async () => {
		const jobRequest = request();
		const payload = acceptancePayload(jobRequest, { changeset_hash: "f".repeat(64) });
		const calls: RequestCall[] = [];
		const submitter = new MutationCloudV3Submitter(
			config(),
			successfulFetch(jobRequest, payload, calls),
			() => Date.parse(TEST_NOW),
		);
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("acceptance receipt changeset_hash differs from the submitted request");
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("rejects a signed acceptance whose source artifact differs from the submitted request", async () => {
		const jobRequest = request();
		const payload = acceptancePayload(jobRequest, {
			source_artifact: { ...jobRequest.source_artifact, sha256: "e".repeat(64) },
		});
		const calls: RequestCall[] = [];
		const submitter = new MutationCloudV3Submitter(
			config(),
			successfulFetch(jobRequest, payload, calls),
			() => Date.parse(TEST_NOW),
		);
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("acceptance receipt source artifact differs from the submitted request");
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("rejects a signed acceptance whose scope mode differs from the submitted request", async () => {
		const jobRequest = request();
		const payload = acceptancePayload(jobRequest, { intended_scope_mode: "companion_fallback" });
		const calls: RequestCall[] = [];
		const submitter = new MutationCloudV3Submitter(
			config(),
			successfulFetch(jobRequest, payload, calls),
			() => Date.parse(TEST_NOW),
		);
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("acceptance receipt scope mode differs from the submitted request");
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("rejects a signed acceptance whose test scope hash differs from the submitted request", async () => {
		const jobRequest = request();
		const payload = acceptancePayload(jobRequest, { test_scope_hash: "d".repeat(64) });
		const calls: RequestCall[] = [];
		const submitter = new MutationCloudV3Submitter(
			config(),
			successfulFetch(jobRequest, payload, calls),
			() => Date.parse(TEST_NOW),
		);
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("acceptance receipt test scope differs from the submitted request");
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("rejects a server authority with an empty tenant or project before any network call", () => {
		const fetchImpl = vi.fn<MutationCloudSubmissionFetch>();
		expect(() =>
			new MutationCloudV3Submitter(config({ serverAuthority: { tenant: "", project: "project-1" } }), fetchImpl),
		).toThrow("must name a tenant and project");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects a server authority whose project differs from the configured projectRef before any network call", () => {
		const fetchImpl = vi.fn<MutationCloudSubmissionFetch>();
		expect(() =>
			new MutationCloudV3Submitter(
				config({ serverAuthority: { tenant: "tenant-1", project: "other-project" } }),
				fetchImpl,
			),
		).toThrow("must name the configured project");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects a non-positive timeoutMs before any network call", () => {
		const fetchImpl = vi.fn<MutationCloudSubmissionFetch>();
		expect(() => new MutationCloudV3Submitter(config({ timeoutMs: 0 }), fetchImpl)).toThrow(
			"timeoutMs must be a positive safe integer",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("relays the source artifact's exact backing buffer through the real fetch adapter with no defensive copy", async () => {
		const jobRequest = request();
		const payload = acceptancePayload(jobRequest);
		const calls: RequestCall[] = [];
		stubGlobalFetch(jobRequest, payload, calls);
		const exactBytes = new Uint8Array(SOURCE_BYTES);
		const submitter = new MutationCloudV3Submitter(config(), undefined, () => Date.parse(TEST_NOW));
		if (journal === null) throw new Error("journal fixture is missing");

		await submitter.submit({
			request: jobRequest,
			sourceArtifactBytes: exactBytes,
			targetBytes: TARGET_BYTES,
			journal,
			createdAtMs: 100,
		});

		const putCall = calls.find((call) => call.init.method === "PUT");
		const postCall = calls.find((call) => call.init.method === "POST");
		expect(putCall?.init.body).toBe(exactBytes.buffer);
		const body = putCall?.init.body;
		assert.instanceOf(body, ArrayBuffer);
		expect(Buffer.from(body)).toEqual(SOURCE_BYTES);
		expect(postCall?.init.body).toBe(JSON.stringify(jobRequest));
	});

	it("defensively copies a partial byte view before handing it to the real fetch adapter", async () => {
		const jobRequest = request();
		const payload = acceptancePayload(jobRequest);
		const calls: RequestCall[] = [];
		stubGlobalFetch(jobRequest, payload, calls);
		const backing = new ArrayBuffer(SOURCE_BYTES.length + 8);
		const partialView = new Uint8Array(backing, 4, SOURCE_BYTES.length);
		partialView.set(SOURCE_BYTES);
		const submitter = new MutationCloudV3Submitter(config(), undefined, () => Date.parse(TEST_NOW));
		if (journal === null) throw new Error("journal fixture is missing");

		await submitter.submit({
			request: jobRequest,
			sourceArtifactBytes: partialView,
			targetBytes: TARGET_BYTES,
			journal,
			createdAtMs: 100,
		});

		const putCall = calls.find((call) => call.init.method === "PUT");
		expect(putCall?.init.body).not.toBe(backing);
		const body = putCall?.init.body;
		assert.instanceOf(body, ArrayBuffer);
		expect(Buffer.from(body)).toEqual(SOURCE_BYTES);
	});

	it("rejects prepared request bytes that are not valid UTF-8 JSON", async () => {
		const fetchImpl = vi.fn<MutationCloudSubmissionFetch>();
		const submitter = new MutationCloudV3Submitter(config(), fetchImpl);

		await expect(
			submitter.authenticatePrepared({
				requestBytes: Uint8Array.from([0xff, 0xfe, 0xfd]),
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
			}),
		).rejects.toThrow("not valid UTF-8 JSON");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects prepared request bytes that are not the protocol's canonical JSON encoding", async () => {
		const jobRequest = request();
		const fetchImpl = vi.fn<MutationCloudSubmissionFetch>();
		const submitter = new MutationCloudV3Submitter(config(), fetchImpl);
		const prettyPrinted = new TextEncoder().encode(JSON.stringify(jobRequest, null, 2));

		await expect(
			submitter.authenticatePrepared({
				requestBytes: prettyPrinted,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
			}),
		).rejects.toThrow("not protocol canonical JSON");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects local target bytes that differ from the request's target content hash", async () => {
		const jobRequest = request();
		let fetchCalls = 0;
		const submitter = new MutationCloudV3Submitter(config(), async () => {
			fetchCalls += 1;
			return response({});
		});
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: Buffer.from("not the target content"),
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("target bytes differ from the request binding");
		expect(fetchCalls).toBe(0);
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("rejects when the contract probe (GET /mutation/keys) responds with a non-2xx status", async () => {
		const jobRequest = request();
		const calls: RequestCall[] = [];
		const submitter = new MutationCloudV3Submitter(config(), async (url, init) => {
			calls.push({ url, init });
			return new Response("service unavailable", { status: 503 });
		});
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("contract probe failed: HTTP 503 service unavailable");
		expect(calls).toHaveLength(1);
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("rejects when the artifact upload (PUT) responds with a non-2xx status", async () => {
		const jobRequest = request();
		const calls: RequestCall[] = [];
		const submitter = new MutationCloudV3Submitter(config(), async (url, init) => {
			calls.push({ url, init });
			if (init.method === "GET") {
				return response({
					protocol_version: "interlinked-mutation/3.0",
					contract_digest: CONTRACT_DIGEST,
					keys: TEST_REGISTRY,
				});
			}
			return new Response("artifact store rejected the upload", { status: 500 });
		});
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("artifact upload failed: HTTP 500 artifact store rejected the upload");
		expect(calls.map((call) => call.init.method)).toEqual(["GET", "PUT"]);
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("rejects an artifact upload response whose echoed binding does not match the request", async () => {
		const jobRequest = request();
		const submitter = new MutationCloudV3Submitter(config(), async (_url, init) => {
			if (init.method === "GET") {
				return response({
					protocol_version: "interlinked-mutation/3.0",
					contract_digest: CONTRACT_DIGEST,
					keys: TEST_REGISTRY,
				});
			}
			return response({ ...jobRequest.source_artifact, sha256: "f".repeat(64), idempotent_replay: false }, 201);
		});
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("artifact upload response is malformed or foreign");
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("rejects when the job submission (POST) responds with a non-2xx status", async () => {
		const jobRequest = request();
		const submitter = new MutationCloudV3Submitter(config(), async (_url, init) => {
			if (init.method === "GET") {
				return response({
					protocol_version: "interlinked-mutation/3.0",
					contract_digest: CONTRACT_DIGEST,
					keys: TEST_REGISTRY,
				});
			}
			if (init.method === "PUT") {
				return response({ ...jobRequest.source_artifact, idempotent_replay: false }, 201);
			}
			return new Response("job queue is full", { status: 503 });
		});
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("job submission failed: HTTP 503 job queue is full");
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});

	it("rejects a job response whose echoed job_key does not match the submitted job", async () => {
		const jobRequest = request();
		const payload = acceptancePayload(jobRequest);
		const submitter = new MutationCloudV3Submitter(config(), async (_url, init) => {
			if (init.method === "GET") {
				return response({
					protocol_version: "interlinked-mutation/3.0",
					contract_digest: CONTRACT_DIGEST,
					keys: TEST_REGISTRY,
				});
			}
			if (init.method === "PUT") {
				return response({ ...jobRequest.source_artifact, idempotent_replay: false }, 201);
			}
			return response({ ...acceptedResponse(jobRequest, payload), job_key: "a-different-job" }, 202);
		});
		if (journal === null) throw new Error("journal fixture is missing");

		await expect(
			submitter.submit({
				request: jobRequest,
				sourceArtifactBytes: SOURCE_BYTES,
				targetBytes: TARGET_BYTES,
				journal,
				createdAtMs: 100,
			}),
		).rejects.toThrow("job response is malformed or foreign");
		expect(journal.getJob(jobRequest.job.job_key)).toBeNull();
	});
});
