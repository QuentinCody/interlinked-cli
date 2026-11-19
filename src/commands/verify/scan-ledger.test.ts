import { describe, expect, it } from "vitest";
import {
	createScanLedger,
	fileBudgetMs,
	pairBudgetMs,
	summarizeNotMeasured,
	summarizeSetAside,
	type NotMeasuredRow,
	type SetAsideRow,
} from "./scan-ledger.js";

const row = (file: string, role: string, kind: string, bytes: number | null): SetAsideRow => ({ file, role, evidence_kind: kind, evidence_detail: "d", bytes });

describe("summarizeSetAside — positive", () => {
	it("P1: counts files by role and by evidence kind", () => {
		const out = summarizeSetAside([row("a.js", "generated", "shape", 10), row("b.js", "vendor", "path", 5), row("c.js", "generated", "shape", 7)]);
		expect(out.files).toBe(3);
		expect(out.by_role).toEqual({ generated: 2, vendor: 1 });
		expect(out.by_evidence).toEqual({ shape: 2, path: 1 });
	});
	it("P2: lists the largest files first and counts the omitted rest", () => {
		const rows = [row("s.js", "generated", "shape", 1), row("l.js", "generated", "shape", 99), row("m.js", "generated", "shape", 50)];
		const out = summarizeSetAside(rows, 2);
		expect(out.listed.map((r) => r.file)).toEqual(["l.js", "m.js"]);
		expect(out.omitted).toBe(1);
	});
});

describe("summarizeSetAside — negative", () => {
	it("N1: an empty ledger yields zero counts and no rows", () => {
		expect(summarizeSetAside([])).toEqual({ files: 0, by_role: {}, by_evidence: {}, listed: [], omitted: 0 });
	});
});

describe("summarizeNotMeasured", () => {
	const rows: NotMeasuredRow[] = [
		{ check: "x", file: "a.js", reason: "r", elapsed_ms: 20 },
		{ check: "x", file: "b.js", reason: "r", elapsed_ms: 30 },
		{ check: "y", file: "a.js", reason: "r", elapsed_ms: 10 },
	];
	it("P3: counts pairs and groups by check", () => {
		const out = summarizeNotMeasured(rows);
		expect(out.pairs).toBe(3);
		expect(out.by_check).toEqual({ x: 2, y: 1 });
	});
	it("N2: an empty list reports zero pairs", () => {
		expect(summarizeNotMeasured([]).pairs).toBe(0);
	});
	it("P4: the cap keeps the slowest rows and counts the omitted", () => {
		const out = summarizeNotMeasured(rows, 1);
		expect(out.rows).toEqual([{ check: "x", file: "b.js", reason: "r", elapsed_ms: 30 }]);
		expect(out.omitted).toBe(2);
	});
});

describe("budgets", () => {
	it("P5: defaults apply when the variable is absent", () => {
		expect(pairBudgetMs({})).toBe(15_000);
		expect(fileBudgetMs({})).toBe(60_000);
	});
	it("P6: a positive integer in the environment overrides", () => {
		expect(pairBudgetMs({ INTERLINKED_VERIFY_PAIR_BUDGET_MS: "250" })).toBe(250);
	});
	it("N3: a malformed value falls back to the default", () => {
		expect(pairBudgetMs({ INTERLINKED_VERIFY_PAIR_BUDGET_MS: "abc" })).toBe(15_000);
	});
});

describe("createScanLedger", () => {
	it("P7: starts empty and not partial", () => {
		const ledger = createScanLedger();
		expect(ledger.setAside).toEqual([]);
		expect(ledger.notMeasured).toEqual([]);
		expect(ledger.partial).toBeNull();
		expect(ledger.measuredFiles).toBe(0);
	});
});
