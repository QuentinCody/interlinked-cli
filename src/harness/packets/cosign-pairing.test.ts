import { describe, expect, it } from "vitest";
import type { GuardRulesConfig } from "../types.js";
import { activeRuleIds, cosignLedgerCounts, cosignPairing, cosignStatusLines, pairedRule } from "./cosign-pairing.js";
import type { PacketJudgmentRow } from "./evaluator.js";
import { sampleFile, warnPacket } from "./fixtures.js";

const cosign = (id: string, cosignals: string[]) => warnPacket({ id, cosignals, calibration: { ...warnPacket().calibration, status: "cosign" } });
const row = (packet: string, cosign_rule: string | null | undefined, eligible: boolean, shown: boolean) => ({ packet, cosign_rule, eligible, shown }) as unknown as PacketJudgmentRow;

describe("pairedRule — the §5 pairing", () => {
	it("P1: the first cosignal that names an active rule is the pair", () => {
		expect(pairedRule(cosign("a", ["gone", "builtin-large-log-read", "other"]), new Set(["other", "builtin-large-log-read"]))).toBe("builtin-large-log-read");
	});
	it("N1: no cosignals, or none active, is unpaired", () => {
		expect(pairedRule(cosign("a", []), new Set(["x"]))).toBeNull();
		expect(pairedRule(cosign("a", ["disabled-rule"]), new Set(["x"]))).toBeNull();
	});
});

describe("activeRuleIds", () => {
	it("P2: the ids of the merged rule set", () => {
		expect([...activeRuleIds({ rules: [{ id: "r1" }, { id: "r2" }] } as unknown as GuardRulesConfig)]).toEqual(["r1", "r2"]);
	});
	it("N2: a config without a rule list is the empty set", () => {
		expect(activeRuleIds({} as GuardRulesConfig).size).toBe(0);
	});
});

describe("cosignPairing", () => {
	it("P3: maps every cosign packet to its pair or null; packets below cosign are absent", () => {
		const file = sampleFile([cosign("paired", ["r1"]), cosign("unpaired", ["r9"]), warnPacket({ id: "warn-only", cosignals: ["r1"] })]);
		expect([...cosignPairing(file, new Set(["r1"]))]).toEqual([
			["paired", "r1"],
			["unpaired", null],
		]);
	});
});

describe("cosignLedgerCounts — the monitor", () => {
	it("P4: a shown paired row is an ask; an eligible unpaired row is withheld; other rows do not count", () => {
		const counts = cosignLedgerCounts([row("a", "r1", true, true), row("a", "r1", true, false), row("a", null, true, false), row("a", null, false, false), row("a", undefined, true, true), row("b", null, true, false)]);
		expect(counts.get("a")).toEqual({ asked: 1, withheld: 1 });
		expect(counts.get("b")).toEqual({ asked: 0, withheld: 1 });
	});
});

describe("cosignStatusLines", () => {
	it("P5: names the pair and the counts, and says why an unpaired packet never asks", () => {
		const file = sampleFile([cosign("paired", ["r1"]), cosign("unpaired", ["r9"])]);
		const lines = cosignStatusLines(file, new Set(["r1"]), [row("paired", "r1", true, true), row("unpaired", null, true, false)]);
		expect(lines).toEqual([
			"  cosign paired     → r1: 1 ask(s) delivered, 0 withheld",
			"  cosign unpaired   → UNPAIRED: asks withheld (cosignals [r9] name no active rule): 0 ask(s) delivered, 1 withheld",
		]);
	});
	it("N3: no cosign packet prints nothing", () => {
		expect(cosignStatusLines(sampleFile([warnPacket()]), new Set(), [])).toEqual([]);
	});
});
