// ID-namespace census + count/range claims (spec-facts substrate).
//
// The flagship drift class from the Sol corpus (docs/design/
// spec-audit-runtime-checks.md class A): "seven bets incl. B7" vs "six bets",
// "FG-INV-28 defined" vs "FG-INV-01 through FG-INV-20 claimed". Everything
// here is a pure function over one file's lines; cross-file comparison lives
// in the ledger. Hardened per Codex review round 1 (2026-07-16): atomic
// numeric guards, endpoint-prefix agreement on ranges, first-on-line
// definition credit, bounded gap enumeration, comma-grouped counts.

import { isDefinitionSite } from "./definition-site.js";
import { hasUnicodeWordGlue, stripEmphasis } from "./emphasis-strip.js";
import type {
	IdNamespace,
	LooseId,
	NamespaceId,
	RangeClaim,
} from "./types.js";

/**
 * Dashed ids: FG-INV-07, REQ-1234. Flat character class (no nested
 * quantifiers -> no catastrophic backtracking); segment shape is enforced
 * by isValidDashedPrefix afterward. The trailing guard rejects longer
 * numeric runs atomically (REQ-12345 is not silently read as REQ-1234),
 * and 4-digit support makes the year filter reachable (CVE-2024 is
 * rejected as a year, not by digit width). Caps are deliberate: prefixes
 * <=31 chars, numbers <=4 digits — wider tokens are not registry ids.
 * The leading guard is a lookbehind (not `\b`), so a match cannot RE-ANCHOR at
 * the internal `\b` a dash creates: an over-cap "AAAA…-BBBB…-REQ-1" must not
 * yield namespace "BBBB…-REQ" by starting mid-token after a dash (sol-max #3).
 * The trailing guard also rejects a following dash — dashed ids are
 * numeric-terminal, so "REQ-1-alpha" is a longer token, not REQ-1 (round-6 #1).
 */
const DASHED_ID_RE = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9-]{0,30})-(\d{1,4})(?!\.?\d)(?![0-9A-Za-z_-])/g;

/** Every dash-separated segment starts with a letter (e.g. "FG-INV"). */
function isValidDashedPrefix(prefix: string): boolean {
	return prefix
		.split("-")
		.every((seg) => /^[A-Z][A-Z0-9]{0,15}$/.test(seg));
}

/** Compact ids: W4, B7, G0. Short uppercase prefix, small number. The trailing
 *  guard rejects longer tokens atomically (B123 never reads as B12) AND a
 *  following dash, so the "P1" in a dashed id "P1-99" is not harvested as a
 *  compact id (which fabricated a compact "P" namespace — sol-max #4). */
const COMPACT_ID_RE = /\b([A-Z]{1,3})(\d{1,2})(?!\.?\d)(?![0-9A-Za-z_-])/g;

/** Compact prefixes that are almost always false positives in prose. */
const COMPACT_STOPLIST = new Set([
	"UTF",
	"SHA",
	"MD",
	"IPV",
	"HTTP",
	"TLS",
	"OS",
	"EC",
	"AES",
	"GPT",
	"ISO",
	"RFC",
	"TOP",
	"CVSS",
]);

/** Minimum distinct ids before a prefix counts as a namespace. */
const MIN_DASHED_IDS = 2;
const MIN_COMPACT_IDS = 3;

/** Numbers that look like years are never namespace ids (CVE-2024 etc.). */
function looksLikeYear(num: number): boolean {
	return num >= 1900 && num <= 2099;
}

/** Both views of the file, kept together: definition SHAPE is judged on the raw
 *  line (emphasis stripping erases the bold-leading form), definition POSITION
 *  on the stripped one (hit columns are stripped coordinates). */
interface LineViews {
	raw: string[];
	stripped: string[];
}

interface RawHit {
	prefix: string;
	num: number;
	id: string;
	line: number;
	/** 0-based column of the token start — used for first-on-line detection. */
	col: number;
	style: "dashed" | "compact";
}

