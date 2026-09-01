// =========================================================
// Mutation cloud v3 — authenticated submission before journal enqueue
// =========================================================

import { createHash } from "node:crypto";
import { isJsonObject } from "../../lib/json-types.js";
import {
	boundedErrorBody,
	type BoundedHttpResponse,
	hasExactJsonKeys,
	readBoundedJson,
} from "./mutation-cloud-v3-http.js";
import type { MutationJournal } from "./mutation-journal-types.js";
import { multiSourceNotMeasuredReason } from "./mutation-target.js";
import { canonicalJson, type V3KeyRegistry } from "./protocol-v3/canonical.js";
import { PROTOCOL_V3_CONTRACT_DIGEST } from "./protocol-v3/contract-identity.js";
import { parseSignedReceipt, type AcceptanceReceiptPayload } from "./protocol-v3/receipts.js";
import {
	deriveAdmission,
	parseMutationJobRequestV3,
	type ValidMutationJobRequest,
} from "./protocol-v3/request.js";
import { PROTOCOL_V3_VERSION, type V3JobBinding } from "./protocol-v3/types.js";
import type { V3ServerAuthority } from "./protocol-v3/verify.js";

const FUTURE_SKEW_MS = 5 * 60 * 1000;
const EXECUTION_STATES = new Set([
	"accepted",
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
	"expired",
]);

interface SubmissionResponse extends BoundedHttpResponse {
	ok: boolean;
	status: number;
}

export type MutationCloudSubmissionFetch = (
	url: string,
	init: {
		method: "GET" | "POST" | "PUT";
		headers: Record<string, string>;
		body?: string | Uint8Array;
		signal: AbortSignal;
		redirect: "error";
	},
) => Promise<SubmissionResponse>;

export interface MutationCloudV3SubmissionConfig {
	baseUrl: string;
	token: string;
	projectRef: string;
	repository: string;
	timeoutMs: number;
	contractDigest: string;
	keyRegistry: V3KeyRegistry;
	serverAuthority: V3ServerAuthority;
}

export interface SubmitMutationJobInput {
	request: ValidMutationJobRequest;
	sourceArtifactBytes: Uint8Array;
	targetBytes: Uint8Array;
	journal: MutationJournal;
	createdAtMs: number;
}

export interface SubmitMutationJobOutcome {
	kind: "enqueued";
	jobId: string;
	remoteJobId: string;
	acceptanceReceiptHash: string;
	idempotentReplay: boolean;
	journalReplay: boolean;
}

interface AuthenticatePreparedMutationJobInput {
	requestBytes: Uint8Array;
	sourceArtifactBytes: Uint8Array;
	targetBytes: Uint8Array;
}

