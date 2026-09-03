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

/** Net brace balance of one line: `{` adds, `}` subtracts. */
function braceDelta(line: string): number {
	let delta = 0;
	for (const ch of line) {
		if (ch === "{") delta++;
		if (ch === "}") delta--;
	}
	return delta;
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
			catchDepth += braceDelta(line);
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

/**
 * True when a catch body narrows `varName` within the 10 lines after `catchLine`.
 * Narrowing counts as instanceof, a tagged-error/code property read, typeof, or an
 * `as ...Error` assertion. The scan stops at the first line that closes the block.
 */
function hasNarrowingAfterCatch(lines: string[], catchLine: number, varName: string): boolean {
	const endSearch = Math.min(catchLine + 10, lines.length);
	for (let j = catchLine + 1; j < endSearch; j++) {
		const jLine = nonNull(lines[j]);
		if (jLine.includes("}") && !jLine.includes("{")) break;
		if (
			jLine.includes("instanceof") ||
			jLine.includes(`${varName}._tag`) ||
			jLine.includes(`${varName}.code`) ||
			jLine.includes(`typeof ${varName}`) ||
			/\bas\s+\w+Error\b/.test(jLine)
		) {
			return true;
		}
	}
	return false;
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
		if (!hasNarrowingAfterCatch(lines, i, `${varName}`)) {
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

export {
	blankStringLiteralsPreserveLength,
	checkInconsistentErrorStrategy,
	checkLossyErrorRethrow,
} from "./error-handling-lossy-rethrow.js";

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

/**
 * Index of the `}` closing the catch block whose `{` sits at `openIdx`,
 * or -1 when the block never closes.
 */
function findCatchCloseIndex(stripped: string, openIdx: number): number {
	let depth = 1;
	for (let i = openIdx + 1; i < stripped.length; i++) {
		const ch = stripped[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Record every builtin-error `instanceof` dispatch between `openIdx` and `closeIdx`. */
function pushInstanceofDispatches(
	stripped: string,
	originalLines: string[],
	openIdx: number,
	closeIdx: number,
	matches: InlineMatch[],
): void {
	const instanceofRe = /\binstanceof\s+([A-Z][A-Za-z0-9_$]*)\b/g;
	instanceofRe.lastIndex = openIdx + 1;
	let opMatch: RegExpExecArray | null = instanceofRe.exec(stripped);
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
		opMatch = instanceofRe.exec(stripped);
	}
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

	let openMatch: RegExpExecArray | null = catchOpenRe.exec(stripped);
	while (openMatch !== null) {
		if (matches.length >= 10) break;
		const openIdx = openMatch.index + openMatch[0].length - 1;
		const closeIdx = findCatchCloseIndex(stripped, openIdx);
		if (closeIdx >= 0) {
			pushInstanceofDispatches(stripped, originalLines, openIdx, closeIdx, matches);
		}
		openMatch = catchOpenRe.exec(stripped);
	}

	return matches;
}

