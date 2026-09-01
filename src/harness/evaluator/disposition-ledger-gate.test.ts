import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadLedger,
	saveLedger,
	upsertRecord,
} from "../mutation/disposition-store.js";
import type { HarnessEvent } from "../types.js";
import { evaluateBaselineIntegrityForEvent } from "./baseline-integrity-gate.js";
import { detectDispositionLedger, isDispositionLedgerPath } from "./disposition-ledger-gate.js";

const LEDGER = "/repo/.interlinked/mutation-dispositions.json";

interface RawRecord {
	file: string;
	symbolId: string;
	mutantId: string;
	symbolHash: string;
	qualifiedName?: string;
	mutator?: string;
	disposition: unknown;
	complexity_delta?: number | null;
	recordedAt?: string;
	recordedBy?: string;
}

function rawRecord(over: Partial<RawRecord> = {}): RawRecord {
	return {
		file: "src/a.ts",
		symbolId: "s1",
		mutantId: "m1",
		symbolHash: "h",
		qualifiedName: "fn",
		mutator: "BooleanLiteral",
		disposition: { kind: "dead_code", resolution: "delete" },
		complexity_delta: null,
		recordedAt: "2026-08-15T00:00:00.000Z",
		recordedBy: "cli:mutation disposition",
		...over,
	};
}

const EVIDENCE = { strategy: "fuzz", runs: 10, seed: "s", budgetMs: 100, searchedAt: "2026-08-15T00:00:00.000Z" };

function ledgerText(records: RawRecord[]): string {
	return JSON.stringify({ version: 1, note: "", environmentHash: "", dependencyGraphVersion: "", records });
}

// ===========================================================================
describe("isDispositionLedgerPath", () => {
	it("P1: matches the committed ledger, absolute or root-relative", () => {
		expect(isDispositionLedgerPath(LEDGER)).toBe(true);
		expect(isDispositionLedgerPath(".interlinked/mutation-dispositions.json")).toBe(true);
	});
	it("N1: does not match other .interlinked files or a suffixed copy", () => {
		expect(isDispositionLedgerPath("/repo/.interlinked/mutation-manifest.json")).toBe(false);
		expect(isDispositionLedgerPath("/repo/.interlinked/mutation-dispositions.json.bak")).toBe(false);
	});
});

describe("detectDispositionLedger — monotonic in FEWER / WEAKER records", () => {
	it("P1: a hand-ADDED record is blocked", () => {
		const before = ledgerText([]);
		const after = ledgerText([rawRecord()]);
		const findings = detectDispositionLedger(LEDGER, before, after);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.rule).toMatch(/disposition-added/);
	});

	it("P2: a RAISED suppression level (unresolved → dead_code) on an existing record is blocked", () => {
		const before = ledgerText([rawRecord({ disposition: { kind: "unresolved", evidence: EVIDENCE } })]);
		const after = ledgerText([rawRecord({ disposition: { kind: "dead_code", resolution: "delete" } })]);
		const findings = detectDispositionLedger(LEDGER, before, after);
		expect(findings.some((f) => f.rule.startsWith("disposition-raised"))).toBe(true);
	});

	it("P3: a REWRITTEN symbolHash on an existing record is blocked (a stale-record rebind)", () => {
		const before = ledgerText([rawRecord({ symbolHash: "h" })]);
		const after = ledgerText([rawRecord({ symbolHash: "h2" })]);
		const findings = detectDispositionLedger(LEDGER, before, after);
		expect(findings.some((f) => f.rule.startsWith("disposition-rebind"))).toBe(true);
	});

	it("P4: an inserted certificate/approval sub-object is blocked (manufactured evidence)", () => {
		const before = ledgerText([rawRecord()]);
		const after = ledgerText([
			rawRecord({ disposition: { kind: "dead_code", resolution: "delete", certificate: { producedBy: "forged" } } }),
		]);
		const findings = detectDispositionLedger(LEDGER, before, after);
		expect(findings.some((f) => f.rule.startsWith("disposition-credential"))).toBe(true);
	});

	it("N1: a REMOVED record is allowed (re-opens work)", () => {
		const before = ledgerText([rawRecord()]);
		const after = ledgerText([]);
		expect(detectDispositionLedger(LEDGER, before, after)).toEqual([]);
	});

	it("N2: a LOWERED suppression level (dead_code → unresolved) is allowed (weakening is safe)", () => {
		const before = ledgerText([rawRecord({ disposition: { kind: "dead_code", resolution: "delete" } })]);
		const after = ledgerText([rawRecord({ disposition: { kind: "unresolved", evidence: EVIDENCE } })]);
		expect(detectDispositionLedger(LEDGER, before, after)).toEqual([]);
	});

	it("N3: a whitespace / key-order reformat with the same records is allowed", () => {
		const before = ledgerText([rawRecord()]);
		// Same record, keys reordered + re-indented.
		const after = JSON.stringify(
			{
				records: [
					{
						disposition: { resolution: "delete", kind: "dead_code" },
						mutantId: "m1",
						symbolHash: "h",
						symbolId: "s1",
						file: "src/a.ts",
						mutator: "BooleanLiteral",
						qualifiedName: "fn",
						complexity_delta: null,
						recordedAt: "2026-08-15T00:00:00.000Z",
						recordedBy: "cli:mutation disposition",
					},
				],
				dependencyGraphVersion: "",
				environmentHash: "",
				note: "",
				version: 1,
			},
			null,
			2,
		);
		expect(detectDispositionLedger(LEDGER, before, after)).toEqual([]);
	});

	it("N4: a non-ledger path is ignored", () => {
		const before = ledgerText([]);
		const after = ledgerText([rawRecord()]);
		expect(detectDispositionLedger("/repo/.interlinked/coverage-baseline.json", before, after)).toEqual([]);
		expect(detectDispositionLedger("/repo/src/foo.ts", "a", "b")).toEqual([]);
	});

	it("N5: creating the ledger (empty before) is not loosening", () => {
		expect(detectDispositionLedger(LEDGER, "", ledgerText([rawRecord()]))).toEqual([]);
	});

	it("N6: fails open on unparseable JSON", () => {
		expect(detectDispositionLedger(LEDGER, "{not json", ledgerText([rawRecord()]))).toEqual([]);
	});
});

