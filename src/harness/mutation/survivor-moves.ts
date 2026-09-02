// ===========================================
// Per-edit mutation — refactor-stable survivor reconciliation (moves)
// ===========================================
// identity.ts anchors a mutant to (file, enclosing symbol, mutator, lexeme,
// ordinal). That key is line-shift invariant, and it is a digest-pinned
// protocol contract, so it cannot learn about refactors. Its blind spot:
// extract a helper, and every survivor that moved with the code lands under a
// NEW symbolId, so the survivor-diff invariant (manifest-diff.ts's
// `computeNewSurvivors`) charges the edit with survivors it did not introduce
// and asks the agent to kill mutants a previous session already accepted as
// the floor.
//
// This module is a LOCAL reconciliation layer over that contract. It never
// changes an identity; it maps a VANISHED prior survivor to the current mutant
// that carries the same CONTENT — a sha256 over the mutated expression's
// normalized token stream plus the normalized skeleton of its enclosing
// statement (nested block interiors blanked). A match means "same mutant, new
// address", and the evaluator treats the current identity as accepted.
//
// Safety properties, in the direction a BLOCKING gate must get right:
//   - A prior survivor is located in the prior content by HASH VERIFICATION:
//     candidate offsets are re-derived through `deriveIdentities`, and only a
//     candidate whose mutantId equals the recorded one counts. No guess can
//     excuse a mutant the manifest never recorded.
//   - The ordinal is re-ranked over the SAME population the record was ranked
//     over: identity.ts ranks distinct offsets among the engine's mutated sites
//     per (symbol, mutator, lexeme), so a group whose AST occurrences outnumber
//     (or undercount) the recorded sites is refused — the recorded id would
//     otherwise reproduce at the wrong site.
//   - An ARRIVAL is a current survivor at an address the manifest has never
//     recorded (any status) inside a CHANGED symbol. A known address is never
//     a "new address": a recorded-killed mutant that now survives is a
//     regression, and a move must never mask it.
//   - A prior survivor whose identity is STILL PRESENT in the current run is
//     consumed there; it can never also excuse a copy elsewhere (a copied
//     survivor is a new survivor).
//   - Matching is a multiset pairing per fingerprint: k vanished priors excuse
//     at most k arrivals with the same content; an unmatched arrival is new.
//   - Any failure to parse, locate, or fingerprint yields NO match — exactly
//     the pre-existing behavior (the survivor stays "new").

import { deriveIdentities } from "./identity.js";
import { fileRecords } from "./manifest-diff.js";
import type { AdaptedMutant } from "./stryker-adapter.js";
import { fingerprintAt, indexSource, offsetsOfLexeme, type SourceIndex, type SourceText } from "./survivor-fingerprint.js";
import type { MutantIdentity, MutantStatus, MutationManifest, RawMutant, StableId } from "./types.js";

/** A prior-floor mutant worth reconciling: survived, or reviewed-equivalent —
 *  the same two statuses `acceptedSurvivors` treats as the floor. */
export interface PriorSurvivor {
	mutantId: StableId;
	mutator: string;
	originalLexeme: string;
	replacement: string;
}

/** The manifest's floor for one file, as reconciliation needs it. */
export interface PriorFloor {
	survivors: PriorSurvivor[];
	/** Every recorded mutant that is NOT part of the accepted floor (killed,
	 *  uncovered, timeout, ignored, …). A same-content twin of one of these
	 *  vanishing makes an arrival's match ambiguous — see `vanishedBuckets`. */
	nonAcceptedRecords: PriorSurvivor[];
	/** EVERY mutant id the manifest records for the file, any status. An
	 *  arrival must be unrecorded — a known address is never a new address. */
	knownIds: ReadonlySet<StableId>;
	/** Distinct recorded sites per `groupOf` key — the engine population the
	 *  recorded ordinals were ranked over (identity.ts ranks distinct offsets
	 *  within each (symbol, mutator, lexeme) group of the raws it is given). */
	siteCountByGroup: ReadonlyMap<string, number>;
}

/** identity.ts's ordinal group: (symbol, mutator, lexeme). */
function groupOf(symbolId: StableId, mutator: string, lexeme: string): string {
	return [symbolId, mutator, lexeme].join("\x00");
}