interface AuthenticatedMutationAcceptance {
	jobId: string;
remoteJobId: string;
	acceptanceReceiptHash: string;
	idempotentReplay: boolean;
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function jobMatches(actual: V3JobBinding, expected: V3JobBinding): boolean {
	return sameJson(actual, expected);
}

function acceptanceMismatch(
	receipt: AcceptanceReceiptPayload,
	request: ValidMutationJobRequest,
	admission: ReturnType<typeof deriveAdmission>,
): string | null {
	if (!jobMatches(receipt.job, request.job)) return "acceptance receipt job binding differs from the submitted request";
	if (receipt.request_hash !== admission.request_hash) return "acceptance receipt request_hash differs from the submitted request";
	if (receipt.changeset_hash !== admission.changeset_hash) {
		return "acceptance receipt changeset_hash differs from the submitted request";
	}
	if (!sameJson(receipt.source_artifact, admission.source_artifact)) {
		return "acceptance receipt source artifact differs from the submitted request";
	}
	if (receipt.intended_scope_mode !== request.scope_mode) {
		return "acceptance receipt scope mode differs from the submitted request";
	}
	if (receipt.test_scope_hash !== sha256(canonicalJson(request.test_files))) {
		return "acceptance receipt test scope differs from the submitted request";
	}
	return null;
}

function requestBody(body: string | Uint8Array): BodyInit {
	if (typeof body === "string") return body;
	if (
		body.buffer instanceof ArrayBuffer &&
		body.byteOffset === 0 &&
		body.byteLength === body.buffer.byteLength
	) {
		// Reuse an exact ArrayBuffer instead of Buffer.from(bytes), which
		// doubled a potentially 64 MiB source artifact before fetch began.
		return body.buffer;
	}
	// Partial/shared views cannot be handed to BodyInit without exposing
	// unrelated bytes. This rare fallback makes one exact defensive copy.
	return Uint8Array.from(body).buffer;
}

function validateSubmissionAuthority(config: MutationCloudV3SubmissionConfig): void {
	const authority = config.serverAuthority;
	if (authority.tenant.length === 0 || authority.project.length === 0) {
		throw new Error("mutation cloud submission authority must name a tenant and project");
	}
	if (authority.project !== config.projectRef) {
		throw new Error("mutation cloud submission authority must name the configured project");
	}
	if (config.repository.length === 0) throw new Error("mutation cloud repository identity is required");
}

function defaultFetch(url: string, init: Parameters<MutationCloudSubmissionFetch>[1]): Promise<SubmissionResponse> {
	const request: RequestInit = {
		method: init.method,
		headers: init.headers,
		signal: init.signal,
		redirect: init.redirect,
	};
	if (init.body !== undefined) request.body = requestBody(init.body);
	// Repeat the signal at the network call boundary so a future RequestInit
	// refactor cannot accidentally turn the configured deadline into an
	// unbounded request.
	return globalThis.fetch(url, { ...request, signal: init.signal });
}

/**
 * Public API for the durable cloud-submission boundary. The submission
 * transaction intentionally ends at the local journal. Cloud
 * acceptance can happen first because both artifact and job endpoints are
 * idempotent; after a crash, the identical call recovers and journals the
 * same authenticated acceptance before any result may be consumed.
 */
export class MutationCloudV3Submitter {
	readonly #baseUrl: string;

	constructor(
		private readonly config: MutationCloudV3SubmissionConfig,
		private readonly fetchImpl: MutationCloudSubmissionFetch = defaultFetch,
		private readonly clock: () => number = Date.now,
	) {
		this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
		if (this.#baseUrl === "") throw new Error("mutation cloud baseUrl is required");
		if (config.token === "") throw new Error("mutation cloud token is required");
		if (config.contractDigest !== PROTOCOL_V3_CONTRACT_DIGEST) {
			throw new Error(
				`mutation cloud contractDigest must match this CLI build (${PROTOCOL_V3_CONTRACT_DIGEST})`,
			);
		}
		if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) {
			throw new Error("mutation cloud timeoutMs must be a positive safe integer");
		}
		validateSubmissionAuthority(config);
	}

	async submit(input: SubmitMutationJobInput): Promise<SubmitMutationJobOutcome> {
		const request = this.#validatedRequest(input.request);
		const accepted = await this.#authenticate(
			request,
			input.sourceArtifactBytes,
			input.targetBytes,
			JSON.stringify(request),
		);
		const admission = deriveAdmission(request);
		const journalResult = input.journal.enqueue({
			jobId: request.job.job_key,
			remoteJobId: request.job.job_key,
			acceptanceReceiptHash: accepted.acceptanceReceiptHash,
			expectedJob: request.job,
			expectedAdmission: admission,
			targetBytes: input.targetBytes,
			targetSha256: request.job.target_content_hash,
			baselineIntent: "require_established",
			createdAtMs: input.createdAtMs,
		});
		return { ...accepted, kind: "enqueued", journalReplay: journalResult === "existing" };
	}

