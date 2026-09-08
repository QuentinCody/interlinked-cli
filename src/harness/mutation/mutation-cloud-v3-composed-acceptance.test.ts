// test-contract: composed acceptance — signed protocol-v3 evidence crosses
// submission, SQLite, the background scheduler, durable finding delivery,
// and the active-session notification queue without a second evaluator.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isJsonObject } from "../../lib/json-types.js";
import { AsyncFindingQueue } from "../async-finding-queue.js";
import { startMutationCloudV3Background } from "./mutation-cloud-v3-background.js";
import type { MutationCloudFetch } from "./mutation-cloud-v3-client.js";
import { MUTATION_FINDING_DELIVERY_RELATIVE_PATH } from "./mutation-cloud-v3-finding-delivery.js";
import {
	MutationCloudV3Runtime,
	type MutationCloudV3RuntimeConfig,
} from "./mutation-cloud-v3-runtime.js";
import { createMutationFindingSessionDelivery } from "./mutation-cloud-v3-session-delivery.js";
import type { MutationCloudSubmissionFetch } from "./mutation-cloud-v3-submission.js";
import {
	MUTATION_RETRY_BASE_DELAY_MS,
	MUTATION_RETRY_MAX_FAILURES,
} from "./mutation-journal-codec.js";
import { openMutationJournal } from "./mutation-journal-sqlite.js";
import type { MutationBaselineIntent, MutationJournal } from "./mutation-journal-types.js";
import {
	authenticateFixture,
	TEST_NOW,
	TEST_REGISTRY,
	TEST_SOURCE_ARTIFACT_TEXT,
} from "./protocol-v3/test-authentication.js";
import {
	deriveAdmission,
	parseMutationJobRequestV3,
	type ValidMutationJobRequest,
} from "./protocol-v3/request.js";
import { MUTATION_RESULT_TARGET_CONTENT, validMutationResult } from "./protocol-v3/test-envelopes.js";
import { PROTOCOL_V3_CONTRACT_DIGEST as CONTRACT_DIGEST } from "./protocol-v3/contract-identity.js";

const NOW_MS = Date.parse(TEST_NOW);

interface AcceptanceFixture {
	request: ValidMutationJobRequest;
	authenticated: ReturnType<typeof authenticateFixture>;
	sourceBytes: Uint8Array;
	targetBytes: Uint8Array;
}

function fixture(jobKey: string, adverse = false): AcceptanceFixture {
	const raw = validMutationResult();
	raw.job = { ...raw.job, job_key: jobKey };
	raw.excluded = [];
	raw.census = { generated: raw.mutants.length, executable: raw.mutants.length, approved_excluded: 0 };
	let evidence: Record<string, unknown>;
	if (adverse) {
		const redShape = {
			...raw,
			kind: "suite_red",
			test_run: { ...raw.test_run, overlay_green: false },
		};
		// SAFETY: widened to construct the suite_red union arm; the fields that
		// belong only to mutation_result are removed before authentication.
		evidence = redShape;
		for (const key of ["report", "census", "excluded", "mutants", "identity_algorithm"]) {
			delete evidence[key];
		}
	} else {
		// SAFETY: validMutationResult is protocol JSON and is reparsed below.
		evidence = raw as unknown as Record<string, unknown>;
	}
	const authenticated = authenticateFixture(evidence);
	const scope = authenticated.raw.scope;
	if (!isJsonObject(scope) || !Array.isArray(scope.test_files)) {
		throw new Error("acceptance fixture has no test scope");
	}
	const parsed = parseMutationJobRequestV3({
		request_version: "1",
		protocol_version: "interlinked-mutation/3.0",
		job: authenticated.inputs.expectedJob,
		source_artifact: authenticated.inputs.expectedAdmission.source_artifact,
		scope_mode: scope.mode,
		test_files: scope.test_files,
		changeset: [{
			path: authenticated.inputs.expectedJob.target_file,
			content_hash: authenticated.inputs.expectedJob.target_content_hash,
		}],
	});
	if (!parsed.ok) throw new Error(parsed.reason);
	return {
		request: parsed.request,
		authenticated,
		sourceBytes: Buffer.from(TEST_SOURCE_ARTIFACT_TEXT, "latin1"),
		targetBytes: Buffer.from(MUTATION_RESULT_TARGET_CONTENT, "utf8"),
	};
}

