// Headings, anchor slugs, section references, and markdown links
// (spec-facts substrate). Feeds spec_dangling_anchor / spec_xref_integrity
// (docs/design/spec-audit-runtime-checks.md §3.3, class B3).

import {
	codePointEndingBefore,
	codePointStartingAt,
	stripEmphasis,
} from "./emphasis-strip.js";
import { decodeEntitiesRaw } from "./entity-names.js";
import { MD_LINK_RE } from "./extract-refs-link-grammar.js";
import {
	maskInlineIgnorable,
	sameLineCommentBlockLines,
	withCommentBlockLines,
} from "./extract-refs-masking.js";
import { collectRefDefinitionLabels, githubSlug } from "./extract-refs-slug.js";
import type { AnchorLink, HeadingInfo, SectionRef } from "./types.js";

// githubSlug and its inline-render pipeline live in extract-refs-slug.ts
// (line-cap split; round-7 #14/#16). Re-exported so consumers keep ONE import
// surface, and used here directly for heading slugging.
export { githubSlug };

// CommonMark permits up to 3 leading spaces before an ATX heading (sol-max #23);
// 4+ is indented code, not a heading. The opening run may also end the line —
// "#" alone is a valid EMPTY heading (round-6 #11).
// The separator after the # run is space/tab ONLY — GFM does not treat NBSP as
// a structural heading separator (round-7 #12), so "# Title" is a paragraph.
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;

/** Validate a dotted section-number token ("7", "7.3", "7.3.1") captured by
 *  the flat scan patterns. Split-based — no regex, provably linear. */
function asSectionNumber(token: string | undefined): string | undefined {
	if (!token) return undefined;
	const trimmed = token.endsWith(".") ? token.slice(0, -1) : token;
	if (!trimmed) return undefined;
	const parts = trimmed.split(".");
	const allNumeric = parts.every(
		(p) => p.length > 0 && [...p].every((c) => c >= "0" && c <= "9"),
	);
	return allNumeric ? trimmed : undefined;
}

/** Replace inline-code spans AND same-line HTML comments with equal-length
 *  spaces so their markdown is not parsed as live refs/links (sol-max #17/#19,
 *  round-5 #18/#20) while preserving column offsets. Impl lives in
 *  extract-refs-masking.ts (line-cap split): CommonMark equal-run backtick
 *  pairing — the old `(`+)[^\n]*?\1` paired UNEQUAL runs, wrongly masking the
 *  live §9 in "`§9``". Fed only to the ref/link scanners, never to
 *  block-structure decisions. */
function blankInlineCode(line: string): string {
	return maskInlineIgnorable(line);
}

/** Leading section number in a heading ("7.3" in "### 7.3 Phantoms"). */
function headingSectionNumber(text: string): string | undefined {
	const m = /^([\d.]{1,16})\s+/.exec(text);
	return asSectionNumber(m?.[1]);
}

/** Appendix letter in a heading ("C" in "## Appendix C — formats"). */
function headingAppendixLetter(text: string): string | undefined {
	const m = /^appendix\s+([a-z])\b/i.exec(text);
	return m?.[1]?.toUpperCase();
}

/**
 * Extract headings with deduplicated GitHub slugs (-1/-2 suffixes on
 * repeats, matching GitHub's anchor generation).
 */
/** A Setext underline: a run of "=" (level 1) or "-" (level 2) under a non-blank
 *  text line. At most 3 leading spaces — 4+ is indented code, not an underline
 *  (sol-max #13). */
function setextLevel(line: string): 1 | 2 | null {
	// Trailing whitespace is space/tab only — NBSP is not GFM structural
	// underline whitespace (round-7 #12).
	if (/^ {0,3}=+[ \t]*$/.test(line)) return 1;
	if (/^ {0,3}-+[ \t]*$/.test(line)) return 2;
	return null;
}

