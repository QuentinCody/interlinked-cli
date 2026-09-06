// test-contract: a dead-lettered row's `status` column is only ever
// "pending" or "evaluated" per the SQL CHECK constraint that governs it
// (see the SAFETY comment in readJournalJob), so readDeadLetteredJobs
// treats any other stored value as journal corruption and refuses to
// project a phase for it rather than guessing.

import { describe, expect, it } from "vitest";
import type { SqliteDatabase } from "./mutation-journal-driver.js";
import { readDeadLetteredJobs } from "./mutation-journal-read.js";

function fakeDbReturning(rows: Record<string, unknown>[]): SqliteDatabase {
	return {
		exec: () => {},
		close: () => {},
		prepare: () => ({
			get: () => rows[0],
			all: () => rows,
			run: () => ({ changes: 0, lastInsertRowid: 0 }),
		}),
	};
}

describe("readDeadLetteredJobs", () => {
	it("throws when a dead-lettered row's status is neither pending nor evaluated", () => {
		const db = fakeDbReturning([
			{
				job_id: "job-1",
				status: "committed",
				retry_failure_count: 2,
				last_error: "boom",
				dead_lettered_at_ms: 123,
				dead_letter_token: "tok-1",
			},
		]);
		expect(() => readDeadLetteredJobs(db, 10)).toThrow(
			"mutation journal dead letter has invalid underlying status",
		);
	});
});
