// Count-claim extraction (spec-facts substrate) — split out of extract-ids.ts
// for the per-file line cap. Word/numeric quantity claims ("six bets", "28
// invariants") that the checks bind to an ID namespace. Pure functions over
// one file's lines; no dependency on the id/range extractors.

import { hasUnicodeWordGlue, stripEmphasis } from "./emphasis-strip.js";
import type { CountClaim } from "./types.js";

const WORD_NUMBERS: Record<string, number> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	thirteen: 13,
	fourteen: 14,
	fifteen: 15,
	sixteen: 16,
	seventeen: 17,
	eighteen: 18,
	nineteen: 19,
	twenty: 20,
};

/** Scale/number words that must not be swallowed as the optional adjective. */
const NON_ADJECTIVES = new Set([
	"hundred",
	"thousand",
	"million",
	"billion",
	"dozen",
]);

// Singular nouns that end in -s (Latin/Greek -is/-us, English -ss). They read
// like the plural noun but are almost always a modifier of the true registry
// noun that follows ("access policies", "status codes", "analysis methods").
// A negative lookahead skips them AS THE NOUN so the regex backtracks to the
// real plural — while genuine "-us"/"-is" plurals ("menus", "APIs", "areas")
// still match. This replaces the earlier `[^ius-]s` morphology guard, which was
// provably wrong: "menus" and "status" both end in "us", so no suffix rule can
// accept one and reject the other (sol-max round-5 #8). The `(?![a-z-])` after
// each stopword matches the WHOLE word, so real plurals of these nouns
// ("accesses", "classes") are still accepted and singularized correctly.
// The CLOSED Latin/Greek singular-s class. The open-ended English -ss class
// (access, glass, class, business, …) is NOT enumerated: the regex covers it
// with `[a-z-]*ss` and the predicate with endsWith("ss") — enumeration drifted
// the moment an unlisted -ss word appeared ("six glass panels" → noun "glass",
// round-6 #7). Real plurals of -ss nouns end in "-sses", never bare "-ss", so
// the open rule cannot eat a true plural.
const SINGULAR_S_LIST =
	"status|analysis|basis|axis|crisis|thesis|hypothesis|emphasis|synopsis|diagnosis|focus|corpus|consensus|bias|series|species";
const SINGULAR_S_NOUN = `[a-z-]*ss|${SINGULAR_S_LIST}`;

const SINGULAR_S_SET: ReadonlySet<string> = new Set(SINGULAR_S_LIST.split("|"));

/**
 * Whether a word ending in -s is grammatically SINGULAR (Latin/Greek -is/-us or
 * an English -ss noun) rather than a plural. Shared by the count extractor (as a
 * regex lookahead) and heading-registry binding, so "Access policies" binds the
 * real noun "policy", not "acces" (sol-max round-5 #8/#12). The `-ss` test
 * covers the open-ended English class (access/process/class/business/…) without
 * enumerating it; the set covers the closed Latin/Greek class.
 */
export function isSingularNounEndingInS(word: string): boolean {
	const w = word.toLowerCase();
	return w.endsWith("ss") || SINGULAR_S_SET.has(w);
}

// Lookbehind blocks starting inside a comma-grouped number ("1,200" must not
// read as "200"), after a decimal point ("1.5 invariants" -> not "5", sol-max
// #13), or after a SIGN — hyphen, plus, or Unicode minus U+2212: "-5/+5/−5
// invariants" are deltas, not census totals, and "twenty-six invariants" must
// not read as "six" (sol-max round-5 #9, round-6 #8). A slash blocks an id
// continuation ("NIP-29/43 events" is one id list, not a "43 events" claim)
// and a tilde blocks an approximation ("~17 commands" is not an exact count) —
// both produced repo-wide false bindings (stop-digest FPs 2026-08-21). The optional single
// adjective covers "the 28 documented invariants"; the trailing guard keeps
// hyphenated/underscored continuations out ("six widgets_case" is an
// identifier, not a claim — round-6 #9). The adjective group is LAZY (`??`):
// greedy would steal the real noun when the following word also ends in s ("six
// bets does" -> noun "does"). The noun's penultimate char must be a letter
// (`[a-z]s`), so "bad_s" (underscore) never matches (sol-max round-5 #8).
const COUNT_CLAIM_RE = new RegExp(
	`(?<![\\d,.+\\u2212~/-])\\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\\d{1,3}(?:,\\d{3})*)\\s+(?:([a-z][a-z-]*)\\s+)??(?!(?:${SINGULAR_S_NOUN})(?![a-z-]))([a-z][a-z-]{0,17}[a-z]s)(?![a-z_-])`,
	"gi",
);

// Verbs and function words that end in -s. The noun pattern is purely
// morphological, so "the tree said 25 was the 75th percentile" parsed as a
// "25 was" count claim and bound "wa" to an unrelated registry (stop-digest
// FP 2026-08-21). Closed list: only words that are (near-)never the registry
// noun of a claim. Genuinely ambiguous words ("sets", "uses") stay out.
const NON_NOUN_S_WORDS = new Set([
	"was",
	"has",
	"does",
	"goes",
	"says",
	"its",
	"this",
	"thus",
	"plus",
	"versus",
	"whereas",
	"perhaps",
	"always",
]);