/** One mutant of the current run, with the raw offset identity derivation
 *  discards. Public API: the element type `currentSites` returns and
 *  `reconcileSurvivorMoves` consumes. */
export interface CurrentSite {
	identity: MutantIdentity;
	status: MutantStatus;
	startOffset: number;
}

export interface SurvivorMove {
	previousMutantId: StableId;
	currentMutantId: StableId;
	fingerprint: string;
}

// The AST half — `indexSource` / `offsetsOfLexeme` / `fingerprintAt` and the
// `SourceIndex` / `SourceText` shapes — lives in ./survivor-fingerprint.ts
// (extracted 2026-09-02, line cap) and is re-exported below for this layer's
// existing importers.
export { fingerprintAt, indexSource, offsetsOfLexeme, type SourceIndex, type SourceText } from "./survivor-fingerprint.js";

/** Every AST occurrence of each survivor's expression, as candidate raw
 *  mutants for identity re-derivation. Deduplicated: the ordinal is a rank of
 *  DISTINCT offsets per (symbol, mutator, lexeme), so a repeated candidate
 *  would neither help nor harm, but it would cost a parse-side lookup. */
function candidateRaws(file: string, index: SourceIndex, survivors: readonly PriorSurvivor[]): RawMutant[] {
	const out: RawMutant[] = [];
	const seen = new Set<string>();
	for (const s of survivors) {
		for (const startOffset of offsetsOfLexeme(index, s.originalLexeme)) {
			const key = [s.mutator, s.originalLexeme, s.replacement, String(startOffset)].join("\x00");
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ file, mutator: s.mutator, originalLexeme: s.originalLexeme, replacement: s.replacement, startOffset });
		}
	}
	return out;
}

/** Distinct candidate offsets per ordinal group — the population the
 *  re-derived ordinals were ranked over. */
function candidateSiteCounts(identities: readonly MutantIdentity[], candidates: readonly RawMutant[]): Map<string, number> {
	const offsets = new Map<string, Set<number>>();
	identities.forEach((identity, i) => {
		const raw = candidates[i];
		if (raw === undefined) return;
		const key = groupOf(identity.symbolId, identity.mutator, identity.originalLexeme);
		const set = offsets.get(key) ?? new Set<number>();
		set.add(raw.startOffset);
		offsets.set(key, set);
	});
	return new Map([...offsets].map(([key, set]) => [key, set.size]));
}

/** Locate any set of recorded mutants (accepted survivors, or the
 *  non-accepted twins `vanishedNonAcceptedKeys` needs) against one recorded
 *  site population — the same hash-verified basis `locatePriorSurvivors`
 *  documents. */
function locateRecordsWithIndex(
	file: string,
	index: SourceIndex,
	records: readonly PriorSurvivor[],
	siteCountByGroup: ReadonlyMap<string, number>,
): Map<StableId, number> {
	const out = new Map<StableId, number>();
	const candidates = candidateRaws(file, index, records);
	const identities = deriveIdentities(file, index.parsed.sf.text, candidates);
	if (identities === null) return out;
	const wanted = new Set(records.map((s) => s.mutantId));
	const population = candidateSiteCounts(identities, candidates);
	identities.forEach((identity, i) => {
		const raw = candidates[i];
		if (raw === undefined || !wanted.has(identity.mutantId)) return;
		// Same ordinal basis as the record: the engine's site count for this
		// group must equal the AST occurrence count, or the rank is not the
		// engine's rank and the recorded id has reproduced at the wrong site.
		const key = groupOf(identity.symbolId, identity.mutator, identity.originalLexeme);
		if (population.get(key) !== siteCountByGroup.get(key)) return;
		out.set(identity.mutantId, raw.startOffset);
	});
	return out;
}

function locateWithIndex(file: string, index: SourceIndex, floor: PriorFloor): Map<StableId, number> {
	return locateRecordsWithIndex(file, index, floor.survivors, floor.siteCountByGroup);
}

/**
 * Where each prior survivor sits in `content`: mutantId → start offset.
 *
 * Hash-verified, not guessed: every AST occurrence of the survivor's expression
 * is fed back through the frozen identity derivation, and an offset counts
 * only when it reproduces the RECORDED mutantId over the RECORDED site
 * population. A survivor whose site the engine and this parser disagree about
 * is simply absent — it then stays "new" under the invariant, which is the
 * pre-existing behavior.
 */
