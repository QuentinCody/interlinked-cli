// ============================================================
// Comment-vs-behavior drift detectors (Mythos blog adaptation)
// ============================================================
// Adapted from the Mythos AI security analysis of curl
// (daniel.haxx.se, 2026-05-11) — "spotting contradictions between
// code comments and actual behavior" was the strongest signal in
// that analysis. We translate it into deterministic regex+AST rules
// instead of LLM inference per feedback_harness_deterministic_only.
//
// Five narrow detectors, each per-function:
//   - comment_claims_limit_no_guard       "max N" / "at most N" / "limited to N"
//   - comment_claims_null_throws_instead  "returns null" / "may return undefined"
//   - comment_claims_validation_missing   "validates X" / "sanitizes Y" / "escapes Z"
//   - comment_claims_idempotent_mutates   "idempotent" + unconditional mutation
//   - comment_claims_throws_doesnt        "@throws ErrorX" + no `throw new ErrorX`
//
// All return InlineMatch[] keyed on the comment line, so the agent
// sees WHICH claim is broken without having to scan the function.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isGeneratedFile,
	isTestFile,
	JS_TS_EXTS,
} from "./shared.js";

interface FunctionWithLeadingComment {
	/** 1-based line of the comment's first line. */
	commentLine: number;
	/** Raw comment text (block or contiguous line comments). */
	commentText: string;
	/** 1-based line where the function body opens. */
	bodyStartLine: number;
	/** Body slice — between matching `{` and `}` of the function. */
	bodyText: string;
}

/** Apply common pre-filters: skip non-source, tests, generated. */
function shouldSkip(filePath: string, content: string): boolean {
	const ext = getExtension(filePath);
	if (!JS_TS_EXTS.has(ext)) return true;
	if (isTestFile(filePath)) return true;
	if (isGeneratedFile(content)) return true;
	return false;
}

/** Collect each function declaration in `content` together with its
 *  immediately-preceding doc comment (JSDoc or contiguous `//` lines).
 *  Functions without a leading comment are skipped — the detectors
 *  only fire on EXPLICIT contract claims, never on missing prose. */
export function collectAnnotatedFunctions(
	content: string,
): FunctionWithLeadingComment[] {
	const out: FunctionWithLeadingComment[] = [];
	const lines = content.split("\n");

	// Regex: function-like declarations on a single line. Captures
	// arrow consts too — `export const foo = (...) => {` and
	// `function foo(...) {`. We require a `{` on the same line to
	// keep the heuristic tight; multi-line signatures are skipped.
	const declRe =
		/^(?:\s*)(?:export\s+)?(?:async\s+)?(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>)/;

	for (const [i, declLine] of lines.entries()) {
		if (!declRe.test(declLine)) continue;
		// Walk backwards collecting the comment block above this line.
		const { commentLine, commentText } = harvestLeadingComment(lines, i);
		if (!commentText) continue;

		const bodyOpenIdx = findBodyOpenIdx(content, lineOffset(lines, i));
		if (bodyOpenIdx === -1) continue;
		const bodyEndIdx = findMatchingBrace(content, bodyOpenIdx);
		if (bodyEndIdx === -1) continue;

		out.push({
			commentLine,
			commentText,
			bodyStartLine: i + 1,
			bodyText: content.slice(bodyOpenIdx + 1, bodyEndIdx),
		});
	}
	return out;
}

function harvestLeadingComment(
	lines: string[],
	declIdx: number,
): { commentLine: number; commentText: string } {
	let j = declIdx - 1;
	// Skip blank lines between comment and decl.
	while (j >= 0 && nonNull(lines[j]).trim() === "") j--;
	if (j < 0) return { commentLine: 0, commentText: "" };

	const last = nonNull(lines[j]).trim();
	if (last.endsWith("*/")) {
		// Block comment — walk back to `/*`.
		let k = j;
		while (k >= 0 && !nonNull(lines[k]).trim().startsWith("/*")) k--;
		if (k < 0) return { commentLine: 0, commentText: "" };
		return { commentLine: k + 1, commentText: lines.slice(k, j + 1).join("\n") };
	}
	if (last.startsWith("//")) {
		// Contiguous line comments — walk back.
		let k = j;
		while (k >= 0 && nonNull(lines[k]).trim().startsWith("//")) k--;
		return {
			commentLine: k + 2,
			commentText: lines.slice(k + 1, j + 1).join("\n"),
		};
	}
	return { commentLine: 0, commentText: "" };
}

