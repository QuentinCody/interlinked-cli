// Instruction packets — replay dry run over the local collection log (design §5).
//
// `packets compile --dry` answers, per packet, "how often would this trigger
// have fired on the calls this machine has already seen?" from
// `.interlinked/collection.jsonl` (`kind: tool_event`, one `pre` and one `post`
// row per call). Only PRE rows are counted (one per call) and the packet's own
// phase is ignored while counting: the corpus is the population of calls, and
// whether the packet listens at pre or post does not change which calls match.
// Delivery (phase × tool × runner) is reported beside the count from
// `support.ts`, so a packet can be "hits 40 rows, never executes live" (R7).
// The log is read as a bounded tail stream, never loaded whole.

import { asJsonObject as asRecord } from "../../lib/json-types.js";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { packetSupport, type PacketSupport } from "./support.js";
import { matchesTrigger, settleView, type TriggerHunk, type TriggerView } from "./trigger.js";
import type { PacketFile } from "./types.js";

export interface ReplayRow {
	session_id: string;
	seq: number;
	tool_use_id: string | null;
	/** The collection row's `provider` (adapter id such as `claude-code`), or null. */
	provider: string | null;
	view: TriggerView;
}

export interface DryRunRow {
	id: string;
	/** Pre rows the trigger matched. */
	triggered: number;
	/** Distinct sessions among the matches. */
	sessions: number;
	/** Pre rows whose tool the packet names (the width denominator). */
	tool_rows: number;
	/** Settled by the packet's deterministic decider, never sent to the model. */
	settled_compliant: number;
	settled_violated: number;
	/** Triggered rows the decider could not settle: what the model would see. */
	residue: number;
	/** triggered / tool_rows, 0 when the denominator is 0. */
	width: number;
	too_wide: boolean;
	cold: boolean;
	support: PacketSupport;
}

/** A trigger wider than this share of its tool's calls is sent back to the compiler (§5). */
const DEFAULT_WIDTH_BOUND = 0.2;

function hunksOf(action: Record<string, unknown>): TriggerHunk[] {
	const diff = asRecord(action.diff);
	const raw = diff && Array.isArray(diff.hunks) ? diff.hunks : null;
	if (raw) {
		return raw.flatMap((h: unknown) => {
			const row = asRecord(h);
			return row && typeof row.new === "string" ? [{ old: typeof row.old === "string" ? row.old : "", new: row.new }] : [];
		});
	}
	if (typeof action.content === "string") return [{ old: "", new: action.content }];
	return [];
}

/** The views one collection row presents (empty for rows that are not tool events). */
export function rowToViews(raw: unknown): ReplayRow[] {
	const r = asRecord(raw);
	if (!r || r.kind !== "tool_event") return [];
	const phase = r.phase;
	if (phase !== "pre" && phase !== "post") return [];
	const tool = typeof r.provider_tool === "string" ? r.provider_tool : "";
	const action = asRecord(r.action) ?? {};
	const session_id = typeof r.session_id === "string" ? r.session_id : "";
	const seq = typeof r.seq === "number" ? r.seq : -1;
	const tool_use_id = typeof r.tool_use_id === "string" ? r.tool_use_id : null;
	const provider = typeof r.provider === "string" ? r.provider : null;
	if (typeof action.command === "string") {
		return [{ session_id, seq, tool_use_id, provider, view: { tool, phase, path: null, command: action.command, hunks: [] } }];
	}
	const path = typeof action.path === "string" ? action.path : null;
	const hunks = hunksOf(action);
	if (path === null && hunks.length === 0) return [];
	return [{ session_id, seq, tool_use_id, provider, view: { tool, phase, path, command: null, hunks } }];
}

/** Stream the newest `tailBytes` of a collection log; a missing file yields nothing. */
export async function* readCollectionRows(file: string, tailBytes: number): AsyncGenerator<ReplayRow> {
	if (!existsSync(file)) return;
	const size = statSync(file).size;
	const start = Math.max(0, size - tailBytes);
	const rl = createInterface({ input: createReadStream(file, { start, encoding: "utf8" }), crlfDelay: Infinity });
	let dropFirst = start > 0;
	for await (const line of rl) {
		if (dropFirst) {
			dropFirst = false;
			continue;
		}
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		yield* rowToViews(parsed);
	}
}

/** Per-packet trigger counts over `rows`, with delivery support for `runner`. */
export function dryRun(file: PacketFile, rows: ReplayRow[], runner: string, opts: { widthBound?: number } = {}): DryRunRow[] {
	const bound = opts.widthBound ?? DEFAULT_WIDTH_BOUND;
	const pre = rows.filter((r) => r.view.phase === "pre");
	return file.packets.map((p) => {
		const applies = { ...p.applies, phase: "pre" as const };
		const toolRows = pre.filter((r) => p.applies.tools.includes(r.view.tool));
		const hits = toolRows.filter((r) => matchesTrigger(applies, r.view));
		const width = toolRows.length === 0 ? 0 : hits.length / toolRows.length;
		const settled = hits.map((h) => settleView(p.settle, h.view));
		const compliant = settled.filter((x) => x === "compliant").length;
		const violated = settled.filter((x) => x === "violated").length;
		return {
			id: p.id,
			triggered: hits.length,
			settled_compliant: compliant,
			settled_violated: violated,
			residue: hits.length - compliant - violated,
			sessions: new Set(hits.map((h) => h.session_id)).size,
			tool_rows: toolRows.length,
			width,
			too_wide: width > bound,
			cold: hits.length === 0,
			support: packetSupport(p, runner),
		};
	});
}