function config(view: AcceptanceFixture): MutationCloudV3RuntimeConfig {
	const authority = { tenant: view.request.job.tenant, project: view.request.job.project };
	return {
		submission: {
			baseUrl: "https://mutation.example",
			token: "composed-acceptance-credential",
			projectRef: view.request.job.project,
			repository: view.request.job.repository,
			timeoutMs: 5_000,
			contractDigest: CONTRACT_DIGEST,
			keyRegistry: TEST_REGISTRY,
			serverAuthority: authority,
		},
		client: {
			baseUrl: "https://mutation.example",
			token: "composed-acceptance-credential",
			projectRef: view.request.job.project,
			claimantId: "composed-acceptance-installation",
			timeoutMs: 5_000,
		},
		evaluator: {
			keyRegistry: TEST_REGISTRY,
			serverAuthority: authority,
			evaluatorPolicyVersion: "composed-acceptance-policy",
			siteCountThreshold: 50,
		},
		owner: "composed-acceptance-owner",
		leaseMs: 15_000,
	};
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function submissionFetch(view: AcceptanceFixture): MutationCloudSubmissionFetch {
	return async (_url, init) => {
		if (init.method === "GET") {
			return json({
				protocol_version: "interlinked-mutation/3.0",
				contract_digest: CONTRACT_DIGEST,
				keys: TEST_REGISTRY,
			});
		}
		if (init.method === "PUT") {
			return json({ ...view.request.source_artifact, idempotent_replay: false }, 201);
		}
		return json({
			job_key: view.request.job.job_key,
			project_ref: view.request.job.project,
			execution_state: "accepted",
			execution_instance_id: `workflow-${view.request.job.job_key}`,
			request_hash: view.authenticated.inputs.expectedAdmission.request_hash,
			changeset_hash: view.authenticated.inputs.expectedAdmission.changeset_hash,
			acceptance_receipt: JSON.parse(view.authenticated.inputs.receipts.acceptance),
			idempotent_replay: false,
		}, 202);
	};
}

function leaseId(body: string | undefined): string {
	const parsed: unknown = JSON.parse(body ?? "{}");
	if (!isJsonObject(parsed) || typeof parsed.lease_id !== "string") {
		throw new Error("claim request has no lease id");
	}
	return parsed.lease_id;
}

function leasedClaim(
	view: AcceptanceFixture,
	body: string | undefined,
	envelope: Record<string, unknown> = view.authenticated.raw,
): Record<string, unknown> {
	return {
		state: "leased",
		job_key: view.request.job.job_key,
		lease_id: leaseId(body),
		lease_until: "2026-08-31T13:05:00.000Z",
		result_hash: envelope.result_hash,
		bundle: {
			envelope,
			acceptance_receipt: JSON.parse(view.authenticated.inputs.receipts.acceptance),
			execution_receipt: JSON.parse(view.authenticated.inputs.receipts.execution ?? "null"),
		},
	};
}

interface TerminalFetchOptions {
	ackStatus?: number;
	envelope?: Record<string, unknown>;
	onAck?: () => void;
	calls?: string[];
}

function terminalFetch(view: AcceptanceFixture, options: TerminalFetchOptions = {}): MutationCloudFetch {
	return async (url, init) => {
		options.calls?.push(url);
		if (url.includes("/report?")) {
			return new Response(Buffer.from(view.authenticated.inputs.report ?? new Uint8Array()), { status: 200 });
		}
		if (url.endsWith("/ack")) {
			options.onAck?.();
			return options.ackStatus === undefined || options.ackStatus === 200
				? json({ state: "acknowledged", job_key: view.request.job.job_key })
				: json({ error: "injected acknowledgement outage" }, options.ackStatus);
		}
		return json(leasedClaim(view, init.body, options.envelope));
	};
}

function enqueue(
	journal: MutationJournal,
	view: AcceptanceFixture,
	baselineIntent: MutationBaselineIntent = "require_established",
): void {
	const admission = deriveAdmission(view.request);
	journal.enqueue({
		jobId: view.request.job.job_key,
		remoteJobId: view.request.job.job_key,
		acceptanceReceiptHash: String(view.authenticated.raw.acceptance_receipt_hash),
		expectedJob: { ...view.request.job },
		expectedAdmission: {
			request_hash: admission.request_hash,
			changeset_hash: admission.changeset_hash,
			source_artifact: { ...admission.source_artifact },
		},
		targetBytes: view.targetBytes,
		targetSha256: view.request.job.target_content_hash,
		baselineIntent,
		createdAtMs: NOW_MS,
	});
}

function deliveryRecords(root: string): Record<string, unknown>[] {
	const path = join(root, MUTATION_FINDING_DELIVERY_RELATIVE_PATH);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => {
			const value: unknown = JSON.parse(line);
			if (!isJsonObject(value)) throw new Error("finding delivery row is not an object");
			return value;
		});
}