/** Style-specific validity: year filter + prefix shape + stoplist. */
function isValidHit(style: "dashed" | "compact", prefix: string, num: number): boolean {
	if (looksLikeYear(num)) return false;
	// The stoplist guards BOTH notations (sol-max #15): "HTTP-200"/"SHA-256"-style
	// dashed pairs are ordinary prose, not registries. Match the WHOLE prefix
	// exactly (sol-max #6) so a compound registry prefix like "HTTP-REQ" or
	// "OS-INV" is NOT blocked just because its first segment is stoplisted.
	if (COMPACT_STOPLIST.has(prefix)) return false;
	return style === "dashed" ? isValidDashedPrefix(prefix) : true;
}

/** Record the leftmost RAW id-token column per line. Fed from EVERY regex
 *  match BEFORE validity/glue/span filtering (round-7 #4): a filtered leading
 *  token ("| HTTP-200 | see REQ-1 |") still occupies first position, so a
 *  trailing reference cannot inherit definition credit. */
function updateMinCol(
	firstColByLine: Map<number, number>,
	line: number,
	col: number,
): void {
	const cur = firstColByLine.get(line);
	if (cur === undefined || col < cur) firstColByLine.set(line, col);
}

function collectHits(
	lines: string[],
	re: RegExp,
	style: "dashed" | "compact",
	firstColByLine: Map<number, number>,
): RawHit[] {
	const hits: RawHit[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		re.lastIndex = 0;
		for (const m of line.matchAll(re)) {
			const col = m.index;
			const id = m[0];
			updateMinCol(firstColByLine, i + 1, col);
			// The ASCII lookarounds cannot see Unicode glue ("éREQ-1",
			// "REQ-1é", combining marks, astral letters) — post-filter by
			// whole code point instead of bloating the regex (round-7 #2).
			if (hasUnicodeWordGlue(line, col, col + id.length)) continue;
			const prefix = m[1] ?? "";
			const num = Number(m[2]);
			if (!isValidHit(style, prefix, num)) continue;
			hits.push({ prefix, num, id, line: i + 1, col, style });
		}
	}
	return hits;
}

/** Whether this hit earns definition credit: first id on the line AND at the
 *  head of a definition-shaped site (see definition-site.ts). */
function creditsDefinition(
	h: RawHit,
	views: LineViews,
	firstColByLine: Map<number, number>,
): boolean {
	if (firstColByLine.get(h.line) !== h.col) return false;
	return isDefinitionSite(
		views.raw[h.line - 1] ?? "",
		views.stripped[h.line - 1] ?? "",
		h.col,
	);
}

/** Fold one hit into its NamespaceId entry (sites, spellings, def credit). */
function recordHit(
	entry: NamespaceId,
	h: RawHit,
	views: LineViews,
	firstColByLine: Map<number, number>,
): void {
	if (entry.sites[entry.sites.length - 1] !== h.line) entry.sites.push(h.line);
	if (!entry.spellings.includes(h.id)) entry.spellings.push(h.id);
	if (
		creditsDefinition(h, views, firstColByLine) &&
		entry.defSites[entry.defSites.length - 1] !== h.line
	) {
		entry.defSites.push(h.line);
	}
}

/** Cap on enumerated gaps — gapCount carries the true total. */
const GAP_LIST_CAP = 50;

/** Append the missing numbers in the open interval (a, b) to `gaps`, stopping at
 *  the list cap. */
function fillGapRange(gaps: number[], a: number, b: number): void {
	for (let n = a + 1; n < b && gaps.length < GAP_LIST_CAP; n++) gaps.push(n);
}

/** Missing numbers in [min..max]: bounded list + true count. `nums` is sorted
 *  ascending and distinct. */
function computeGaps(nums: number[]): { gaps: number[]; gapCount: number } {
	const min = nums[0] ?? 0;
	const max = nums[nums.length - 1] ?? 0;
	// Count is arithmetic (`nums` is distinct) — never scan the span for it.
	const gapCount = max - min + 1 - nums.length;
	const gaps: number[] = [];
	// Walk adjacent SORTED values, filling each pair's gap — O(present), never
	// O(span), even for a dense P-1..P-9999 registry with no gaps (sol-max #3).
	for (let i = 0; i + 1 < nums.length && gaps.length < GAP_LIST_CAP; i++) {
		fillGapRange(gaps, nums[i] ?? 0, nums[i + 1] ?? 0);
	}
	return { gaps, gapCount };
}

