// Claim↔namespace binding rules, shared by the single-file checks
// (checks/spec-structure.ts) and the cross-file ledger. A count claim is
// only checkable when evidence ties its noun to an ID namespace — this is
// the FP control that keeps ordinary prose quantities inert
// (docs/design/spec-audit-runtime-checks.md §3.3).

import { isSingularNounEndingInS, singularize } from "./extract-counts.js";
import type { CountClaim, IdNamespace, SpecFacts } from "./types.js";

type Heading = SpecFacts["headings"][number];

/** Lines on which any id of the namespace appears. */
function idLineSet(ns: IdNamespace): Set<number> {
	const set = new Set<number>();
	for (const id of ns.ids) {
		for (const line of id.sites) set.add(line);
	}
	return set;
}

/** Lines on which TWO OR MORE distinct ids of the namespace appear — a
 *  registry enumeration ("six bets B1, B2, B7"), as opposed to one incidental
 *  mention. Same-line claim binding requires this (round-8): a findings-table
 *  row like "F9 — the audit lists 83 commands" carries one id plus a generic
 *  noun, and binding from it flagged every "N commands" claim repo-wide
 *  against the F census (stop-digest FPs 2026-08-21).
 *  Exported for tests; production callers go through the memoized
 *  enumLinesFor below. */
function enumerationLineSet(ns: IdNamespace): Set<number> {
	const idsOnLine = new Map<number, number>();
	const set = new Set<number>();
	for (const id of ns.ids) {
		// De-duplicate per id: one id repeated on a line is still one id.
		for (const line of new Set(id.sites)) {
			const n = (idsOnLine.get(line) ?? 0) + 1;
			idsOnLine.set(line, n);
			if (n >= 2) set.add(line);
		}
	}
	return set;
}

/** DEFINITION-site lines only (registry rows) — heading binding requires a real
 *  registry in the section, not incidental prose mentions (FP control). */
export function defLineSet(ns: IdNamespace): Set<number> {
	const set = new Set<number>();
	for (const id of ns.ids) {
		for (const line of id.defSites) set.add(line);
	}
	return set;
}

/** Section-end line per heading, computed ONCE per file and memoized (sol-max
 *  #12): a heading's section runs until the next heading of the same-or-higher
 *  level. Keyed by heading line. */
const sectionEndCache = new WeakMap<SpecFacts, Map<number, number>>();
function sectionEnds(facts: SpecFacts): Map<number, number> {
	const cached = sectionEndCache.get(facts);
	if (cached) return cached;
	const hs = facts.headings;
	const ends = new Map<number, number>();
	for (let i = 0; i < hs.length; i++) {
		const h = hs[i];
		if (!h) continue;
		let end = facts.lineCount;
		for (let j = i + 1; j < hs.length; j++) {
			const n = hs[j];
			if (n && n.level <= h.level) {
				end = n.line - 1;
				break;
			}
		}
		ends.set(h.line, end);
	}
	sectionEndCache.set(facts, ends);
	return ends;
}

/** Smallest value in a set, by iteration — `Math.min(...set)` overflows the call
 *  stack on a large registry (sol-max #9: ~130k defined ids is valid markdown). */
function minOf(nums: Set<number>): number {
	let m = Number.POSITIVE_INFINITY;
	for (const n of nums) if (n < m) m = n;
	return m;
}

/** Lines where same-line claim↔id proximity is ambiguous — computed once per
 *  file and memoized. Two shapes: a line carrying MORE THAN ONE count claim
 *  ("six bets B1…B6 and four gates G1…G4" would cross-bind bet↔G and gate↔B —
 *  sol-max round-5 #10), and a line where ids of MORE THAN ONE namespace appear
 *  ("Six bets B1…B6 use gates G1…G3" has one claim but two candidate
 *  registries, and the noun could name either — round-7 #28). On such lines
 *  binding must come from the heading path instead. */
const ambiguousLineCache = new WeakMap<SpecFacts, Set<number>>();
function ambiguousClaimLines(facts: SpecFacts): Set<number> {
	const cached = ambiguousLineCache.get(facts);
	if (cached) return cached;
	const ambiguous = new Set<number>();
	const claimsOnLine = new Map<number, number>();
	for (const c of facts.countClaims) {
		const n = (claimsOnLine.get(c.line) ?? 0) + 1;
		claimsOnLine.set(c.line, n);
		if (n > 1) ambiguous.add(c.line);
	}
	addMultiNamespaceLines(facts, ambiguous);
	ambiguousLineCache.set(facts, ambiguous);
	return ambiguous;
}