/** A Setext heading's TEXT line must be a PARAGRAPH — not blank, another
 *  underline, a THEMATIC BREAK, an ATX heading, a list item, a blockquote, or
 *  indented code (sol-max #16, round-5 #16). A blockquote marker `>` needs no
 *  following space, while an ATX heading DOES require one (`#tag` is paragraph
 *  text — sol-max #13). Indentation counts a leading tab as 4 columns
 *  (CommonMark tab stops), so a tab within the first 3 columns is indented
 *  code; a thematic break (`***`/`___`/spaced runs of 3+) is not paragraph
 *  text. `---` runs are already rejected as underlines by setextLevel. */
function isSetextTextEligible(line: string): boolean {
	if (line.trim() === "" || setextLevel(line) !== null) return false;
	// Indented code: 4+ leading spaces OR a tab reachable in the first 3 columns.
	if (/^(?: {0,3}\t| {4,})/.test(line)) return false;
	// Thematic break: ≤3 leading spaces then 3+ matching -, _, or * with optional
	// spaces/tabs between. ReDoS-safe: `\1` is a literal distinct from `[ \t]`,
	// so the adjacent quantifiers can never match the same char.
	if (/^ {0,3}([-_*])[ \t]*(?:\1[ \t]*){2,}$/.test(line)) return false;
	return !/^\s*(?:[-*+]\s|\d+[.)]\s|>|#{1,6}\s)/.test(line); // list / quote / ATX
}

/** Last index of the consecutive paragraph run starting at `i` — the lines a
 *  following Setext underline folds into ONE heading (sol-max #14). No line cap:
 *  a Setext heading may have any positive number of text lines, so the WHOLE
 *  paragraph folds in — a cap emitted a TRUNCATED suffix heading with wrong text
 *  and provenance (round-5 #15). Linearity comes from the run-start gate in
 *  headingAt (scans begin only at a run's first line, and runs are disjoint) —
 *  not from a cap; the folded TEXT is bounded separately by joinSetextText. */
function setextTextRunEnd(
	lines: string[],
	i: number,
	fencedLines: Set<number>,
): number {
	let j = i;
	// isSetextTextEligible already rejects underlines (setextLevel != null), so
	// the run stops right before the =/- underline without a separate check.
	while (
		j + 1 < lines.length &&
		!fencedLines.has(j + 2) &&
		isSetextTextEligible(lines[j + 1] ?? "")
	) {
		j++;
	}
	return j;
}

/** Whether line `i` (0-based) STARTS a paragraph run — its predecessor is not
 *  an unfenced, Setext-eligible run member. A Setext underline attaches to the
 *  WHOLE preceding paragraph, so a heading may begin only at the run's first
 *  line: starting mid-run folded a truncated suffix with wrong text and wrong
 *  provenance (round-5 #15). The gate is also the linearity guarantee for the
 *  uncapped run scan — interior lines return null in O(1), so each disjoint run
 *  is walked once. */
function isSetextRunStart(
	lines: string[],
	i: number,
	fencedLines: Set<number>,
): boolean {
	if (i === 0 || fencedLines.has(i)) return true;
	return !isSetextTextEligible(lines[i - 1] ?? "");
}

/** Cap on a folded Setext heading's TEXT length. Folding is unbounded in LINES
 *  (CommonMark allows any positive number), but the joined text feeds
 *  githubSlug, and a degenerate megabyte-scale fold would hand slugging an
 *  unbounded string (adversarial verify: 1MB fold → multi-second slug). Real
 *  multi-line Setext headings are far under this; past the cap the SLUG is
 *  truncated while line-range provenance stays exact. */
const SETEXT_TEXT_CAP = 4096;

/** Run lines joined by single spaces, capped at SETEXT_TEXT_CAP chars. */
function joinSetextText(lines: string[], i: number, j: number): string {
	let text = "";
	for (let k = i; k <= j && text.length < SETEXT_TEXT_CAP; k++) {
		const t = (lines[k] ?? "").trim();
		text = text ? `${text} ${t}` : t;
	}
	return text.length > SETEXT_TEXT_CAP ? text.slice(0, SETEXT_TEXT_CAP) : text;
}

/** One ATX or Setext heading resolved from line `i`, or null. Returns the
 *  text, level, and the number of extra lines (paragraph continuations +
 *  underline) the heading consumed after `i`. */