function buildNamespace(
	prefix: string,
	style: "dashed" | "compact",
	hits: RawHit[],
	views: LineViews,
	firstColByLine: Map<number, number>,
): IdNamespace {
	const byNum = new Map<number, NamespaceId>();
	for (const h of hits) {
		let entry = byNum.get(h.num);
		if (!entry) {
			entry = { id: h.id, num: h.num, sites: [], defSites: [], spellings: [] };
			byNum.set(h.num, entry);
		}
		recordHit(entry, h, views, firstColByLine);
	}
	const ids = [...byNum.values()].sort((a, b) => a.num - b.num);
	const nums = ids.map((e) => e.num);
	const { gaps, gapCount } = computeGaps(nums);
	return {
		prefix,
		style,
		ids,
		min: nums[0] ?? 0,
		max: nums[nums.length - 1] ?? 0,
		uniqueCount: ids.length,
		gaps,
		gapCount,
	};
}

/** Group hits by (style, prefix). */
function groupByPrefix(hits: RawHit[]): Map<string, RawHit[]> {
	const groups = new Map<string, RawHit[]>();
	for (const h of hits) {
		const key = `${h.style} ${h.prefix}`;
		const arr = groups.get(key);
		if (arr) arr.push(h);
		else groups.set(key, [h]);
	}
	return groups;
}

/** Char spans [start,end) of each validated range claim, taken from the claim's
 *  EXACT regex-match column on its emphasis-STRIPPED line (sol-max #4 — a
 *  substring search let an endpoint that failed the leading boundary elsewhere,
 *  "XFG-1 through FG-2", steal a later claim's span, and repeated identical ranges
 *  collided). An id occurrence INSIDE a span is one of the claim's own endpoints
 *  and must not seed the census (sol-max #12); a same-line definition OUTSIDE the
 *  span still counts, and a mixed-style range excludes both endpoints. */
function rangeSpansByLine(
	claims: RangeClaim[],
): Map<number, Array<[number, number]>> {
	const spans = new Map<number, Array<[number, number]>>();
	for (const c of claims) {
		const span: [number, number] = [c.col, c.col + c.raw.length];
		const arr = spans.get(c.line);
		if (arr) arr.push(span);
		else spans.set(c.line, [span]);
	}
	// Sort + merge each line's spans once so membership tests binary-search —
	// a line repeating thousands of claims made every hit scan every span
	// (quadratic; ~1.6s on 30k claims one line — round-7 #3).
	for (const [line, arr] of spans) spans.set(line, sortAndMergeSpans(arr));
	return spans;
}

/** Sort spans by start and merge overlaps into disjoint intervals. Claims from
 *  one regex pass are already sorted and disjoint; caller-supplied claim sets
 *  are not guaranteed to be. */
function sortAndMergeSpans(
	spans: Array<[number, number]>,
): Array<[number, number]> {
	spans.sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const [s, e] of spans) {
		const last = merged[merged.length - 1];
		if (last !== undefined && s <= last[1]) {
			if (e > last[1]) last[1] = e;
		} else {
			merged.push([s, e]);
		}
	}
	return merged;
}

/** Binary search over sorted disjoint spans: is `col` inside any of them? */
function inSortedSpan(spans: Array<[number, number]>, col: number): boolean {
	let lo = 0;
	let hi = spans.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const [s, e] = spans[mid] ?? [0, 0];
		if (col < s) hi = mid - 1;
		else if (col >= e) lo = mid + 1;
		else return true;
	}
	return false;
}

/** Whether a token at (line,col) falls inside any range-claim span. */
function inRangeSpan(
	line: number,
	col: number,
	spans: Map<number, Array<[number, number]>>,
): boolean {
	const lineSpans = spans.get(line);
	return lineSpans ? inSortedSpan(lineSpans, col) : false;
}

