// Refactor-stable survivor reconciliation — the local move-awareness layer
// over the digest-pinned identity contract. identity.ts is frozen, so a
// survivor that moves into an extracted helper gets a NEW identity there; this
// layer maps it back to its prior record by content fingerprint so the gate
// does not charge the edit with a survivor it did not introduce.

import { describe, expect, it } from "vitest";
import { evaluateMutation } from "./evaluate.js";
import { computeSymbolHashes, deriveIdentities } from "./identity.js";
import { applyMeasuredRun, changedSymbols, emptyManifest, toMutantRecord } from "./manifest.js";
import type { AdaptedMutant } from "./stryker-adapter.js";
import {
	currentSites,
	locatePriorSurvivors,
	movedSurvivorIds,
	type PriorFloor,
	priorFloorOf,
	reconcileSurvivorMoves,
	type SurvivorMove,
} from "./survivor-moves.js";
import type {
	MutantIdentity,
	MutantRecord,
	MutantStatus,
	MutationGateOutcome,
	MutationManifest,
	RawMutant,
	StableId,
	SymbolRecord,
	TestRunResult,
} from "./types.js";
import { mutationOutcomeToDecision } from "./verdict.js";

const FILE = "src/example.ts";
const META = {
	engine: "stryker",
	engineVersion: "1",
	dependencyGraphVersion: "g",
	environmentHash: "e",
	authoritativeAt: "t0",
};

const BEFORE = [
	"export function f(a: number, b: number): string {",
	'\tif (a > b) return "gt";',
	'\treturn "le";',
	"}",
	"",
].join("\n");

/** The condition moved VERBATIM into an extracted helper (a pure move). */
const AFTER_MOVE = [
	"export function f(a: number, b: number): string {",
	"\treturn classify(a, b);",
	"}",
	"",
	"function classify(a: number, b: number): string {",
	'\tif (a > b) return "gt";',
	'\treturn "le";',
	"}",
	"",
].join("\n");

/** Moved AND the enclosing statement changed. */
const AFTER_MOVE_CHANGED = AFTER_MOVE.replace('return "gt"', 'return "greater"');

/** Moved AND the mutated expression itself changed (`>` became `>=`). */
const AFTER_MOVE_EXPR = AFTER_MOVE.replace("a > b", "a >= b");

/** `f` untouched, plus a genuinely new function carrying its own condition. */
const AFTER_NEW = `${BEFORE}\nexport function g(x: number): boolean {\n\treturn x < 0;\n}\n`;

/** `f` untouched, plus a COPY of its condition in a new helper. */
const AFTER_COPY = [
	BEFORE,
	"function classify(a: number, b: number): string {",
	'\tif (a > b) return "gt";',
	'\treturn "le";',
	"}",
	"",
].join("\n");

/** Two `>` sites in one symbol — the ordinal-basis fixtures. */
const TWO_GT = [
	"export function f(a: number, b: number): string {",
	'\tif (a > b) return "gt";',
	'\tif (a > 0) return "pos";',
	'\treturn "le";',
	"}",
	"",
].join("\n");

/** `f` and `g` carry the SAME statement — the regression-masking fixtures
 *  (verdict 2026-09-01: f's `>` survived, g's `>` killed). */
const TWO_FN = [
	"export function f(a: number, b: number): string {",
	'\tif (a > b) return "gt";',
	'\treturn "le";',
	"}",
	"",
	"export function g(a: number, b: number): string {",
	'\tif (a > b) return "gt";',
	'\treturn "le";',
	"}",
	"",
].join("\n");

/** f's condition deleted; g untouched. */
const TWO_FN_F_DELETED = [
	"export function f(a: number, b: number): string {",
	'\treturn "le";',
	"}",
	"",
	"export function g(a: number, b: number): string {",
	'\tif (a > b) return "gt";',
	'\treturn "le";',
	"}",
	"",
].join("\n");

/** f's condition deleted AND g edited elsewhere — g is a changed symbol whose
 *  `>` keeps its recorded (killed) identity. */
const TWO_FN_F_DELETED_G_CHANGED = [
	"export function f(a: number, b: number): string {",
	'\treturn "le";',
	"}",
	"",
	"export function g(a: number, b: number): string {",
	'\tif (a > b) return "gt";',
	'\treturn "lte";',
	"}",
	"",
].join("\n");

