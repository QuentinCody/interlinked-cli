// test-contract: every strict-parsing rejection this module can produce
// throws with the specific reason it exists to report, and every success
// path returns the exact typed value the caller's evaluator depends on.
// Fixtures are built directly against each function's own validated shape
// (job binding, remote-evidence wrapper, manifest head) rather than routed
// through the full protocol-v3 envelope parser, except where a real parsed
// envelope is the only faithful way to exercise a receipt-arm branch.

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ClaimedMutationJob } from "./mutation-journal-types.js";
import {
	manifestFromHead,
	parseProtocolV3Envelope,
	parseProtocolV3RemoteEvidence,
	receiptInputs,
	reportBytes,
	targetContentFromJournal,
	type ProtocolV3RemoteEvidence,
} from "./protocol-v3-job-evaluator-input.js";
import type { ParsedEnvelope } from "./protocol-v3/parse.js";
import { validMutationResult } from "./protocol-v3/test-envelopes.js";
import type { V3JobBinding } from "./protocol-v3/types.js";
import { PROTOCOL_V3_VERSION } from "./protocol-v3/types.js";

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function jobBinding(overrides: Partial<V3JobBinding> = {}): V3JobBinding {
	return {
		tenant: "t_dev",
		project: "p_cli",
		repository: "github.com/QuentinCody/interlinked-cli",
		commit: "0123456789abcdef0123456789abcdef01234567",
		target_file: "src/lib/example.ts",
		target_content_hash: "1".repeat(64),
		job_key: "job_0001",
		...overrides,
	};
}

/** Only the fields `targetContentFromJournal` reads. The remaining
 *  `ClaimedMutationJob` fields are journal bookkeeping this module never
 *  touches, so the cast is a fixture shortcut, not a behavior stand-in. */
function claimedJob(overrides: {
	acceptanceReceiptHash: string;
	targetSha256: string;
	targetBytes: Uint8Array;
}): Readonly<ClaimedMutationJob> {
	// SAFETY: targetContentFromJournal reads only acceptanceReceiptHash,
	// targetSha256, and targetBytes off this parameter; the remaining
	// ClaimedMutationJob fields are journal bookkeeping it never touches.
	return overrides as unknown as Readonly<ClaimedMutationJob>;
}

/** A full "cancelled" envelope, parsed through the real strict parser, so
 *  its `execution_receipt_hash` is genuinely absent (cancelled is not an
 *  evidence-carrying kind — the terminalization arm is legal for it). */
function cancelledEnvelope(): ParsedEnvelope {
	const base = validMutationResult();
	const parsed = parseProtocolV3Envelope({
		protocol_version: PROTOCOL_V3_VERSION,
		kind: "cancelled",
		job: base.job,
		acceptance_receipt_hash: base.acceptance_receipt_hash,
		terminalization_record_hash: "c".repeat(64),
		result_hash: base.result_hash,
		signature: base.signature,
		seq: base.seq,
		occurred_at: base.occurred_at,
		cancellation_reason: "operator_abort",
	});
	return parsed;
}

function executionEnvelope(): ParsedEnvelope {
	return parseProtocolV3Envelope(validMutationResult());
}

function manifestHeadFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		generation: 0,
		authoritativeAt: "2026-08-31T11:00:00.000Z",
		engine: "stryker",
		engineVersion: "8.2.0",
		dependencyGraphVersion: "fixture",
		environmentHash: "fixture",
		files: {},
		...overrides,
	};
}

describe("parseProtocolV3RemoteEvidence — receipt arm and report_bytes typing", () => {
	it("rejects a wrapper carrying neither an execution receipt nor a terminalization record", () => {
		expect(() =>
			parseProtocolV3RemoteEvidence({
				envelope: {},
				acceptance_receipt: "ar",
				execution_receipt: null,
				terminalization_record: null,
				report_bytes: null,
			}),
		).toThrow("terminal evidence must carry exactly one execution_receipt or terminalization_record");
	});

	it("rejects a wrapper carrying both an execution receipt and a terminalization record", () => {
		expect(() =>
			parseProtocolV3RemoteEvidence({
				envelope: {},
				acceptance_receipt: "ar",
				execution_receipt: "er",
				terminalization_record: "tr",
				report_bytes: null,
			}),
		).toThrow("terminal evidence must carry exactly one execution_receipt or terminalization_record");
	});

	it("rejects a non-null, non-byte-array report_bytes value", () => {
		expect(() =>
			parseProtocolV3RemoteEvidence({
				envelope: {},
				acceptance_receipt: "ar",
				execution_receipt: "er",
				terminalization_record: null,
				report_bytes: "not-bytes",
			}),
		).toThrow("report_bytes must be a byte array or null");
	});
});

