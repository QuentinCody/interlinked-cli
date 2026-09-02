import { describe, expect, it } from "vitest";
import { SIMPLIFICATION_REPORT_SCHEMA_VERSION } from "./simplification-types.js";
import {
	isValidLineRange,
	parseHandoffSubmissionReason,
	parseReportCommand,
	parseRequestedRemedies,
} from "./simplification-schema-guards.js";

describe("isValidLineRange", () => {
	it("accepts a null/null range", () => {
		expect(isValidLineRange(null, null)).toBe(true);
	});

	it("accepts a well-ordered positive integer range", () => {
		expect(isValidLineRange(1, 1)).toBe(true);
		expect(isValidLineRange(3, 90)).toBe(true);
	});

	it("accepts a half-open range on either side", () => {
		expect(isValidLineRange(null, 7)).toBe(true);
		expect(isValidLineRange(7, null)).toBe(true);
	});

	it("rejects a non-integer start or end", () => {
		expect(isValidLineRange(1.5, 4)).toBe(false);
		expect(isValidLineRange(1, 4.5)).toBe(false);
	});

	it("rejects a start or end below 1", () => {
		expect(isValidLineRange(0, 4)).toBe(false);
		expect(isValidLineRange(-2, null)).toBe(false);
		expect(isValidLineRange(null, 0)).toBe(false);
	});

	it("rejects an inverted range", () => {
		expect(isValidLineRange(9, 4)).toBe(false);
	});
});

describe("parseRequestedRemedies", () => {
	it("returns an empty list for no remedies", () => {
		expect(parseRequestedRemedies([])).toEqual([]);
	});

	it("preserves order and duplicates of known remedies", () => {
		expect(parseRequestedRemedies(["delete", "shrink", "delete"]))
			.toEqual(["delete", "shrink", "delete"]);
	});

	it("accepts every declared remedy", () => {
		expect(parseRequestedRemedies(["delete", "stdlib", "native", "yagni", "shrink"]))
			.toEqual(["delete", "stdlib", "native", "yagni", "shrink"]);
	});

	it("rejects the whole list when any entry is unknown", () => {
		expect(parseRequestedRemedies(["delete", "rewrite"])).toBeNull();
		expect(parseRequestedRemedies([""])).toBeNull();
	});
});

describe("parseHandoffSubmissionReason", () => {
	it("returns the reason for a not_submitted submission", () => {
		expect(parseHandoffSubmissionReason({ status: "not_submitted", reason: "advisory" }))
			.toBe("advisory");
	});

	it("rejects a non-object submission", () => {
		expect(parseHandoffSubmissionReason(null)).toBeNull();
		expect(parseHandoffSubmissionReason("not_submitted")).toBeNull();
		expect(parseHandoffSubmissionReason([])).toBeNull();
	});

	it("rejects any status other than not_submitted", () => {
		expect(parseHandoffSubmissionReason({ status: "submitted", reason: "x" })).toBeNull();
	});

	it("rejects a missing or empty reason", () => {
		expect(parseHandoffSubmissionReason({ status: "not_submitted" })).toBeNull();
		expect(parseHandoffSubmissionReason({ status: "not_submitted", reason: "" })).toBeNull();
		expect(parseHandoffSubmissionReason({ status: "not_submitted", reason: 3 })).toBeNull();
	});
});

describe("parseReportCommand", () => {
	const base = {
		schema_version: SIMPLIFICATION_REPORT_SCHEMA_VERSION,
		lens: "simplification",
		read_only: true,
	};

	it("returns each accepted command", () => {
		expect(parseReportCommand({ ...base, command: "scan" })).toBe("scan");
		expect(parseReportCommand({ ...base, command: "review" })).toBe("review");
		expect(parseReportCommand({ ...base, command: "audit" })).toBe("audit");
	});

	it("rejects a wrong schema version", () => {
		expect(parseReportCommand({ ...base, schema_version: "nope", command: "scan" })).toBeNull();
	});

	it("rejects a wrong lens or a non-read-only report", () => {
		expect(parseReportCommand({ ...base, lens: "other", command: "scan" })).toBeNull();
		expect(parseReportCommand({ ...base, read_only: false, command: "scan" })).toBeNull();
	});

	it("rejects an unknown command", () => {
		expect(parseReportCommand({ ...base, command: "fix" })).toBeNull();
		expect(parseReportCommand({ ...base })).toBeNull();
	});
});