/** f's condition deleted AND g RENAMED to h, body byte-identical — g's killed
 *  `>` re-mints a NEW, never-recorded identity under `h` (verdict 2026-09-01,
 *  gap #2: a routine rename must not let the vanished survivor in f excuse
 *  what could be a killed→survived regression in h). */
const TWO_FN_F_DELETED_G_RENAMED = [
	"export function f(a: number, b: number): string {",
	'\treturn "le";',
	"}",
	"",
	"export function h(a: number, b: number): string {",
	'\tif (a > b) return "gt";',
	'\treturn "le";',
	"}",
	"",
].join("\n");

/** f's condition deleted AND g given a third, unused parameter — the arity
 *  change alone re-mints g's killed `>` under a NEW identity. */
const TWO_FN_F_DELETED_G_REARITY = [
	"export function f(a: number, b: number): string {",
	'\treturn "le";',
	"}",
	"",
	"export function g(a: number, b: number, c: number): string {",
	'\tif (a > b) return "gt";',
	'\treturn "le";',
	"}",
	"",
].join("\n");

/** f's condition MOVED verbatim into an extracted helper; g stays untouched,
 *  same name/arity/body — its recorded-killed `>` keeps its OWN id, still
 *  present in the current run (the non-ambiguous companion to the rename and
 *  arity fixtures above). */
const TWO_FN_F_MOVED = [
	"export function f(a: number, b: number): string {",
	"\treturn classify(a, b);",
	"}",
	"",
	"function classify(a: number, b: number): string {",
	'\tif (a > b) return "gt";',
	'\treturn "le";',
	"}",
	"",
	"export function g(a: number, b: number): string {",
	'\tif (a > b) return "gt";',
	'\treturn "le";',
	"}",
	"",
].join("\n");

interface Spec {
	needle: string;
	lexeme: string;
	replacement: string;
	mutator: string;
	/** Which occurrence of `needle` (0-based). */
	nth?: number;
}

const GT: Spec = { needle: "> b", lexeme: ">", replacement: ">=", mutator: "EqualityOperator" };
const GT0: Spec = { needle: "> 0", lexeme: ">", replacement: ">=", mutator: "EqualityOperator" };
const GTE: Spec = { needle: ">= b", lexeme: ">=", replacement: ">", mutator: "EqualityOperator" };
const LT: Spec = { needle: "< 0", lexeme: "<", replacement: "<=", mutator: "EqualityOperator" };
const GREEN: TestRunResult = { overlayGreen: true, redWitnessSatisfied: null };

/** Strict-safe positional access (noUncheckedIndexedAccess is on). */
function nth<T>(arr: readonly T[], i: number): T {
	const v = arr[i];
	if (v === undefined) throw new Error(`expected element ${i}`);
	return v;
}

function rawAt(content: string, spec: Spec): RawMutant {
	let idx = -1;
	for (let i = 0; i <= (spec.nth ?? 0); i++) idx = content.indexOf(spec.needle, idx + 1);
	if (idx < 0) throw new Error(`needle not found: ${spec.needle}`);
	return { file: FILE, mutator: spec.mutator, originalLexeme: spec.lexeme, replacement: spec.replacement, startOffset: idx };
}

function identitiesOf(content: string, raws: RawMutant[]): MutantIdentity[] {
	const ids = deriveIdentities(FILE, content, raws);
	if (ids === null) throw new Error("typescript unavailable");
	return ids;
}

function hashesOf(content: string): NonNullable<ReturnType<typeof computeSymbolHashes>> {
	const hashes = computeSymbolHashes(FILE, content);
	if (hashes === null) throw new Error("typescript unavailable");
	return hashes;
}

/** A manifest whose records for FILE are exactly `survivors` (survived) plus
 *  `killed` (killed) — identities ranked over BOTH, as the engine would. */
