// test-contract: unit — normalizeRetainedEvidence validates and re-copies the
// authenticated evidence bundle a durable mutation journal row carries: the
// nested canonical-JSON fields (envelope / acceptanceReceipt / optional
// executionReceipt / optional terminalizationRecord) and the optional report
// byte blob. Every case below drives the function through its one exported
// entry point with a hand-built input object — no SQLite row, no mocking of
// the module under test.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeRetainedEvidence } from "./mutation-journal-retained.js";
import { canonicalJson } from "./protocol-v3/canonical.js";

/** A well-formed {canonicalJson, sha256} pair for `value`. */
function retainedJson(value: unknown): { canonicalJson: string; sha256: string } {
	const encoded = canonicalJson(value);
	return { canonicalJson: encoded, sha256: createHash("sha256").update(encoded).digest("hex") };
}

/** 64 lowercase hex chars: passes the format check without claiming to hash
 * anything in particular — used where a test needs a well-formed hash that
 * is (deliberately) not the real digest of the paired payload. */
const WELL_FORMED_HASH = "a".repeat(64);

/** A fully valid evidence input: callers override just the field under test. */
function validEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		formatVersion: 1,
		envelope: retainedJson({ kind: "envelope" }),
		acceptanceReceipt: retainedJson({ kind: "acceptance" }),
		executionReceipt: retainedJson({ kind: "execution" }),
		terminalizationRecord: null,
		report: null,
		...overrides,
	};
}

/** Runs `normalizeRetainedEvidence` and returns the thrown Error, or fails
 * the test if it did not throw. */
function captureThrow(input: unknown): Error {
	try {
		normalizeRetainedEvidence(input);
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		// SAFETY: the assertion above proves `error` is an Error instance.
		return error as Error;
	}
	throw new Error("expected normalizeRetainedEvidence to throw, but it returned");
}

describe("normalizeRetainedEvidence", () => {
	it("returns a normalized record with fresh, independent report bytes on a valid input", () => {
		const sourceBytes = Uint8Array.from([1, 2, 3]);
		const reportSha = createHash("sha256").update(sourceBytes).digest("hex");
		const result = normalizeRetainedEvidence(
			validEvidence({ report: { bytes: sourceBytes, sha256: reportSha } }),
		);
		sourceBytes[0] = 99; // mutate the caller's array after the call
		expect(result.formatVersion).toBe(1);
		expect(result.report?.bytes[0]).toBe(1); // unaffected by the later mutation
		expect(result.executionReceipt?.canonicalJson).toBe(canonicalJson({ kind: "execution" }));
		expect(result.terminalizationRecord).toBeNull();
	});

	it("rejects a non-object top-level value", () => {
		const error = captureThrow("not-an-object");
		expect(error.message).toBe("retainedEvidence must be an object");
	});

	it("rejects when both executionReceipt and terminalizationRecord are present", () => {
		const error = captureThrow(
			validEvidence({ terminalizationRecord: retainedJson({ kind: "terminalization" }) }),
		);
		expect(error.message).toBe(
			"retainedEvidence must carry exactly one executionReceipt or terminalizationRecord",
		);
	});

	it("rejects when neither executionReceipt nor terminalizationRecord is present", () => {
		const error = captureThrow(validEvidence({ executionReceipt: null }));
		expect(error.message).toBe(
			"retainedEvidence must carry exactly one executionReceipt or terminalizationRecord",
		);
	});

	it("rejects a non-object nested canonical-JSON field", () => {
		const error = captureThrow(validEvidence({ envelope: "not-an-object" }));
		expect(error.message).toBe("retainedEvidence.envelope must be a retained canonical JSON record");
	});

	it("rejects an empty canonicalJson string on a nested field", () => {
		const error = captureThrow(
			validEvidence({ envelope: { canonicalJson: "", sha256: WELL_FORMED_HASH } }),
		);
		expect(error.message).toBe("retainedEvidence.envelope.canonicalJson must not be empty");
	});

	it("rejects a canonicalJson string that is not valid JSON", () => {
		const error = captureThrow(
			validEvidence({ envelope: { canonicalJson: "{not json", sha256: WELL_FORMED_HASH } }),
		);
		expect(error.message).toBe("retainedEvidence.envelope.canonicalJson is not valid JSON");
		expect(error.cause).toBeInstanceOf(Error);
	});

	it("rejects valid JSON whose keys are not in canonical (sorted) form", () => {
		const error = captureThrow(
			validEvidence({
				envelope: { canonicalJson: '{"b":1,"a":2}', sha256: WELL_FORMED_HASH },
			}),
		);
		expect(error.message).toBe(
			"retainedEvidence.envelope.canonicalJson is not in protocol canonical form",
		);
	});

	it("rejects canonical JSON whose sha256 does not match its bytes", () => {
		const encoded = canonicalJson({ a: 1 });
		const error = captureThrow(
			validEvidence({ envelope: { canonicalJson: encoded, sha256: WELL_FORMED_HASH } }),
		);
		expect(error.message).toBe(
			"retainedEvidence.envelope.canonicalJson does not match its sha256",
		);
	});

	it("rejects a non-object report field", () => {
		const error = captureThrow(validEvidence({ report: "not-a-report" }));
		expect(error.message).toBe("retainedEvidence.report must be a retained report record");
	});

	it("rejects a report whose bytes field is not a byte array", () => {
		const error = captureThrow(
			validEvidence({ report: { bytes: "not-bytes", sha256: WELL_FORMED_HASH } }),
		);
		expect(error.message).toBe("retainedEvidence.report.bytes must be a byte array");
	});

	it("rejects a report whose sha256 field is not a string", () => {
		const error = captureThrow(
			validEvidence({ report: { bytes: Uint8Array.from([1, 2, 3]), sha256: 12345 } }),
		);
		expect(error.message).toBe("retainedEvidence.report.sha256 must be a string");
	});
});