const roots: string[] = [];

function temporaryRoot(label: string): string {
	const root = mkdtempSync(join(tmpdir(), `interlinked-${label}-`));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("protocol-v3 composed CLI acceptance", () => {
	it("persists before failed remote ack, delivers one stable adverse finding after restart, then resumes ack-only", async () => {
		const root = temporaryRoot("v3-composed-adverse");
		const view = fixture("job_composed_adverse", true);
		const pending = new MutationCloudV3Runtime(root, config(view), {
			submissionFetch: submissionFetch(view),
			clientFetch: async () => json({ error: "not ready" }, 409),
			clockMs: () => NOW_MS,
		});
		const submitted = await pending.submit({
			request: view.request,
			sourceArtifactBytes: view.sourceBytes,
			targetBytes: view.targetBytes,
			createdAtMs: NOW_MS,
		});
		expect(submitted.immediate.processor).toMatchObject({ kind: "pending" });
		pending.close();

		let persistedBeforeAck = false;
		const firstCalls: string[] = [];
		const terminal = new MutationCloudV3Runtime(root, config(view), {
			clientFetch: terminalFetch(view, {
				ackStatus: 503,
				calls: firstCalls,
				onAck: () => {
					const observer = openMutationJournal(root);
					persistedBeforeAck = observer.getEvaluation(view.request.job.job_key) !== null;
					expect(observer.getJob(view.request.job.job_key)?.status).toBe("evaluated");
					observer.close();
				},
			}),
			clockMs: () => NOW_MS + MUTATION_RETRY_BASE_DELAY_MS,
		});
		const committed = await terminal.processNext();
		expect(committed.processor).toMatchObject({ kind: "retry", stage: "remote_ack" });
		expect(committed.evaluation?.decision).toMatchObject({ verdict: "adverse" });
		expect(committed.evaluation?.findings).toHaveLength(1);
		expect(persistedBeforeAck).toBe(true);
		terminal.close();

		const queue = new AsyncFindingQueue({ now: () => NOW_MS + (2 * MUTATION_RETRY_BASE_DELAY_MS) });
		const notify = createMutationFindingSessionDelivery({
			sessions: { getAll: () => [{ session_id: "session-a" }, { session_id: "session-b" }] },
			queue,
			clock: () => NOW_MS + (2 * MUTATION_RETRY_BASE_DELAY_MS),
		});
		const background = startMutationCloudV3Background({
			root,
			log: vi.fn(),
			intervalMs: 60_000,
			onFinding: notify,
		}, {
			configExists: () => true,
			loadConfig: () => ({ ...config(view), backgroundEnabled: true }),
			openRuntime: () => {
				const runtime = new MutationCloudV3Runtime(root, config(view), {
					clientFetch: terminalFetch(view),
					clockMs: () => NOW_MS + (2 * MUTATION_RETRY_BASE_DELAY_MS),
				});
				return {
					processNext: async () => { throw new Error("injected result-poll outage"); },
					deliverOneFinding: () => runtime.deliverOneFinding(),
					close: () => runtime.close(),
				};
			},
		});
		expect(await background.tick()).toBe("failed");
		background.stop();

		const records = deliveryRecords(root);
		expect(records).toHaveLength(1);
		const outboxId = records[0]?.outbox_id;
		expect(outboxId).toMatch(/^[1-9][0-9]*:[a-f0-9]{64}$/);
		for (const sessionId of ["session-a", "session-b"]) {
			expect(queue.pending(sessionId)).toMatchObject([{
				id: `mutation.finding:${String(outboxId)}`,
				check: "mutation_cloud_v3",
			}]);
		}

		const recoveryCalls: string[] = [];
		const recovered = new MutationCloudV3Runtime(root, config(view), {
			clientFetch: terminalFetch(view, { calls: recoveryCalls }),
			clockMs: () => NOW_MS + (2 * MUTATION_RETRY_BASE_DELAY_MS),
		});
		const acknowledged = await recovered.processNext();
		expect(acknowledged.processor).toEqual({
			kind: "acknowledged",
			jobId: view.request.job.job_key,
			phase: "ack",
		});
		expect(recoveryCalls.some((url) => url.endsWith("/ack"))).toBe(true);
		expect(recoveryCalls.some((url) => url.includes("/report?"))).toBe(false);
		expect(await recovered.deliverOneFinding()).toEqual({ kind: "idle" });
		recovered.close();
		expect(deliveryRecords(root)).toHaveLength(1);
	});

	it("adopts through the real evaluator once, then a later clean result creates no finding", async () => {
		const root = temporaryRoot("v3-composed-clean");
		const adoptedView = fixture("job_composed_adopt");
		const journal = openMutationJournal(root);
		const adoptedRuntime = new MutationCloudV3Runtime(root, config(adoptedView), {
			journal,
			clientFetch: terminalFetch(adoptedView),
			clockMs: () => NOW_MS,
		});
		enqueue(journal, adoptedView, "adopt_current");
		const adopted = await adoptedRuntime.processNext();
		expect(adopted.processor).toMatchObject({ kind: "acknowledged" });
		expect(adopted.evaluation?.decision).toMatchObject({ verdict: "baseline_adopted" });
		expect(await adoptedRuntime.deliverOneFinding()).toMatchObject({ kind: "delivered" });
		adoptedRuntime.close();

		const cleanView = fixture("job_composed_clean");
		const cleanRuntime = new MutationCloudV3Runtime(root, config(cleanView), {
			journal,
			clientFetch: terminalFetch(cleanView),
			clockMs: () => NOW_MS + 1,
		});
		enqueue(journal, cleanView);
		const clean = await cleanRuntime.processNext();
		expect(clean.processor).toMatchObject({ kind: "acknowledged" });
		expect(clean.evaluation?.decision).toMatchObject({ verdict: "clean" });
		expect(clean.evaluation?.findings).toEqual([]);
		expect(await cleanRuntime.deliverOneFinding()).toEqual({ kind: "idle" });
		expect(deliveryRecords(root)).toHaveLength(1);
		cleanRuntime.close();
		journal.close();
	});

	it.each(["malformed", "foreign"] as const)(
		"never classifies %s terminal evidence as clean and eventually dead-letters it",
		async (variant) => {
			const root = temporaryRoot(`v3-composed-${variant}`);
			const view = fixture(`job_composed_${variant}`);
			const foreign = fixture("job_foreign_evidence");
			const malformed = { ...view.authenticated.raw, unexpected_contract_field: true };
			const envelope = variant === "foreign" ? foreign.authenticated.raw : malformed;
			const journal = openMutationJournal(root);
			let nowMs = NOW_MS;
			const runtime = new MutationCloudV3Runtime(root, config(view), {
				journal,
				clientFetch: terminalFetch(view, { envelope }),
				clockMs: () => nowMs,
			});
			enqueue(journal, view);

			for (let attempt = 1; attempt <= MUTATION_RETRY_MAX_FAILURES; attempt += 1) {
				const result = await runtime.processNext();
				if (attempt < MUTATION_RETRY_MAX_FAILURES) {
					expect(result.processor).toMatchObject({ kind: "retry" });
					const row = journal.getJob(view.request.job.job_key);
					if (row === null) throw new Error("retrying job disappeared from SQLite");
					nowMs = row.nextAttemptAtMs;
				} else {
					expect(result.processor).toMatchObject({ kind: "dead_letter" });
				}
			}

			expect(journal.getEvaluation(view.request.job.job_key)).toBeNull();
			expect(journal.getJob(view.request.job.job_key)).toMatchObject({
				status: "dead_letter",
				failureCount: MUTATION_RETRY_MAX_FAILURES,
			});
			expect(await runtime.deliverOneFinding()).toEqual({ kind: "idle" });
			expect(deliveryRecords(root)).toEqual([]);
			runtime.close();
			journal.close();
		},
	);
});