function manifestOf(content: string, survivors: RawMutant[], killed: RawMutant[] = []): MutationManifest {
	const records: Record<StableId, SymbolRecord> = {};
	for (const [symbolId, entry] of hashesOf(content)) {
		records[symbolId] = {
			symbolId,
			qualifiedName: entry.qualifiedName,
			symbolHash: entry.symbolHash,
			mutants: {},
			instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
		};
	}
	identitiesOf(content, [...survivors, ...killed]).forEach((id, i) => {
		const symbol = records[id.symbolId];
		if (symbol === undefined) throw new Error("symbol missing");
		symbol.mutants[id.mutantId] = toMutantRecord(id, i < survivors.length ? "survived" : "killed", "t0");
	});
	return { ...emptyManifest(META), files: { [FILE]: records } };
}

/** The default floor: BEFORE with f's `>` recorded as a survivor. */
function baseOf(): MutationManifest {
	return manifestOf(BEFORE, [rawAt(BEFORE, GT)]);
}

/** A copy of `manifest` with every FILE survivor flipped to a reviewed equivalent. */
function reviewed(manifest: MutationManifest): MutationManifest {
	const copy: MutationManifest = JSON.parse(JSON.stringify(manifest));
	for (const symbol of Object.values(copy.files[FILE] ?? {})) {
		for (const m of Object.values(symbol.mutants)) {
			if (m.status === "survived") Object.assign(m, { status: "equivalent", accepted_reason: "patched + suite green" });
		}
	}
	return copy;
}

/** The record for `mutantId` anywhere under FILE, or throw. */
function recordOf(manifest: MutationManifest, mutantId: StableId): MutantRecord {
	for (const symbol of Object.values(manifest.files[FILE] ?? {})) {
		const m = symbol.mutants[mutantId];
		if (m !== undefined) return m;
	}
	throw new Error(`record not found: ${mutantId}`);
}

function changedOf(base: MutationManifest, after: string): Set<StableId> {
	return changedSymbols(base, FILE, hashesOf(after));
}

function adaptedOf(raws: RawMutant[], status: MutantStatus = "survived"): AdaptedMutant[] {
	return raws.map((raw) => ({ raw, status }));
}

/** Reconcile the default floor (BEFORE) against `currentRaws` in `after`. */
function movesFor(after: string, currentRaws: RawMutant[], status: MutantStatus = "survived"): SurvivorMove[] {
	const base = baseOf();
	return reconcileSurvivorMoves({
		file: FILE,
		priorContent: BEFORE,
		prior: priorFloorOf(base, FILE),
		currentContent: after,
		current: currentSites(identitiesOf(after, currentRaws), adaptedOf(currentRaws, status)),
		changed: changedOf(base, after),
	});
}

type Measured = Extract<MutationGateOutcome, { kind: "measured" }>;

function measured(out: MutationGateOutcome): Measured {
	if (out.kind !== "measured") throw new Error(`expected a measured outcome, got ${out.kind}`);
	return out;
}

interface EvalArgs {
	base: MutationManifest;
	after: string;
	adapted: AdaptedMutant[];
	priorContent: string | undefined;
}

function evalWith(args: EvalArgs): Measured {
	return measured(
		evaluateMutation({
			file: FILE,
			baseManifest: args.base,
			overlayContent: args.after,
			adapted: args.adapted,
			siteCountThreshold: 50,
			testRun: GREEN,
			executedTestCount: 1,
			engineExitCode: 0,
			at: "t1",
			priorContent: args.priorContent,
		}),
	);
}

function evalMove(after: string, raws: RawMutant[], priorContent: string | undefined): Measured {
	return evalWith({ base: baseOf(), after, adapted: adaptedOf(raws), priorContent });
}

// `indexSource` / `offsetsOfLexeme` / `fingerprintAt` cases live in
// survivor-fingerprint.test.ts (the AST half was extracted 2026-09-02).

describe("priorFloorOf", () => {
	it("P1: records every id (any status) and the distinct site count per ordinal group", () => {
		const floor = priorFloorOf(manifestOf(TWO_GT, [rawAt(TWO_GT, GT0)], [rawAt(TWO_GT, GT)]), FILE);
		expect(floor.survivors).toHaveLength(1);
		expect(floor.knownIds.size).toBe(2);
		expect([...floor.siteCountByGroup.values()]).toEqual([2]);
	});
});

