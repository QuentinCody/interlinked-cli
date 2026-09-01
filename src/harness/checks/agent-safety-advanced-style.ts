// interlinked-tdd: exempt
// Agent-safety checks — self-contained correctness/style detectors.
// Extracted verbatim from agent-safety-advanced.ts to stay under the line cap.
// Each function depends only on ./shared.js helpers (no project-graph / fs / path).

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// --- 6. Additional correctness/style ---

/**
 * Detect throw of non-Error values: `throw "message"`, `throw 0`, `throw undefined`.
 * Throwing non-Error objects loses stack traces and breaks instanceof Error checks.
 */
export function checkThrowLiteral(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = nonNull(strippedLines[i]).trim();
		// throw followed by a string literal, number, boolean, null, undefined, or a variable (not `new`)
		// We check original content for string literals since stripped content removes them
		if (/^\bthrow\s+/.test(trimmed)) {
			const afterThrow = trimmed.replace(/^throw\s+/, "");
			// Skip: throw new Error(...), throw new SomeError(...)
			if (/^new\s+/.test(afterThrow)) continue;
			// Skip: throw someVar (could be an Error instance — too ambiguous)
			// Only flag obvious literals: throw "...", throw 0, throw true, throw null, throw undefined
			const origTrimmed = nonNull(originalLines[i]).trim().replace(/^throw\s+/, "");
			if (
				/^["'`]/.test(origTrimmed) ||
				/^\d+/.test(afterThrow) ||
				/^(true|false|null|undefined)\b/.test(afterThrow)
			) {
				matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
			}
		}
	}
	return matches;
}

/**
 * Detect unvalidated JSON.parse / res.json() / req.json() flow — a cold-agent
 * reading `const data = JSON.parse(raw)` followed by `data.someField` has no
 * cue what shape `data` is supposed to have, and no runtime protection if the
 * parsed value doesn't match. This check flags cases where the parsed value
 * reaches property access WITHOUT being piped through a schema parser first.
 *
 * Triggers on:
 *   - `const/let/var <v> = JSON.parse(...)`
 *   - `const/let/var <v> = await <expr>.json()` (fetch/Response/Request body)
 *
 * Resolves as safe if within the next `SCAN_AHEAD` lines `<v>` appears as the
 * argument to `.parse(`, `.safeParse(`, `.decode(`, `.check(`, or
 * `.validate(` — covering zod, valibot, ajv, yup, io-ts, arktype, superstruct,
 * and friends.
 *
 * Flags as unsafe if `<v>.<field>` appears before any validation call.
 * Otherwise (value returned, passed to a function, etc.) we can't tell — skip
 * to keep the FP rate near zero.
 *
 * Skips test files and non-JS/TS files.
 */
