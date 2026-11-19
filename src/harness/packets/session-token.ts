// Instruction packets — the session part of a judgment id (break R5 #4).
//
// Judgment ids used the first 8 characters of the session id. Codex session ids are UUIDv7, whose leading
// characters are a timestamp: sessions started within about a minute share them, so two observations in two
// sessions at the same seq with the same evidence got ONE id, one label and one shown finding. The token is now a
// hash of the whole session id. Ids are recomputed from ledger rows, so only labels and adjudications saved under
// an old-form id need `legacyAliases`, which keeps such an id joining wherever it names exactly one observation.

import { createHash } from "node:crypto";

/** 8 hex characters of sha256(session id). */
export function sessionToken(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
}

/** The pre-fix session part: the session id's first 8 characters. */
export function legacySessionToken(sessionId: string): string {
	return sessionId.slice(0, 8);
}

/** What a per-call judgment id is made of (a `PacketJudgmentRow` subset; structural, so no import cycle). */
export interface JudgmentIdParts {
	packet: string;
	session_id: string;
	seq: number | null;
	/** Read only when seq is null or negative. Optional so window rows (no tool call) still fit. */
	tool_use_id?: string | null;
	packet_hash: string | null;
	evidence_hash: string | null;
}

/** The id a judgment is adjudicated and labeled under: packet, session token, seq, the packet VERSION (hash
 *  prefix) and the EVIDENCE (hash prefix) — a label names one wording asked about one evidence. */
export function judgmentId(row: JudgmentIdParts): string {
	return judgmentIdWith(row, sessionToken(row.session_id), callToken(row));
}

/** The pre-R5 id form (session id prefix, raw seq), for labels and adjudications saved before the change. */
export function legacyJudgmentId(row: JudgmentIdParts): string {
	return judgmentIdWith(row, legacySessionToken(row.session_id), String(row.seq ?? "?"));
}

/** The call part: the seq when it is 0 or more; else `t` + 8 hex of sha256(tool_use_id), so two calls of one session
 *  without a usable seq and with equal evidence do not share an id (audit R6 W5); `?` when neither exists. */
function callToken(row: JudgmentIdParts): string {
	if (row.seq !== null && row.seq >= 0) return String(row.seq);
	if (row.tool_use_id) return `t${createHash("sha256").update(row.tool_use_id).digest("hex").slice(0, 8)}`;
	return String(row.seq ?? "?");
}

function judgmentIdWith(row: JudgmentIdParts, session: string, call: string): string {
	return `${row.packet}:${session}:${call}:${(row.packet_hash ?? "").slice(0, 8)}:${(row.evidence_hash ?? "").slice(0, 8)}`;
}

/** Old-form id → current id, for every old id that names exactly one current id (an ambiguous one joins nothing). */
export function legacyAliases<R>(rows: readonly R[], currentId: (r: R) => string, oldId: (r: R) => string): Map<string, string> {
	const targets = new Map<string, Set<string>>();
	for (const r of rows) {
		const old = oldId(r);
		const id = currentId(r);
		if (old === id) continue;
		targets.set(old, (targets.get(old) ?? new Set()).add(id));
	}
	const out = new Map<string, string>();
	for (const [old, ids] of targets) if (ids.size === 1) out.set(old, [...ids][0] as string);
	return out;
}