describe("locatePriorSurvivors — positive (must fire)", () => {
	it("P1: locates a recorded survivor at its exact offset, verified through the identity hash", () => {
		const floor = priorFloorOf(baseOf(), FILE);
		expect(floor.survivors).toHaveLength(1);
		const located = locatePriorSurvivors({ file: FILE, content: BEFORE }, floor);
		expect(located.get(nth(floor.survivors, 0).mutantId)).toBe(BEFORE.indexOf("> b"));
	});

	it("P2: locates the SECOND of two engine-mutated sites when the recorded population matches the AST", () => {
		const floor = priorFloorOf(manifestOf(TWO_GT, [rawAt(TWO_GT, GT0)], [rawAt(TWO_GT, GT)]), FILE);
		const located = locatePriorSurvivors({ file: FILE, content: TWO_GT }, floor);
		expect(located.get(nth(floor.survivors, 0).mutantId)).toBe(TWO_GT.indexOf("> 0"));
	});
});

describe("locatePriorSurvivors — negative (must not fire)", () => {
	it("N1: a survivor whose expression no longer appears anywhere is not located", () => {
		const floor = priorFloorOf(baseOf(), FILE);
		expect(locatePriorSurvivors({ file: FILE, content: AFTER_MOVE_EXPR }, floor).size).toBe(0);
	});

	it("N2: a candidate whose derived identity differs from the recorded one is never claimed", () => {
		const forged: PriorFloor = {
			...priorFloorOf(baseOf(), FILE),
			survivors: [{ mutantId: "0".repeat(16), mutator: "EqualityOperator", originalLexeme: ">", replacement: ">=" }],
		};
		expect(locatePriorSurvivors({ file: FILE, content: BEFORE }, forged).size).toBe(0);
	});

	it("N3: no survivors ⇒ nothing located", () => {
		const empty: PriorFloor = { ...priorFloorOf(baseOf(), FILE), survivors: [] };
		expect(locatePriorSurvivors({ file: FILE, content: BEFORE }, empty).size).toBe(0);
	});

	it("N4: a group the engine ranked over FEWER sites than the AST holds is refused — the id would reproduce at the wrong site", () => {
		// The engine skipped the first `>` (only the second was recorded, at ordinal 0).
		const floor = priorFloorOf(manifestOf(TWO_GT, [rawAt(TWO_GT, GT0)]), FILE);
		const recorded = nth(floor.survivors, 0).mutantId;
		// The trap: ranked over BOTH AST occurrences, the recorded id lands on the FIRST site.
		const overAll = identitiesOf(TWO_GT, [rawAt(TWO_GT, GT), rawAt(TWO_GT, GT0)]);
		expect(nth(overAll, 0).mutantId).toBe(recorded);
		expect(locatePriorSurvivors({ file: FILE, content: TWO_GT }, floor).size).toBe(0);
	});
});

describe("reconcileSurvivorMoves — positive (must fire)", () => {
	it("P1: a survivor moved verbatim into an extracted helper is matched to its prior record", () => {
		const prior = priorFloorOf(baseOf(), FILE).survivors;
		const currentRaw = [rawAt(AFTER_MOVE, GT)];
		const current = identitiesOf(AFTER_MOVE, currentRaw);
		const moves = movesFor(AFTER_MOVE, currentRaw);
		expect(moves).toHaveLength(1);
		const move = nth(moves, 0);
		expect(move.previousMutantId).toBe(nth(prior, 0).mutantId);
		expect(move.currentMutantId).toBe(nth(current, 0).mutantId);
		// The identity contract really did change under the move — that is the gap this layer closes.
		expect(move.currentMutantId).not.toBe(move.previousMutantId);
	});
});