export function checkUnvalidatedJsonBoundary(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const SCAN_AHEAD = 15;

	// Assignment form: `const/let/var <v> = (await )?(JSON.parse|<ident>.json)(`.
	const ASSIGN =
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?\s*=\s*(?:await\s+)?(?:JSON\.parse|[\w.]+\.json)\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);

		const m = ASSIGN.exec(line);
		if (!m) continue;
		const varName = m[1];

		// Regex escape via alternation: varName is an identifier, safe.
		const propAccess = new RegExp(`\\b${varName}\\.[A-Za-z_$]`);
		// Schema-library method call. `(?<!JSON)` keeps a RE-parse
		// (`JSON.parse(v)`) from counting as validation — JSON.parse asserts
		// nothing about shape.
		const validated = new RegExp(
			`(?<!JSON)\\.(?:parse|safeParse|decode|check|validate)\\s*\\(\\s*${varName}\\b`,
		);
		// Local validator (boundary-parser campaign): a bare `parseX(v)` /
		// `isX(v)` / `validateX(v)` / `normalizeX(v)` call with the value as
		// first argument IS the validation this check demands — the swept
		// pattern routes JSON through `parseFoo(v: unknown): Foo | null`
		// instead of a schema library. The lookbehind rejects dotted calls
		// (`JSON.parse`, `foo.isX`) so only file-local helpers count.
		const localValidator = new RegExp(
			`(?<![.\\w$])(?:is|parse|validate|normalize)[\\w$]*\\s*\\(\\s*${varName}\\b`,
		);
		// An Array.isArray gate is shape validation too — the per-element
		// mapper after it is usually a bare function REFERENCE
		// (`parsed.map(parseRow)`), which call-shaped recognition can't see.
		const arrayGate = new RegExp(`\\bArray\\.isArray\\s*\\(\\s*${varName}\\b`);

		let flag = false;
		for (let j = i + 1; j < Math.min(strippedLines.length, i + 1 + SCAN_AHEAD); j++) {
			const forward = nonNull(strippedLines[j]);
			if (validated.test(forward) || localValidator.test(forward) || arrayGate.test(forward)) {
				flag = false;
				break;
			}
			if (propAccess.test(forward)) {
				flag = true;
				break;
			}
		}

		if (flag) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect `Promise.reject(<literal>)` — rejecting with a non-Error value.
 * Same failure mode as `throw "string"`: breaks `instanceof Error`, drops
 * the stack trace, and forces downstream catchers to `typeof`-narrow instead
 * of using structured error types.
 *
 * Conservative regex: only `Promise.reject(<literal>)` on one line. Does NOT
 * flag `reject("...")` inside a `new Promise((resolve, reject) => ...)`
 * executor body because plain `reject` is a parameter name and the detection
 * would FP on any executor rebound to a same-named variable.
 */
