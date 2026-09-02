// Unit coverage for the ledger trailer line(s) a per-function metric gate's
// block message appends in ledger mode: the always-present burn-down note
// plus a drift note when the ledger's generation cap no longer matches the
// currently effective cap (see function-complexity-baseline.ts::ledgerDriftNote
// for why that drift can happen without any `caps ratchet` run).

import { describe, expect, it } from "vitest";
import type { FileGrandfather } from "../function-complexity-baseline.js";
import { ledgerBlockLines } from "./metric-gate-ledger-line.js";

function gf(cap: number): FileGrandfather {
	return { byName: new Map(), pooled: [], total: 3, cap };
}

describe("ledgerBlockLines — positive (must fire)", () => {
	it("P1: includes a drift note pointing at the ratchet verb when the ledger cap differs from the effective cap", () => {
		const out = ledgerBlockLines("cyclomatic", gf(8), 6);
		expect(out).toContain("Ledger cap (8) differs from the effective cyclomatic cap (6)");
		expect(out).toContain("interlinked caps ratchet cyclomatic --to 6");
	});

	it("P2: always includes the ledger burn-down note when a ledger applies", () => {
		const out = ledgerBlockLines("cyclomatic", gf(8), 8);
		expect(out).toContain("lists 3 cyclomatic function(s)");
	});
});

describe("ledgerBlockLines — negative (must not fire)", () => {
	it("N1: no drift note when the ledger cap equals the effective cap", () => {
		const out = ledgerBlockLines("cyclomatic", gf(8), 8);
		expect(out).not.toContain("caps ratchet cyclomatic --to");
	});

	it("N2: empty string when no ledger applies (legacy delta mode)", () => {
		expect(ledgerBlockLines("cyclomatic", null, 6)).toBe("");
	});
});