describe("reconcileSurvivorMoves — negative (must not fire)", () => {
	it("N1: a genuinely new survivor in a new function matches nothing", () => {
		expect(movesFor(AFTER_NEW, [rawAt(AFTER_NEW, GT), rawAt(AFTER_NEW, LT)])).toEqual([]);
	});

	it("N2: a moved survivor whose enclosing statement changed is not matched", () => {
		expect(movesFor(AFTER_MOVE_CHANGED, [rawAt(AFTER_MOVE_CHANGED, GT)])).toEqual([]);
	});

	it("N3: a moved survivor whose expression changed is not matched", () => {
		expect(movesFor(AFTER_MOVE_EXPR, [rawAt(AFTER_MOVE_EXPR, GTE)])).toEqual([]);
	});

	it("N4: a COPIED survivor is not excused by the original that stayed behind", () => {
		const raws = [rawAt(AFTER_COPY, GT), rawAt(AFTER_COPY, { ...GT, nth: 1 })];
		expect(movesFor(AFTER_COPY, raws)).toEqual([]);
	});

	it("N5: a killed current mutant is never reported as a moved survivor", () => {
		expect(movesFor(AFTER_MOVE, [rawAt(AFTER_MOVE, GT)], "killed")).toEqual([]);
	});

	it("N6: no prior survivors ⇒ no moves", () => {
		const currentRaw = [rawAt(AFTER_MOVE, GT)];
		const moves = reconcileSurvivorMoves({
			file: FILE,
			priorContent: BEFORE,
			prior: { ...priorFloorOf(baseOf(), FILE), survivors: [] },
			currentContent: AFTER_MOVE,
			current: currentSites(identitiesOf(AFTER_MOVE, currentRaw), adaptedOf(currentRaw)),
			changed: changedOf(baseOf(), AFTER_MOVE),
		});
		expect(moves).toEqual([]);
	});

	it("N7: a current survivor at a KNOWN address (recorded killed) is never an arrival, even with matching content", () => {
		// f's `>` (survived) vanished; g's `>` — recorded KILLED, same statement — now survives.
		const base = manifestOf(TWO_FN, [rawAt(TWO_FN, GT)], [rawAt(TWO_FN, { ...GT, nth: 1 })]);
		const raws = [rawAt(TWO_FN_F_DELETED, GT)];
		const moves = reconcileSurvivorMoves({
			file: FILE,
			priorContent: TWO_FN,
			prior: priorFloorOf(base, FILE),
			currentContent: TWO_FN_F_DELETED,
			current: currentSites(identitiesOf(TWO_FN_F_DELETED, raws), adaptedOf(raws)),
			changed: changedOf(base, TWO_FN_F_DELETED),
		});
		expect(moves).toEqual([]);
	});

	it("N8: an unrecorded survivor in an UNCHANGED symbol is never an arrival", () => {
		// Same shape as N7 but the arrival is claimed only through `changed`: with
		// g's id struck from the known set, the unchanged-symbol rule still refuses it.
		const base = manifestOf(TWO_FN, [rawAt(TWO_FN, GT)], [rawAt(TWO_FN, { ...GT, nth: 1 })]);
		const raws = [rawAt(TWO_FN_F_DELETED, GT)];
		const gId = nth(identitiesOf(TWO_FN_F_DELETED, raws), 0).mutantId;
		const floor = priorFloorOf(base, FILE);
		const knownIds = new Set([...floor.knownIds].filter((id) => id !== gId));
		const moves = reconcileSurvivorMoves({
			file: FILE,
			priorContent: TWO_FN,
			prior: { ...floor, knownIds },
			currentContent: TWO_FN_F_DELETED,
			current: currentSites(identitiesOf(TWO_FN_F_DELETED, raws), adaptedOf(raws)),
			changed: changedOf(base, TWO_FN_F_DELETED),
		});
		expect(changedOf(base, TWO_FN_F_DELETED).has(nth(identitiesOf(TWO_FN_F_DELETED, raws), 0).symbolId)).toBe(false);
		expect(moves).toEqual([]);
	});
});

describe("movedSurvivorIds", () => {
	it("P1: returns the CURRENT identity of a pure move", () => {
		const raws = [rawAt(AFTER_MOVE, GT)];
		const identities = identitiesOf(AFTER_MOVE, raws);
		const ids = movedSurvivorIds({
			file: FILE,
			key: FILE,
			baseManifest: baseOf(),
			priorContent: BEFORE,
			currentContent: AFTER_MOVE,
			identities,
			adapted: adaptedOf(raws),
			changed: changedOf(baseOf(), AFTER_MOVE),
		});
		expect([...ids]).toEqual([nth(identities, 0).mutantId]);
	});

	it("N1: without prior content there is nothing to reconcile against", () => {
		const raws = [rawAt(AFTER_MOVE, GT)];
		const ids = movedSurvivorIds({
			file: FILE,
			key: FILE,
			baseManifest: baseOf(),
			currentContent: AFTER_MOVE,
			identities: identitiesOf(AFTER_MOVE, raws),
			adapted: adaptedOf(raws),
			changed: changedOf(baseOf(), AFTER_MOVE),
		});
		expect(ids.size).toBe(0);
	});
});