	/** Authenticate an already-journaled exact request. This method has no
	 * baseline/adoption input and never makes a row claimable by itself. */
	async authenticatePrepared(
		input: AuthenticatePreparedMutationJobInput,
	): Promise<AuthenticatedMutationAcceptance> {
		let text: string;
		let raw: unknown;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(input.requestBytes);
			raw = JSON.parse(text);
		} catch (error) {
			throw new Error("mutation cloud prepared request bytes are not valid UTF-8 JSON", { cause: error });
		}
		const request = this.#validatedRequest(raw);
		if (canonicalJson(request) !== text) {
			throw new Error("mutation cloud prepared request bytes are not protocol canonical JSON");
		}
		return this.#authenticate(request, input.sourceArtifactBytes, input.targetBytes, input.requestBytes);
	}

	#validatedRequest(raw: unknown): ValidMutationJobRequest {
		const parsed = parseMutationJobRequestV3(raw);
		if (!parsed.ok) throw new Error(`mutation cloud request is invalid: ${parsed.reason}`);
		const request = parsed.request;
		if (
			request.job.tenant !== this.config.serverAuthority.tenant ||
			request.job.project !== this.config.serverAuthority.project ||
			request.job.repository !== this.config.repository
		) {
			throw new Error(
				"mutation cloud request differs from the authenticated local authority or immutable repository identity",
			);
		}
		const multiSource = multiSourceNotMeasuredReason(request.changeset.map((entry) => entry.path));
		if (multiSource !== null) {
			throw new Error(`mutation cloud request is not measurable: ${multiSource}`);
		}
		return request;
	}

	async #authenticate(
		request: ValidMutationJobRequest,
		sourceArtifactBytes: Uint8Array,
		targetBytes: Uint8Array,
		requestBytes: string | Uint8Array,
	): Promise<AuthenticatedMutationAcceptance> {
		this.#verifyLocalBytes(request, sourceArtifactBytes, targetBytes);
		await this.#verifyServiceContract();
		await this.#uploadArtifact(request, sourceArtifactBytes);
		const accepted = await this.#createJob(request, requestBytes);
		const admission = deriveAdmission(request);
		const receiptText = JSON.stringify(accepted.acceptanceReceipt);
		const receipt = parseSignedReceipt(receiptText, "acceptance", this.config.keyRegistry);
		if (!receipt.ok) throw new Error(`mutation cloud acceptance receipt rejected: ${receipt.reason}`);
		const mismatch = acceptanceMismatch(receipt.payload, request, admission);
		if (mismatch !== null) throw new Error(mismatch);
		const issuedAt = Date.parse(receipt.payload.issued_at);
		if (!Number.isFinite(issuedAt)) throw new Error("mutation cloud acceptance receipt time is malformed");
		if (issuedAt > this.clock() + FUTURE_SKEW_MS) {
			throw new Error("mutation cloud acceptance receipt is unreasonably in the future");
		}
		return {
			jobId: request.job.job_key,
			remoteJobId: request.job.job_key,
			acceptanceReceiptHash: receipt.canonical_hash,
			idempotentReplay: accepted.idempotentReplay,
		};
	}

	#verifyLocalBytes(
		request: ValidMutationJobRequest,
		sourceArtifactBytes: Uint8Array,
		targetBytes: Uint8Array,
	): void {
		if (
			sourceArtifactBytes.byteLength !== request.source_artifact.bytes ||
			sha256(sourceArtifactBytes) !== request.source_artifact.sha256
		) {
			throw new Error("mutation cloud source artifact bytes differ from the request binding");
		}
		if (sha256(targetBytes) !== request.job.target_content_hash) {
			throw new Error("mutation cloud target bytes differ from the request binding");
		}
	}

	async #verifyServiceContract(): Promise<void> {
		const response = await this.#request("/mutation/keys", "GET");
		if (!response.ok) {
			throw new Error(
				`mutation cloud contract probe failed: HTTP ${response.status} ${await boundedErrorBody(response, [this.config.token])}`,
			);
		}
		const body = await readBoundedJson(response, "mutation cloud contract response");
		if (
			!isJsonObject(body) ||
			!hasExactJsonKeys(body, ["protocol_version", "contract_digest", "keys"]) ||
			body.protocol_version !== PROTOCOL_V3_VERSION ||
			body.contract_digest !== PROTOCOL_V3_CONTRACT_DIGEST ||
			!sameJson(body.keys, this.config.keyRegistry)
		) {
			throw new Error("mutation cloud service contract or trust registry differs from the pinned client configuration");
		}
	}

	async #uploadArtifact(request: ValidMutationJobRequest, bytes: Uint8Array): Promise<void> {
		const query = new URLSearchParams({ project_ref: this.config.projectRef });
		const response = await this.#request(
			`/mutation/artifacts/${encodeURIComponent(request.source_artifact.artifact_id)}?${query.toString()}`,
			"PUT",
			bytes,
			{
				"content-type": "application/octet-stream",
				"content-length": String(bytes.byteLength),
				"x-interlinked-sha256": request.source_artifact.sha256,
			},
		);
		if (!response.ok) {
			throw new Error(
				`mutation cloud artifact upload failed: HTTP ${response.status} ${await boundedErrorBody(response, [this.config.token])}`,
			);
		}
		const body = await readBoundedJson(response, "mutation cloud artifact response");
		if (
			!isJsonObject(body) ||
			!hasExactJsonKeys(body, ["format", "artifact_id", "sha256", "bytes", "idempotent_replay"]) ||
			body.format !== request.source_artifact.format ||
			body.artifact_id !== request.source_artifact.artifact_id ||
			body.sha256 !== request.source_artifact.sha256 ||
			body.bytes !== request.source_artifact.bytes ||
			typeof body.idempotent_replay !== "boolean"
		) {
			throw new Error("mutation cloud artifact upload response is malformed or foreign");
		}
	}

	async #createJob(request: ValidMutationJobRequest, requestBytes: string | Uint8Array): Promise<{
		acceptanceReceipt: Record<string, unknown>;
		idempotentReplay: boolean;
	}> {
		const admission = deriveAdmission(request);
		const response = await this.#request("/mutation/jobs", "POST", requestBytes, {
			"content-type": "application/json",
		});
		if (!response.ok) {
			throw new Error(
				`mutation cloud job submission failed: HTTP ${response.status} ${await boundedErrorBody(response, [this.config.token])}`,
			);
		}
		const body = await readBoundedJson(response, "mutation cloud job response");
		if (
			!isJsonObject(body) ||
			!hasExactJsonKeys(body, [
				"job_key",
				"project_ref",
				"execution_state",
				"execution_instance_id",
				"request_hash",
				"changeset_hash",
				"acceptance_receipt",
				"idempotent_replay",
			]) ||
			body.job_key !== request.job.job_key ||
			body.project_ref !== this.config.projectRef ||
			typeof body.execution_state !== "string" ||
			!EXECUTION_STATES.has(body.execution_state) ||
			typeof body.execution_instance_id !== "string" ||
			body.execution_instance_id === "" ||
			body.request_hash !== admission.request_hash ||
			body.changeset_hash !== admission.changeset_hash ||
			!isJsonObject(body.acceptance_receipt) ||
			typeof body.idempotent_replay !== "boolean"
		) {
			throw new Error("mutation cloud job response is malformed or foreign");
		}
		return {
			acceptanceReceipt: body.acceptance_receipt,
			idempotentReplay: body.idempotent_replay,
		};
	}

	#request(
		path: string,
		method: "GET" | "POST" | "PUT",
		body?: string | Uint8Array,
		extraHeaders: Record<string, string> = {},
	): Promise<SubmissionResponse> {
		const init: Parameters<MutationCloudSubmissionFetch>[1] = {
			method,
			headers: { authorization: `Bearer ${this.config.token}`, ...extraHeaders },
			signal: AbortSignal.timeout(this.config.timeoutMs),
			redirect: "error",
		};
		if (body !== undefined) init.body = body;
		return this.fetchImpl(`${this.#baseUrl}${path}`, init);
	}
}
