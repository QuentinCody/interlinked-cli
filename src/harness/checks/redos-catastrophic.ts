// ReDoS — catastrophic-backtracking regex detector (a distinct algorithmic-
// complexity / DoS bug class). A quantified group whose body ALSO contains an
// unbounded quantifier — (a+)+, (\d*)*, ([a-z]+)* — matches adversarial input in
// exponential time, turning one crafted request into a CPU-pegging hang.
//
// FP discipline: we extract the actual regex BODY (from a `/.../ ` literal, a
// `new RegExp("…")`, or a Python `re.<fn>("…")`) and test the nested-quantifier
// signature ONLY on that body. Testing raw code would false-positive on ordinary
// arithmetic like `(x+1)*2`. Ext-gated to JS/TS (literals + RegExp) and Python
// (re.*). Returns InlineMatch[].

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	isVendoredOrFixturePath,
	lineHasNoqaSuppression,
} from "./shared.js";

const JS_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
const PY_EXTS = new Set([".py", ".pyi"]);
const MATCH_LIMIT = 10;

/** A quantified group `(…+…)` or `(…*…)` immediately re-quantified by `+ * {n,}`.
 *  Bodies are bounded (no nested parens, ≤80 chars) so the detector is itself
 *  linear — never a ReDoS. */
const NESTED_QUANT = /\([^()]{0,80}?[+*][^()]{0,80}?\)\s*(?:[*+]|\{\d+,\}?)/;

/** Pull candidate regex bodies out of one line for the given language. */
function regexBodies(line: string, isPy: boolean): string[] {
	const bodies: string[] = [];
	if (isPy) {
		// re.compile / match / search / fullmatch / sub / split / findall("…")
		const re =
			/\bre\.(?:compile|match|search|fullmatch|sub|subn|split|findall|finditer)\s*\(\s*r?(['"])((?:\\.|(?!\1)[^\\]){0,200})\1/g;
		for (const m of line.matchAll(re)) if (m[2]) bodies.push(m[2]);
		return bodies;
	}
	// JS: new RegExp("…") / RegExp('…')
	const rr = /\bRegExp\s*\(\s*(['"])((?:\\.|(?!\1)[^\\]){0,200})\1/g;
	for (const m of line.matchAll(rr)) if (m[2]) bodies.push(m[2]);
	// JS regex literal /…/flags — not preceded by an identifier/`)` (avoids division).
	const lit = /(?<![\w)$\]])\/((?:\\.|[^/\\\n]){1,200})\/[gimsuy]*/g;
	for (const m of line.matchAll(lit)) if (m[1]) bodies.push(m[1]);
	return bodies;
}

/** Running block-comment state while walking a file's lines. */
interface CommentScan {
	inBlock: boolean;
}

/**
 * True when this line carries no scannable code — it is wholly a comment.
 *
 * A JSDoc block has the exact shape of a regex literal (`/`, body, `/`), so
 * without this the scanner reads prose as a pattern: the 2026-08-04 corpus run
 * found 5 such hits, every one a comment documenting a regex rather than a
 * regex. Deliberately WHOLE-LINE only — every observed false positive was a
 * full-line comment, and stripping mid-line comment spans would require
 * distinguishing `//` inside a string literal from a real comment, which would
 * break the `RegExp("…")` extraction this detector depends on.
 *
 * Mutates `state` to carry block-comment nesting across lines.
 */
function isCommentOnlyLine(line: string, state: CommentScan): boolean {
	const trimmed = line.trim();
	if (state.inBlock) {
		// A block that closes mid-line leaves trailing code, which must be scanned.
		const close = trimmed.indexOf("*/");
		if (close === -1) return true;
		state.inBlock = false;
		return trimmed.slice(close + 2).trim().length === 0;
	}
	if (trimmed.startsWith("//")) return true;
	if (trimmed.startsWith("#")) return true; // Python comment
	if (!trimmed.startsWith("/*") && !trimmed.startsWith("*")) return false;
	if (trimmed.startsWith("*")) return true; // JSDoc continuation line
	const close = trimmed.indexOf("*/");
	if (close === -1) {
		state.inBlock = true;
		return true;
	}
	return trimmed.slice(close + 2).trim().length === 0;
}

/**
 * Evaluate one line for a catastrophic-backtracking regex and return the
 * match to record, or null when the line clears every gate. Mutates
 * `commentState` to carry block-comment nesting across lines (must run on
 * every line, including ones skipped later, so state cannot desync).
 */
function redosMatchForLine(
	line: string,
	lineIndex: number,
	isPy: boolean,
	commentState: CommentScan,
): InlineMatch | null {
	const isComment = isCommentOnlyLine(line, commentState);
	if (isComment) return null;
	if (!line.includes("(")) return null; // every ReDoS signature needs a group
	let hit = false;
	for (const body of regexBodies(line, isPy)) {
		if (NESTED_QUANT.test(body)) {
			hit = true;
			break;
		}
	}
	if (!hit) return null;
	if (lineHasNoqaSuppression(line, "redos_catastrophic")) return null;
	return { line: lineIndex + 1, text: line.trim().slice(0, 150) };
}

export function checkRedosCatastrophic(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isPy = PY_EXTS.has(ext);
	if (!isPy && !JS_EXTS.has(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const commentState: CommentScan = { inBlock: false };
	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = lines[i] ?? "";
		const match = redosMatchForLine(line, i, isPy, commentState);
		if (match) matches.push(match);
	}
	return matches;
}