describe("evaluateMutation with priorContent — the gate treats a matched move as unchanged", () => {
	it("N1: a pure move is NOT a new survivor (must not fire)", () => {
		const out = evalMove(AFTER_MOVE, [rawAt(AFTER_MOVE, GT)], BEFORE);
		expect(out.newSurvivors).toEqual([]);
		expect(out.decision).toBe("allow");
	});

	it("P1: the same move WITHOUT prior content is still charged as new (must fire) — the status quo this layer refines", () => {
		const out = evalMove(AFTER_MOVE, [rawAt(AFTER_MOVE, GT)], undefined);
		expect(out.newSurvivors).toHaveLength(1);
		expect(out.decision).toBe("block");
	});

	it("P2: a genuinely new survivor stays new (must fire)", () => {
		const out = evalMove(AFTER_NEW, [rawAt(AFTER_NEW, GT), rawAt(AFTER_NEW, LT)], BEFORE);
		expect(out.newSurvivors.map((m) => m.originalLexeme)).toEqual(["<"]);
		expect(out.decision).toBe("block");
	});

	it("P3: a moved-AND-changed expression is new (must fire)", () => {
		const out = evalMove(AFTER_MOVE_CHANGED, [rawAt(AFTER_MOVE_CHANGED, GT)], BEFORE);
		expect(out.newSurvivors).toHaveLength(1);
		expect(out.decision).toBe("block");
	});

	it("P4: a copied survivor is new even though its original stayed (must fire)", () => {
		const raws = [rawAt(AFTER_COPY, GT), rawAt(AFTER_COPY, { ...GT, nth: 1 })];
		const out = evalMove(AFTER_COPY, raws, BEFORE);
		expect(out.newSurvivors).toHaveLength(1);
		expect(out.decision).toBe("block");
	});

	// Verdict 2026-09-01 (major): a vanished survivor in f must not excuse a
	// killed→survived regression of g's same-content mutant.
	it("P5: a killed→survived regression in an UNCHANGED symbol still blocks when a same-content survivor vanished (must fire)", () => {
		const base = manifestOf(TWO_FN, [rawAt(TWO_FN, GT)], [rawAt(TWO_FN, { ...GT, nth: 1 })]);
		const raws = [rawAt(TWO_FN_F_DELETED, GT)];
		const out = evalWith({ base, after: TWO_FN_F_DELETED, adapted: adaptedOf(raws), priorContent: TWO_FN });
		expect(out.decision).toBe("block");
		expect(out.newSurvivors.map((m) => m.mutantId)).toEqual([nth(identitiesOf(TWO_FN_F_DELETED, raws), 0).mutantId]);
		expect(out.movedSurvivors).toBeUndefined();
	});

	it("P6: a recorded-killed mutant that now survives in a CHANGED symbol is a new survivor, not a move (must fire)", () => {
		const base = manifestOf(TWO_FN, [rawAt(TWO_FN, GT)], [rawAt(TWO_FN, { ...GT, nth: 1 })]);
		const raws = [rawAt(TWO_FN_F_DELETED_G_CHANGED, GT)];
		const gId = nth(identitiesOf(TWO_FN_F_DELETED_G_CHANGED, raws), 0);
		expect(changedOf(base, TWO_FN_F_DELETED_G_CHANGED).has(gId.symbolId)).toBe(true);
		expect(priorFloorOf(base, FILE).knownIds.has(gId.mutantId)).toBe(true);
		const out = evalWith({ base, after: TWO_FN_F_DELETED_G_CHANGED, adapted: adaptedOf(raws), priorContent: TWO_FN });
		expect(out.decision).toBe("block");
		expect(out.newSurvivors).toHaveLength(1);
		expect(out.movedSurvivors).toBeUndefined();
	});

	// Verdict 2026-09-02 (gap #2): the killed/uncovered twin need not keep its
	// OWN address to be dangerous — re-minting its identity (rename, arity
	// change) is just as unrecorded-and-in-a-changed-symbol as a genuine move,
	// so an unguarded pairing would let f's vanished survivor excuse it.
	it("P7: a killed twin RENAMED (g→h, body byte-identical) is a new survivor, not a move (must fire)", () => {
		const base = manifestOf(TWO_FN, [rawAt(TWO_FN, GT)], [rawAt(TWO_FN, { ...GT, nth: 1 })]);
		const raws = [rawAt(TWO_FN_F_DELETED_G_RENAMED, GT)];
		const hId = nth(identitiesOf(TWO_FN_F_DELETED_G_RENAMED, raws), 0);
		expect(priorFloorOf(base, FILE).knownIds.has(hId.mutantId)).toBe(false);
		expect(changedOf(base, TWO_FN_F_DELETED_G_RENAMED).has(hId.symbolId)).toBe(true);
		const out = evalWith({ base, after: TWO_FN_F_DELETED_G_RENAMED, adapted: adaptedOf(raws), priorContent: TWO_FN });
		expect(out.decision).toBe("block");
		expect(out.newSurvivors.map((m) => m.mutantId)).toEqual([hId.mutantId]);
		expect(out.movedSurvivors ?? 0).toBe(0);
	});

	it("P8: a killed twin given a new ARITY (g(a,b)→g(a,b,c)) is a new survivor, not a move (must fire)", () => {
		const base = manifestOf(TWO_FN, [rawAt(TWO_FN, GT)], [rawAt(TWO_FN, { ...GT, nth: 1 })]);
		const raws = [rawAt(TWO_FN_F_DELETED_G_REARITY, GT)];
		const gId = nth(identitiesOf(TWO_FN_F_DELETED_G_REARITY, raws), 0);
		expect(priorFloorOf(base, FILE).knownIds.has(gId.mutantId)).toBe(false);
		expect(changedOf(base, TWO_FN_F_DELETED_G_REARITY).has(gId.symbolId)).toBe(true);
		const out = evalWith({ base, after: TWO_FN_F_DELETED_G_REARITY, adapted: adaptedOf(raws), priorContent: TWO_FN });
		expect(out.decision).toBe("block");
		expect(out.newSurvivors.map((m) => m.mutantId)).toEqual([gId.mutantId]);
		expect(out.movedSurvivors ?? 0).toBe(0);
	});

	it("N2: a pure move still reconciles when an UNMOVED killed twin keeps its own recorded id (must not fire)", () => {
		const base = manifestOf(TWO_FN, [rawAt(TWO_FN, GT)], [rawAt(TWO_FN, { ...GT, nth: 1 })]);
		const raws = [rawAt(TWO_FN_F_MOVED, GT), rawAt(TWO_FN_F_MOVED, { ...GT, nth: 1 })];
		const identities = identitiesOf(TWO_FN_F_MOVED, raws);
		const classifyId = nth(identities, 0);
		const gId = nth(identities, 1);
		// g is untouched: same name/arity/body ⇒ the SAME recorded (killed) id,
		// still present in the current run — not a vanish, so no ambiguity.
		expect(priorFloorOf(base, FILE).knownIds.has(gId.mutantId)).toBe(true);
		const adapted: AdaptedMutant[] = [
			{ raw: nth(raws, 0), status: "survived" },
			{ raw: nth(raws, 1), status: "killed" },
		];
		const out = evalWith({ base, after: TWO_FN_F_MOVED, adapted, priorContent: TWO_FN });
		expect(out.decision).toBe("allow");
		expect(out.newSurvivors).toEqual([]);
		expect(out.movedSurvivors).toBe(1);
		const moves = reconcileSurvivorMoves({
			file: FILE,
			priorContent: TWO_FN,
			prior: priorFloorOf(base, FILE),
			currentContent: TWO_FN_F_MOVED,
			current: currentSites(identities, adapted),
			changed: changedOf(base, TWO_FN_F_MOVED),
		});
		expect(moves).toEqual([{ previousMutantId: nth(priorFloorOf(base, FILE).survivors, 0).mutantId, currentMutantId: classifyId.mutantId, fingerprint: nth(moves, 0)?.fingerprint }]);
	});
});

