// Error-handling taste checks (bare catch, untyped catch, throw-as-control-flow, etc).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	pushBareCatchOneLiner,
	pushBarePythonExcept,
	pushCommentOnlyCatch,
} from "./error-handling-bare-catch.js";
import { getExtension, type InlineMatch, isTestFile, JS_TS_ALL_EXTS, stripComments } from "./shared.js";

// ===========================================
// Taste Enforcement: Error Handling Quality
// ===========================================
// These checks push agents toward explicit, composable error handling
// and away from patterns that silently lose error context.

/** Detect bare catch blocks: catch {} or catch with only a comment inside */
export function checkBareCatchBlock(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext) && ext !== ".py") return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = nonNull(lines[i]);
		// JS/TS: catch (...) { } or catch { } on same line
		if (pushBareCatchOneLiner(line, i, matches)) {
			// The shared `matches.length >= 10` cap below is unreachable from this
			// branch's `continue` — check it here too, or a file with many bare
			// one-liner catches never caps (source defect found via mutation testing
			// 2026-07-31: a bound test expecting exactly 10 got 11).
			if (matches.length >= 10) break;
			continue;
		}
		// catch block with only a comment inside
		pushCommentOnlyCatch(lines, i, matches);
		// Python: except: pass / except Exception: pass
		if (ext === ".py") pushBarePythonExcept(lines, i, matches);
		if (matches.length >= 10) break;
	}

	return matches;
}

/** Detect catch-and-return-null: catch (e) { return null/undefined } — lossy error handling */
export function checkCatchReturnNull(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	let inCatch = false;
	let catchLine = 0;
	let catchDepth = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = nonNull(lines[i]);
		if (/\bcatch\s*(\([^)]*\))?\s*\{/.test(line)) {
			inCatch = true;
			catchLine = i;
			// Start at depth 1 — we're already inside the catch block's opening brace.
			// Count additional braces from the NEXT line to avoid the `} catch {` line
			// where the closing `}` of try and opening `{` of catch net to zero.
			catchDepth = 1;
			continue;
		}
		if (inCatch) {
			for (const ch of line) {
				if (ch === "{") catchDepth++;
				if (ch === "}") catchDepth--;
			}
			if (/\breturn\s+(null|undefined)\s*;?/.test(line)) {
				const catchText = nonNull(lines[catchLine]).trim().slice(0, 80);
				matches.push({
					line: i + 1,
					text: `return null/undefined in catch — error context is lost: ${catchText}`,
				});
			}
			if (catchDepth <= 0) inCatch = false;
		}
		if (matches.length >= 10) break;
	}

	return matches;
}

/** Detect throw-as-control-flow: throwing for expected conditions (not found, validation) */
export function checkThrowAsControlFlow(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripComments(content);
	const lines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const CONTROL_FLOW_THROWS =
		/\bthrow\s+new\s+(?:Error|TypeError|RangeError)\s*\(\s*["'`](?:not found|invalid|missing|expected|no such|does not exist|cannot find|failed to)/i;

	for (let i = 0; i < lines.length; i++) {
		if (CONTROL_FLOW_THROWS.test(nonNull(lines[i]))) {
			matches.push({
				line: i + 1,
				text: `throw for expected condition — return a Result or error value instead: ${nonNull(originalLines[i]).trim().slice(0, 120)}`,
			});
		}
		if (matches.length >= 5) break;
	}

	return matches;
}

/** Detect untyped catch: catch (e) without type narrowing or instanceof check */
export function checkUntypedCatch(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripComments(content);
	const lines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < lines.length; i++) {
		const catchMatch = nonNull(lines[i]).match(/\bcatch\s*\(\s*(\w+)\s*\)\s*\{/);
		if (!catchMatch) continue;

		const varName = catchMatch[1];
		let hasNarrowing = false;
		const endSearch = Math.min(i + 10, lines.length);
		for (let j = i + 1; j < endSearch; j++) {
			const jLine = nonNull(lines[j]);
			if (nonNull(jLine).includes("}") && !nonNull(jLine).includes("{")) break;
			if (
				nonNull(jLine).includes("instanceof") ||
				nonNull(jLine).includes(`${varName}._tag`) ||
				nonNull(jLine).includes(`${varName}.code`) ||
				nonNull(jLine).includes(`typeof ${varName}`) ||
				/\bas\s+\w+Error\b/.test(jLine)
			) {
				hasNarrowing = true;
				break;
			}
		}

		if (!hasNarrowing) {
			matches.push({
				line: i + 1,
				text: `untyped catch(${varName}) without narrowing — use instanceof, tagged errors, or error codes: ${nonNull(originalLines[i]).trim().slice(0, 100)}`,
			});
		}
		if (matches.length >= 5) break;
	}

	return matches;
}

/** Detect error string comparison: if (err.message === "...") — fragile pattern */
export function checkErrorStringComparison(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripComments(content);
	const lines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const ERR_MSG_CMP = /\.message\s*===?\s*["'`]|\.message\.includes\s*\(\s*["'`]/;

	for (let i = 0; i < lines.length; i++) {
		if (ERR_MSG_CMP.test(nonNull(lines[i]))) {
			matches.push({
				line: i + 1,
				text: `comparing error.message string — fragile, use error codes or instanceof instead: ${nonNull(originalLines[i]).trim().slice(0, 120)}`,
			});
		}
		if (matches.length >= 5) break;
	}

	return matches;
}

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
			const quote = c;
			i++; // keep the opening delimiter
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
			continue;
		}
		i++;
	}
	return out.join("");
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

/**
 * Detect `instanceof <BuiltinError>` dispatch inside a catch block.
 *
 * Effect-TS lessons port (docs/design/effect-ts-harness-additions.md §2.1).
 * Effect dispatches errors via `Effect.catchTag("NetworkError", ...)` — tag
 * discrimination on a structural field, not nominal class identity. The
 * vanilla-JS `instanceof Error` analog is fragile: it returns false across
 * realm boundaries (iframes, worker contexts, vm.runInContext), so a real
 * `Error` instance from another realm slips past the branch and ends up
 * in whatever the catch's fall-through path does.
 *
 * Limited to the JS-builtin error classes (`Error`, `TypeError`,
 * `RangeError`, `SyntaxError`, `EvalError`, `URIError`, `ReferenceError`,
 * `AggregateError`) — user-defined error subclasses can legitimately be
 * dispatched on, because no cross-realm leakage applies and the project
 * controls construction.
 */
const BUILTIN_ERROR_CLASSES = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"SyntaxError",
	"EvalError",
	"URIError",
	"ReferenceError",
	"AggregateError",
]);