// ===========================================================================
// Integration through the existing baseline_integrity_gate rule.
// ===========================================================================
describe("evaluateBaselineIntegrityForEvent — the disposition ledger rides the existing rule", () => {
	function writeEvent(_before: string, after: string): HarnessEvent {
		return {
			tool_name: "Write",
			tool_input: { file_path: LEDGER, content: after },
			cwd: "/repo",
		} as unknown as HarnessEvent;
	}
	const getDisk = (text: string) => ({ getDisk: () => text });

	it("P1: a hand-added record via the Write tool is BLOCKED under rule baseline_integrity_gate", () => {
		const before = ledgerText([]);
		const after = ledgerText([rawRecord()]);
		const decision = evaluateBaselineIntegrityForEvent(writeEvent(before, after), getDisk(before));
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("baseline_integrity_gate");
	});

	it("N1: removing a record via the Write tool is ALLOWED (null)", () => {
		const before = ledgerText([rawRecord()]);
		const after = ledgerText([]);
		expect(evaluateBaselineIntegrityForEvent(writeEvent(before, after), getDisk(before))).toBeNull();
	});

	it("N2: the disable-bypass env var lets an intentional reset through", () => {
		const before = ledgerText([]);
		const after = ledgerText([rawRecord()]);
		process.env.INTERLINKED_DISABLE_BASELINE_GUARD = "1";
		try {
			expect(evaluateBaselineIntegrityForEvent(writeEvent(before, after), getDisk(before))).toBeNull();
		} finally {
			delete process.env.INTERLINKED_DISABLE_BASELINE_GUARD;
		}
	});
});

describe("the harness's own internal write is never gated", () => {
	let configDir: string;
	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "disposition-gate-"));
		mkdirSync(configDir, { recursive: true });
	});
	afterEach(() => rmSync(configDir, { recursive: true, force: true }));

	it("N1: upsertRecord + saveLedger (internal fs, never a tool event) lands the record ungated, while the SAME add by hand would block", () => {
		// The store writes through fs — it never constructs a Write/Edit tool event,
		// so evaluateBaselineIntegrityForEvent never sees it. The record just lands.
		const emptyText = ledgerText([]);
		const record = {
			file: "src/a.ts",
			symbolId: "s1",
			mutantId: "m1",
			symbolHash: "h",
			qualifiedName: "fn",
			mutator: "BooleanLiteral",
			disposition: { kind: "dead_code" as const, resolution: "delete" as const },
			complexity_delta: null,
			recordedAt: "2026-08-15T00:00:00.000Z",
			recordedBy: "cli:mutation disposition",
		};
		const next = upsertRecord({ ledger: loadLedger(configDir), record });
		expect(next).not.toBeNull();
		if (next) saveLedger(configDir, next);
		expect(loadLedger(configDir).records).toHaveLength(1);

		// The identical add, done by HAND through the ledger file, is caught. The only
		// difference is the write mechanism — which is exactly the exemption's boundary.
		const after = ledgerText([rawRecord()]);
		expect(detectDispositionLedger(LEDGER, emptyText, after).length).toBeGreaterThan(0);
	});
});
