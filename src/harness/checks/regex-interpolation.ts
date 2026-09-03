// regex_from_interpolation — interpolate-then-parse: a RegExp built by string
// interpolation, so DATA becomes pattern SYNTAX (Bun #30693 lineage).
//
// Fires on: (a) a template-literal argument (plain or String.raw-tagged) with
// ≥1 ${...} substitution; (b) a `+` concatenation argument with ≥1 non-literal
// operand. Exempt when EVERY substitution / non-literal operand is: (1) an
// /escape/i call; (2) a bare CONST_CASE identifier/member (fragment
// composition); (3) a numeric literal; (4) a bare identifier whose LAST
// assignment in the preceding ~2.5KB window is an /escape/i call — the window
// is cut at the nearest column-0 `}`, a later reassignment (`n = n + user`,
// `n += user`) cancels it, and it is matched against the stripped view so
// assignment-shaped prose inside a string exempts nothing. Never fires on:
// string-literal patterns, identifier arguments, zero-substitution templates,
// calls chained on a template (`` `${x}`.replace(...) `` is a call argument),
// or custom-tagged templates (esc`...` is assumed to escape).
//
// Detection lexes the file ONCE into two offset-aligned views with a local
// JS/TS lexer — deliberately not the shared line-based strippers, which treat
// `#` as a Python comment (blinding it to `this.#re = new RegExp(...)`), reset
// string state per line (`https://` in a multi-line template reads as a
// comment), and open block comments from `/*` inside string literals. Call
// sites are matched in the stripped view (string/template/regex interiors
// blanked — string-embedded `new RegExp(` never matches); arguments are read
// from the code view at the same offsets (substitutions stay visible). Regex
// literals are lexed with a prev-significant-char division heuristic; all
// malformed/over-budget scans bail conservatively (no finding).

import {
	getExtension,
	type InlineMatch,
	isGeneratedFile,
	isTestFile,
	isVendoredOrFixturePath,
	JS_TS_ALL_EXTS,
} from "./shared.js";
// Shared line table. Direct in-package import — shared.ts sits at its line cap
// and cannot carry another re-export line.
import { buildLineIndex } from "./shared-text-utils.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const CHECK_ID = "regex_from_interpolation";
const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;
/** Max chars consumed when extracting a call's first argument. */
const ARG_SCAN_BUDGET = 1500;
/** Max chars walked inside any single template/substitution scan. */
const SCAN_STEP_BUDGET = 2000;
/** Nested-template recursion bound (templates inside ${...} inside templates). */
const MAX_TEMPLATE_NESTING = 5;
/** Lookbehind window for the two-step escape idiom (`n = escapeX(v)` then use). */
const ESCAPE_ASSIGN_WINDOW = 2500;
/** Backscan bound when classifying `/` as regex-literal start vs division. */
const PREV_SIG_WINDOW = 200;
/** Sentinel from skipStringLike: char does not start a string/template token. */
const NOT_A_STRING_START = -2;

// ─── Patterns ─────────────────────────────────────────────────────────────────

/** `new RegExp(` / bare `RegExp(` call sites; lookbehind rejects member and
 *  renamed forms (`x.RegExp(`), and `RegExp.escape(` can never match. */
const CALL_SITE_RE = /(?<![\w$.])(?:new\s{1,20})?RegExp\s{0,10}\(/;

/** Template-shaped argument: plain backtick or String.raw-tagged. */
const TEMPLATE_SHAPE_RE = /^(?:String\s{0,5}\.\s{0,5}raw\s{0,5})?`/;

/** Bare CONST_CASE identifier — unbounded length, per the exemption contract. */
const CONST_IDENT_RE = /^[A-Z][A-Z0-9_]*$/;
const CONST_MEMBER_RE = /^[A-Z][A-Z0-9_]*(?:\s{0,5}\.\s{0,5}[A-Za-z_$][\w$]{0,60}){1,2}$/;
const NUMERIC_LITERAL_RE =
	/^(?:0[xXoObB][0-9a-fA-F_]{1,30}|[0-9][0-9_]{0,30}(?:\.[0-9][0-9_]{0,30})?)$/;
/** Callee head of a call expression — captures the dotted callee name. */
const CALL_HEAD_RE =
	/^([A-Za-z_$][\w$]{0,60}(?:\s{0,5}\.\s{0,5}[A-Za-z_$][\w$]{0,60}){0,4})\s{0,5}\(/;
const STRING_DQ_RE = /^"(?:[^"\\\n]|\\.){0,1000}"$/;
const STRING_SQ_RE = /^'(?:[^'\\\n]|\\.){0,1000}'$/;
/** Prev significant char that makes a following `/` division, not a regex. */
const DIVISION_PREV_RE = /[\w$)\]}'"`]/;