/** A run-START line that is not setext-able paragraph text because it OPENS a
 *  different block: a link-reference definition ("[label]: dest") or an HTML
 *  block (a "<name"/"</name" tag opener). Checked ONLY at the run's first line
 *  (round-7 #18): "[foo]: /url\n---" and "<div>\n---" emit no heading, while an
 *  interior LRD/HTML line ("A\n[foo]: /url\nB\n---") still FOLDS — putting this
 *  in isSetextTextEligible instead would break the whole-paragraph fold and
 *  re-introduce the round-5 #15 truncated-suffix bug. Because eligibility is
 *  unchanged, a following "<div>\nbar" keeps bar as a run CONTINUATION, not a
 *  fresh run-start, so the multi-line HTML block yields no phantom "bar". */
/** CommonMark HTML-block type-6 tag names (§4.6). A line opening with one of
 *  these is a block, not paragraph text. Inline tags (em, strong, a, code,
 *  span, br, img…) are deliberately absent. */
const HTML_BLOCK_TAG_RE = new RegExp(
	`^ {0,3}</?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|style|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \\t/>]|$)`,
	"i",
);

/** A line that is a COMPLETE standalone HTML tag (open or close), only
 *  whitespace to end-of-line — CommonMark type-7 HTML block (§4.6). "<em>text"
 *  is NOT one (text follows the tag), so it stays paragraph text (round-7 #14). */
const HTML_STANDALONE_TAG_RE =
	/^ {0,3}(?:<[a-z][a-z0-9-]*(?:\s[^<>]{0,1000})?\/?>|<\/[a-z][a-z0-9-]*\s{0,100}>)[ \t]*$/i;

/** A run-START line that is not setext-able paragraph text because it OPENS a
 *  different block: a COMPLETE link-reference definition ("[label]: dest" — the
 *  destination is required, so "[foo]:" alone stays a paragraph, round-7 #13),
 *  or an HTML block (a type-6 block tag or a complete standalone tag — but not
 *  an inline tag with trailing text, round-7 #14). */
function opensNonParagraphBlock(line: string): boolean {
	// Link-reference definition: label ends at the FIRST unescaped "]", no nested
	// "[" (§4.7), and a NON-EMPTY destination must follow the colon (round-7 #13).
	// Friedl-unrolled + bounded ⇒ ReDoS-safe.
	if (/^ {0,3}\[(?:[^[\]\\]|\\.){0,999}\]:[ \t]*\S/.test(line)) return true;
	return HTML_BLOCK_TAG_RE.test(line) || HTML_STANDALONE_TAG_RE.test(line);
}

function headingAt(
	lines: string[],
	i: number,
	fencedLines: Set<number>,
): { text: string; level: number; consumed: number } | null {
	if (fencedLines.has(i + 1)) return null;
	const line = lines[i] ?? "";
	const atx = HEADING_RE.exec(line);
	if (atx) return { text: (atx[2] ?? "").trim(), level: (atx[1] ?? "#").length, consumed: 0 };
	// Setext: a paragraph run followed by an =/- underline, folded from the
	// run's FIRST line only (sol-max #14, round-5 #15).
	if (!isSetextTextEligible(line)) return null;
	if (!isSetextRunStart(lines, i, fencedLines)) return null;
	if (opensNonParagraphBlock(line)) return null; // LRD / HTML block, not a heading (round-7 #18)
	const j = setextTextRunEnd(lines, i, fencedLines);
	if (j + 1 >= lines.length || fencedLines.has(j + 2)) return null;
	const level = setextLevel(lines[j + 1] ?? "");
	if (level === null) return null;
	return { text: joinSetextText(lines, i, j), level, consumed: j - i + 1 };
}