/** Nouns that read as counts but almost never bind to an ID namespace. */
const COUNT_NOUN_STOPLIST = new Set([
	"times",
	"ways",
	"days",
	"hours",
	"minutes",
	"seconds",
	"years",
	"weeks",
	"months",
	"bytes",
	"bits",
	"lines",
	"chars",
	"characters",
	"tokens",
	"users",
	"files",
	"things",
	"words",
	"places",
	"parts",
	"others",
	"commits",
	"checks",
	"errors",
	"tests",
	"warnings",
	"branches",
	"attempts",
	"retries",
	"steps",
	"sessions",
	// Generic across every doc family in an agent-harness repo (hook events /
	// Nostr events; CLI / shell commands) — one niche doc's co-occurrence bound
	// them to its registry and flagged unrelated claims repo-wide (stop-digest
	// FPs 2026-08-21).
	"events",
	"commands",
	// Second FP batch, same day, same mechanism via the heading-owner path
	// ("### Sequence detectors" over PR1.. phase ids bound detector→PR): these
	// nouns describe the harness's own subject matter, so nearly every doc uses
	// them and any single binding misfires repo-wide.
	"writes",
	"reads",
	"edits",
	"detectors",
	"mutants",
	"numbers",
	"seams",
	// Third batch (2026-08-23): campaign/plan files use "A1, U2, …" unit ids,
	// which bound entry→A repo-wide and flagged every "N entries" claim.
	"entries",
]);

/** Spec-frequent plurals the rules below would mangle. Extend as found. */
const IRREGULAR_PLURALS: Record<string, string> = {
	analyses: "analysis",
	theses: "thesis",
	hypotheses: "hypothesis",
	indices: "index",
	matrices: "matrix",
	vertices: "vertex",
	criteria: "criterion",
	statuses: "status",
};

/**
 * Naive singular form for binding ("bets" -> "bet", "phases" -> "phase",
 * "classes" -> "class", "indexes" -> "index"). Deliberately not a full
 * lemmatizer: correctness targets registry-realistic nouns; both sides of a
 * ledger binding use this same function, so consistency is what matters.
 */
export function singularize(noun: string): string {
	const irregular = Object.hasOwn(IRREGULAR_PLURALS, noun)
		? IRREGULAR_PLURALS[noun]
		: undefined;
	if (irregular) return irregular;
	if (noun.endsWith("ies")) return `${noun.slice(0, -3)}y`;
	if (noun.endsWith("sses")) return noun.slice(0, -2);
	if (/(?:xes|ches|shes|zes)$/.test(noun)) return noun.slice(0, -2);
	if (noun.endsWith("s")) return noun.slice(0, -1);
	return noun;
}

/** Validate one count-claim regex match; null when it is not a real claim. */
function parseCountMatch(
	m: RegExpMatchArray,
	lineNo: number,
): CountClaim | null {
	const numRaw = (m[1] ?? "").toLowerCase();
	const adjective = (m[2] ?? "").toLowerCase();
	const noun = (m[3] ?? "").toLowerCase();
	if (COUNT_NOUN_STOPLIST.has(noun) || NON_NOUN_S_WORDS.has(noun)) return null;
	// `Object.hasOwn`, not `in`: a bare `in` also matches inherited keys, so
	// "constructor"/"toString" would be treated as number words (sol-max #24).
	if (adjective && (NON_ADJECTIVES.has(adjective) || Object.hasOwn(WORD_NUMBERS, adjective))) {
		return null;
	}
	const value = WORD_NUMBERS[numRaw] ?? Number(numRaw.replace(/,/g, ""));
	if (!Number.isFinite(value) || value <= 0 || value > 500) return null;
	return {
		noun,
		nounSingular: singularize(noun),
		value,
		raw: m[0],
		line: lineNo,
	};
}

/**
 * Extract "<number> [adjective] <plural-noun>" count claims. Binding a noun
 * to a namespace (and thus deciding whether a claim is checkable) is the
 * ledger's job — extraction stays broad but cheap, and the stoplist keeps
 * pure-quantity nouns ("three times") out. Broad-by-design: unbound claims
 * are inert; only namespace-bound nouns ever produce findings.
 */
/** One regex match → claim, rejecting a match glued to a Unicode letter/digit
 *  on either side — the ASCII `\b`/guards can't see it, so "ésix bets" / "six
 *  betsé" would truncate out of a larger word (round-7 #3). */
function matchToClaim(line: string, m: RegExpMatchArray, lineNo: number): CountClaim | null {
	const start = m.index ?? 0;
	if (hasUnicodeWordGlue(line, start, start + m[0].length)) return null;
	return parseCountMatch(m, lineNo);
}

export function extractCountClaims(lines: string[]): CountClaim[] {
	const out: CountClaim[] = [];
	for (let i = 0; i < lines.length; i++) {
		// Scan the emphasis-STRIPPED line so a formatted term is seen as it
		// renders — "**six** bets" / "_six bets_" are "six bets" claims (round-7
		// #2). Same paired-only stripping the id/range extractors use.
		const line = stripEmphasis(lines[i] ?? "");
		COUNT_CLAIM_RE.lastIndex = 0;
		for (const m of line.matchAll(COUNT_CLAIM_RE)) {
			const claim = matchToClaim(line, m, i + 1);
			if (claim) out.push(claim);
		}
	}
	return out;
}