export function locatePriorSurvivors(source: SourceText, floor: PriorFloor): Map<StableId, number> {
	if (floor.survivors.length === 0) return new Map();
	const index = indexSource(source);
	if (index === null) return new Map();
	return locateWithIndex(source.file, index, floor);
}

interface Arrival {
	mutantId: StableId;
	offset: number;
	fingerprint: string;
}

/** What makes two mutants "the same content": the fingerprint (expression +
 *  statement shape) plus the operator and its replacement. */
interface ContentKey {
	fingerprint: string;
	mutator: string;
	replacement: string;
}

function bucketKey(key: ContentKey): string {
	return [key.fingerprint, key.mutator, key.replacement].join("\x00");
}

function pushBucket(buckets: Map<string, Arrival[]>, key: string, arrival: Arrival): void {
	const bucket = buckets.get(key) ?? [];
	bucket.push(arrival);
	buckets.set(key, bucket);
}

interface VanishedInput {
	index: SourceIndex;
	survivors: readonly PriorSurvivor[];
	located: ReadonlyMap<StableId, number>;
	currentIds: ReadonlySet<StableId>;
}

/** Prior survivors that VANISHED from their recorded identity, by content key. */
function vanishedBuckets(input: VanishedInput): Map<string, Arrival[]> {
	const buckets = new Map<string, Arrival[]>();
	for (const s of input.survivors) {
		// Still present under its own identity ⇒ unmoved. It is accepted there
		// and must not ALSO excuse a copy somewhere else.
		if (input.currentIds.has(s.mutantId)) continue;
		const offset = input.located.get(s.mutantId);
		if (offset === undefined) continue;
		const fingerprint = fingerprintAt(input.index, offset, s.originalLexeme);
		if (fingerprint === null) continue;
		pushBucket(buckets, bucketKey({ fingerprint, mutator: s.mutator, replacement: s.replacement }), {
			mutantId: s.mutantId,
			offset,
			fingerprint,
		});
	}
	return buckets;
}

interface AmbiguousInput {
	index: SourceIndex;
	nonAcceptedRecords: readonly PriorSurvivor[];
	located: ReadonlyMap<StableId, number>;
	currentIds: ReadonlySet<StableId>;
}

/** Content keys where a NON-ACCEPTED prior record (killed, uncovered, …) also
 *  vanished from its recorded identity. A rename or arity change re-mints a
 *  killed mutant's identity exactly the way it re-mints a survivor's, so an
 *  arrival at this content could be that regression, not a move of the
 *  accepted survivor. Ambiguous ⇒ refuse the pairing; the arrival stays new. */
function vanishedNonAcceptedKeys(input: AmbiguousInput): Set<string> {
	const keys = new Set<string>();
	for (const r of input.nonAcceptedRecords) {
		// Still present under its own identity ⇒ not a candidate twin at all.
		if (input.currentIds.has(r.mutantId)) continue;
		const offset = input.located.get(r.mutantId);
		if (offset === undefined) continue;
		const fingerprint = fingerprintAt(input.index, offset, r.originalLexeme);
		if (fingerprint === null) continue;
		keys.add(bucketKey({ fingerprint, mutator: r.mutator, replacement: r.replacement }));
	}
	return keys;
}

interface ArrivedInput {
	index: SourceIndex;
	current: readonly CurrentSite[];
	/** Every recorded id (any status) — a known address can never arrive. */
	knownIds: ReadonlySet<StableId>;
	/** Symbols whose hash changed — the only place a new address can appear. */
	changed: ReadonlySet<StableId>;
}

/** Current survivors at a NEW address — unrecorded, in a changed symbol — by
 *  content key. A recorded mutant that now survives (killed→survived in an
 *  unchanged symbol, or under its own id in a changed one) is a regression or
 *  a new survivor for the invariant to judge, never a move candidate. */