// ─── String/template/regex token scanners ─────────────────────────────────────

/** Skip a single-line quoted string; index past the close, or -1 unterminated. */
function skipQuoted(text: string, start: number): number {
	const quote = text.charAt(start);
	for (let j = start + 1; j < text.length; j++) {
		const ch = text.charAt(j);
		if (ch === "\\") j++;
		else if (ch === quote) return j + 1;
		else if (ch === "\n") return -1;
	}
	return -1;
}

/** Consume one `${...}` substitution starting at its `$`; pushes its source
 *  onto `collect` when provided. Index just past the substitution's `}`, or
 *  -1 malformed/over-budget. */
function consumeTemplateSubstitution(
	text: string,
	dollarIdx: number,
	depth: number,
	collect: string[] | undefined,
): number {
	const subEnd = scanSubstitution(text, dollarIdx + 2, depth);
	if (subEnd === -1) return -1;
	if (collect) collect.push(text.slice(dollarIdx + 2, subEnd));
	return subEnd + 1;
}

/** Skip a template literal from its backtick, pushing TOP-LEVEL `${...}` sub
 *  texts onto `collect`; index past the close, or -1 malformed/over-budget. */
function scanTemplate(
	text: string,
	backtickIdx: number,
	depth: number,
	collect: string[] | undefined,
): number {
	if (depth > MAX_TEMPLATE_NESTING) return -1;
	let j = backtickIdx + 1;
	let steps = 0;
	while (j < text.length) {
		if (steps++ > SCAN_STEP_BUDGET) return -1;
		const ch = text.charAt(j);
		if (ch === "`") return j + 1;
		if (ch === "\\") {
			j += 2;
		} else if (ch === "$" && text.charAt(j + 1) === "{") {
			const next = consumeTemplateSubstitution(text, j, depth, collect);
			if (next === -1) return -1;
			j = next;
		} else {
			j++;
		}
	}
	return -1;
}

/** Walk a `${...}` body from just past the `${`; index of the matching `}`,
 *  or -1 malformed/over-budget. String-aware, brace-depth-tracked. */
function scanSubstitution(text: string, start: number, depth: number): number {
	let brace = 0;
	let steps = 0;
	let j = start;
	while (j < text.length) {
		if (steps++ > SCAN_STEP_BUDGET) return -1;
		const skipped = skipStringLike(text, j, depth);
		if (skipped === -1) return -1;
		if (skipped >= 0) {
			j = skipped;
			continue;
		}
		const ch = text.charAt(j);
		if (ch === "{") brace++;
		else if (ch === "}") {
			if (brace === 0) return j;
			brace--;
		}
		j++;
	}
	return -1;
}

/** Skip the string/template/regex-literal token at `j`: index past it, -1 when
 *  malformed, NOT_A_STRING_START when `j` starts no such token. */
function skipStringLike(text: string, j: number, depth: number): number {
	const ch = text.charAt(j);
	if (ch === "`") return scanTemplate(text, j, depth + 1, undefined);
	if (ch === "'" || ch === '"') return skipQuoted(text, j);
	if (ch === "/" && startsRegexLiteral(text, j)) return skipRegexLiteral(text, j);
	return NOT_A_STRING_START;
}

/** Last non-whitespace char within PREV_SIG_WINDOW before `idx` ("" if none). */
function prevSignificantChar(text: string, idx: number): string {
	const floor = Math.max(0, idx - PREV_SIG_WINDOW);
	for (let k = idx - 1; k >= floor; k--) {
		const c = text.charAt(k);
		if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return c;
	}
	return "";
}

/** A `/` starts a regex literal unless the prev significant char ends a value. */
function startsRegexLiteral(text: string, idx: number): boolean {
	const prev = prevSignificantChar(text, idx);
	return prev === "" || !DIVISION_PREV_RE.test(prev);
}