export function extractHeadings(
	lines: string[],
	fencedLines: Set<number>,
): HeadingInfo[] {
	const out: HeadingInfo[] = [];
	// Whole-line HTML comment blocks are hidden content — no headings inside
	// (round-5 #20). Line-level only: block decisions still read RAW lines.
	const skip = withCommentBlockLines(lines, fencedLines);
	// Undefined reference links render literally (round-7 #16): collect the
	// file's "[label]: dest" definitions once so githubSlug reduces "[t][ref]"
	// only when ref is defined. Skip fenced/comment-hidden lines — a def there
	// activates nothing (round-7 #18).
	const refLabels = collectRefDefinitionLabels(lines, skip);
	// Dedup against ALL previously emitted slugs (sol-max #18): "Setup / Setup-1 /
	// Setup" advances the third to "setup-2". The per-base suffix RESUMES where it
	// last stopped instead of restarting at 1, so N identical headings cost O(N),
	// not O(N²) (sol-max #15).
	const used = new Set<string>();
	const nextN = new Map<string, number>();
	for (let i = 0; i < lines.length; i++) {
		const h = headingAt(lines, i, skip);
		if (!h) continue;
		const base = githubSlug(h.text, refLabels);
		let slug = base;
		let n = nextN.get(base) ?? 1;
		while (used.has(slug)) {
			slug = `${base}-${n}`;
			n++;
		}
		nextN.set(base, n);
		used.add(slug);
		// Number/appendix metadata reads the RENDERED heading text, so emphasis
		// around the number ("## **7.3 Phantoms**", "## *Appendix C*") doesn't
		// hide it (round-7 #11). Link-wrapped numbers ("[7.3](url)") are a
		// documented residual — link reduction lives in the slug pipeline.
		const metaText = stripEmphasis(h.text);
		const sectionNumber = headingSectionNumber(metaText);
		const appendixLetter = headingAppendixLetter(metaText);
		out.push({
			line: i + 1,
			level: h.level,
			text: h.text,
			slug,
			...(sectionNumber ? { sectionNumber } : {}),
			...(appendixLetter ? { appendixLetter } : {}),
		});
		i += h.consumed; // skip the Setext underline
	}
	return out;
}

// "§7.3" / "§§3–5" / "Section 7.3" / "Appendix C". Flat token captures
// (validated by asSectionNumber) keep the scan patterns free of nested
// quantifiers. The double-section form expands to both endpoints
// (intermediate sections are not required to exist — authors write §§3–5
// across renumbered gaps).
const SECTION_SIGN_RE = /§§?\s?([\d.]{1,16})(?:\s?[–—-]\s?([\d.]{1,16}))?/g;
const SECTION_WORD_RE = /\bSection\s+([\d.]{1,16})\b/g;
const APPENDIX_RE = /\bAppendix\s+([A-Z])\b/g;

/** A single letter, digit, or COMBINING MARK in ANY Unicode plane. Marks count
 *  as word-glue: a decomposed "é" ends in a mark, and a token glued to it
 *  ("éSection 7") is one word, not a boundary (round-6 #19). Boundary
 *  predicates test exactly one whole code point, never a lone surrogate. */
const BOUNDARY_WORD_RE = /[\p{L}\p{N}\p{M}]/u;

/** Whether the char immediately AFTER match `m` runs the token into another
 *  letter OR digit (any Unicode, astral-safe) — the flat captures have no
 *  complete trailing boundary, so "§7.3abc", "§7.3é", "§7.3𝐀" (a surrogate
 *  pair), "Appendix Cé", and a 17-digit number would all truncate-and-mis-fire
 *  (sol-max #22/#16, round-5 #17). */
function runsIntoWordChar(line: string, m: RegExpMatchArray): boolean {
	const end = (m.index ?? 0) + m[0].length;
	return BOUNDARY_WORD_RE.test(codePointStartingAt(line, end));
}

/** Whether the char immediately BEFORE match `m` is a letter/digit (any Unicode,
 *  astral-safe). The word/appendix forms anchor on an ASCII `\b`, so a preceding
 *  NON-ASCII letter ("préSection 7", "préAppendix C") slips past `\b` and must be
 *  rejected here (round-5 #17). */
function precededByWordChar(line: string, m: RegExpMatchArray): boolean {
	return BOUNDARY_WORD_RE.test(codePointEndingBefore(line, m.index ?? 0));
}