function arrivedBuckets(input: ArrivedInput): Map<string, Arrival[]> {
	const { index, knownIds, changed } = input;
	const buckets = new Map<string, Arrival[]>();
	for (const site of input.current) {
		const id = site.identity;
		if (site.status !== "survived" || knownIds.has(id.mutantId) || !changed.has(id.symbolId)) continue;
		const fingerprint = fingerprintAt(index, site.startOffset, id.originalLexeme);
		if (fingerprint === null) continue;
		pushBucket(buckets, bucketKey({ fingerprint, mutator: id.mutator, replacement: id.replacement }), {
			mutantId: id.mutantId,
			offset: site.startOffset,
			fingerprint,
		});
	}
	return buckets;
}

function byOffset(a: Arrival, b: Arrival): number {
	return a.offset - b.offset;
}

/** Multiset pairing per content key, in source order on both sides. A key
 *  present in `ambiguous` (a same-content non-accepted record also vanished)
 *  is skipped entirely — the arrival could be that regression instead of the
 *  survivor's move, and a killed→survived transition must never be masked. */
function pairBuckets(
	vanished: Map<string, Arrival[]>,
	arrived: Map<string, Arrival[]>,
	ambiguous: ReadonlySet<string>,
): SurvivorMove[] {
	const moves: SurvivorMove[] = [];
	for (const [key, priors] of vanished) {
		if (ambiguous.has(key)) continue;
		const currents = arrived.get(key);
		if (currents === undefined) continue;
		priors.sort(byOffset);
		currents.sort(byOffset);
		const n = Math.min(priors.length, currents.length);
		for (let i = 0; i < n; i++) {
			const p = priors[i];
			const c = currents[i];
			if (p !== undefined && c !== undefined) {
				moves.push({ previousMutantId: p.mutantId, currentMutantId: c.mutantId, fingerprint: p.fingerprint });
			}
		}
	}
	return moves.sort((a, b) => a.currentMutantId.localeCompare(b.currentMutantId));
}

/** Public API: the argument shape of `reconcileSurvivorMoves`. */
export interface ReconcileArgs {
	/** The identity-anchoring path — the SAME string `deriveIdentities` was
	 *  given when the prior records were written and for the current run. */
	file: string;
	/** The content the prior records were measured against (pre-edit disk). */
	priorContent: string;
	prior: PriorFloor;
	/** The proposed (post-overlay) content of the current run. */
	currentContent: string;
	current: readonly CurrentSite[];
	/** Symbols whose hash changed in the current content (`changedSymbols`). */
	changed: ReadonlySet<StableId>;
}

/**
 * Map each vanished prior survivor to the current survivor that carries the
 * same content, if one exists. Pure: two parses, no I/O, no clock.
 */
export function reconcileSurvivorMoves(args: ReconcileArgs): SurvivorMove[] {
	if (args.prior.survivors.length === 0) return [];
	const priorIndex = indexSource({ file: args.file, content: args.priorContent });
	const currentIndex = indexSource({ file: args.file, content: args.currentContent });
	if (priorIndex === null || currentIndex === null) return [];
	const currentIds = new Set(args.current.map((c) => c.identity.mutantId));
	const located = locateWithIndex(args.file, priorIndex, args.prior);
	const vanished = vanishedBuckets({ index: priorIndex, survivors: args.prior.survivors, located, currentIds });
	const arrived = arrivedBuckets({
		index: currentIndex,
		current: args.current,
		knownIds: args.prior.knownIds,
		changed: args.changed,
	});
	const nonAcceptedLocated = locateRecordsWithIndex(args.file, priorIndex, args.prior.nonAcceptedRecords, args.prior.siteCountByGroup);
	const ambiguous = vanishedNonAcceptedKeys({
		index: priorIndex,
		nonAcceptedRecords: args.prior.nonAcceptedRecords,
		located: nonAcceptedLocated,
		currentIds,
	});
	return pairBuckets(vanished, arrived, ambiguous);
}

/** The floor's survivors for one manifest key — `survived` and reviewed
 *  `equivalent`, the two statuses `acceptedSurvivors` accepts. */
export function priorSurvivorsOf(manifest: MutationManifest, key: string): PriorSurvivor[] {
	const out: PriorSurvivor[] = [];
	for (const symbol of Object.values(fileRecords(manifest, key))) {
		for (const m of Object.values(symbol.mutants)) {
			if (m.status !== "survived" && m.status !== "equivalent") continue;
			out.push({ mutantId: m.mutantId, mutator: m.mutator, originalLexeme: m.originalLexeme, replacement: m.replacement });
		}
	}
	return out;
}

