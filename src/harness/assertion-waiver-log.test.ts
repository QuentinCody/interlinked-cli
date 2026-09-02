// Unit tests for assertion-waiver-log.ts — the campaign waiver that turns a
// mutation_directed_assertion_removal BLOCK into a logged allow.
//
//   Positive (MUST fire — waiver active / record persisted):
//     P1  INTERLINKED_ASSERTION_MOVE_WAIVER=1 activates the waiver
//     P2  records append as one JSON line each to .interlinked/assertion-waivers.jsonl
//     P3  a record carries file, line, assertion text, session id, ts, rule id
//     P4  an equivalent same-session addition REDEEMS a pending row (redeemed_by row appended)
//     P5  a pending row is redeemed at most once (multiset budget; a redeemed row is no longer pending)
//   Negative (MUST NOT fire — waiver inactive / nothing persisted):
//     N1  unset or "0" leaves the waiver inactive
//     N2  dry_run reports success but writes nothing (a dry run must not move the gate)
//     N3  no .interlinked directory ⇒ append reports failure and writes nothing
//     N4  a different session's pending row, a different subject, and a foreign ledger line redeem nothing
//     N5  a dry-run redemption returns the matches but writes no row

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ASSERTION_WAIVER_ENV,
	ASSERTION_WAIVER_LOG,
	appendAssertionWaivers,
	assertionMoveWaiverActive,
	buildAssertionWaiverRecords,
	redeemWaivedRemovals,
} from "./assertion-waiver-log.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "assertion-waiver-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function ledgerPath(): string {
	return join(dir, ".interlinked", ASSERTION_WAIVER_LOG);
}

const REMOVED = [
	{ line: 3, text: "expect(b).toBe(2);" },
	{ line: 7, text: 'it("gone", () => {' },
];

describe("assertionMoveWaiverActive — positive (must fire)", () => {
	it("P1: the env var set to 1 activates the waiver", () => {
		expect(assertionMoveWaiverActive({ [ASSERTION_WAIVER_ENV]: "1" })).toBe(true);
	});
});

describe("assertionMoveWaiverActive — negative (must not fire)", () => {
	it("N1: unset or 0 leaves the waiver inactive", () => {
		expect(assertionMoveWaiverActive({})).toBe(false);
		expect(assertionMoveWaiverActive({ [ASSERTION_WAIVER_ENV]: "0" })).toBe(false);
		expect(assertionMoveWaiverActive({ [ASSERTION_WAIVER_ENV]: "true" })).toBe(false);
	});
});

describe("buildAssertionWaiverRecords", () => {
	it("P3: one record per removed line, carrying file/line/assertion/session/ts/rule id", () => {
		const records = buildAssertionWaiverRecords({
			filePath: "/repo/x.mutation-kill.test.ts",
			removed: REMOVED,
			sessionId: "sess-1",
			clock: () => new Date("2026-09-01T12:00:00.000Z").getTime(),
		});
		expect(records).toEqual([
			{
				ts: "2026-09-01T12:00:00.000Z",
				session_id: "sess-1",
				rule_id: "mutation_directed_assertion_removal",
				file: "/repo/x.mutation-kill.test.ts",
				line: 3,
				assertion: "expect(b).toBe(2);",
			},
			{
				ts: "2026-09-01T12:00:00.000Z",
				session_id: "sess-1",
				rule_id: "mutation_directed_assertion_removal",
				file: "/repo/x.mutation-kill.test.ts",
				line: 7,
				assertion: 'it("gone", () => {',
			},
		]);
	});
});

describe("appendAssertionWaivers — positive (must fire)", () => {
	it("P2: appends one JSON line per record and reports success", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const records = buildAssertionWaiverRecords({ filePath: "f.ts", removed: REMOVED, sessionId: "s" });
		expect(appendAssertionWaivers(dir, records, false)).toBe(true);
		expect(appendAssertionWaivers(dir, records.slice(0, 1), undefined)).toBe(true);
		const lines = readFileSync(ledgerPath(), "utf-8").trimEnd().split("\n");
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0] ?? "")).toEqual(records[0]);
		expect(JSON.parse(lines[2] ?? "")).toEqual(records[0]);
	});
});