describe("targetContentFromJournal — target-byte authentication", () => {
	it("rejects targetBytes whose hash matches the journal claim but not the expected job's content hash", () => {
		const bytes = Buffer.from("export const y = 2;\n", "utf8");
		const hash = sha256Hex(bytes);
		const job = claimedJob({ acceptanceReceiptHash: "a".repeat(64), targetSha256: hash, targetBytes: bytes });
		const expected = jobBinding({ target_content_hash: "9".repeat(64) });
		expect(() => targetContentFromJournal(job, expected)).toThrow(
			"journal targetBytes do not match expectedJob.target_content_hash",
		);
	});

	it("rejects targetBytes that are not valid UTF-8 source text", () => {
		const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
		const hash = sha256Hex(bytes);
		const job = claimedJob({ acceptanceReceiptHash: "b".repeat(64), targetSha256: hash, targetBytes: bytes });
		const expected = jobBinding({ target_content_hash: hash });
		expect(() => targetContentFromJournal(job, expected)).toThrow(
			"journal targetBytes are not valid UTF-8 source text",
		);
	});

	it("rejects a decoded string that cannot be losslessly re-encoded back to the original bytes", () => {
		const bytes = Buffer.from("perfectly ordinary ascii content", "utf8");
		const hash = sha256Hex(bytes);
		const job = claimedJob({ acceptanceReceiptHash: "c".repeat(64), targetSha256: hash, targetBytes: bytes });
		const expected = jobBinding({ target_content_hash: hash });
		// Seam injection: force the round-trip re-encoding to diverge from the
		// original bytes without a real non-lossless UTF-8 input (fuzzed 2M
		// random byte strings against Node's fatal-mode TextDecoder produced no
		// such input — see rangesOpen reasoning for line 181 in the report).
		const decoy = Buffer.from([0x00]);
		const spy = vi.spyOn(Buffer, "from").mockReturnValueOnce(decoy);
		expect(() => targetContentFromJournal(job, expected)).toThrow(
			"journal targetBytes cannot be losslessly represented as UTF-8 source text",
		);
		spy.mockRestore();
	});

	it("returns the decoded content on a fully authenticated round trip", () => {
		const content = "export const z = 3;\n";
		const bytes = Buffer.from(content, "utf8");
		const hash = sha256Hex(bytes);
		const job = claimedJob({ acceptanceReceiptHash: "d".repeat(64), targetSha256: hash, targetBytes: bytes });
		const expected = jobBinding({ target_content_hash: hash });
		expect(targetContentFromJournal(job, expected)).toBe(content);
	});
});

describe("manifestFromHead — head snapshot field validation", () => {
	it("rejects a generation that is not a non-negative safe integer", () => {
		expect(() => manifestFromHead(manifestHeadFixture({ generation: -1 }))).toThrow(
			"mutation manifest head snapshot.generation must be a non-negative safe integer",
		);
	});

	it("rejects a sourceRevision present but not a string", () => {
		expect(() => manifestFromHead(manifestHeadFixture({ sourceRevision: 42 }))).toThrow(
			"mutation manifest head snapshot.sourceRevision must be a string when present",
		);
	});

	it("rejects a fileProvenance present but not an object", () => {
		expect(() => manifestFromHead(manifestHeadFixture({ fileProvenance: "not-an-object" }))).toThrow(
			"mutation manifest head snapshot.fileProvenance must be an object when present",
		);
	});

	it("accepts a well-formed snapshot with sourceRevision and fileProvenance present", () => {
		const manifest = manifestFromHead(
			manifestHeadFixture({ sourceRevision: "0123456789abcdef0123456789abcdef01234567", fileProvenance: {} }),
		);
		expect(manifest.generation).toBe(0);
	});
});

describe("reportBytes — envelope report-pointer binding", () => {
	it("rejects an envelope whose report pointer is not a well-formed object", () => {
		// SAFETY: reportBytes immediately casts its envelope param to JsonObject
		// and reads only `.report` at runtime — the ParsedEnvelope brand is a
		// compile-time-only symbol this shape never needs to carry.
		const envelope = { report: "not-an-object" } as unknown as ParsedEnvelope;
		expect(() => reportBytes(envelope, null)).toThrow("parsed envelope contains an invalid report pointer");
	});

	it("rejects a report pointer whose bytes field is not a number", () => {
		// SAFETY: same as above — only `.report.bytes` is read at runtime.
		const envelope = { report: { bytes: "20480" } } as unknown as ParsedEnvelope;
		expect(() => reportBytes(envelope, null)).toThrow("parsed envelope contains an invalid report pointer");
	});

	it("requires report_bytes when the envelope binds a report pointer", () => {
		const envelope = executionEnvelope();
		expect(() => reportBytes(envelope, null)).toThrow(
			"report_bytes is required when the envelope binds a report pointer",
		);
	});
});

describe("receiptInputs — receipt arm cross-check against the envelope", () => {
	it("rejects an execution-arm envelope paired with a wire wrapper missing its execution receipt", () => {
		const envelope = executionEnvelope();
		const wire: ProtocolV3RemoteEvidence = {
			envelope: {},
			acceptance_receipt: "ar",
			execution_receipt: null,
			terminalization_record: null,
			report_bytes: null,
		};
		expect(() => receiptInputs(wire, envelope)).toThrow(
			"terminal evidence receipt arm disagrees with the envelope execution receipt hash",
		);
	});

	it("rejects a terminalization-arm envelope paired with a wire wrapper missing its terminalization record", () => {
		const envelope = cancelledEnvelope();
		const wire: ProtocolV3RemoteEvidence = {
			envelope: {},
			acceptance_receipt: "ar",
			execution_receipt: null,
			terminalization_record: null,
			report_bytes: null,
		};
		expect(() => receiptInputs(wire, envelope)).toThrow(
			"terminal evidence receipt arm disagrees with the envelope terminalization record hash",
		);
	});

	it("returns the execution receipt pairing when both the envelope and wire agree on the execution arm", () => {
		const envelope = executionEnvelope();
		const wire: ProtocolV3RemoteEvidence = {
			envelope: {},
			acceptance_receipt: "ar",
			execution_receipt: "er",
			terminalization_record: null,
			report_bytes: null,
		};
		expect(receiptInputs(wire, envelope)).toEqual({ acceptance: "ar", execution: "er" });
	});

	it("returns the terminalization pairing when both the envelope and wire agree on the terminalization arm", () => {
		const envelope = cancelledEnvelope();
		const wire: ProtocolV3RemoteEvidence = {
			envelope: {},
			acceptance_receipt: "ar",
			execution_receipt: null,
			terminalization_record: "tr",
			report_bytes: null,
		};
		expect(receiptInputs(wire, envelope)).toEqual({ acceptance: "ar", terminalization: "tr" });
	});
});