describe("movedSurvivors on the measured outcome — positive (must fire)", () => {
	it("P1: a pure-move allow carries the count and the wire decision says so", () => {
		const out = evalMove(AFTER_MOVE, [rawAt(AFTER_MOVE, GT)], BEFORE);
		expect(out.decision).toBe("allow");
		expect(out.movedSurvivors).toBe(1);
		const wire = mutationOutcomeToDecision(out);
		expect(wire.decision).toBe("allow");
		expect(wire.warnings?.join("\n")).toMatch(/1 previously accepted survivor\(s\) moved with the code/);
	});
});

describe("movedSurvivors on the measured outcome — negative (must not fire)", () => {
	it("N1: absent without prior content (nothing was reconciled)", () => {
		const out = evalMove(AFTER_MOVE, [rawAt(AFTER_MOVE, GT)], undefined);
		expect(out.movedSurvivors).toBeUndefined();
	});

	it("N2: absent on a clean allow that needed no reconciliation, and the wire carries no warning", () => {
		const raws = [rawAt(AFTER_NEW, GT), rawAt(AFTER_NEW, LT)];
		const adapted: AdaptedMutant[] = [
			{ raw: nth(raws, 0), status: "survived" },
			{ raw: nth(raws, 1), status: "killed" },
		];
		const out = evalWith({ base: baseOf(), after: AFTER_NEW, adapted, priorContent: BEFORE });
		expect(out.decision).toBe("allow");
		expect(out.movedSurvivors).toBeUndefined();
		expect(mutationOutcomeToDecision(out).warnings).toBeUndefined();
	});
});

