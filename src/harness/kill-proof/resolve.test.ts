// ===========================================
// Kill proof — re-locating a manifest mutant after the symbol's body changed
// ===========================================
// Pins the C24 drift defect (docs/reviews/kill-proof-manifest-route.md §3): an
// identical lexeme inserted EARLIER in the same symbol took ordinal 0 — and the
// mutant id with it — so `--mutant` resolved to the new dead-code site and wrote
// a SURVIVED receipt under an id that was killed one run earlier. The manifest
// is built the honest way (identity.ts + applyMeasuredRun + saveManifest) from
// one engine-shaped raw mutant, so the ids and hashes are the real ones.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSymbolHashes, deriveIdentities } from "../mutation/identity.js";
import { applyMeasuredRun, emptyManifest, loadManifest, saveManifest } from "../mutation/manifest.js";
import type { MutantRecord, RawMutant, SymbolRecord } from "../mutation/types.js";
import { measuredSites, relocate, resolveMutant } from "./resolve.js";

const FILE = "src/bounds.ts";
const LEXEME = "ms < firstMs";
const REAL_IF = "\tif (!Number.isFinite(firstMs) || ms < firstMs) row.first = ts;\n";
const SOURCE = [
	"export function updateSeenBounds(row: { first: string }, ts: string): void {",
	"\tconst ms = new Date(ts).getTime();",
	"\tconst firstMs = new Date(row.first).getTime();",
	REAL_IF.trimEnd(),
	"}",
	"",
].join("\n");
/** The C24 probe: an identical lexeme inserted BEFORE the real `if`, in the same symbol. */
const PROBE = "\tconst probeEarlier = ms < firstMs;\n\tvoid probeEarlier;\n";
const DRIFTED = SOURCE.replace(REAL_IF, PROBE + REAL_IF);
const RAW: RawMutant = { file: FILE, mutator: "EqualityOperator", originalLexeme: LEXEME, replacement: "ms <= firstMs", startOffset: SOURCE.indexOf(LEXEME) };

let root: string;
let mutantId: string;

function requireTs<T>(value: T | null): T {
	if (value === null) throw new Error("typescript is required for this suite");
	return value;
}

function write(content: string): void {
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, FILE), content);
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-resolve-")));
	write(SOURCE);
	const identities = requireTs(deriveIdentities(FILE, SOURCE, [RAW]));
	const identity = identities[0];
	if (identity === undefined) throw new Error("no identity derived");
	mutantId = identity.mutantId;
	const manifest = applyMeasuredRun({
		base: emptyManifest({ engine: "stryker", engineVersion: "9", dependencyGraphVersion: "0", environmentHash: "t", authoritativeAt: "2026-11-05T00:00:00.000Z" }),
		file: FILE,
		overlayHashes: requireTs(computeSymbolHashes(FILE, SOURCE)),
		measured: [{ identity, status: "killed" }],
		at: "2026-11-05T00:00:00.000Z",
		cwd: root,
	});
	saveManifest(join(root, ".interlinked"), manifest);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const spec = () => ({ kind: "manifest", mutantId } as const);
const symbolHashOf = (content: string): string => {
	const entry = [...requireTs(computeSymbolHashes(FILE, content)).values()].find((e) => e.qualifiedName === "updateSeenBounds");
	if (entry === undefined) throw new Error("updateSeenBounds not hashed");
	return entry.symbolHash;
};

describe("resolveMutant — manifest re-location after a body edit — positive (must fire)", () => {
	it("P1: the C24 scenario (identical lexeme inserted earlier in the symbol) is refused as ambiguous, never ranked", () => {
		write(DRIFTED);
		expect(resolveMutant(root, spec())).toEqual({
			ok: false,
			reason: "ambiguous re-location: ms < firstMs now occurs 2 times in updateSeenBounds (was 1); re-measure the file",
		});
	});

	it("P2: a receipt's manifest mutant re-located through `relocate` is refused the same way", () => {
		const before = resolveMutant(root, spec());
		if (!before.ok) throw new Error(before.reason);
		write(DRIFTED);
		const after = relocate(root, before.mutant);
		expect(!after.ok && after.reason).toMatch(/^ambiguous re-location: ms < firstMs now occurs 2 times in updateSeenBounds \(was 1\)/);
	});

	it("P3: a symbol that no longer exists is named, not counted as candidate tokens", () => {
		write(SOURCE.replace("updateSeenBounds", "updateBounds"));
		expect(resolveMutant(root, spec())).toEqual({ ok: false, reason: `source drift: symbol updateSeenBounds not found (mutant ${mutantId})` });
	});

	it("P4: measuredSites reads the group's population off the manifest's own ordinals", () => {
		const record = (ordinal: number, lexeme = LEXEME, mutator = "EqualityOperator"): MutantRecord => ({
			mutantId: `m${ordinal}${lexeme}`,
			siteId: `s${ordinal}`,
			mutator,
			originalLexeme: lexeme,
			replacement: "x",
			ordinalWithinSymbol: ordinal,
			status: "survived",
			firstSeen: "",
		});
		const symbol: SymbolRecord = {
			symbolId: "sym",
			qualifiedName: "updateSeenBounds",
			symbolHash: "h",
			mutants: { a: record(0), b: record(2), c: record(5, "ms > lastMs"), d: record(7, LEXEME, "ConditionalExpression") },
			instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
		};
		// Same mutator + lexeme: ordinals 0 and 2 ⇒ 3 sites; the other lexeme and the other mutator do not count.
		expect(measuredSites(symbol, record(0))).toBe(3);
		expect(measuredSites(symbol, record(5, "ms > lastMs"))).toBe(6);
		// The record's own ordinal is part of the population even when it is the only record of its group.
		expect(measuredSites(symbol, record(7, LEXEME, "ConditionalExpression"))).toBe(8);
	});
});