/** Skip a regex literal (escape- and char-class-aware): index past close+flags,
 *  or -1 when unterminated on its line (callers treat as not-a-regex/bail). */
function skipRegexLiteral(text: string, idx: number): number {
	let inClass = false;
	for (let j = idx + 1; j < text.length; j++) {
		const ch = text.charAt(j);
		if (ch === "\\") {
			j++;
		} else if (ch === "\n") {
			return -1;
		} else if (inClass) {
			if (ch === "]") inClass = false;
		} else if (ch === "[") {
			inClass = true;
		} else if (ch === "/") {
			let k = j + 1;
			while (k < text.length && /[a-z]/i.test(text.charAt(k))) k++;
			return k;
		}
	}
	return -1;
}

// ─── Two-view lexer ───────────────────────────────────────────────────────────

/** Blank every char except newlines (offset/line-structure preserving). */
function blankPreservingNewlines(s: string): string {
	return s.replace(/[^\n]/g, " ");
}

/** End index (exclusive) of the comment starting at `i` (`//` or `/*`). */
function commentEnd(content: string, i: number, marker: string): number {
	if (marker === "/") {
		const nl = content.indexOf("\n", i);
		return nl === -1 ? content.length : nl;
	}
	const close = content.indexOf("*/", i + 2);
	return close === -1 ? content.length : close + 2;
}

/** End of the string/template/regex token at `i`, or `i` when the char starts
 *  no token (or it is malformed — treated as a plain char). */
function stringLikeEnd(text: string, i: number): number {
	const ch = text.charAt(i);
	let end = NOT_A_STRING_START;
	if (ch === "'" || ch === '"') end = skipQuoted(text, i);
	else if (ch === "`") end = scanTemplate(text, i, 0, undefined);
	else if (ch === "/" && startsRegexLiteral(text, i)) end = skipRegexLiteral(text, i);
	return end > i ? end : i;
}

/** Lex JS/TS content once into two offset-aligned views: codeText (comments
 *  blanked, tokens intact) and strippedText (comments blanked AND string/
 *  template/regex interiors blanked; delimiters and newlines preserved). */
function lexTwoViews(content: string): { codeText: string; strippedText: string } {
	const code: string[] = [];
	const stripped: string[] = [];
	let i = 0;
	while (i < content.length) {
		const ch = content.charAt(i);
		const next = content.charAt(i + 1);
		if (ch === "/" && (next === "/" || next === "*")) {
			const end = commentEnd(content, i, next);
			const blank = blankPreservingNewlines(content.slice(i, end));
			code.push(blank);
			stripped.push(blank);
			i = end;
		} else {
			const tokenEnd = stringLikeEnd(content, i);
			if (tokenEnd > i) {
				const token = content.slice(i, tokenEnd);
				code.push(token);
				stripped.push(
					token.charAt(0) +
						blankPreservingNewlines(token.slice(1, -1)) +
						token.charAt(token.length - 1),
				);
				i = tokenEnd;
			} else {
				code.push(ch);
				stripped.push(ch);
				i++;
			}
		}
	}
	return { codeText: code.join(""), strippedText: stripped.join("") };
}

// ─── Argument extraction & splitting ──────────────────────────────────────────

/** First argument of a call, scanning past the open paren (string/template/
 *  regex aware); null on malformed/over-budget input (conservative). */
function readFirstArg(text: string, start: number): string | null {
	let depth = 0;
	const limit = Math.min(text.length, start + ARG_SCAN_BUDGET);
	let j = start;
	while (j < limit) {
		const skipped = skipStringLike(text, j, 0);
		if (skipped === -1) return null;
		if (skipped >= 0) {
			j = skipped;
			continue;
		}
		const ch = text.charAt(j);
		if (depth === 0 && (ch === ")" || ch === ",")) return text.slice(start, j);
		if ("([{".includes(ch)) depth++;
		if (")]}".includes(ch)) depth--;
		if (depth < 0) return null;
		j++;
	}
	return null;
}

/** Split an argument on top-level `+` (ignoring `++`); null when a contained
 *  string token is malformed. */
