// test-contract: durable transport — cloud claims are normalized for the
// authenticated evaluator and remote acknowledgement happens only afterward.
// Every malformed field (bad ids, wrong hashes, foreign jobs, oversized or
// tampered reports, HTTP failures) throws its own attributable error instead
// of trusting the cloud; the platform fetch is exercised too, not only the
// injected test double.

import { describe, expect, it, vi } from "vitest";
import { authenticateFixture } from "./protocol-v3/test-authentication.js";
import { validMutationResult } from "./protocol-v3/test-envelopes.js";
import {
	MutationCloudV3Client,
	type MutationCloudFetch,
} from "./mutation-cloud-v3-client.js";
import type { RemoteMutationJobIdentity } from "./mutation-job-processor.js";
import type { MutationJournalAck } from "./mutation-journal-types.js";
import { MAX_REPORT_BYTES } from "./protocol-v3/field-checks.js";

const JOB: RemoteMutationJobIdentity = {
	remoteJobId: "job_0001",
	acceptanceReceiptHash: "b".repeat(64),
};

const CONFIG = {
	baseUrl: "https://cloud.example/",
	token: "test-token",
	projectRef: "p_cli",
	claimantId: "cli_installation_1",
	timeoutMs: 5_000,
};

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function terminalFixture(): {
	claim: Record<string, unknown>;
	report: Uint8Array;
	resultHash: string;
	acceptanceHash: string;
} {
	// SAFETY: the test fabricator accepts a JSON object and the production
	// parser later reconstructs and validates the complete envelope.
	const fabricated = authenticateFixture(validMutationResult() as unknown as Record<string, unknown>);
	const envelope = fabricated.raw;
	const resultHash = String(envelope.result_hash);
	const acceptanceHash = String(envelope.acceptance_receipt_hash);
	return {
		claim: {
			state: "leased",
			job_key: "job_0001",
			lease_id: "filled-by-test",
			lease_until: "2026-08-31T13:01:00.000Z",
			result_hash: resultHash,
			bundle: {
				envelope,
				acceptance_receipt: JSON.parse(fabricated.inputs.receipts.acceptance),
				execution_receipt: JSON.parse(fabricated.inputs.receipts.execution ?? "null"),
			},
		},
		report: fabricated.inputs.report ?? new Uint8Array(),
		resultHash,
		acceptanceHash,
	};
}

function clientWith(fetchImpl: MutationCloudFetch): MutationCloudV3Client {
	return new MutationCloudV3Client(CONFIG, fetchImpl);
}

function claimWithCapturedLease(fixture: ReturnType<typeof terminalFixture>, initBody: unknown): Record<string, unknown> {
	const parsed = JSON.parse(String(initBody)) as { lease_id: string };
	return { ...fixture.claim, lease_id: parsed.lease_id };
}

