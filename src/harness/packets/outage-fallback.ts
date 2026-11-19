// Instruction packets — released text when packets stop being live MID-SESSION (design §9).
//
// The static fallback (`fallback-start.ts`) covers what the packet file and config decide. This covers what
// only a call reveals: Jev failed, the judgment came back at shadow because the calibration binding names
// another model, the spend cap was reached, or the judgment did not arrive within the delivery budget (audit B,
// finding 3: a slow Jev used to return before any fallback ran, every call). Each released packet's words are
// handed back once per context — ids the hook already recorded as received are skipped (`fallback-ledger.ts`).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PacketJudgmentRow } from "./evaluator.js";
import { allReleasedEntries } from "./fallback.js";
import { deliveredIds } from "./fallback-ledger.js";
import { statusRank } from "./schema.js";
import { PACKET_FILE_BASENAME } from "./types.js";

export const SLOW_JEV_REASON = "Jev slower than the delivery budget";

/** Why this session's released packets are not live right now, or null: a failed ask in these rows, the daemon's
 *  runtime reason (spend cap, last call failed), or a live packet's judgment forced to shadow by a binding
 *  mismatch (R39: model/runner). */
export function nonLiveReason(rows: readonly PacketJudgmentRow[], runtime: string | null): string | null {
	if (rows.some((r) => r.gate === "ask_failed")) return "Jev unreachable";
	if (runtime !== null) return runtime;
	const forced = rows.find((r) => r.status_effective === "shadow" && r.status !== null && statusRank(r.status) >= statusRank("warn"));
	if (forced) return `judged at shadow: calibration binding does not match this evaluator (model ${forced.model ?? "?"})`;
	return null;
}

/** Every release in the packet file tagged with `reason`, minus those this session already received. */
export function outageFallbackLines(cwd: string, sessionId: string, reason: string): string[] {
	const path = join(cwd, ".interlinked", PACKET_FILE_BASENAME);
	if (!existsSync(path)) return [];
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const received = deliveredIds(join(cwd, ".interlinked"), sessionId);
	return allReleasedEntries(text, reason)
		.filter((e) => !received.has(e.id))
		.map((e) => e.line);
}
