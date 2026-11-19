// When an id occurrence counts as a DEFINITION rather than a reference.
//
// Definition credit drives `NamespaceId.defSites`, which the spec_numbering
// check reads to say "this id is defined twice" and to compute registry gaps.
// It used to be a pure line-SHAPE test: any heading / table row / list item /
// blockquote line credited its first id. Shape alone cannot tell a registry row
// from a sentence that merely happens to live inside one, so every later
// mention of a tier/stage name in a table cell or a numbered step read as a
// redefinition — measured on docs/plans/16-monotonic-quality-enforcement.md,
// where T1/T2 are defined once in §3 and referenced in later prose.
//
// The fix is POSITION: a definition names its subject at the HEAD of its site —
// the first table cell, the start of a list item, the start of a quoted or
// bold-leading line. Anything after a word of running text on that site is a
// reference. Headings are exempt from the head rule (a title defines its
// subject wherever the id sits: "### Detector D1 — Assertion Side Effects").

/**
 * A line that plausibly *defines* an id (vs merely mentioning it). CommonMark
 * bullets include `-`, `*`, and `+`; ordered rows use `N.` or `N)`. A
 * bold-LEADING line counts only when the bold wraps an id-shaped token
 * ("**FG-INV-18**"), not arbitrary prose like "**Note:**" (sol-max #4/#5).
 * Judged on the RAW line — emphasis stripping erases the bold-leading shape.
 */
function isDefinitionLine(line: string): boolean {
	const t = line.trimStart();
	return (
		/^#{1,6}\s/.test(t) || // ATX heading requires whitespace after # (sol-max #1)
		t.startsWith("|") ||
		t.startsWith("- ") ||
		t.startsWith("* ") ||
		t.startsWith("+ ") ||
		t.startsWith(">") || // CommonMark permits `>` with no following space (sol-max #5)
		/^[-*+]\s\[[ xX]\]\s/.test(t) ||
		/^\d+[.)]\s/.test(t) ||
		/^\*\*[A-Z][A-Z0-9-]*\d\*\*/.test(t) // bold must wrap ONLY the id (sol-max #2)
	);
}

/** Whatever sits between a site's head and the id must carry no WORD: only
 *  whitespace, residual unpaired emphasis/code markers (stripEmphasis leaves
 *  those), openers, and typographic decoration ("| ★R1 |", "- → B7"). One word
 *  of running text means the id is being talked about, not declared. Letters
 *  AND digits both count as words — "4a T1" is a row about something else. */
const HEAD_DECORATION_RE = /^[^\p{L}\p{N}]*$/u;

/** Leading bullet / task / ordered-list marker — mirrors isDefinitionLine's
 *  list arms, so the head of a list item is the item's own content start. */
const LIST_MARKER_RE = /^[ \t]*(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/;

/** Leading blockquote markers. Transparent: "> | REQ-1 | x |" is still a row,
 *  so the real shape is decided on the text after them. */
const QUOTE_MARKER_RE = /^[ \t]*>+[ \t]*/;

/** Half-open column window `[start, end)` in which an id earns definition
 *  credit, or `null` when the whole line qualifies (headings). */
interface HeadWindow {
	start: number;
	end: number;
}

/**
 * The head window of a definition-shaped line, in EMPHASIS-STRIPPED
 * coordinates (the same coordinates hit columns are recorded in).
 *
 * - heading → `null`: a title defines wherever the id sits.
 * - table row → the first cell only; a later cell is a reference.
 * - list item / blockquote / plain (bold-leading) → from the content start to
 *   end of line, with the decoration rule doing the "at the head" work.
 */
function definitionHeadWindow(stripped: string): HeadWindow | null {
	const quote = QUOTE_MARKER_RE.exec(stripped);
	const offset = quote?.[0].length ?? 0;
	const body = stripped.slice(offset);
	if (/^[ \t]*#{1,6}\s/.test(body)) return null;
	const lead = body.length - body.trimStart().length;
	if (body.charAt(lead) === "|") {
		const start = offset + lead + 1;
		const close = stripped.indexOf("|", start);
		return { start, end: close === -1 ? stripped.length : close };
	}
	const marker = LIST_MARKER_RE.exec(body);
	return { start: offset + (marker?.[0].length ?? lead), end: stripped.length };
}

/** The registry shape of a definition site. `named` = a list item whose leading bold names the id and a title
 *  (`- **S1 native-isolated**: …`); `item` = any other list item, blockquote text or bold-leading line. */
export type DefinitionShape = "heading" | "table" | "named" | "item";

/** A list item that opens with bold text holding an id AND at least one more word. Judged on the RAW line. */
const NAMED_ITEM_RE = /^[ \t]*(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)\*\*[A-Za-z][A-Za-z0-9-]*\d+[a-z]? [^*]+\*\*/;

/** The shape of a definition-shaped line, judged like `definitionHeadWindow` (blockquote markers are transparent). */
export function definitionShape(rawLine: string, stripped: string): DefinitionShape {
	const body = stripped.replace(QUOTE_MARKER_RE, "");
	if (/^[ \t]*#{1,6}\s/.test(body)) return "heading";
	if (body.trimStart().startsWith("|")) return "table";
	return NAMED_ITEM_RE.test(rawLine.replace(QUOTE_MARKER_RE, "")) ? "named" : "item";
}

/**
 * Whether the id at stripped-column `col` is DEFINED here.
 *
 * `rawLine` decides the site's shape (bold-leading survives only unstripped);
 * `strippedLine` + `col` decide whether the id sits at that site's head.
 */
export function isDefinitionSite(
	rawLine: string,
	strippedLine: string,
	col: number,
): boolean {
	if (!isDefinitionLine(rawLine)) return false;
	const window = definitionHeadWindow(strippedLine);
	if (!window) return true;
	if (col < window.start || col >= window.end) return false;
	return HEAD_DECORATION_RE.test(strippedLine.slice(window.start, col));
}