/** Id hits over the emphasis-STRIPPED lines with range-claim endpoints excluded,
 *  plus the first-column map (both in stripped coordinates, so span exclusion and
 *  first-on-line credit stay consistent — sol-max #1). The first-column map is
 *  fed from every RAW regex match, not just surviving hits (round-7 #4). Shared
 *  by the namespace and loose-id extractors. Definition-shape is still judged on
 *  the RAW line by the callers, so a bold-leading "**FG-INV-18**" definition is
 *  not lost. */
function spanFilteredHits(
	lines: string[],
	rangeClaims?: RangeClaim[],
): { hits: RawHit[]; views: LineViews; firstColByLine: Map<number, number> } {
	const stripped = lines.map(stripEmphasis);
	const spans = rangeSpansByLine(rangeClaims ?? extractRangeClaims(lines));
	const firstColByLine = new Map<number, number>();
	const hits = [
		...collectHits(stripped, DASHED_ID_RE, "dashed", firstColByLine),
		...collectHits(stripped, COMPACT_ID_RE, "compact", firstColByLine),
	].filter((h) => !inRangeSpan(h.line, h.col, spans));
	return { hits, views: { raw: lines, stripped }, firstColByLine };
}

/**
 * Cluster ID-like tokens into namespaces. Dashed prefixes qualify with >=2
 * distinct numbers; compact (short) prefixes need >=3 plus a stoplist, since
 * "V8"-style tokens are common in prose. A prefix seen in both styles keeps
 * them separate (they are different notations). Definition credit goes only to
 * the first id on a definition-shaped line AND only at that site's HEAD — a
 * later table cell or a mid-sentence mention inside a list item is a reference
 * (see definition-site.ts).
 * Range-claim endpoints are excluded from the census (sol-max #12) so a claim
 * cannot validate its own extent; pass the file's `rangeClaims` to reuse the
 * fence-aware set, or omit to derive them from `lines`.
 */
export function extractIdNamespaces(
	lines: string[],
	rangeClaims?: RangeClaim[],
): IdNamespace[] {
	const { hits, views, firstColByLine } = spanFilteredHits(lines, rangeClaims);
	const out: IdNamespace[] = [];
	for (const [key, groupHits] of groupByPrefix(hits)) {
		const [style, prefix] = key.split(" ") as ["dashed" | "compact", string];
		const distinct = new Set(groupHits.map((h) => h.num)).size;
		const minimum = style === "dashed" ? MIN_DASHED_IDS : MIN_COMPACT_IDS;
		if (distinct < minimum) continue;
		out.push(buildNamespace(prefix, style, groupHits, views, firstColByLine));
	}
	// Plain lexical sort — localeCompare would make ordering locale-dependent,
	// and this substrate must serialize deterministically across machines.
	out.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
	return out;
}

/** DEFINED id occurrences whose (style,prefix) group is BELOW the per-file
 *  namespace threshold — the fragments a registry split across files leaves in a
 *  file that doesn't independently qualify (sol-max #1). The global census folds
 *  these into a prefix that qualifies elsewhere, so a lone "- B7" extends a
 *  B1..B6 registry. Restricted to the HEAD of DEFINITION-shaped lines so prose
 *  mentions never fold in, and range endpoints are excluded (same span filter as
 *  the census). */
export function extractLooseDefinedIds(
	lines: string[],
	rangeClaims?: RangeClaim[],
): LooseId[] {
	const { hits, views, firstColByLine } = spanFilteredHits(lines, rangeClaims);
	const out: LooseId[] = [];
	for (const [key, groupHits] of groupByPrefix(hits)) {
		const [style, prefix] = key.split(" ") as ["dashed" | "compact", string];
		const distinct = new Set(groupHits.map((h) => h.num)).size;
		const minimum = style === "dashed" ? MIN_DASHED_IDS : MIN_COMPACT_IDS;
		if (distinct >= minimum) continue; // qualifies on its own — already a namespace
		for (const h of groupHits) {
			if (creditsDefinition(h, views, firstColByLine)) {
				out.push({ style, prefix, num: h.num });
			}
		}
	}
	return out;
}

