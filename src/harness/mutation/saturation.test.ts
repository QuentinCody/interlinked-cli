// Saturation status per file: covered, and every recorded mutant killed or proved
// equivalent, against CURRENT symbol hashes. The manifest rows are built from the
// real symbol hasher (`computeSymbolHashes`), never hand-typed ids.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSymbolHashes } from "./identity.js";
import { emptyManifest } from "./manifest.js";
import {
	detectSaturationBaselineLoosening,
	fileSaturation,
	loadSaturationBaseline,
	ratchetSaturationBaseline,
	saturationCensus,
	saturationRegressions,
	saveSaturationBaseline,
} from "./saturation.js";
import type { MutantStatus, MutationManifest, SymbolRecord } from "./types.js";

const FILE = "src/clamp.ts";
const SOURCE = "export function clamp(n: number, max: number): number {\n\tif (n > max) return max;\n\treturn n;\n}\n";

function symbols(content: string, statuses: MutantStatus[], dispositionKind?: string, file = FILE): Record<string, SymbolRecord> {
	const hashes = computeSymbolHashes(file, content);
	if (hashes === null) throw new Error("typescript unavailable");
	const out: Record<string, SymbolRecord> = {};
	for (const [symbolId, entry] of hashes) {
		if (entry.qualifiedName !== "clamp") continue;
		const mutants: SymbolRecord["mutants"] = {};
		statuses.forEach((status, i) => {
			const mutantId = `m${i}`.padEnd(16, "0");
			mutants[mutantId] = {
				mutantId, siteId: `s${i}`.padEnd(16, "0"), mutator: "EqualityOperator", originalLexeme: ">", replacement: ">=", ordinalWithinSymbol: i, status, firstSeen: "2026-11-06T00:00:00Z",
				...(dispositionKind !== undefined && status === "survived" ? { disposition: { kind: dispositionKind } } : {}),
			};
		});
		out[symbolId] = { symbolId, qualifiedName: entry.qualifiedName, symbolHash: entry.symbolHash, mutants, instability: { events: [], consecutiveStableRuns: 1, quarantined: false } };
	}
	return out;
}

function manifestWith(files: Record<string, Record<string, SymbolRecord>>): MutationManifest {
	const base = emptyManifest({ engine: "stryker", engineVersion: "9", dependencyGraphVersion: "0", environmentHash: "t", authoritativeAt: "2026-11-06T00:00:00Z" });
	return { ...base, files };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "saturation-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("fileSaturation — positive (must report saturated)", () => {
	it("P1: every mutant killed or timed out on current symbols is saturated", () => {
		const row = fileSaturation(FILE, symbols(SOURCE, ["killed", "timeout"]), SOURCE);
		expect(row.status).toBe("saturated");
		expect(row.counts).toMatchObject({ killed: 2, survived: 0, uncovered: 0 });
	});

	it("P2: a proved-equivalent mutant does not break saturation", () => {
		expect(fileSaturation(FILE, symbols(SOURCE, ["killed", "equivalent"]), SOURCE).status).toBe("saturated");
	});

	it("P3: a survivor with a proved_equivalent disposition counts as equivalent", () => {
		const row = fileSaturation(FILE, symbols(SOURCE, ["killed", "survived"], "proved_equivalent"), SOURCE);
		expect(row.status).toBe("saturated");
		expect(row.counts).toMatchObject({ equivalent: 1, survived: 0, accepted: 0 });
	});
});