/** Add lines on which ids from two or more distinct namespaces appear. */
function addMultiNamespaceLines(facts: SpecFacts, ambiguous: Set<number>): void {
	const namespacesOnLine = new Map<number, number>();
	for (const ns of facts.namespaces) {
		for (const line of idLineSet(ns)) {
			const n = (namespacesOnLine.get(line) ?? 0) + 1;
			namespacesOnLine.set(line, n);
			if (n > 1) ambiguous.add(line);
		}
	}
}

/** Strong-majority containment: the owner's section must hold at least two def
 *  lines for every one outside it (3·inside ≥ 2·total, integer-exact). ALL
 *  would break the common benign stray — one changelog/appendix row re-defining
 *  an id outside the registry section — while a genuine two-section split
 *  (1-in/2-out, 1/1, 2/2) never reaches the bar. `>= owner.line`, not `>`: the
 *  heading line is itself a valid definition site ("## Bets B1" — sol-max
 *  round-5 #11). */
function ownerSectionCoversDefs(
	owner: Heading,
	end: number,
	defLines: Set<number>,
): boolean {
	let inside = 0;
	for (const line of defLines) {
		if (line >= owner.line && line <= end) inside++;
	}
	return 3 * inside >= 2 * defLines.size;
}

/** Registry noun of the heading OWNING this namespace's definitions, or null.
 *  Owner = the deepest heading above the EARLIEST def whose section spans it
 *  (sol-max #10/#11), VETOED unless that section also contains a strong
 *  majority of ALL def lines (round-7 #27): a registry whose definitions
 *  straddle sections has no unambiguous owner, and the earliest-def heading
 *  must not bind it ("## Bets / - X1 / ## Gates / - X2 / - X3" names no
 *  owner). Only the owner's REGISTRY noun — first eligible plural, the same
 *  rule heading-derived binding uses — may name a claim (round-7 #29);
 *  returning the resolved noun rather than the heading makes any other match
 *  structurally impossible. */
function ownerNounOf(facts: SpecFacts, defLines: Set<number>): string | null {
	if (defLines.size === 0) return null;
	const ends = sectionEnds(facts);
	const owner = deepestOwnerHeading(facts, minOf(defLines), ends);
	if (!owner) return null;
	const end = ends.get(owner.line) ?? facts.lineCount;
	if (!ownerSectionCoversDefs(owner, end, defLines)) return null;
	// Bind from the RENDERED heading (its slug), not raw markdown: a link
	// destination or HTML comment in the heading ("## [Registry](bets.md)",
	// "## <!-- owners --> Bets") is not visible naming evidence (round-7 #10).
	return headingRegistryNoun(owner.slug);
}

/** Memoized ownerNounOf, keyed per facts by the defLines SET IDENTITY. The
 *  checks path (checks/spec-structure.ts) calls the public predicate once per
 *  namespace×claim but builds idLines/defLines ONCE per namespace, so after
 *  the first claim every lookup is O(1) — 300 namespaces × 300 claims ran
 *  ~981ms unmemoized (round-7 #30). A caller that rebuilds the Set per call
 *  simply misses the memo (old cost, same result). Values are string|null, so
 *  `undefined` from .get() unambiguously means "absent". WeakMaps keep both
 *  the facts and the Sets collectable. */
const ownerNounCache = new WeakMap<SpecFacts, WeakMap<Set<number>, string | null>>();
function ownerNounFor(facts: SpecFacts, defLines: Set<number>): string | null {
	let byDefs = ownerNounCache.get(facts);
	if (!byDefs) {
		byDefs = new WeakMap();
		ownerNounCache.set(facts, byDefs);
	}
	const hit = byDefs.get(defLines);
	if (hit !== undefined) return hit;
	const noun = ownerNounOf(facts, defLines);
	byDefs.set(defLines, noun);
	return noun;
}

/** Per-claim bind test given the namespace's precomputed owner registry noun
 *  and the file's ambiguous lines. Shared by the public predicate and the
 *  internal binding loop so the two can never drift. The heading path accepts
 *  ONLY the owner's registry noun: a secondary heading noun ("owners" in
 *  "## Bets and owners") must not bind, or a stray "six owners" claim
 *  fabricates drift against the B census (round-7 #29). */
function claimBindsGivenOwner(
	claim: CountClaim,
	enumLines: Set<number>,
	ownerNoun: string | null,
	ambiguousLines: Set<number>,
): boolean {
	// Same-line binding requires an ENUMERATION line (≥2 distinct ids of the
	// namespace), not one incidental id mention — see enumerationLineSet.
	if (enumLines.has(claim.line) && !ambiguousLines.has(claim.line)) return true;
	return ownerNoun !== null && ownerNoun === claim.nounSingular;
}