/** Word-glue test for the WORD-anchored ref forms ("Section 7", "Appendix C"):
 *  the match must not run into a letter/digit on EITHER side (round-5 #17). The
 *  `§` sign form uses only the trailing half — `§` is self-delimiting. */
function hasWordCharGlue(line: string, m: RegExpMatchArray): boolean {
	return runsIntoWordChar(line, m) || precededByWordChar(line, m);
}

/** All section/appendix refs on one prose line. */
function refsOnLine(line: string, lineNo: number): SectionRef[] {
	const out: SectionRef[] = [];
	const add = (
		kind: SectionRef["kind"],
		ref: string | undefined,
		m: RegExpMatchArray,
	): void => {
		if (ref) out.push({ line: lineNo, kind, ref, raw: m[0], col: m.index ?? 0 });
	};
	for (const m of line.matchAll(SECTION_SIGN_RE)) {
		// § is self-delimiting; only a trailing boundary is enforced (astral-safe).
		if (runsIntoWordChar(line, m)) continue;
		add("section", asSectionNumber(m[1]), m);
		add("section", asSectionNumber(m[2]), m);
	}
	for (const m of line.matchAll(SECTION_WORD_RE)) {
		if (hasWordCharGlue(line, m)) continue;
		add("section", asSectionNumber(m[1]), m);
	}
	for (const m of line.matchAll(APPENDIX_RE)) {
		// Appendix had NO boundary guard — "Appendix Cé" / "préAppendix C" mis-fired
		// (round-5 #17). Same Unicode boundary on both sides.
		if (hasWordCharGlue(line, m)) continue;
		add("appendix", m[1], m);
	}
	return out;
}

/** Lines occupied by a heading — ATX or Setext (text line AND its underline) —
 *  so section-ref scanning can skip them (sol-max #17). */
function headingOccupiedLines(lines: string[], fencedLines: Set<number>): Set<number> {
	const set = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		const h = headingAt(lines, i, fencedLines);
		if (!h) continue;
		for (let k = 0; k <= h.consumed; k++) set.add(i + 1 + k); // text lines + underline
		i += h.consumed;
	}
	return set;
}

/** Prose references to sections/appendices (heading lines excluded).
 *  Public substrate API — consumed by spec_dangling_anchor. */
/** Blank the `(destination "title")` of every inline link (column-preserving),
 *  keeping the link TEXT — a "§9" or "Appendix C" inside a URL or title is not a
 *  visible prose reference and must not seed a dangling-section finding
 *  (round-7 #16). Bounded classes ⇒ ReDoS-safe. */
function blankLinkTargets(line: string): string {
	return line.replace(
		/(!?\[[^\]\n]{0,1000}\])(\([^)\n]{0,2000}\))/g,
		(_, label: string, target: string) => label + " ".repeat(target.length),
	);
}

export function extractSectionRefs(
	lines: string[],
	fencedLines: Set<number>,
): SectionRef[] {
	const skip = withCommentBlockLines(lines, fencedLines); // hidden comment blocks (round-5 #20)
	const headingLines = headingOccupiedLines(lines, skip);
	const out: SectionRef[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (skip.has(i + 1) || headingLines.has(i + 1)) continue;
		// Blank inline code + same-line comments (sol-max #17, round-5 #20) AND
		// link destinations/titles (round-7 #16) so a literal or in-URL §ref is
		// not read as a live reference.
		out.push(...refsOnLine(blankLinkTargets(blankInlineCode(lines[i] ?? "")), i + 1));
	}
	return out;
}

// [text](target) and ![alt](target); targets with a scheme (http:, mailto:)
// are external and skipped; "#slug" is a same-file anchor; anything else is a
// relative path with an optional "#anchor". MD_LINK_RE itself (ONE capture
// group — m[1] = dest) and the shared escape-aware label grammar live in
// extract-refs-link-grammar.ts (round-7 #15/#20 + line-cap split).
const SCHEME_RE = /^[a-z][a-z0-9+.-]{0,63}:/i;