function splitTopLevelPlus(arg: string): string[] | null {
	const parts: string[] = [];
	let depth = 0;
	let segStart = 0;
	let j = 0;
	while (j < arg.length) {
		const skipped = skipStringLike(arg, j, 0);
		if (skipped === -1) return null;
		if (skipped >= 0) {
			j = skipped;
			continue;
		}
		const ch = arg.charAt(j);
		if ("([{".includes(ch)) depth++;
		if (")]}".includes(ch)) depth--;
		if (ch === "+" && depth === 0 && arg.charAt(j + 1) !== "+" && arg.charAt(j - 1) !== "+") {
			parts.push(arg.slice(segStart, j));
			segStart = j + 1;
		}
		j++;
	}
	parts.push(arg.slice(segStart));
	return parts;
}

// ─── Exemption / operand classification ───────────────────────────────────────

/** Call expression whose callee name matches /escape/i — e.g. RegExp.escape(x). */
function isEscapeCall(e: string): boolean {
	if (!e.endsWith(")")) return false;
	const head = CALL_HEAD_RE.exec(e);
	if (!head?.[1]) return false;
	return /escape/i.test(head[1]);
}

/** Escape `$` so a validated identifier can be embedded in a RegExp source. */
function escapeIdentForRegex(s: string): string {
	return s.replace(/\$/g, "\\$&");
}

/** Two-step escape idiom: the LAST assignment to `ident` in the lookbehind is
 *  a plain `=` from an /escape/i call; any later reassignment of another
 *  shape (`n = n + user`, `n += user`) cancels the exemption. */
function assignedFromEscapeCall(ident: string, lookbehind: string): boolean {
	if (!/^[A-Za-z_$][\w$]{0,60}$/.test(ident)) return false;
	const safe = escapeIdentForRegex(ident);
	const assignRe = new RegExp(
		String.raw`(?<![\w$.])${safe}\s{0,5}([+\-*/%&|^]?=)(?![=>])\s{0,5}(?:([A-Za-z_$][\w$.]{0,120})\s{0,5}\()?`,
		"g",
	);
	let exempt = false;
	let m: RegExpExecArray | null;
	while ((m = assignRe.exec(lookbehind)) !== null) {
		exempt = m[1] === "=" && m[2] !== undefined && /escape/i.test(m[2]);
	}
	return exempt;
}

/** Escape-exemption lookbehind: sliced from the STRIPPED view (prose inside a
 *  string exempts nothing) and cut at the last column-0 `}` (one top-level
 *  scope's escape assignment cannot leak into the next). */
function escapeLookbehind(strippedText: string, offset: number): string {
	const win = strippedText.slice(Math.max(0, offset - ESCAPE_ASSIGN_WINDOW), offset);
	const cut = win.lastIndexOf("\n}");
	return cut === -1 ? win : win.slice(cut + 2);
}

/** Exempt dynamic part: numeric, CONST_CASE ident/member, /escape/i call, or
 *  identifier last-assigned from an /escape/i call. */
function isExemptDynamicPart(raw: string, lookbehind: string): boolean {
	const e = raw.trim();
	if (NUMERIC_LITERAL_RE.test(e)) return true;
	if (CONST_IDENT_RE.test(e) || CONST_MEMBER_RE.test(e)) return true;
	if (isEscapeCall(e)) return true;
	return assignedFromEscapeCall(e, lookbehind);
}

/** Template scan: top-level subs + index just past the closing backtick. */
function collectTemplateSubs(p: string): { subs: string[]; end: number } | null {
	const tickIdx = p.indexOf("`");
	if (tickIdx === -1) return null;
	const subs: string[] = [];
	const end = scanTemplate(p, tickIdx, 0, subs);
	return end === -1 ? null : { subs, end };
}

/** Subs when the operand is EXACTLY one template literal — nothing chained
 *  after the closing backtick (`` `${x}`.replace(...) `` is a call, not a
 *  template argument) — else null. */
function bareTemplateSubs(p: string): string[] | null {
	if (!TEMPLATE_SHAPE_RE.test(p)) return null;
	const t = collectTemplateSubs(p);
	return t === null || p.slice(t.end).trim().length > 0 ? null : t.subs;
}

type OperandKind = "literal" | "exempt" | "dynamic" | "malformed";

