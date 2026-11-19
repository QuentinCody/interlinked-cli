// Instruction packets — the cosign pairing (design §5, §8; audit C9).
//
// `cosignals` lists the deterministic rule ids whose ALLOW a packet may raise to ASK: the packet catches the
// residue of that rule (the calls the rule lets through). A cosign packet asks only while one of its cosignals
// names an ACTIVE rule of the merged rule set (builtin minus `disabled_rules`, custom, distilled, finding rules);
// with none it is UNPAIRED and its asks are withheld (the judgment still lands, eligible, never shown).
// The per-call reading (ask only when the rule itself matched) is not used: a matched builtin rule blocks, so
// its allow is exactly the calls it did not match.
// Pure except `cosignPairingAt` / `hasCosignPackets`, which read the packet file.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardRulesConfig, HarnessDecision } from "../types.js";
import type { PacketJudgmentRow } from "./evaluator.js";
import { parsePacketFile } from "./schema.js";
import { PACKET_FILE_BASENAME, type Packet, type PacketFile } from "./types.js";

/** The ids of the rules the guard runs here (the merged list `loadRules` returns). */
export function activeRuleIds(rules: GuardRulesConfig): Set<string> {
	return new Set((rules.rules ?? []).map((r) => r.id));
}

/** The first cosignal that names an active rule, or null (unpaired: the packet may not ask). */
export function pairedRule(packet: Packet, active: ReadonlySet<string>): string | null {
	return packet.cosignals.find((id) => active.has(id)) ?? null;
}

/** Every packet at cosign, mapped to its paired rule or null. */
export function cosignPairing(file: PacketFile, active: ReadonlySet<string>): Map<string, string | null> {
	return new Map(file.packets.filter((p) => p.calibration.status === "cosign").map((p) => [p.id, pairedRule(p, active)]));
}

export interface CosignCounts {
	/** PreToolUse asks delivered (a paired row that was shown). */
	asked: number;
	/** Eligible judgments of an unpaired packet: an ask the pairing withheld. */
	withheld: number;
}

/** Per packet, from the PreToolUse cosign rows (those carry `cosign_rule`; PostToolUse rows do not). */
export function cosignLedgerCounts(rows: readonly PacketJudgmentRow[]): Map<string, CosignCounts> {
	const out = new Map<string, CosignCounts>();
	for (const r of rows) {
		if (r.cosign_rule === undefined) continue;
		const c = out.get(r.packet) ?? { asked: 0, withheld: 0 };
		if (r.cosign_rule !== null && r.shown) c.asked++;
		else if (r.cosign_rule === null && r.eligible) c.withheld++;
		out.set(r.packet, c);
	}
	return out;
}

/** `packets status` lines: one per cosign packet, its pair (or why it never asks) and the ledger counts. */
export function cosignStatusLines(file: PacketFile, active: ReadonlySet<string>, rows: readonly PacketJudgmentRow[]): string[] {
	const counts = cosignLedgerCounts(rows);
	return file.packets
		.filter((p) => p.calibration.status === "cosign")
		.map((p) => {
			const rule = pairedRule(p, active);
			const c = counts.get(p.id) ?? { asked: 0, withheld: 0 };
			const pair = rule ?? `UNPAIRED: asks withheld (cosignals [${p.cosignals.join(", ")}] name no active rule)`;
			return `  cosign ${p.id.padEnd(10)} → ${pair}: ${c.asked} ask(s) delivered, ${c.withheld} withheld`;
		});
}

/** True when the packet file holds a packet at cosign (the PreToolUse path has something to decide). */
export function hasCosignPackets(cwd: string): boolean {
	return cosignPairingAt(cwd, null).size > 0;
}

/** Each cosign packet's paired rule (null: unpaired) under `rules`; with no rules, every pair is null. Empty
 *  when the file is absent or does not parse. */
export function cosignPairingAt(cwd: string, rules: GuardRulesConfig | null): Map<string, string | null> {
	const path = join(cwd, ".interlinked", PACKET_FILE_BASENAME);
	if (!existsSync(path)) return new Map();
	const parsed = parsePacketFile(readFileSync(path, "utf8"));
	return parsed.ok ? cosignPairing(parsed.value, rules ? activeRuleIds(rules) : new Set()) : new Map();
}

/** The one row an ask would be delivered for: the first eligible cosign judgment of a PAIRED packet (§5: a
 *  cosign packet tightens only the allow of a rule it names). */
export function pickAsk(rows: readonly PacketJudgmentRow[], pairs: ReadonlyMap<string, string | null>): PacketJudgmentRow | null {
	return rows.find((r) => r.eligible && r.status_effective === "cosign" && r.warning !== null && (pairs.get(r.packet) ?? null) !== null) ?? null;
}

/** The §3 decision table, PreToolUse side: a paired cosign packet may raise ALLOW to ASK; block and ask are
 *  untouched; no row, a failed row, a row below tau, or an unpaired packet changes nothing. Pure. */
export function decidePacketAsk(local: HarnessDecision, rows: readonly PacketJudgmentRow[], pairs: ReadonlyMap<string, string | null>): HarnessDecision {
	if (local.decision !== "allow") return local;
	const hit = pickAsk(rows, pairs);
	if (!hit) return local;
	return {
		...local,
		decision: "ask",
		reason: `[interlinked:packet] ${hit.packet} asks for confirmation (cosign on rule ${pairs.get(hit.packet)}, ${hit.settled === "violated" ? "matched the violated pattern" : `p=${(hit.p ?? 0).toFixed(2)}`}):\n${hit.warning}`,
		rule_id: `packet:${hit.packet}`,
		severity: "low",
		category: "packet",
	};
}
