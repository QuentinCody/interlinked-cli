// Instruction packets — the blind label sheet and the label join (design §8).
//
// A judgment row never carries evidence (privacy: the ledger records gates,
// never what was sent). For labeling, the sheet joins each JUDGED row back to
// its collection row (tool_use_id first, then session+seq) and re-renders the
// evidence with the SAME renderer and bounds the evaluator used, so a labeler
// sees exactly what Jev saw — and never the score: the sheet has no p, gate,
// model or status field. `labeledJudgments` joins the labelers' answers back
// by the same id for `calibrate.ts`.

import type { JevEntry, JevNoulQuestion } from "../jev/types.js";
import { EVIDENCE_BOUNDS, judgmentId, legacyJudgmentId, type PacketJudgmentRow } from "./evaluator.js";
import { legacyAliases } from "./session-token.js";

export { judgmentId };
import { renderEvidence } from "./evidence.js";
import type { Label, LabeledJudgment } from "./calibrate.js";
import type { ReplayRow } from "./replay.js";
import type { PacketFile } from "./types.js";

export interface LabelSheetRow {
	id: string;
	packet: string;
	session_id: string;
	tool_use_id: string | null;
	seq: number | null;
	runner: string;
	instruction: string;
	question: JevNoulQuestion;
	evidence: JevEntry;
}

function isJudged(row: PacketJudgmentRow): boolean {
	return row.gate === null && row.p !== null && row.settled === null;
}

/** One OBSERVATION: a packet version asked about one evidence of one tool call. A cosign packet is judged at
 *  PreToolUse and again at PostToolUse for the same call — two rows, two seqs, two judgment ids, one observation
 *  (audit C4: it counted twice in the holdout and in adjudications). */
function observationKey(row: Pick<PacketJudgmentRow, "packet" | "session_id" | "tool_use_id" | "seq" | "packet_hash" | "evidence_hash">): string {
	return [row.packet, row.session_id, row.tool_use_id ?? `#${row.seq}`, row.packet_hash, row.evidence_hash].join("\u0000");
}

/** Every row id → the id of its observation's representative: the newest JUDGED row, the one the sheet exports
 *  (break R5 #5: the newest row of any kind moved labels onto an unjudged row), else the newest row. Labels and
 *  adjudications given under any alias join the representative, which alone is exported, scored and counted as
 *  shown. An id of the pre-R5 form joins too, wherever it names exactly one observation. */
export function observationAliases(rows: readonly PacketJudgmentRow[]): Map<string, string> {
	const rep = new Map<string, PacketJudgmentRow>();
	for (const row of rows) {
		const key = observationKey(row);
		const prev = rep.get(key);
		if (!prev || (isJudged(row) && !isJudged(prev)) || (isJudged(row) === isJudged(prev) && prev.ts <= row.ts)) rep.set(key, row);
	}
	const repId = (row: PacketJudgmentRow) => judgmentId(rep.get(observationKey(row)) as PacketJudgmentRow);
	const aliases = new Map<string, string>();
	for (const row of rows) aliases.set(judgmentId(row), repId(row));
	for (const [old, id] of legacyAliases(rows, repId, legacyJudgmentId)) if (!aliases.has(old)) aliases.set(old, id);
	return aliases;
}

/** A label map keyed by representative ids: an alias's label joins its representative unless the representative
 *  has its own (the representative's label wins). */
export function canonicalLabels(labels: Record<string, Label>, aliases: ReadonlyMap<string, string>): Record<string, Label> {
	const out: Record<string, Label> = {};
	for (const [id, label] of Object.entries(labels)) {
		const rep = aliases.get(id) ?? id;
		if (rep === id || out[rep] === undefined) out[rep] = label;
	}
	return out;
}

/** One judged row per observation, the newest `ts` winning: a replayed event without a tool_use_id can be judged
 *  twice under one id, and a cosign call twice under two ids — neither may count twice. */