function classifyTemplateOperand(p: string, lookbehind: string): OperandKind {
	const t = collectTemplateSubs(p);
	if (t === null) return "malformed";
	if (t.subs.length === 0) return "literal";
	return t.subs.every((s) => isExemptDynamicPart(s, lookbehind)) ? "exempt" : "dynamic";
}

/** Classify one `+`-operand of a concatenation argument. */
function classifyOperand(raw: string, lookbehind: string): OperandKind {
	const p = raw.trim();
	if (p.length === 0) return "dynamic";
	if (TEMPLATE_SHAPE_RE.test(p)) return classifyTemplateOperand(p, lookbehind);
	if (STRING_DQ_RE.test(p) || STRING_SQ_RE.test(p)) return "literal";
	if (NUMERIC_LITERAL_RE.test(p)) return "exempt";
	if (isExemptDynamicPart(p, lookbehind)) return "exempt";
	return "dynamic";
}

// ─── Verdict & core scan ──────────────────────────────────────────────────────

const TEMPLATE_MSG =
	"RegExp built from a template with unescaped ${...} interpolation — data becomes pattern syntax; " +
	"escape substitutions (RegExp.escape / an escapeRegExp helper) or compose from CONST_CASE fragments";
const CONCAT_MSG =
	"RegExp built by string concatenation with unescaped dynamic parts — data becomes pattern syntax; " +
	"escape them (RegExp.escape / an escapeRegExp helper) or compose from CONST_CASE fragments";

/** Verdict for a first-argument expression: finding message, or null for
 *  exempt/benign shapes. `lookbehind` is the stripped window before the call. */
function interpolationVerdict(argRaw: string, lookbehind: string): string | null {
	const arg = argRaw.trim();
	if (arg.length === 0) return null;
	const parts = splitTopLevelPlus(arg);
	if (parts === null) return null;
	if (parts.length >= 2) {
		const kinds = parts.map((p) => classifyOperand(p, lookbehind));
		if (kinds.includes("malformed")) return null;
		return kinds.includes("dynamic") ? CONCAT_MSG : null;
	}
	// Single operand: only an argument that IS exactly one template literal
	// fires (identifiers, member refs, chained calls, literals: out of scope).
	const subs = bareTemplateSubs(arg);
	if (subs === null || subs.length === 0) return null;
	return subs.every((s) => isExemptDynamicPart(s, lookbehind)) ? null : TEMPLATE_MSG;
}

function collectFindings(content: string): InlineMatch[] {
	// Call sites matched in the stripped view (string-embedded call text is
	// blanked there); args read from the code view at the same offset. One
	// global pass; per-hit work is window-bounded (near-linear everywhere).
	const { codeText, strippedText } = lexTwoViews(content);
	const rawLines = content.split("\n");
	// Repeated lookups over one string (both lex views preserve offsets) — the
	// precomputed O(log n) form.
	const lineIndex = buildLineIndex(codeText);

	const matches: InlineMatch[] = [];
	const seen = new Set<number>();
	const callRe = new RegExp(CALL_SITE_RE.source, "g");
	let hit: RegExpExecArray | null;
	while ((hit = callRe.exec(strippedText)) !== null) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		const lineNo = lineIndex.lineAt(hit.index + hit[0].indexOf("RegExp"));
		if (seen.has(lineNo)) continue;
		const arg = readFirstArg(codeText, hit.index + hit[0].length);
		if (arg === null) continue;
		const verdict = interpolationVerdict(arg, escapeLookbehind(strippedText, hit.index));
		if (verdict === null) continue;
		seen.add(lineNo);
		const rawText = (rawLines[lineNo - 1] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
		matches.push({ line: lineNo, text: `${CHECK_ID}: ${verdict} — ${rawText}` });
	}
	return matches;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect dynamic RegExp construction from unescaped interpolation
 * (interpolate-then-parse: data becomes pattern syntax).
 *
 * Check id: `regex_from_interpolation`
 *
 * Returns up to 10 `InlineMatch` findings per file (fields: `line`, `text`);
 * `text` is prefixed with the check id and an actionable message. Only fires
 * on JS/TS source files; test / vendored / generated files skipped.
 */
export function checkRegexFromInterpolation(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];
	if (isTestFile(filePath) || isVendoredOrFixturePath(filePath)) return [];
	if (isGeneratedFile(content)) return [];
	return collectFindings(content);
}