// Count claims live in extract-counts.ts (line-cap split); re-exported here
// so existing importers keep resolving them from extract-ids.js.
export { extractCountClaims } from "./extract-counts.js";

// stripEmphasis moved to emphasis-strip.ts (round-7 #5): only PAIRED
// `*`/backtick runs are removed now — unpaired markers are literal per
// CommonMark, and unconditional deletion fabricated ids ("- A*1" -> "A1",
// "A*1 through A*9" -> a range).

// Leading lookbehind prevents mid-token starts ("...FG-)INV-01" can never
// begin a claim); the endpoint must repeat the SAME prefix (dashed or
// compact form) or be a truly bare number — "FG-INV-01 through OTHER-20"
// must not fabricate an FG-INV range. Lazy prefix: greedy would swallow the
// range start's leading digit into the prefix.
// Endpoint guards: `(?!\.?\d)` rejects version-like suffixes ("FG-INV-20.0"
// must not truncate into a range to 20) while a sentence-final period
// ("through FG-INV-20.") still parses — the dot only blocks when a digit
// follows it.
// The endpoint boundary guards exclude `_` (as well as letters/digits/dash):
// an underscore-embedded endpoint ("X_A1 through A9_case") is not a range claim
// — the underscore id-guards apply here too (sol-max #6). The final guard also
// rejects a dash so "A1 through A9-extra" cannot truncate into A1..A9
// (round-6 #6), mirroring the id regexes' numeric-terminal contract.
// Word operators (through/thru/to) require surrounding whitespace so a single
// token "A1toA9" is NOT read as a range (round-7 #6); symbol operators (–, —, …,
// ..., ..) are self-delimiting and allow optional spacing.
const RANGE_CLAIM_RE =
	/(?<![A-Za-z0-9_-])([A-Z][A-Z0-9-]{0,30}?)-?(\d{1,4})(?!\.?\d)(?:\s+(?:through|thru|to)\s+|\s*(?:–|—|…|\.\.\.|\.\.)\s*)(?:\1-(\d{1,4})|\1(\d{1,4})|(?<![A-Za-z0-9_-])(\d{1,4}))(?!\.?\d)(?![0-9A-Za-z_-])/g;

/** Validate one range-claim regex match; null when it is not a real claim. */
function parseRangeMatch(
	m: RegExpMatchArray,
	lineNo: number,
): RangeClaim | null {
	const prefix = m[1] ?? "";
	const from = Number(m[2]);
	const to = Number(m[3] ?? m[4] ?? m[5]);
	if (!isValidDashedPrefix(prefix)) return null;
	if (looksLikeYear(from) || looksLikeYear(to)) return null;
	if (!(to > from)) return null;
	return {
		prefix,
		style: m[0].charAt(prefix.length) === "-" ? "dashed" : "compact",
		from,
		to,
		toExplicit: (m[3] ?? m[4]) !== undefined,
		raw: m[0],
		line: lineNo,
		col: m.index ?? 0,
	};
}

/**
 * Extract "PREFIX-01 through PREFIX-20"-style range claims (the AGENTS.md
 * "FG-INV-01 ... FG-INV-20" shape). The ledger validates `to` against the
 * namespace census max. `toExplicit` records whether the upper endpoint
 * repeated the prefix or was bare shorthand ("through 20").
 */
/** One regex match → range claim, rejecting a match glued to a Unicode
 *  letter/digit on either side (round-7 #5 — the ASCII lookarounds can't see
 *  it). */
function rangeMatchToClaim(line: string, m: RegExpMatchArray, lineNo: number): RangeClaim | null {
	const start = m.index ?? 0;
	if (hasUnicodeWordGlue(line, start, start + m[0].length)) return null;
	return parseRangeMatch(m, lineNo);
}

export function extractRangeClaims(lines: string[]): RangeClaim[] {
	const out: RangeClaim[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = stripEmphasis(lines[i] ?? "");
		RANGE_CLAIM_RE.lastIndex = 0;
		for (const m of line.matchAll(RANGE_CLAIM_RE)) {
			const claim = rangeMatchToClaim(line, m, i + 1);
			if (claim) out.push(claim);
		}
	}
	return out;
}