describe("applyMeasuredRun carries the prior record across a move — positive (must fire)", () => {
	it("P1: a moved reviewed-equivalent survivor keeps status, reason and firstSeen under its new id", () => {
		const raws = [rawAt(AFTER_MOVE, GT)];
		const currentId = nth(identitiesOf(AFTER_MOVE, raws), 0).mutantId;
		const out = evalWith({ base: reviewed(baseOf()), after: AFTER_MOVE, adapted: adaptedOf(raws), priorContent: BEFORE });
		expect(out.decision).toBe("allow");
		if (out.refreshedManifest === undefined) throw new Error("expected a refreshed manifest");
		const record = recordOf(out.refreshedManifest, currentId);
		expect(record.status).toBe("equivalent");
		expect(record.accepted_reason).toBe("patched + suite green");
		expect(record.firstSeen).toBe("t0");
	});

	it("P2: a moved plain survivor keeps its firstSeen (it is not a fresh sighting)", () => {
		const raws = [rawAt(AFTER_MOVE, GT)];
		const currentId = nth(identitiesOf(AFTER_MOVE, raws), 0).mutantId;
		const out = evalMove(AFTER_MOVE, raws, BEFORE);
		if (out.refreshedManifest === undefined) throw new Error("expected a refreshed manifest");
		const record = recordOf(out.refreshedManifest, currentId);
		expect(record.status).toBe("survived");
		expect(record.firstSeen).toBe("t0");
	});
});

describe("applyMeasuredRun carries the prior record across a move — negative (must not fire)", () => {
	it("N1: a moved equivalent the tests now KILL is recorded killed — a review never revives a dead mutant", () => {
		const base = reviewed(baseOf());
		const raws = [rawAt(AFTER_MOVE, GT)];
		const identity = nth(identitiesOf(AFTER_MOVE, raws), 0);
		const priorId = nth(priorFloorOf(base, FILE).survivors, 0).mutantId;
		const next = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: hashesOf(AFTER_MOVE),
			measured: [{ identity, status: "killed" }],
			at: "t1",
			moves: [{ previousMutantId: priorId, currentMutantId: identity.mutantId }],
		});
		const record = recordOf(next, identity.mutantId);
		expect(record.status).toBe("killed");
		expect(record.accepted_reason).toBeUndefined();
		expect(record.firstSeen).toBe("t0");
	});

	it("N2: without moves, the same current id is a fresh sighting stamped with this run", () => {
		const raws = [rawAt(AFTER_MOVE, GT)];
		const identity = nth(identitiesOf(AFTER_MOVE, raws), 0);
		const next = applyMeasuredRun({
			base: baseOf(),
			file: FILE,
			overlayHashes: hashesOf(AFTER_MOVE),
			measured: [{ identity, status: "survived" }],
			at: "t1",
		});
		expect(recordOf(next, identity.mutantId).firstSeen).toBe("t1");
	});
});