/**
 * A count-claim noun binds to a namespace when they co-occur on one UNAMBIGUOUS
 * line (single claim AND single namespace present — sol-max #10, round-7 #28),
 * or when the noun IS the registry noun of the heading owning the namespace's
 * DEFINED ids ("## The six bets" over the B1..B7 table). The heading path
 * requires DEFINITION sites (sol-max #9) so a retired-list mention does not
 * bind, and a strong majority of them inside the owner's section (round-7
 * #27). Owner resolution and the ambiguity set are memoized per facts
 * (round-7 #30): the checks path's namespace×claim loop pays O(1) per call
 * after the first when it reuses one defLines Set per namespace
 * (checks/spec-structure.ts does).
 */
export function claimBindsToNamespace(
	claim: CountClaim,
	facts: SpecFacts,
	ns: IdNamespace,
	defLines: Set<number>,
): boolean {
	const ownerNoun = ownerNounFor(facts, defLines);
	return claimBindsGivenOwner(claim, enumLinesFor(ns), ownerNoun, ambiguousClaimLines(facts));
}

/** Memoized enumerationLineSet, keyed by namespace identity — the checks path
 *  calls the bind predicate once per namespace×claim, and the set is invariant
 *  per namespace. */
const enumLineCache = new WeakMap<IdNamespace, Set<number>>();
function enumLinesFor(ns: IdNamespace): Set<number> {
	const hit = enumLineCache.get(ns);
	if (hit) return hit;
	const set = enumerationLineSet(ns);
	enumLineCache.set(ns, set);
	return set;
}

/** Headings whose plural word is almost never a registry noun. */
const HEADING_NOUN_STOP = new Set([
	"notes",
	"contents",
	"changes",
	"updates",
	"options",
	"docs",
	"details",
	"examples",
	"steps",
	"tools",
]);

/** The registry noun a heading names — the FIRST plural word (≥4 chars, not
 *  stoplisted), singularized with the same function count claims use, or null.
 *  First (not all, not last): a heading leads with its subject, so "## Bets and
 *  owners" yields "bet" — the real registry noun (sol-max #11) without binding a
 *  secondary noun that would fabricate drift (sol-max #8). */
function headingRegistryNoun(headingText: string): string | null {
	for (const w of headingText.toLowerCase().split(/[^a-z]+/)) {
		if (
			w.length >= 4 &&
			w.endsWith("s") &&
			!HEADING_NOUN_STOP.has(w) &&
			!isSingularNounEndingInS(w) // "Access"/"Status" are singular, not the registry noun (sol-max #12)
		) {
			return singularize(w);
		}
	}
	return null;
}

/** The DEEPEST heading owning `minDef` — the nearest heading above it whose
 *  section still spans it (sol-max #10). An ancestor section also contains the
 *  defs, but only this immediate owner names the registry. */
function deepestOwnerHeading(
	facts: SpecFacts,
	minDef: number,
	ends: Map<number, number>,
): Heading | null {
	let owner: Heading | null = null;
	for (const h of facts.headings) {
		const spans = (ends.get(h.line) ?? facts.lineCount) >= minDef;
		// `<=`, not `<`: a heading line is itself a valid definition site, so a
		// registry whose earliest def is on the heading ("## Bets B1") is still
		// owned by that heading (sol-max #11).
		if (h.line <= minDef && h.line > (owner?.line ?? -1) && spans) owner = h;
	}
	return owner;
}

/**
 * Noun→namespace binding evidence within one file: which (style-qualified)
 * namespace prefixes each claim noun binds to. The ledger merges these per
 * file to check claims in files that don't enumerate the ids themselves
 * (README says "six bets"; the plan is where bets↔B is established).
 */
export function localNounBindings(facts: SpecFacts): Map<string, Set<string>> {
	const bindings = new Map<string, Set<string>>();
	const bind = (noun: string, key: string): void => {
		const set = bindings.get(noun);
		if (set) set.add(key);
		else bindings.set(noun, new Set([key]));
	};
	const ambiguousLines = ambiguousClaimLines(facts);
	for (const ns of facts.namespaces) {
		if (ns.uniqueCount < 2) continue;
		const idLines = idLineSet(ns);
		// Owner noun resolved ONCE per namespace (invariant across claims) — the
		// fix for the cubic namespace×claim×heading blowup (sol-max round-5 #1) —
		// and SHARED with the heading-derived binding below, so the count-claim
		// path and the heading path can never disagree on the noun (round-7 #29).
		const ownerNoun = ownerNounFor(facts, defLineSet(ns));
		const key = `${ns.style} ${ns.prefix}`;
		for (const claim of facts.countClaims) {
			if (claimBindsGivenOwner(claim, idLines, ownerNoun, ambiguousLines)) {
				bind(claim.nounSingular, key);
			}
		}
		// Heading-derived binding (sol-max #10/#11): the owner's registry noun
		// binds even without a local count claim, so a plain "## Bets" registry
		// reaches a cross-file "six bets" claim.
		if (ownerNoun) bind(ownerNoun, key);
	}
	return bindings;
}