describe("MutationCloudV3Client", () => {
	it("P: treats a not-ready claim as pending without inventing evidence", async () => {
		const fetchImpl = vi.fn<MutationCloudFetch>().mockResolvedValue(json({ error: "not ready" }, 409));
		await expect(clientWith(fetchImpl).claimResult(JOB)).resolves.toEqual({ kind: "pending" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("P: claims a terminal bundle, retrieves the hash-bound report, and emits the strict evaluator wrapper", async () => {
		const fixture = terminalFixture();
		const calls: Array<{
			url: string;
			body: string | undefined;
			authorization: string | undefined;
			redirect: "error";
		}> = [];
		const fetchImpl: MutationCloudFetch = async (url, init) => {
			calls.push({
				url,
				body: init.body,
				authorization: init.headers.authorization,
				redirect: init.redirect,
			});
			if (init.method === "POST") return json(claimWithCapturedLease(fixture, init.body));
			return new Response(Buffer.from(fixture.report).toString("utf8"), {
				status: 200,
				headers: { "x-interlinked-sha256": fixture.resultHash },
			});
		};
		const job = { ...JOB, acceptanceReceiptHash: fixture.acceptanceHash };
		const result = await clientWith(fetchImpl).claimResult(job);
		expect(result).toEqual({
			kind: "terminal",
			evidence: expect.objectContaining({
				envelope: expect.objectContaining({ result_hash: fixture.resultHash }),
				acceptance_receipt: expect.any(String),
				execution_receipt: expect.any(String),
				terminalization_record: null,
				report_bytes: Uint8Array.from(fixture.report),
			}),
		});
		expect(calls).toHaveLength(2);
		expect(calls[1]?.url).toContain("/report?project_ref=p_cli");
		expect(calls.every((call) => call.authorization === "Bearer test-token")).toBe(true);
		expect(calls.every((call) => call.redirect === "error")).toBe(true);
	});

	it("N: rejects a terminal result bound to a foreign acceptance receipt", async () => {
		const fixture = terminalFixture();
		const fetchImpl: MutationCloudFetch = async (_url, init) => json(claimWithCapturedLease(fixture, init.body));
		await expect(clientWith(fetchImpl).claimResult(JOB)).rejects.toThrow("different acceptance receipt");
	});

	it("N: rejects a report whose retrieved bytes disagree with the authenticated pointer", async () => {
		const fixture = terminalFixture();
		let calls = 0;
		const fetchImpl: MutationCloudFetch = async (_url, init) => {
			calls++;
			return calls === 1
				? json(claimWithCapturedLease(fixture, init.body))
				: new Response("tampered report", { status: 200 });
		};
		await expect(
			clientWith(fetchImpl).claimResult({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }),
		).rejects.toThrow("report bytes disagree");
	});

	it("N: rejects an oversized authenticated report pointer before requesting the report", async () => {
		const fixture = terminalFixture();
		// SAFETY: terminalFixture constructs the bundle and envelope as plain
		// JSON objects specifically for adversarial transport mutation.
		const bundle = fixture.claim.bundle as Record<string, unknown>;
		// SAFETY: same test-fabricator invariant as the bundle cast above.
		const envelope = bundle.envelope as Record<string, unknown>;
		envelope.report = { r2_sha256: "a".repeat(64), bytes: MAX_REPORT_BYTES + 1 };
		const fetchImpl = vi.fn<MutationCloudFetch>(async (_url, init) =>
			json(claimWithCapturedLease(fixture, init.body)),
		);

		await expect(
			clientWith(fetchImpl).claimResult({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }),
		).rejects.toThrow(`${MAX_REPORT_BYTES}-byte`);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("N: requires exactly one execution or terminalization receipt", async () => {
		const fixture = terminalFixture();
		const claim = fixture.claim;
		// SAFETY: terminalFixture constructs this property as a plain object.
		const bundle = (claim.bundle ?? {}) as Record<string, unknown>;
		bundle.terminalization_record = bundle.execution_receipt;
		const fetchImpl: MutationCloudFetch = async (_url, init) => json(claimWithCapturedLease(fixture, init.body));
		await expect(
			clientWith(fetchImpl).claimResult({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }),
		).rejects.toThrow("exactly one");
	});

	it("P: reclaims the deterministic remote lease before journal-backed acknowledgement", async () => {
		const fixture = terminalFixture();
		const bodies: Record<string, unknown>[] = [];
		const fetchImpl: MutationCloudFetch = async (url, init) => {
			// SAFETY: the production client generated this JSON request body.
			const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
			bodies.push(body);
			if (url.endsWith("/ack")) {
				return json({ state: "acknowledged", job_key: "job_0001", idempotent_replay: false });
			}
			return json(claimWithCapturedLease(fixture, init.body));
		};
		const ack = {
			jobId: "local_1",
			leaseToken: "local-lease",
			acceptanceReceiptHash: fixture.acceptanceHash,
			resultHash: fixture.resultHash,
			evaluatorPolicyVersion: "policy-v1",
		// SAFETY: production creates this opaque value only from the committed
		// SQLite row; this transport test needs only its public bound fields.
		} as MutationJournalAck;
		await clientWith(fetchImpl).acknowledge(
			{ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash },
			ack,
		);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.lease_id).toBe(bodies[1]?.lease_id);
		expect(bodies[1]?.result_hash).toBe(fixture.resultHash);
	});

	it("uses the platform fetch when no override is supplied", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "not ready" }, 409));
		try {
			const client = new MutationCloudV3Client(CONFIG);
			await expect(client.claimResult(JOB)).resolves.toEqual({ kind: "pending" });
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://cloud.example/mutation/jobs/job_0001/claim",
				expect.objectContaining({
					method: "POST",
					redirect: "error",
					headers: expect.objectContaining({ authorization: "Bearer test-token" }),
				}),
			);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("rejects a job id that fails the opaque-identifier pattern", async () => {
		const fetchImpl = vi.fn<MutationCloudFetch>();
		await expect(
			clientWith(fetchImpl).claimResult({ remoteJobId: "", acceptanceReceiptHash: "b".repeat(64) }),
		).rejects.toThrow("mutation cloud job id is malformed");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects an acceptance receipt hash that is not lowercase sha-256 hex", async () => {
		const fetchImpl = vi.fn<MutationCloudFetch>();
		await expect(
			clientWith(fetchImpl).claimResult({ remoteJobId: "job_0001", acceptanceReceiptHash: "not-a-hash" }),
		).rejects.toThrow("mutation cloud acceptance receipt hash is not lowercase sha-256 hex");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects a report pointer whose byte count is not a positive integer", async () => {
		const fixture = terminalFixture();
		// SAFETY: terminalFixture constructs the bundle and envelope as plain
		// JSON objects specifically for adversarial transport mutation.
		const bundle = fixture.claim.bundle as Record<string, unknown>;
		// SAFETY: same test-fabricator invariant as the bundle cast above.
		const envelope = bundle.envelope as Record<string, unknown>;
		envelope.report = { r2_sha256: "a".repeat(64), bytes: 0 };
		const fetchImpl: MutationCloudFetch = async (_url, init) => json(claimWithCapturedLease(fixture, init.body));
		await expect(
			clientWith(fetchImpl).claimResult({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }),
		).rejects.toThrow("report.bytes is not a positive safe integer");
	});

	it("rejects a terminal bundle carrying unknown fields", async () => {
		const fixture = terminalFixture();
		// SAFETY: terminalFixture constructs the bundle as a plain JSON object
		// specifically for adversarial transport mutation.
		const bundle = fixture.claim.bundle as Record<string, unknown>;
		bundle.unexpected_field = "surprise";
		const fetchImpl: MutationCloudFetch = async (_url, init) => json(claimWithCapturedLease(fixture, init.body));
		await expect(
			clientWith(fetchImpl).claimResult({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }),
		).rejects.toThrow("mutation cloud terminal bundle carries unknown fields");
	});

	it("rejects a terminal bundle missing its acceptance receipt", async () => {
		const fixture = terminalFixture();
		// SAFETY: terminalFixture constructs the bundle as a plain JSON object
		// specifically for adversarial transport mutation.
		const bundle = fixture.claim.bundle as Record<string, unknown>;
		delete bundle.acceptance_receipt;
		const fetchImpl: MutationCloudFetch = async (_url, init) => json(claimWithCapturedLease(fixture, init.body));
		await expect(
			clientWith(fetchImpl).claimResult({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }),
		).rejects.toThrow("mutation cloud terminal bundle is missing its acceptance receipt");
	});

	it("rejects a non-positive timeoutMs at construction", () => {
		expect(() => new MutationCloudV3Client({ ...CONFIG, timeoutMs: 0 })).toThrow(
			"mutation cloud timeoutMs must be a positive safe integer",
		);
	});

	it("treats an already-acknowledged claim as never having reached this journal", async () => {
		const fetchImpl: MutationCloudFetch = async () => json({ state: "acknowledged", job_key: "job_0001" });
		await expect(clientWith(fetchImpl).claimResult(JOB)).rejects.toThrow(
			"remote mutation result was acknowledged before this journal committed it",
		);
	});

	it("rejects an acknowledged claim response for a foreign job", async () => {
		const fetchImpl: MutationCloudFetch = async () => json({ state: "acknowledged", job_key: "job_9999" });
		await expect(clientWith(fetchImpl).claimResult(JOB)).rejects.toThrow(
			"mutation cloud claim returned a foreign job",
		);
	});

	it("rejects a claim result_hash that disagrees with its own envelope", async () => {
		const fixture = terminalFixture();
		// SAFETY: terminalFixture constructs the bundle and envelope as plain
		// JSON objects specifically for adversarial transport mutation.
		const bundle = fixture.claim.bundle as Record<string, unknown>;
		// SAFETY: same test-fabricator invariant as the bundle cast above.
		const envelope = bundle.envelope as Record<string, unknown>;
		envelope.result_hash = "f".repeat(64);
		const fetchImpl: MutationCloudFetch = async (_url, init) => json(claimWithCapturedLease(fixture, init.body));
		await expect(
			clientWith(fetchImpl).claimResult({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }),
		).rejects.toThrow("mutation cloud claim result_hash disagrees with its envelope");
	});

	it("rejects an acknowledgement whose accepted receipt hash disagrees with the job", async () => {
		const fetchImpl = vi.fn<MutationCloudFetch>();
		const ack = {
			jobId: "local_1",
			leaseToken: "local-lease",
			acceptanceReceiptHash: "c".repeat(64),
			resultHash: "d".repeat(64),
			evaluatorPolicyVersion: "policy-v1",
		// SAFETY: production creates this opaque value only from the committed
		// SQLite row; this transport test needs only its public bound fields.
		} as MutationJournalAck;
		await expect(clientWith(fetchImpl).acknowledge(JOB, ack)).rejects.toThrow(
			"journal acknowledgement is bound to a different acceptance receipt",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects an acknowledgement whose result hash disagrees with the remote lease", async () => {
		const fixture = terminalFixture();
		const fetchImpl: MutationCloudFetch = async (_url, init) => json(claimWithCapturedLease(fixture, init.body));
		const ack = {
			jobId: "local_1",
			leaseToken: "local-lease",
			acceptanceReceiptHash: fixture.acceptanceHash,
			resultHash: "9".repeat(64),
			evaluatorPolicyVersion: "policy-v1",
		// SAFETY: production creates this opaque value only from the committed
		// SQLite row; this transport test needs only its public bound fields.
		} as MutationJournalAck;
		await expect(
			clientWith(fetchImpl).acknowledge({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }, ack),
		).rejects.toThrow("journal acknowledgement result hash disagrees with the remote result");
	});

	it("rejects a malformed acknowledgement response from the cloud", async () => {
		const fixture = terminalFixture();
		const fetchImpl: MutationCloudFetch = async (url, init) => {
			if (url.endsWith("/ack")) return json({ state: "nope" });
			return json(claimWithCapturedLease(fixture, init.body));
		};
		const ack = {
			jobId: "local_1",
			leaseToken: "local-lease",
			acceptanceReceiptHash: fixture.acceptanceHash,
			resultHash: fixture.resultHash,
			evaluatorPolicyVersion: "policy-v1",
		// SAFETY: production creates this opaque value only from the committed
		// SQLite row; this transport test needs only its public bound fields.
		} as MutationJournalAck;
		await expect(
			clientWith(fetchImpl).acknowledge({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }, ack),
		).rejects.toThrow("mutation cloud ack response is malformed");
	});

	it("surfaces the HTTP status when the claim request itself fails", async () => {
		const fetchImpl: MutationCloudFetch = async () => json({ error: "boom" }, 500);
		await expect(clientWith(fetchImpl).claimResult(JOB)).rejects.toThrow("mutation cloud claim failed: HTTP 500");
	});

	it("rejects a leased claim response whose shape does not match its request", async () => {
		const fetchImpl: MutationCloudFetch = async () => json({ state: "weird" });
		await expect(clientWith(fetchImpl).claimResult(JOB)).rejects.toThrow(
			"mutation cloud leased claim response is malformed or foreign",
		);
	});

	it("surfaces the HTTP status when the report fetch itself fails", async () => {
		const fixture = terminalFixture();
		const fetchImpl: MutationCloudFetch = async (_url, init) =>
			init.method === "POST" ? json(claimWithCapturedLease(fixture, init.body)) : json({ error: "gone" }, 500);
		await expect(
			clientWith(fetchImpl).claimResult({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }),
		).rejects.toThrow("mutation cloud report failed: HTTP 500");
	});

	it("rejects a report whose bytes hash differs from the authenticated pointer despite matching length", async () => {
		const fixture = terminalFixture();
		const tampered = Buffer.from(fixture.report);
		tampered[0] = (tampered[0] ?? 0) ^ 0xff;
		const fetchImpl: MutationCloudFetch = async (_url, init) => {
			if (init.method === "POST") return json(claimWithCapturedLease(fixture, init.body));
			return new Response(new Uint8Array(tampered), { status: 200 });
		};
		await expect(
			clientWith(fetchImpl).claimResult({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }),
		).rejects.toThrow("mutation cloud report bytes disagree with the authenticated pointer");
	});
});
