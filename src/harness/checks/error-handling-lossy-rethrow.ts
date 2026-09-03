// Lossy-rethrow / inconsistent-strategy error-handling checks.
// Extracted from error-handling.ts (line-cap burn-down).

import { getExtension, type InlineMatch, isTestFile, JS_TS_ALL_EXTS, stripComments } from "./shared.js";

/**
 * Blank the CONTENT of every '…' / "…" / `…` literal with spaces, preserving
 * length and newlines so byte offsets stay aligned with the (comment-stripped)
 * input. Delimiters are kept. Unlike `stripStrings`, which collapses each
 * literal to a 2-char placeholder and so shifts every later offset, this keeps
 * positions stable — the arg-window paren scan in `checkLossyErrorRethrow`
 * indexes into it directly, and a `catch`/`throw`/`cause` token living inside a
 * string literal is blanked so it can't masquerade as code. Apply to
 * comment-stripped input. (Regex literals are not special-cased — matching the
 * existing strip helpers' limitation; quotes in regexes are vanishingly rare in
 * the catch/throw windows this check inspects.)
 */
export function blankStringLiteralsPreserveLength(s: string): string {
	const out = s.split("");
	const n = s.length;
	let i = 0;
	while (i < n) {
		const c = s[i];
		if (c === '"' || c === "'" || c === "`") {
			i = blankLiteralBody(s, out, i + 1, c); // `i + 1` keeps the opening delimiter
			continue;
		}
		i++;
	}
	return out.join("");
}

/**
 * Blank one literal's body in `out`, scanning from `start` (just past the
 * opening delimiter) until the matching `quote` or end of input. Escape pairs
 * are consumed two chars at a time; newlines are preserved so offsets stay
 * aligned. Returns the index just past the literal.
 */
function blankLiteralBody(s: string, out: string[], start: number, quote: string): number {
	const n = s.length;
	let i = start;
	while (i < n) {
		const ch = s[i];
		if (ch === "\\") {
			if (s[i] !== "\n") out[i] = " ";
			if (i + 1 < n && s[i + 1] !== "\n") out[i + 1] = " ";
			i += 2;
			continue;
		}
		if (ch === quote) {
			i++; // keep the closing delimiter
			break;
		}
		if (ch !== "\n") out[i] = " ";
		i++;
	}
	return i;
}

/**
 * Detect catch blocks that throw a fresh `new Error(...)` (or any `*Error`
 * subclass constructor) without forwarding the caught exception via the
 * ES2022 `{ cause: e }` option. Loses the original stack trace and breaks
 * `error.cause`-chain inspection downstream — the same shape the
 * "Errors Deserve Better" post (April 2026) flags as the lie-of-omission
 * around error rethrow.
 *
 * Fires on:
 *   catch (e) { throw new Error("wrapped"); }
 *   catch (e) { throw new TypeError(`bad: ${e}`); }
 *   catch (err) { logger.error(err); throw new HttpError("upstream"); }
 *
 * Skips:
 *   - `throw e` / `throw err` (cause already preserved by reference)
 *   - `throw new Error("msg", { cause: e })` and friends
 *   - `throw new MyError({ cause }, ...)` shorthand
 *   - `catch { ... }` with no caught variable (nothing to preserve)
 *   - test files (legitimate throw-and-rethrow patterns in fixtures)
 *
 * Args of the throw expression are scanned with strings/comments blanked,
 * so a `cause` token inside a template-literal body never silences the check.
 */