/**
 * The rule exempts the "is this any thrown Error at all?" guard when it is
 * message/property EXTRACTION rather than subtype dispatch — e.g.
 * `e instanceof Error ? e.message : String(e)`. A cross-realm Error that slips
 * past the guard just takes the fallback branch, which yields an equivalent
 * string; no divergent handler is selected, so the realm-boundary fragility is
 * harmless here. Only the BASE `Error` qualifies (subtype checks like
 * `instanceof TypeError` remain genuine dispatch), and the ternary consequent
 * must read a message-ish property off the operand or stringify it.
 */
export function isMessageExtractionGuard(
	className: string,
	stripped: string,
	afterIdx: number,
): boolean {
	if (className !== "Error") return false;
	const after = stripped.slice(afterIdx, afterIdx + 120);
	return /^\s*\?\s*(?:[\w$]+\s*\.\s*(?:message|stack|name|cause)\b|[\w$]+\s*\.\s*toString\s*\(|String\s*\()/.test(
		after,
	);
}

export function checkErrorDispatchByInstanceof(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const catchOpenRe = /\bcatch\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*\{/g;
	const INSTANCEOF_RE = /\binstanceof\s+([A-Z][A-Za-z0-9_$]*)\b/g;

	let openMatch: RegExpExecArray | null = catchOpenRe.exec(stripped);
	while (openMatch !== null) {
		if (matches.length >= 10) break;
		const openIdx = openMatch.index + openMatch[0].length - 1;
		let depth = 1;
		let closeIdx = -1;
		for (let i = openIdx + 1; i < stripped.length; i++) {
			const ch = stripped[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					closeIdx = i;
					break;
				}
			}
		}
		if (closeIdx < 0) {
			openMatch = catchOpenRe.exec(stripped);
			continue;
		}

		INSTANCEOF_RE.lastIndex = openIdx + 1;
		let opMatch: RegExpExecArray | null = INSTANCEOF_RE.exec(stripped);
		while (opMatch !== null && opMatch.index < closeIdx) {
			if (matches.length >= 10) break;
			const className = nonNull(opMatch[1]);
			const afterIdx = opMatch.index + opMatch[0].length;
			if (
				BUILTIN_ERROR_CLASSES.has(className) &&
				!isMessageExtractionGuard(className, stripped, afterIdx)
			) {
				const lineNum = stripped.slice(0, opMatch.index).split("\n").length;
				matches.push({
					line: lineNum,
					text: `instanceof ${className} inside catch — fragile across realm boundaries; dispatch on a _tag/code/name field instead: ${(originalLines[lineNum - 1] ?? "").trim().slice(0, 120)}`,
				});
			}
			opMatch = INSTANCEOF_RE.exec(stripped);
		}

		openMatch = catchOpenRe.exec(stripped);
	}

	return matches;
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