describe("resolveMutant — manifest re-location after a body edit — negative (must not fire)", () => {
	it("N1: the unchanged file re-locates to the real `if` (symbol hash unchanged)", () => {
		const resolved = resolveMutant(root, spec());
		expect(resolved.ok && [resolved.mutant.offset, resolved.mutant.line, resolved.mutant.ordinalWithinSymbol]).toEqual([SOURCE.indexOf(LEXEME), 4, 0]);
	});

	it("N2: a comment inserted above the symbol leaves the hash unchanged and still re-locates", () => {
		const commented = `// bounds are kept per row\n${SOURCE}`;
		expect(symbolHashOf(commented)).toBe(symbolHashOf(SOURCE));
		write(commented);
		const resolved = resolveMutant(root, spec());
		expect(resolved.ok && [resolved.mutant.offset, resolved.mutant.line]).toEqual([commented.indexOf(LEXEME), 5]);
	});

	it("N3: an unrelated statement inside the body (hash changes, count unchanged) keeps today's ordinal re-location", () => {
		const edited = SOURCE.replace(REAL_IF, `\tconst lastMs = new Date(ts).getTime();\n\tvoid lastMs;\n${REAL_IF}`);
		expect(symbolHashOf(edited)).not.toBe(symbolHashOf(SOURCE));
		write(edited);
		const resolved = resolveMutant(root, spec());
		expect(resolved.ok && [resolved.mutant.offset, resolved.mutant.line, resolved.mutant.mutantId]).toEqual([edited.indexOf(LEXEME), 6, mutantId]);
	});

	it("N4: a lexeme-count change with the SAME symbol hash is impossible — the hash covers every token of the body", () => {
		const countChanging = [
			DRIFTED,
			SOURCE.replace(REAL_IF, `${REAL_IF}\tvoid (ms < firstMs);\n`),
			SOURCE.replace(REAL_IF, "\trow.first = ts;\n"),
			SOURCE.replace(REAL_IF, `${REAL_IF.replace("row.first = ts", "row.first = ts, void (ms < firstMs), void (ms < firstMs)")}`),
		];
		const base = symbolHashOf(SOURCE);
		for (const variant of countChanging) {
			expect(variant.split(LEXEME).length - 1).not.toBe(SOURCE.split(LEXEME).length - 1);
			expect(symbolHashOf(variant)).not.toBe(base);
		}
	});

	it("N5: the lexeme removed from the symbol is drift (no site), not ambiguity", () => {
		write(SOURCE.replace(REAL_IF, "\trow.first = ts;\n"));
		const resolved = resolveMutant(root, spec());
		expect(!resolved.ok && resolved.reason).toBe(`source drift: no site among 0 candidate token(s) (mutant ${mutantId} in updateSeenBounds)`);
	});

	it("N6: the manifest on disk records a symbolHash and an ordinal, not a site count — the count is derived", () => {
		const manifest = loadManifest(join(root, ".interlinked"));
		const symbol = Object.values(manifest?.files[FILE] ?? {}).find((s) => s.qualifiedName === "updateSeenBounds");
		if (symbol === undefined) throw new Error("symbol missing from the manifest");
		expect(symbol.symbolHash).toBe(symbolHashOf(SOURCE));
		const record = symbol.mutants[mutantId];
		expect(record?.ordinalWithinSymbol).toBe(0);
		expect(record !== undefined && "measuredSites" in record).toBe(false);
		expect(record !== undefined && measuredSites(symbol, record)).toBe(1);
	});
});
