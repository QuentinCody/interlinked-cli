// ===========================================
// Operator taint-clear audit log
// ===========================================
//
// Lowering a sensitivity level is the one taint operation that is NOT a
// ratchet, so it is the one that has to leave a record. `.interlinked/
// taint-clears.jsonl` answers, months later, why a session that read a secret
// is reported as Public: who cleared it, from which level, which source had
// set that level, and what reason they typed.
//
// Append-only JSONL, same shape as every other ledger under `.interlinked/`.
// It is evidence for a human, not an enforcement input — nothing reads it to
// decide anything.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { SensitivityLevel } from "./types.js";
import { readSensitivity } from "./session-snapshot-codec.js";

export interface TaintClearAuditRow {
	ts: string;
	session: string;
	previous_level: SensitivityLevel;
	/** The source that had set `previous_level` (`unknown` when none matched). */
	set_by: string;
	reason: string;
	/** `os.userInfo().username` of whoever ran the command. */
	operator_user: string;
	pid: number;
}

export function taintClearLogPath(cwd: string): string {
	return join(cwd, ".interlinked", "taint-clears.jsonl");
}

export type AuditAppendResult = { ok: true } | { ok: false; error: string };

/** Append one audit row. Best-effort by design: the clear itself has already
 *  happened when this runs, so a logging failure is reported to the operator
 *  rather than thrown back as if the clear had not applied. */
export function appendTaintClearAudit(cwd: string, row: TaintClearAuditRow): AuditAppendResult {
	const target = taintClearLogPath(cwd);
	try {
		mkdirSync(dirname(target), { recursive: true });
		appendFileSync(target, `${JSON.stringify(row)}\n`);
		return { ok: true };
	} catch (err) {
		// The message is for an operator to read, so the thrown value's shape
		// does not matter — no dispatch on an error type happens here.
		return { ok: false, error: String(err) };
	}
}

function parseRow(line: string): TaintClearAuditRow | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isJsonObject(value)) return null;
	const { ts, session, set_by, reason, operator_user, pid } = value;
	if (typeof ts !== "string" || typeof session !== "string") return null;
	if (typeof set_by !== "string" || typeof reason !== "string") return null;
	if (typeof operator_user !== "string" || typeof pid !== "number") return null;
	return {
		ts,
		session,
		previous_level: readSensitivity(value.previous_level),
		set_by,
		reason,
		operator_user,
		pid,
	};
}

/** Every well-formed audit row, oldest first. A malformed line is skipped —
 *  a hand-edited ledger must not make the whole history unreadable. */
export function readTaintClearAudit(cwd: string): TaintClearAuditRow[] {
	const target = taintClearLogPath(cwd);
	if (!existsSync(target)) return [];
	let raw: string;
	try {
		raw = readFileSync(target, "utf-8");
	} catch {
		return [];
	}
	const rows: TaintClearAuditRow[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		const row = parseRow(line);
		if (row) rows.push(row);
	}
	return rows;
}
