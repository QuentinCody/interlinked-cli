// ===========================================
// Companion tests for mutation-journal-evidence.ts
// ===========================================
// Focused on the two "incomplete pair" read-time guards: a row whose
// execution_receipt (json/hash) or report (bytes/hash) columns disagree on
// nullness is a corrupted/partial write, and `readRetainedEvidence` must
// refuse to silently coerce it into a valid `JournalRetainedEvidence` — it
// throws instead. A fake `SqliteDatabase` stands in for node:sqlite so each
// row shape can be constructed directly, including ones the real schema's
// CHECK constraints would never let `insertRetainedEvidence` write.

import { describe, expect, it } from "vitest";
import type { SqliteDatabase } from "./mutation-journal-driver.js";
import { readRetainedEvidence } from "./mutation-journal-evidence.js";

/** A row that would decode cleanly — every guarded pair is fully present or
 *  fully null. Callers override one field to break exactly one pair. */
const VALID_ROW: Record<string, unknown> = {
	format_version: 1,
	envelope_json: "{}",
	envelope_sha256: "e".repeat(64),
	acceptance_receipt_json: "{}",
	acceptance_receipt_sha256: "a".repeat(64),
	execution_receipt_json: null,
	execution_receipt_sha256: null,
	terminalization_record_json: null,
	terminalization_record_sha256: null,
	report_bytes: null,
	report_sha256: null,
};

/** Minimal `SqliteDatabase` whose one prepared statement always answers
 *  `.get()` with `row` — enough for `readRetainedEvidence`, which never
 *  calls `.run()` or `.all()`. */
function fakeDbReturning(row: Record<string, unknown>): SqliteDatabase {
	return {
		exec: () => {},
		prepare: () => ({
			run: () => ({ changes: 0, lastInsertRowid: 0 }),
			get: () => row,
			all: () => [row],
		}),
		close: () => {},
	};
}

describe("readRetainedEvidence — incomplete-pair guards", () => {
	it("throws when execution_receipt_json is present but execution_receipt_sha256 is null", () => {
		const db = fakeDbReturning({
			...VALID_ROW,
			execution_receipt_json: "{\"kind\":\"execution\"}",
			execution_receipt_sha256: null,
		});
		expect(() => readRetainedEvidence(db, 1)).toThrow(
			"mutation evidence row has an incomplete execution_receipt_json/execution_receipt_sha256 pair",
		);
	});

	it("throws when terminalization_record_sha256 is present but terminalization_record_json is null", () => {
		const db = fakeDbReturning({
			...VALID_ROW,
			terminalization_record_json: null,
			terminalization_record_sha256: "t".repeat(64),
		});
		expect(() => readRetainedEvidence(db, 1)).toThrow(
			"mutation evidence row has an incomplete terminalization_record_json/terminalization_record_sha256 pair",
		);
	});

	it("throws when report_bytes is present but report_sha256 is null", () => {
		const db = fakeDbReturning({
			...VALID_ROW,
			report_bytes: Uint8Array.from([1, 2, 3]),
			report_sha256: null,
		});
		expect(() => readRetainedEvidence(db, 1)).toThrow(
			"mutation evidence row has an incomplete report_bytes/report_sha256 pair",
		);
	});
});