describe("fileSaturation — negative (must not report saturated)", () => {
	it("N1: a survivor makes the file open", () => {
		const row = fileSaturation(FILE, symbols(SOURCE, ["killed", "survived"]), SOURCE);
		expect(row.status).toBe("open");
		expect(row.counts.survived).toBe(1);
	});

	it("N2: an uncovered mutant makes the file open", () => {
		expect(fileSaturation(FILE, symbols(SOURCE, ["killed", "uncovered"]), SOURCE).status).toBe("open");
	});

	it("N3: an accepted-risk survivor is counted as accepted and still open — a change there fails no test", () => {
		const row = fileSaturation(FILE, symbols(SOURCE, ["killed", "survived"], "accepted_risk"), SOURCE);
		expect(row.status).toBe("open");
		expect(row.counts.accepted).toBe(1);
	});

	it("N4: a symbol whose current hash differs from the manifest is stale, so the file is unknown", () => {
		const edited = SOURCE.replace("n > max", "n >= max");
		const row = fileSaturation(FILE, symbols(SOURCE, ["killed"]), edited);
		expect(row.status).toBe("unknown");
		expect(row.staleSymbols).toBe(1);
	});

	it("N4b: a survivor recorded on a stale symbol is not current evidence: unknown, not open, and not counted", () => {
		const edited = SOURCE.replace("n > max", "n >= max");
		const row = fileSaturation(FILE, symbols(SOURCE, ["survived"]), edited);
		expect(row.status).toBe("unknown");
		expect(row.counts.survived).toBe(0);
	});

	it("N5: a function with no measured mutants is unmeasured code, so the file is unknown", () => {
		const grown = `${SOURCE}export function twice(n: number): number {\n\treturn n * 2;\n}\n`;
		const row = fileSaturation(FILE, symbols(SOURCE, ["killed"]), grown);
		expect(row.status).toBe("unknown");
		expect(row.unmeasuredSymbols).toBe(1);
	});

	it("N6: an indeterminate run is unknown, never saturated", () => {
		expect(fileSaturation(FILE, symbols(SOURCE, ["killed", "indeterminate"]), SOURCE).status).toBe("unknown");
	});

	it("N7: a missing file is gone; a file with no mutants is unmeasured", () => {
		expect(fileSaturation(FILE, symbols(SOURCE, ["killed"]), null).status).toBe("gone");
		expect(fileSaturation(FILE, symbols(SOURCE, []), SOURCE).status).toBe("unmeasured");
	});
});

describe("saturationCensus", () => {
	it("reads each manifest file from the root and totals the statuses", () => {
		writeFileSync(join(dir, "clamp.ts"), SOURCE);
		const manifest = manifestWith({ "clamp.ts": symbols(SOURCE, ["killed"], undefined, "clamp.ts"), "gone.ts": symbols(SOURCE, ["killed"], undefined, "gone.ts") });
		const census = saturationCensus(dir, manifest);
		expect(census.totals).toMatchObject({ saturated: 1, gone: 1, files: 2 });
		expect(census.rows.map(row => row.file)).toEqual(["clamp.ts", "gone.ts"]);
	});
});

describe("saturation baseline ratchet", () => {
	const row = (file: string, status: "saturated" | "open" | "gone") => ({ file, status, counts: { killed: 0, equivalent: 0, survived: 0, uncovered: 0, accepted: 0, indeterminate: 0 }, staleSymbols: 0, unmeasuredSymbols: 0 });

	it("only grows: a file saturated once stays listed after it opens", () => {
		const first = ratchetSaturationBaseline({ version: 1, saturated: [] }, [row("a.ts", "saturated"), row("b.ts", "open")]);
		expect(first.saturated).toEqual(["a.ts"]);
		const second = ratchetSaturationBaseline(first, [row("a.ts", "open"), row("b.ts", "saturated")]);
		expect(second.saturated).toEqual(["a.ts", "b.ts"]);
	});

	it("a listed file that is no longer saturated is a regression; a gone file is not", () => {
		const baseline = { version: 1 as const, saturated: ["a.ts", "b.ts", "c.ts"] };
		expect(saturationRegressions(baseline, [row("a.ts", "open"), row("b.ts", "gone"), row("c.ts", "saturated")]).map(r => r.file)).toEqual(["a.ts"]);
	});

	it("round-trips through disk; a missing or corrupt file reads as empty", () => {
		expect(loadSaturationBaseline(dir).saturated).toEqual([]);
		saveSaturationBaseline(dir, { version: 1, saturated: ["z.ts", "a.ts"] });
		expect(loadSaturationBaseline(dir).saturated).toEqual(["a.ts", "z.ts"]);
		writeFileSync(join(dir, "saturation-baseline.json"), "{nope");
		expect(loadSaturationBaseline(dir).saturated).toEqual([]);
	});
});

describe("detectSaturationBaselineLoosening", () => {
	const path = ".interlinked/saturation-baseline.json";

	it("P: removing a saturated file from the list is a finding", () => {
		const found = detectSaturationBaselineLoosening(path, { version: 1, saturated: ["a.ts", "b.ts"] }, { version: 1, saturated: ["a.ts"] });
		expect(found).toHaveLength(1);
		expect(found[0]?.rule).toBe("saturated:b.ts");
	});

	it("N: adding a file, or reordering, is not", () => {
		expect(detectSaturationBaselineLoosening(path, { version: 1, saturated: ["b.ts"] }, { version: 1, saturated: ["a.ts", "b.ts"] })).toEqual([]);
	});
});
