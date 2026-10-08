import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	appendTaintClearAudit,
	readTaintClearAudit,
	taintClearLogPath,
	type TaintClearAuditRow,
} from "./taint-clear-log.js";

let cwd: string;

const ROW: TaintClearAuditRow = {
	ts: "2026-10-05T12:00:00.000Z",
	session: "c698b9a9-d8f0-449f-a527-d7c3efd48402",
	previous_level: "Confidential",
	set_by: "<command-output>",
	reason: "youtube public key false positive",
	operator_user: "qcody",
	pid: 4242,
};

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "taint-audit-"));
});

describe("taint clear audit — positive (must fire)", () => {
	it("P1: appends one JSON line per clear and reads them back newest-last", () => {
		expect(appendTaintClearAudit(cwd, ROW).ok).toBe(true);
		expect(appendTaintClearAudit(cwd, { ...ROW, pid: 7 }).ok).toBe(true);
		const lines = readFileSync(taintClearLogPath(cwd), "utf-8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(readTaintClearAudit(cwd).map((row) => row.pid)).toEqual([4242, 7]);
	});

	it("P2: every documented field survives the round trip", () => {
		appendTaintClearAudit(cwd, ROW);
		expect(readTaintClearAudit(cwd)[0]).toEqual(ROW);
	});

	it("P3: the log lands under .interlinked/", () => {
		expect(taintClearLogPath(cwd)).toBe(join(cwd, ".interlinked", "taint-clears.jsonl"));
	});
});

describe("taint clear audit — negative (must not fire)", () => {
	it("N1: an absent log reads as an empty list, not an error", () => {
		expect(readTaintClearAudit(cwd)).toEqual([]);
	});

	it("N2: a malformed line is skipped, not thrown", () => {
		appendTaintClearAudit(cwd, ROW);
		writeFileSync(taintClearLogPath(cwd), `not json\n${JSON.stringify(ROW)}\n{"session":1}\n`);
		expect(readTaintClearAudit(cwd)).toEqual([ROW]);
	});
});