describe("appendAssertionWaivers — negative (must not fire)", () => {
	it("N2: a dry run reports success but persists nothing", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const records = buildAssertionWaiverRecords({ filePath: "f.ts", removed: REMOVED, sessionId: "s" });
		expect(appendAssertionWaivers(dir, records, true)).toBe(true);
		expect(existsSync(ledgerPath())).toBe(false);
	});

	it("N3: an absent .interlinked directory reports failure and persists nothing", () => {
		const records = buildAssertionWaiverRecords({ filePath: "f.ts", removed: REMOVED, sessionId: "s" });
		expect(appendAssertionWaivers(dir, records, false)).toBe(false);
		expect(existsSync(ledgerPath())).toBe(false);
	});
});

const CLOCK = () => new Date("2026-09-02T09:00:00.000Z").getTime();

/** Seed the ledger with one waived removal of `expect(b).toBe(2);` for `sessionId`. */
function seedPending(sessionId: string): void {
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	const records = buildAssertionWaiverRecords({
		filePath: "/repo/a.mutation-kill.test.ts",
		removed: REMOVED.slice(0, 1),
		sessionId,
		clock: CLOCK,
	});
	expect(appendAssertionWaivers(dir, records, false)).toBe(true);
}

function ledgerRows(): unknown[] {
	return readFileSync(ledgerPath(), "utf-8").trimEnd().split("\n").map((l) => JSON.parse(l));
}

describe("redeemWaivedRemovals — positive (must fire)", () => {
	it("P4: an equivalent same-session addition redeems the pending row and appends a redeemed_by row", () => {
		seedPending("s");
		const redeemed = redeemWaivedRemovals({
			projectRoot: dir,
			sessionId: "s",
			addingFile: "/repo/b.mutation-kill.test.ts",
			added: [{ line: 9, text: "expect( b ).toBe( 2 );" }],
			dryRun: false,
			clock: CLOCK,
		});
		expect(redeemed).toEqual([
			{
				ts: "2026-09-02T09:00:00.000Z",
				session_id: "s",
				rule_id: "mutation_directed_assertion_removal",
				file: "/repo/a.mutation-kill.test.ts",
				line: 3,
				assertion: "expect(b).toBe(2);",
				redeemed_by: "/repo/b.mutation-kill.test.ts",
			},
		]);
		expect(ledgerRows()).toHaveLength(2);
		expect(ledgerRows()[1]).toEqual(redeemed[0]);
	});

	it("P5: a redeemed row is no longer pending — a second equivalent addition redeems nothing", () => {
		seedPending("s");
		const opts = { projectRoot: dir, sessionId: "s", addingFile: "/repo/b.mutation-kill.test.ts", dryRun: false };
		expect(redeemWaivedRemovals({ ...opts, added: [{ line: 9, text: "expect(b).toBe(2);" }] })).toHaveLength(1);
		expect(redeemWaivedRemovals({ ...opts, added: [{ line: 12, text: "expect(b).toBe(2);" }] })).toEqual([]);
		expect(ledgerRows()).toHaveLength(2);
	});
});

describe("redeemWaivedRemovals — negative (must not fire)", () => {
	it("N4: another session's row, a different subject, and a foreign ledger line redeem nothing", () => {
		seedPending("other-session");
		appendFileSync(ledgerPath(), "not json\n{\"session_id\":\"s\"}\n");
		const base = { projectRoot: dir, addingFile: "/repo/b.mutation-kill.test.ts", dryRun: false };
		expect(redeemWaivedRemovals({ ...base, sessionId: "s", added: [{ line: 1, text: "expect(b).toBe(2);" }] })).toEqual([]);
		expect(
			redeemWaivedRemovals({ ...base, sessionId: "other-session", added: [{ line: 1, text: "expect(flag).toBe(2);" }] }),
		).toEqual([]);
		expect(redeemWaivedRemovals({ ...base, sessionId: "other-session", added: [] })).toEqual([]);
		expect(readFileSync(ledgerPath(), "utf-8").trimEnd().split("\n")).toHaveLength(3);
	});

	it("N5: a dry-run redemption returns the match but writes no row", () => {
		seedPending("s");
		const redeemed = redeemWaivedRemovals({
			projectRoot: dir,
			sessionId: "s",
			addingFile: "/repo/b.mutation-kill.test.ts",
			added: [{ line: 9, text: "expect(b).toBe(2);" }],
			dryRun: true,
		});
		expect(redeemed).toHaveLength(1);
		expect(ledgerRows()).toHaveLength(1);
	});
});