export function checkLossyErrorRethrow(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	// Single length-preserving source: comments removed, then string CONTENTS
	// blanked in place. Detection and the `{ cause }` arg-window check both run
	// on `code` so (a) a `catch`/`throw` token inside a string literal can't
	// masquerade as code, and (b) byte offsets stay aligned (stripStrings
	// collapses literals and would shift the cause-window slice). Line numbers
	// come from counting preserved newlines.
	const code = blankStringLiteralsPreserveLength(stripComments(content));
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const catchOpenRe = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g;
	const ERROR_CTOR_RE =
		/\bthrow\s+new\s+(?:[A-Z][A-Za-z0-9_$]*Error|Error|TypeError|RangeError|SyntaxError|EvalError|URIError|AggregateError)\s*\(/g;

	let openMatch: RegExpExecArray | null = catchOpenRe.exec(code);
	while (openMatch !== null && matches.length < 10) {
		const catchVar = openMatch[1];
		const openIdx = openMatch.index + openMatch[0].length - 1;
		const closeIdx = findBraceClose(code, openIdx);

		if (closeIdx >= 0) {
			collectLossyRethrowsInCatch(
				code,
				catchVar,
				openIdx + 1,
				closeIdx,
				originalLines,
				ERROR_CTOR_RE,
				matches,
			);
		}

		openMatch = catchOpenRe.exec(code);
	}

	return matches;
}

/**
 * Depth-count forward from just past an opening `{` (whose own index is
 * `openIdx`) to find the index of its matching `}`. Returns -1 if the brace
 * never closes before EOF.
 */
function findBraceClose(code: string, openIdx: number): number {
	let depth = 1;
	for (let i = openIdx + 1; i < code.length; i++) {
		const ch = code[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Depth-count forward from the position just after a call's opening `(` to
 * find the index of its matching `)`, never scanning past `limit` (the
 * enclosing catch block's own close). Returns -1 if the call's parens never
 * balance before `limit`.
 */
function findParenClose(code: string, argsStart: number, limit: number): number {
	let depth = 1;
	for (let i = argsStart; i < code.length && i < limit; i++) {
		const ch = code[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Scan one catch block's body (`[bodyStart, closeIdx)` of `code`) for
 * `throw new *Error(...)` sites that drop the caught exception, pushing a
 * match for each one that lacks a `{ cause }` option. Stops early once
 * `matches` reaches the shared 10-match cap.
 */
function collectLossyRethrowsInCatch(
	code: string,
	catchVar: string | undefined,
	bodyStart: number,
	closeIdx: number,
	originalLines: string[],
	errorCtorRe: RegExp,
	matches: InlineMatch[],
): void {
	errorCtorRe.lastIndex = bodyStart;
	let throwMatch: RegExpExecArray | null = errorCtorRe.exec(code);
	while (throwMatch !== null && throwMatch.index < closeIdx && matches.length < 10) {
		const argsStart = throwMatch.index + throwMatch[0].length;
		const argsEnd = findParenClose(code, argsStart, closeIdx);
		if (argsEnd < 0) break;

		const argsWindow = code.slice(argsStart, argsEnd);
		const preservesCause = /\bcause\s*[:,}]/.test(argsWindow);
		if (!preservesCause) {
			const lineNum = code.slice(0, throwMatch.index).split("\n").length;
			matches.push({
				line: lineNum,
				text: `throw new Error in catch(${catchVar}) without { cause: ${catchVar} } — original stack lost: ${(originalLines[lineNum - 1] ?? "").trim().slice(0, 100)}`,
			});
		}
		throwMatch = errorCtorRe.exec(code);
	}
}

/** Detect inconsistent error strategy in a single file: mix of throw + return { error } + return null */
export function checkInconsistentErrorStrategy(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];
	if (content.split("\n").length < 20) return [];

	const stripped = stripComments(content);

	const throwCount = (stripped.match(/\bthrow\s+new\s+\w*Error/g) || []).length;
	const returnNullCount = (stripped.match(/\breturn\s+null\s*;/g) || []).length;
	const returnErrorObjCount = (
		stripped.match(/\breturn\s+\{\s*(?:error|success\s*:\s*false)/g) || []
	).length;

	const strategies = [throwCount > 0, returnNullCount > 1, returnErrorObjCount > 0].filter(
		Boolean,
	).length;

	if (strategies >= 3) {
		return [
			{
				line: 1,
				text: `file uses ${strategies} different error strategies (throw: ${throwCount}, return null: ${returnNullCount}, return {error}: ${returnErrorObjCount}) — pick one approach, preferably Result types or typed error returns`,
			},
		];
	}

	return [];
}
