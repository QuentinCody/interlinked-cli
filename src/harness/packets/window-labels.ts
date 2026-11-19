// Instruction packets — window judgments → the blind label sheet and the scorer (design §8).
//
// Window rows carry no evidence (privacy: the ledger records gates, never what
// was sent). For labeling, each judged window is REBUILT from the session's
// logs (the same `turnWindows` / `sessionWindow` the evaluator used, by the row's window kind), re-rendered under the same
// consent and redaction (`renderWindowState`), and exported under its window
// judgment id. Only model judgments count, one per id (newest wins), and only
// under the packet's current hash. `windowLabeledJudgments` joins the
// labelers' answers back by id with the evaluator cohort, so window packets
// enter `calibratePacket` and `applyPromotions` exactly like per-call packets.

import type { JevEntry, JevNoulQuestion } from "../jev/types.js";
import type { Label, LabeledJudgment } from "./calibrate.js";
import { legacyWindowJudgmentId, renderWindowState, type WindowJudgmentRow, windowJudgmentId } from "./trajectory.js";
import type { PacketFile, PacketsConfig } from "./types.js";
import { canonicalLabels, cohortKey } from "./label-sheet.js";
import { legacyAliases } from "./session-token.js";
import { sessionWindow, type WindowSource, turnWindows } from "./window-source.js";

export interface WindowLabelSheetRow {
	id: string;
	kind: "window";
	packet: string;
	session_id: string;
	window: { kind: "turn" | "session"; from_seq: number; to_seq: number };
	runner: string;
	instruction: string;
	question: JevNoulQuestion;
	evidence: JevEntry;
}

/** Model judgments under the packet's current hash, one per id (newest wins). */
export function windowJudgedRows(rows: readonly WindowJudgmentRow[], file: PacketFile): WindowJudgmentRow[] {
	const current = new Map(file.packets.map((p) => [p.id, p.packet_hash]));
	const byId = new Map<string, WindowJudgmentRow>();
	for (const r of rows) {
		if (r.gate !== null || r.p === null || r.settled !== null) continue;
		if (current.get(r.packet) !== r.packet_hash) continue;
		const id = windowJudgmentId(r);
		const prev = byId.get(id);
		if (!prev || prev.ts <= r.ts) byId.set(id, r);
	}
	return [...byId.values()];
}

/** Blind sheet rows for every judged window whose logs still hold it; `unjoined` counts the rest. */
export function buildWindowLabelSheet(rows: readonly WindowJudgmentRow[], file: PacketFile, sources: ReadonlyMap<string, WindowSource>, config: PacketsConfig, cwd: string): { sheet: WindowLabelSheetRow[]; unjoined: number } {
	const packets = new Map(file.packets.map((p) => [p.id, p]));
	const sheet: WindowLabelSheetRow[] = [];
	let unjoined = 0;
	for (const row of windowJudgedRows(rows, file)) {
		const packet = packets.get(row.packet);
		const source = sources.get(row.session_id);
		if (!packet || !source) {
			unjoined++;
			continue;
		}
		// Rebuild the window of the KIND the evaluator judged (review-100 n42: session rows were looked up among turn
		// windows, so they never joined, or joined a one-turn session's turn digest).
		const candidates = row.window.kind === "session" ? [sessionWindow(row.session_id, source.calls, source.timeline)] : turnWindows(row.session_id, source.calls, source.timeline);
		const window = candidates.find((w) => w.from_seq === row.window.from_seq && w.to_seq === row.window.to_seq);
		if (!window) {
			unjoined++;
			continue;
		}
		sheet.push({
			id: windowJudgmentId(row),
			kind: "window",
			packet: row.packet,
			session_id: row.session_id,
			window: { kind: row.window.kind, from_seq: row.window.from_seq, to_seq: row.window.to_seq },
			runner: row.runner,
			instruction: packet.source.quote,
			question: packet.questions.violated,
			evidence: renderWindowState(window, config, cwd).entry,
		});
	}
	return { sheet, unjoined };
}

/** Judged window rows with each labeler's label attached by id; rows no labeler answered are dropped. */
export function windowLabeledJudgments(rows: readonly WindowJudgmentRow[], labelers: Record<string, Record<string, Label>>, file: PacketFile): LabeledJudgment[] {
	const out: LabeledJudgment[] = [];
	const judgedRows = windowJudgedRows(rows, file);
	// A label saved under the pre-R5 id form joins where that id names exactly one window judgment.
	const legacy = legacyAliases(judgedRows, windowJudgmentId, legacyWindowJudgmentId);
	const canonical = Object.entries(labelers).map(([name, byId]) => [name, canonicalLabels(byId, legacy)] as const);
	for (const row of judgedRows) {
		if (row.p === null) continue;
		const id = windowJudgmentId(row);
		const labels: Record<string, Label> = {};
		for (const [name, byId] of canonical) {
			const label = byId[id];
			if (label) labels[name] = label;
		}
		if (Object.keys(labels).length === 0) continue;
		out.push({ id, packet: row.packet, session_id: row.session_id, p: row.p, labels, cohort: cohortKey(row) });
	}
	return out;
}