export function checkPromiseRejectNonError(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `Promise.reject(` followed by a literal we recognize as non-Error.
	// Literals: string (', ", or `), number, true/false/null/undefined.
	const NON_ERROR_ARG = /Promise\.reject\s*\(\s*(?:["'`]|-?\d|true\b|false\b|null\b|undefined\b)/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (NON_ERROR_ARG.test(nonNull(strippedLines[i]))) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

// checkTemplateCurlyInString and checkSelfCompare were removed — regex-based detection
// has too many false positives (embedded shell scripts, property access chains).
// These are better caught by oxlint with AST analysis (no-template-curly-in-string, no-self-compare).

/**
 * Detect async functions that never use await.
 * The async keyword is unnecessary and misleading — it wraps the return in a Promise for no reason.
 */
// Brace-track from line `start` (which opens a block somewhere on/after it) to
// the line that closes it. Returns `bodyStarted: false` when no `{` was ever
// seen; `bodyEnd` is the line index of the closing brace (or the last line).
function findBlockEndByBrace(
	lines: string[],
	start: number,
): { bodyStarted: boolean; bodyEnd: number } {
	let braceDepth = 0;
	let bodyStarted = false;
	let bodyEnd = start;
	for (let j = start; j < lines.length; j++) {
		for (const ch of nonNull(lines[j])) {
			if (ch === "{") {
				braceDepth++;
				bodyStarted = true;
			}
			if (ch === "}") braceDepth--;
		}
		if (bodyStarted && braceDepth <= 0) {
			bodyEnd = j;
			break;
		}
	}
	return { bodyStarted, bodyEnd };
}

// Decide whether an async function body is "fine as async" — i.e. should NOT be
// flagged by checkRequireAwait. True when it awaits, is short enough to be a
// trivial wrapper, or references promise machinery (.then/.catch/.finally,
// Promise, or a short delegating `return fn(...)`).
function asyncBodyIsAcceptable(
	bodyText: string,
	originalBodyText: string,
	bodyLen: number,
): boolean {
	// Search both stripped and original body text for await — stripping can
	// sometimes remove await inside template literals or complex expressions.
	if (/\bawait\b/.test(bodyText) || /\bawait\b/.test(originalBodyText)) return true;
	// Short functions (≤5 lines) — likely just wrapping/delegating.
	if (bodyLen <= 5) return true;
	// Bodies that reference promise-related patterns.
	if (/\.(then|catch|finally)\s*\(/.test(bodyText)) return true;
	if (/\bPromise\b/.test(bodyText) || /\bPromise\b/.test(originalBodyText)) return true;
	if (/\breturn\s+\w+\s*\(/.test(bodyText) && bodyLen <= 10) return true;
	return false;
}

export function checkRequireAwait(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];
	// Skip MCP tool handlers — async is required by the McpServer callback interface.
	const norm = filePath.replace(/\\/g, "/");
	if (/\bservers?\b/.test(norm) || /\bscripts?\b/.test(norm)) return [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = nonNull(strippedLines[i]).trim();

		// Match async function declarations (not arrow functions — those are harder to scope)
		if (!/\basync\s+function\b/.test(trimmed)) continue;

		// Skip Next.js route handlers — must be async by App Router convention
		const fnName = trimmed.match(/\basync\s+function\s+(\w+)/)?.[1] ?? "";
		if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(fnName)) continue;

		const { bodyStarted, bodyEnd } = findBlockEndByBrace(strippedLines, i);
		if (!bodyStarted) continue;

		const bodyText = strippedLines.slice(i, bodyEnd + 1).join("\n");
		const originalBodyText = originalLines.slice(i, bodyEnd + 1).join("\n");
		if (asyncBodyIsAcceptable(bodyText, originalBodyText, bodyEnd - i)) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * Detect accumulating spread in reduce: arr.reduce((acc, x) => ({...acc, [x]: 1}), {}).
 * This is O(n^2) because each iteration creates a full copy. Use Object.fromEntries or a loop.
 */
export function checkAccumulatingSpread(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = nonNull(strippedLines[i]).trim();
		// Pattern: .reduce( ... { ...acc  or  .reduce( ... [...acc
		if (/\.reduce\s*\(/.test(trimmed)) {
			// Look at this line and the next few for spread of accumulator
			const window = strippedLines.slice(i, Math.min(i + 5, strippedLines.length)).join(" ");
			// Skip an optional arrow-fn parameter list `(acc, x) =>` between
			// `.reduce(` and the spread. Without it, the `)` closing the param
			// list stops `[^)]*` and the canonical accumulating form
			// `reduce((acc, x) => [...acc, x], [])` is missed.
			if (/\.reduce\s*\((?:\s*\([^)]*\)\s*=>)?[^)]*[\[{]\s*\.\.\./.test(window)) {
				matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
			}
		}
	}
	return matches;
}

/**
 * Detect a run of 5+ consecutive field copies `target.k = source.k` — same
 * property name on both sides, same target + source objects. Hand-copying one
 * object's fields onto another is fragile: a field later added to the source
 * is silently skipped at the copy site. This is the bug class behind a builder
 * that computes a field its caller forgets to forward.
 */
export function checkManualFieldCopy(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const strippedLines = stripCommentsAndStrings(content).split("\n");
	const matches: InlineMatch[] = [];
	// A field copy is `<obj>.<key> = <obj>.<key>` ending the statement (after
	// an optional `if (...)` guard). Captures target obj/key + source obj/key.
	const copyRe =
		/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*;?\s*$/;
	let runTarget = "";
	let runSource = "";
	let runCount = 0;
	let runStart = 0;
	const flushRun = () => {
		if (runCount >= 5 && matches.length < 10) {
			matches.push({
				line: runStart,
				text:
					`${runCount} consecutive field copies ${runTarget}.x = ${runSource}.x` +
					` — a field added to ${runSource} is silently skipped here`,
			});
		}
		runCount = 0;
	};
	for (let i = 0; i < strippedLines.length; i++) {
		const trimmed = nonNull(strippedLines[i]).trim();
		if (trimmed === "") continue; // blank / comment-only — does not break a run
		const m = trimmed.match(copyRe);
		const isCopy = m !== null && m[2] === m[4] && m[1] !== m[3];
		if (isCopy) {
			if (runCount > 0 && m[1] === runTarget && m[3] === runSource) {
				runCount++;
			} else {
				flushRun();
				runTarget = nonNull(m[1]);
				runSource = nonNull(m[3]);
				runStart = i + 1;
				runCount = 1;
			}
		} else {
			flushRun();
		}
	}
	flushRun();
	return matches;
}