/** The whole recorded floor for one manifest key: its survivors, every
 *  recorded id (any status), and the recorded site population per ordinal
 *  group (distinct siteIds — two replacements at one token share a site). */
export function priorFloorOf(manifest: MutationManifest, key: string): PriorFloor {
	const knownIds = new Set<StableId>();
	const sites = new Map<string, Set<StableId>>();
	for (const symbol of Object.values(fileRecords(manifest, key))) {
		for (const m of Object.values(symbol.mutants)) {
			knownIds.add(m.mutantId);
			const group = groupOf(symbol.symbolId, m.mutator, m.originalLexeme);
			const set = sites.get(group) ?? new Set<StableId>();
			set.add(m.siteId);
			sites.set(group, set);
		}
	}
	const siteCountByGroup = new Map([...sites].map(([group, set]) => [group, set.size]));
	return {
		survivors: priorSurvivorsOf(manifest, key),
		nonAcceptedRecords: nonAcceptedRecordsOf(manifest, key),
		knownIds,
		siteCountByGroup,
	};
}

/** Every recorded mutant NOT part of the accepted floor (killed, uncovered,
 *  timeout, ignored, …) — the complement of `priorSurvivorsOf`. */
function nonAcceptedRecordsOf(manifest: MutationManifest, key: string): PriorSurvivor[] {
	const out: PriorSurvivor[] = [];
	for (const symbol of Object.values(fileRecords(manifest, key))) {
		for (const m of Object.values(symbol.mutants)) {
			if (m.status === "survived" || m.status === "equivalent") continue;
			out.push({ mutantId: m.mutantId, mutator: m.mutator, originalLexeme: m.originalLexeme, replacement: m.replacement });
		}
	}
	return out;
}

/** Zip derived identities with the adapter rows they came from, keeping the
 *  raw start offset the identity layer discards (same pairing as evaluate.ts). */
export function currentSites(identities: readonly MutantIdentity[], adapted: readonly AdaptedMutant[]): CurrentSite[] {
	const out: CurrentSite[] = [];
	const n = Math.min(identities.length, adapted.length);
	for (let i = 0; i < n; i++) {
		const identity = identities[i];
		const a = adapted[i];
		if (identity && a) out.push({ identity, status: a.status, startOffset: a.raw.startOffset });
	}
	return out;
}

/** Public API: the argument shape of `movedSurvivorIds` (evaluate.ts). */
export interface MovedSurvivorArgs {
	/** The identity-anchoring path (see {@link ReconcileArgs.file}). */
	file: string;
	/** The normalized manifest key the prior records live under. */
	key: string;
	baseManifest: MutationManifest;
	/** Absent ⇒ nothing to reconcile against; identity alone decides. */
	priorContent?: string | undefined;
	currentContent: string;
	identities: readonly MutantIdentity[];
	adapted: readonly AdaptedMutant[];
	/** Symbols whose hash changed in `currentContent` (`changedSymbols`). */
	changed: ReadonlySet<StableId>;
}

/** The matched moves of one run, from the manifest's own floor. Empty without
 *  `priorContent`. The evaluator adds each `currentMutantId` to the accepted
 *  floor so `computeNewSurvivors` reads it as unchanged, and hands the pairs to
 *  `applyMeasuredRun` so the prior record's review travels with the move. */
export function survivorMoves(args: MovedSurvivorArgs): SurvivorMove[] {
	if (args.priorContent === undefined) return [];
	return reconcileSurvivorMoves({
		file: args.file,
		priorContent: args.priorContent,
		prior: priorFloorOf(args.baseManifest, args.key),
		currentContent: args.currentContent,
		current: currentSites(args.identities, args.adapted),
		changed: args.changed,
	});
}

/** The CURRENT identities of matched moves — `survivorMoves` as a set. */
export function movedSurvivorIds(args: MovedSurvivorArgs): Set<StableId> {
	return new Set(survivorMoves(args).map((move) => move.currentMutantId));
}