/** Normalize a captured link destination, or null for external/degenerate. An
 *  angle destination `<…>` arrives WITH its delimiters (one capture group serves
 *  both dest forms) — strip them; MD_LINK_RE only captures a well-formed `<…>`,
 *  so the endsWith guard is defense in depth (round-5 #19/#22). The length cap
 *  is the total-length backstop (round-5 #23): the regex bounds each atom, but
 *  nested paren groups still multiply. A `//`-prefixed target is scheme-RELATIVE
 *  — external, resolved against the host, never a local file (round-5 #21); a
 *  single-slash root-relative path is untouched. */
function resolveLinkDest(target: string): string | null {
	let dest = target;
	if (dest.startsWith("<")) {
		if (!dest.endsWith(">")) return null;
		dest = dest.slice(1, -1);
	}
	if (!dest || dest.length > 4096) return null;
	// CommonMark backslash escapes apply INSIDE destinations before any
	// classification: "http\://example.com" renders as the external URL, not a
	// local file named "http\:…" (round-6 #22). ASCII punctuation only.
	dest = dest.replace(/\\([!-/:-@[-`{-~])/g, "$1");
	// Entity references decode before scheme/fragment interpretation too, so
	// "h&#116;tp://…" is the external URL "http://…", not a local file, and an
	// anchor keeps its decoded text (round-7 #17).
	dest = decodeEntitiesRaw(dest);
	if (SCHEME_RE.test(dest)) return null; // external scheme (http:, mailto:, …)
	if (dest.startsWith("//")) return null; // scheme-relative → external
	return dest;
}

/** Classify one link target into an AnchorLink (null = external/skip). */
function classifyLinkTarget(
	target: string,
	raw: string,
	line: number,
): AnchorLink | null {
	const dest = resolveLinkDest(target);
	if (dest === null) return null;
	if (dest.startsWith("#")) {
		const anchor = dest.slice(1);
		if (!anchor) return null; // placeholder link — placeholder_markdown_link's beat
		return { line, anchor, raw };
	}
	const hash = dest.indexOf("#");
	if (hash < 0) return { line, targetFile: dest, raw };
	const anchor = dest.slice(hash + 1);
	return {
		line,
		targetFile: dest.slice(0, hash),
		...(anchor ? { anchor } : {}),
		raw,
	};
}

/** Same-file anchors and relative-path links (external URLs excluded). */
export function extractAnchorLinks(
	lines: string[],
	fencedLines: Set<number>,
): AnchorLink[] {
	const out: AnchorLink[] = [];
	const skip = withCommentBlockLines(lines, fencedLines); // hidden comment blocks (round-5 #20)
	// A one-line HTML comment block ("<!-- x --> tail") renders its tail as
	// LITERAL text, so links there are not links (round-7 #26). Refs still
	// read these lines (visible text) — this set is links-only.
	const linksHidden = sameLineCommentBlockLines(lines, fencedLines);
	for (let i = 0; i < lines.length; i++) {
		if (skip.has(i + 1) || linksHidden.has(i + 1)) continue;
		// Blank inline-code spans (any backtick-run length) so a literal
		// `[plan](missing.md)` example is not read as a live link (sol-max #19).
		const original = lines[i] ?? "";
		const line = blankInlineCode(original);
		// Every MD_LINK_RE match contains a literal `](` (the pattern's `\]\(`),
		// so a line without it cannot hold a link — skip the per-`[` label scan
		// entirely (round-7 #20; same guard renderInline uses, round-5 #2).
		if (!line.includes("](")) continue;
		for (const m of line.matchAll(MD_LINK_RE)) {
			// Masking is column-preserving, so provenance slices the ORIGINAL
			// source — diagnostics must quote verbatim text, not the mask
			// ("[a<!--c-->b](x)" was recorded with spaces — round-6 #23).
			const raw = original.slice(m.index, m.index + m[0].length);
			const link = classifyLinkTarget(m[1] ?? "", raw, i + 1);
			if (link) out.push(link);
		}
	}
	return out;
}