function lineOffset(lines: string[], targetIdx: number): number {
	let off = 0;
	for (let i = 0; i < targetIdx; i++) off += nonNull(lines[i]).length + 1; // +1 for \n
	return off;
}

function findBodyOpenIdx(content: string, declLineStart: number): number {
	// Find the first `{` on or after the declaration line, but skip
	// `{` chars inside type annotations like `: { x: number }` by
	// requiring it to be the LAST `{` on the line.
	const nl = content.indexOf("\n", declLineStart);
	const lineEnd = nl === -1 ? content.length : nl;
	const line = content.slice(declLineStart, lineEnd);
	const lastOpen = line.lastIndexOf("{");
	if (lastOpen === -1) return -1;
	return declLineStart + lastOpen;
}

function findMatchingBrace(content: string, openIdx: number): number {
	let depth = 1;
	let i = openIdx + 1;
	while (i < content.length && depth > 0) {
		const ch = content[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		i++;
	}
	return depth === 0 ? i - 1 : -1;
}

const MAX_COMMENT_PREVIEW_CHARS = 150;

function asMatch(line: number, commentText: string): InlineMatch {
	// Use the first line of the comment as the displayed text — the
	// claim that drove the finding.
	const firstLine = nonNull(commentText.split("\n")[0]).trim();
	return {
		line,
		text: firstLine.length > MAX_COMMENT_PREVIEW_CHARS ? `${firstLine.slice(0, MAX_COMMENT_PREVIEW_CHARS - 1)}…` : firstLine,
	};
}

// -----------------------------------------------------------------
// Detector 1: "max N" / "at most N" / "limited to N" with no guard
// -----------------------------------------------------------------

const LIMIT_CLAIM_RE =
	/\b(?:max(?:imum)?|at\s*most|limited\s*to|up\s*to|no\s*more\s*than)(?:\s+of)?\s+(\d+)\b/i;

export function checkCommentClaimsLimitNoGuard(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (shouldSkip(filePath, content)) return [];
	const out: InlineMatch[] = [];
	for (const fn of collectAnnotatedFunctions(content)) {
		const m = LIMIT_CLAIM_RE.exec(fn.commentText);
		if (!m) continue;
		const claimed = m[1];
		// Look for ANY guard mentioning that number — `< N`, `<= N`,
		// `> N`, `>= N`, `length === N`, `slice(0, N)`, etc. The check
		// is tolerant: any reference to the number is treated as a
		// guard. False positives here are worse than false negatives.
		const guardRe = new RegExp(`(?:<=?|>=?|===|!==|==|!=|slice|substring|limit\\s*:|maxLength\\s*[:=])\\s*[^\\n]{0,40}\\b${claimed}\\b`);
		if (guardRe.test(fn.bodyText)) continue;
		// Also pass when the literal number appears anywhere in body
		// — heuristic: explicit number reference suggests awareness.
		const literalRe = new RegExp(`\\b${claimed}\\b`);
		if (literalRe.test(fn.bodyText)) continue;
		out.push(asMatch(fn.commentLine, fn.commentText));
	}
	return out;
}

// -----------------------------------------------------------------
// Detector 2: "returns null on failure" / "may return undefined"
// -----------------------------------------------------------------

const NULL_CLAIM_RE =
	/\b(?:returns?\s+null\s+(?:on|when|if)|may\s+return\s+(?:null|undefined)|returns?\s+undefined\s+(?:on|when|if))\b/i;
const TRY_BLOCK_RE = /\btry\s*\{/;

export function checkCommentClaimsNullThrowsInstead(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (shouldSkip(filePath, content)) return [];
	const out: InlineMatch[] = [];
	for (const fn of collectAnnotatedFunctions(content)) {
		if (!NULL_CLAIM_RE.test(fn.commentText)) continue;
		// Look for `throw` not enclosed in a try-block. We approximate
		// by checking: if the body contains `throw` AND does NOT
		// contain `try {` ahead of all throws, fire. (More precise
		// dominance analysis would require an AST; the heuristic is
		// tolerant.)
		if (!/\bthrow\s+/.test(fn.bodyText)) continue;
		if (TRY_BLOCK_RE.test(fn.bodyText)) continue;
		out.push(asMatch(fn.commentLine, fn.commentText));
	}
	return out;
}

// -----------------------------------------------------------------
// Detector 3: "validates X" / "sanitizes Y" / "escapes Z"
// -----------------------------------------------------------------

const VALIDATION_CLAIM_RE = /\b(?:validate[sd]?|sanitize[sd]?|escape[sd]?)\b/i;
// Body must contain at least ONE of: conditional, regex, encode/escape call.
const VALIDATION_EVIDENCE_RE =
	/(?:\bif\s*\(|[!=]==|<=?|>=?|\.test\s*\(|\.match\s*\(|\.replace\s*\(|encodeURI(?:Component)?\s*\(|escape\w*\s*\(|sanitize\w*\s*\(|validate\w*\s*\(|\bregex\b)/i;

export function checkCommentClaimsValidationMissing(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (shouldSkip(filePath, content)) return [];
	const out: InlineMatch[] = [];
	for (const fn of collectAnnotatedFunctions(content)) {
		if (!VALIDATION_CLAIM_RE.test(fn.commentText)) continue;
		if (VALIDATION_EVIDENCE_RE.test(fn.bodyText)) continue;
		out.push(asMatch(fn.commentLine, fn.commentText));
	}
	return out;
}

// -----------------------------------------------------------------
// Detector 4: "idempotent" + mutation outside guard
// -----------------------------------------------------------------

const IDEMPOTENT_CLAIM_RE = /\bidempoten(?:t|cy|tly)\b/i;
const MUTATION_RE =
	/(?:[\w$]+\s*(?:\+\+|--|\+=|-=|\*=|\/=|%=|\|=|&=|\^=)|\.set\s*\(|\.push\s*\(|\.pop\s*\(|\.shift\s*\(|\.unshift\s*\(|\.delete\s*\()/;
const GUARD_RE = /\bif\s*\(|\?\?|\.has\s*\(|\.includes\s*\(|=\s*=\s*=/;

export function checkCommentClaimsIdempotentMutates(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (shouldSkip(filePath, content)) return [];
	const out: InlineMatch[] = [];
	for (const fn of collectAnnotatedFunctions(content)) {
		if (!IDEMPOTENT_CLAIM_RE.test(fn.commentText)) continue;
		if (!MUTATION_RE.test(fn.bodyText)) continue;
		if (GUARD_RE.test(fn.bodyText)) continue;
		out.push(asMatch(fn.commentLine, fn.commentText));
	}
	return out;
}

// -----------------------------------------------------------------
// Detector 5: "@throws ErrorX" + body never throws ErrorX
// -----------------------------------------------------------------

const THROWS_TAG_RE = /@throws\s*(?:\{([A-Z][\w.$]*)\}|([A-Z][\w.$]*))/g;

export function checkCommentClaimsThrowsDoesnt(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (shouldSkip(filePath, content)) return [];
	const out: InlineMatch[] = [];
	for (const fn of collectAnnotatedFunctions(content)) {
		THROWS_TAG_RE.lastIndex = 0;
		const claimed: string[] = [];
		let m: RegExpExecArray | null = THROWS_TAG_RE.exec(fn.commentText);
		while (m !== null) {
			const name = m[1] || m[2];
			if (name) claimed.push(name);
			m = THROWS_TAG_RE.exec(fn.commentText);
		}
		if (claimed.length === 0) continue;
		const missing = claimed.filter((errName) => {
			// Match `throw new ErrorX(` OR `throw ErrorX` references.
			const re = new RegExp(`\\bthrow\\s+(?:new\\s+)?${errName.replace(/\./g, "\\.")}\\s*\\(`);
			return !re.test(fn.bodyText);
		});
		if (missing.length === 0) continue;
		out.push(asMatch(fn.commentLine, fn.commentText));
	}
	return out;
}