function dedupeById(rows: readonly PacketJudgmentRow[]): PacketJudgmentRow[] {
	const byObservation = new Map<string, PacketJudgmentRow>();
	for (const row of rows) {
		if (!isJudged(row)) continue;
		const key = observationKey(row);
		const prev = byObservation.get(key);
		if (!prev || prev.ts <= row.ts) byObservation.set(key, row);
	}
	return [...byObservation.values()];
}

function indexReplay(rows: readonly ReplayRow[]): { byToolUse: Map<string, ReplayRow>; bySeq: Map<string, ReplayRow> } {
	const byToolUse = new Map<string, ReplayRow>();
	const bySeq = new Map<string, ReplayRow>();
	for (const r of rows) {
		if (r.view.phase !== "pre") continue;
		if (r.tool_use_id && !byToolUse.has(r.tool_use_id)) byToolUse.set(r.tool_use_id, r);
		const key = `${r.session_id}#${r.seq}`;
		if (!bySeq.has(key)) bySeq.set(key, r);
	}
	return { byToolUse, bySeq };
}

/** Blind sheet rows for every judged row that joins a collection row; `unjoined` counts the rest. A row without a
 *  tool_use_id joins by (session, seq); a LIVE row carries its post event's seq, so `postToPre` (`pairPostToPre`,
 *  `session#postSeq` → `session#preSeq`) maps it to the pre row the index holds (review-100 n140). */
export function buildLabelSheet(judgments: readonly PacketJudgmentRow[], file: PacketFile, replay: readonly ReplayRow[], postToPre: ReadonlyMap<string, string> = new Map()): { sheet: LabelSheetRow[]; unjoined: number } {
	const packets = new Map(file.packets.map((p) => [p.id, p]));
	const index = indexReplay(replay);
	const sheet: LabelSheetRow[] = [];
	let unjoined = 0;
	for (const row of dedupeById(judgments)) {
		const packet = packets.get(row.packet);
		if (!packet || packet.packet_hash !== row.packet_hash) continue; // a judgment of an older wording is never relabeled under the new one
		const twin = (row.tool_use_id ? index.byToolUse.get(row.tool_use_id) : undefined) ?? index.bySeq.get(postToPre.get(`${row.session_id}#${row.seq}`) ?? `${row.session_id}#${row.seq}`);
		if (!twin) {
			unjoined++;
			continue;
		}
		const rendered = renderEvidence(packet.evidence, twin.view, EVIDENCE_BOUNDS);
		if (!rendered.ok) {
			unjoined++;
			continue;
		}
		sheet.push({
			id: judgmentId(row),
			packet: row.packet,
			session_id: row.session_id,
			tool_use_id: row.tool_use_id,
			seq: row.seq,
			runner: row.runner,
			instruction: packet.source.quote,
			question: packet.questions.violated,
			evidence: rendered.evidence,
		});
	}
	return { sheet, unjoined };
}

/** The evaluator cohort a row belongs to: resolved model, runner, renderer, redaction (design §8, R5). */
export function cohortKey(row: Pick<PacketJudgmentRow, "model" | "runner" | "renderer" | "redaction">): string {
	return `${row.model ?? "?"}|${row.runner}|${row.renderer}|${row.redaction}`;
}

/** Judged rows with each labeler's label attached by id; rows no labeler answered are dropped. */
export function labeledJudgments(judgments: readonly PacketJudgmentRow[], labelers: Record<string, Record<string, Label>>): LabeledJudgment[] {
	const out: LabeledJudgment[] = [];
	const aliases = observationAliases(judgments);
	const canonical = Object.fromEntries(Object.entries(labelers).map(([name, byId]) => [name, canonicalLabels(byId, aliases)]));
	for (const row of dedupeById(judgments)) {
		if (row.p === null) continue;
		const id = judgmentId(row);
		const labels: Record<string, Label> = {};
		for (const [name, byId] of Object.entries(canonical)) {
			const label = byId[id];
			if (label) labels[name] = label;
		}
		if (Object.keys(labels).length === 0) continue;
		out.push({ id, packet: row.packet, session_id: row.session_id, p: row.p, labels, cohort: cohortKey(row) });
	}
	return out;
}
