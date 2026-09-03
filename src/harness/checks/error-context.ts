// Error-context preservation checks: catch bindings serialized or rewrapped
// in ways that silently destroy the error's message / stack / cause chain,
// plus the resource-handle sibling (acquired handle with no release path).
//
// Three detectors, one family:
//   - json_stringify_error      — JSON.stringify(err) on a catch binding:
//                                 Error own-properties are non-enumerable, so
//                                 the log line is `{}` (message/stack lost).
//   - catch_rewrap_loses_cause  — new *Error in a catch that references the
//                                 caught binding ONLY via string coercion
//                                 (concat / String() / .toString() / template
//                                 interpolation / bare property read) — the
//                                 cause chain and stack are destroyed.
//                                 Complementary slice to lossy_error_rethrow
//                                 in error-handling.ts, which covers the
//                                 "binding not referenced at all" case.
//   - resource_handle_leak      — narrow slice of the Effect-TS §2.5 design
//                                 (docs/design/effect-ts-harness-additions.md):
//                                 a raw fd from fs.openSync or a
//                                 fs.createWriteStream binding with no
//                                 close/end/destroy anywhere downstream and no
//                                 ownership handoff (return / pipe / alias).
//                                 Read streams, sockets, and spawned children
//                                 are deliberately excluded — they have
//                                 legitimate self-terminating lifecycles.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	stripComments,
} from "./shared.js";
// Shared offset→line helper (1-based; the comment/string stripper preserves
// line count, so it is valid over stripped text). Direct in-package import —
// shared.ts sits at its line cap and cannot carry another re-export line.
import { offsetToLine } from "./shared-text-utils.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 120;

// ─── Shared scanning helpers ──────────────────────────────────────────────────

/** Escape special regex metacharacters in an identifier. */
function escapeForRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Blank the contents of '…' / "…" quoted literals and the TEXT portions of
 * `…` template literals with spaces (length- and newline-preserving), while
 * KEEPING `${ … }` interpolation expressions intact. Unlike the fully-blanking
 * helpers, this lets a detector see identifiers referenced inside template
 * interpolations (`${err}`) — which is exactly the lossy-coercion signal
 * catch_rewrap_loses_cause needs — without string bodies masquerading as code.
 * Apply to comment-stripped input.
 */
function blankStringsKeepTemplateExprs(s: string): string {
	const out = s.split("");
	const n = s.length;
	let i = 0;
	while (i < n) {
		const c = s[i];
		if (c === '"' || c === "'") {
			i = blankQuotedLiteral(s, out, i);
			continue;
		}
		if (c === "`") {
			i = blankTemplateLiteral(s, out, i);
			continue;
		}
		i++;
	}
	return out.join("");
}

/** Blank a single- or double-quoted literal's contents; returns index past it. */
function blankQuotedLiteral(s: string, out: string[], start: number): number {
	const quote = s[start];
	const n = s.length;
	let i = start + 1; // keep the opening delimiter
	while (i < n) {
		const ch = s[i];
		if (ch === "\\") {
			out[i] = " ";
			if (i + 1 < n && s[i + 1] !== "\n") out[i + 1] = " ";
			i += 2;
			continue;
		}
		if (ch === quote) return i + 1; // keep the closing delimiter
		if (ch === "\n") return i; // unterminated — bail at line end
		out[i] = " ";
		i++;
	}
	return i;
}

/** Blank a template literal's text but keep `${…}` expressions; returns index past it. */
function blankTemplateLiteral(s: string, out: string[], start: number): number {
	const n = s.length;
	let i = start + 1; // keep the opening backtick
	while (i < n) {
		const ch = s[i];
		if (ch === "\\") {
			out[i] = " ";
			if (i + 1 < n && s[i + 1] !== "\n") out[i + 1] = " ";
			i += 2;
			continue;
		}
		if (ch === "`") return i + 1;
		if (ch === "$" && s[i + 1] === "{") {
			// keep the `${` marker and the expression body
			i = skipTemplateInterpolation(s, out, i + 2);
			continue;
		}
		if (ch !== "\n") out[i] = " ";
		i++;
	}
	return i;
}

/**
 * Walk an already-entered `${…}` interpolation from `start` (just past the
 * `${`) to just past its closing `}`, leaving the expression body intact and
 * blanking the text of any nested template literal it contains.
 */
function skipTemplateInterpolation(s: string, out: string[], start: number): number {
	const n = s.length;
	let i = start;
	let depth = 1;
	while (i < n && depth > 0) {
		const c2 = s[i];
		if (c2 === "`") {
			i = blankTemplateLiteral(s, out, i); // nested template
			continue;
		}
		if (c2 === "{") depth++;
		else if (c2 === "}") depth--;
		i++;
	}
	return i;
}

interface CatchBlock {
	varName: string;
	bodyStart: number;
	bodyEnd: number;
}

/** Find the matching `}` for the `{` at openIdx, or -1. */
function matchBraceEnd(code: string, openIdx: number): number {
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

/** All `catch (<id>) { … }` blocks (typed bindings allowed) in blanked code. */
function findCatchBlocks(code: string): CatchBlock[] {
	const blocks: CatchBlock[] = [];
	const catchRe = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)\s*\{/g;
	let m: RegExpExecArray | null = catchRe.exec(code);
	while (m !== null) {
		const varName = m[1];
		const openIdx = m.index + m[0].length - 1;
		const closeIdx = matchBraceEnd(code, openIdx);
		if (varName !== undefined && closeIdx > 0) {
			blocks.push({ varName, bodyStart: openIdx + 1, bodyEnd: closeIdx });
		}
		m = catchRe.exec(code);
	}
	return blocks;
}

function recordMatch(
	code: string,
	rawLines: string[],
	offset: number,
	message: string,
	matches: InlineMatch[],
	seen: Set<number>,
): void {
	if (matches.length >= MAX_MATCHES_PER_FILE) return;
	const line = offsetToLine(code, offset);
	if (seen.has(line)) return;
	seen.add(line);
	const excerpt = (rawLines[line - 1] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
	matches.push({ line, text: `${message}: ${excerpt}` });
}

/** Comment-stripped, quote-blanked (template exprs kept) view + raw lines. */
function prepareJsTsSource(
	content: string,
	filePath: string,
): { code: string; rawLines: string[] } | null {
	if (isTestFile(filePath)) return null;
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return null;
	return {
		code: blankStringsKeepTemplateExprs(stripComments(content)),
		rawLines: content.split("\n"),
	};
}

// ─── 1. json_stringify_error ──────────────────────────────────────────────────

/**
 * Detect `JSON.stringify(<catch binding>)` with the binding passed bare.
 *
 * Check id: `json_stringify_error`
 *
 * Error own-properties (message, stack, name) are non-enumerable, so
 * `JSON.stringify(err)` yields `{}` — the log/response line carries nothing.
 * Fires only on the bare binding as the first argument (replacer/space args
 * allowed); `err.message`, `String(err)`, or an explicit-field object literal
 * are all fine.
 */
export function detectJsonStringifyError(content: string, filePath: string): InlineMatch[] {
	const src = prepareJsTsSource(content, filePath);
	if (!src) return [];
	const { code, rawLines } = src;
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	for (const blk of findCatchBlocks(code)) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		const body = code.slice(blk.bodyStart, blk.bodyEnd);
		const bareRe = new RegExp(
			String.raw`JSON\s*\.\s*stringify\s*\(\s*${escapeForRegex(blk.varName)}\s*[,)]`,
			"g",
		);
		let hit: RegExpExecArray | null = bareRe.exec(body);
		while (hit !== null) {
			recordMatch(
				code,
				rawLines,
				blk.bodyStart + hit.index,
				`json_stringify_error: JSON.stringify(${blk.varName}) serializes an Error to {} — use ${blk.varName}.message/${blk.varName}.stack or explicit fields`,
				matches,
				seen,
			);
			hit = bareRe.exec(body);
		}
	}
	return matches;
}

// ─── 2. catch_rewrap_loses_cause ──────────────────────────────────────────────

/** How the caught binding is referenced inside an Error-constructor arg list. */
function classifyBindingRefs(
	args: string,
	varName: string,
): { lossy: number; preserving: number } {
	const refRe = new RegExp(String.raw`\b${escapeForRegex(varName)}\b`, "g");
	let lossy = 0;
	let preserving = 0;
	let m: RegExpExecArray | null = refRe.exec(args);
	while (m !== null) {
		const before = args.slice(0, m.index);
		const after = args.slice(m.index + varName.length);
		if (/\bcause\s*:\s*$/.test(before)) preserving++;
		else if (isInsideTemplateExpr(before)) lossy++;
		else if (/\bString\s*\(\s*$/.test(before)) lossy++;
		else if (/\+\s*$/.test(before) || /^(?:\s*\.\s*\w+)?\s*\+/.test(after)) lossy++;
		// A bare property/method read — `err.message`, `err.toString()`,
		// `err.stack` — coerces the binding to one of its values and drops the
		// Error object, so the stack and .cause chain are lost just as with
		// String()/concat. Requires the ref be immediately followed by `.<member>`;
		// a bare `err` (passed to the ctor / an options value) stays preserving,
		// and any `{ cause: err }` alongside pushes preserving>0 → no fire.
		else if (/^\s*\.\s*[A-Za-z_$][\w$]*/.test(after)) lossy++;
		else preserving++; // bare arg / options-object value
		m = refRe.exec(args);
	}
	return { lossy, preserving };
}

/** True when the offset (end of `before`) sits inside an unclosed `${…}`. */
function isInsideTemplateExpr(before: string): boolean {
	const open = before.lastIndexOf("${");
	return open >= 0 && !before.slice(open).includes("}");
}

/**
 * Exempt the canonical error-normalization ternary:
 * `err instanceof Error ? err : new Error(String(err))`.
 * The alternative branch only runs when the binding is proven NOT an Error —
 * a non-Error thrown value has no stack or cause chain to lose, so
 * stringifying it is the correct normalization (found as the only fire
 * pattern when dogfooding this detector on the harness itself).
 */
function isErrorNormalizationTernary(code: string, ctorIdx: number, varName: string): boolean {
	const v = escapeForRegex(varName);
	const before = code.slice(Math.max(0, ctorIdx - 160), ctorIdx);
	const normRe = new RegExp(
		"\\b" + v + "\\s+instanceof\\s+[A-Za-z_$][\\w$]*\\s*\\?\\s*" + v + "\\s*:\\s*$",
	);
	return normRe.test(before);
}

/** Matching `)` for an arg list opening at `start`, bounded by `limit`; or -1. */
function matchParenEnd(code: string, start: number, limit: number): number {
	let depth = 1;
	for (let i = start; i < code.length && i < limit; i++) {
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
 * Detect a NEW `*Error` constructed inside `catch (<id>)` that references the
 * caught binding ONLY via string coercion (concat / String() / `.toString()` /
 * template interpolation / bare property read) — no `{ cause: <id> }`, no bare
 * `<id>` constructor argument.
 *
 * Check id: `catch_rewrap_loses_cause`
 *
 * Effect-TS lessons port (docs/design/effect-ts-harness-additions.md §2.2).
 * Stringifying the caught error into the wrapper's message drops the stack
 * and severs the `.cause` chain. The fix is mechanical: pass `{ cause: e }`
 * (Node 16.9+ / TS 4.6+) or hand `e` to the wrapper class directly.
 *
 * Does NOT fire on: `throw e` rethrow, `new Error(msg, { cause: e })`,
 * error classes taking `e` as a constructor arg, or constructors that never
 * mention the binding (that case is lossy_error_rethrow's, in
 * error-handling.ts).
 */
export function detectCatchRewrapLosesCause(content: string, filePath: string): InlineMatch[] {
	const src = prepareJsTsSource(content, filePath);
	if (!src) return [];
	const { code, rawLines } = src;
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();
	const ctorRe = /\bnew\s+((?:[A-Z][A-Za-z0-9_$]*)?Error)\s*\(/g;

	for (const blk of findCatchBlocks(code)) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		ctorRe.lastIndex = blk.bodyStart;
		let ctor: RegExpExecArray | null = ctorRe.exec(code);
		while (ctor !== null && ctor.index < blk.bodyEnd) {
			const argsStart = ctor.index + ctor[0].length;
			const argsEnd = matchParenEnd(code, argsStart, blk.bodyEnd);
			if (argsEnd < 0) break;
			const { lossy, preserving } = classifyBindingRefs(
				code.slice(argsStart, argsEnd),
				blk.varName,
			);
			if (
				lossy > 0 &&
				preserving === 0 &&
				!isErrorNormalizationTernary(code, ctor.index, blk.varName)
			) {
				recordMatch(
					code,
					rawLines,
					ctor.index,
					`catch_rewrap_loses_cause: new ${ctor[1]} stringifies ${blk.varName} — stack and cause chain lost; add { cause: ${blk.varName} } or pass ${blk.varName} itself`,
					matches,
					seen,
				);
			}
			ctor = ctorRe.exec(code);
		}
	}
	return matches;
}

// ─── 3. resource_handle_leak ──────────────────────────────────────────────────

/** Acquisitions with NO auto-close lifecycle: raw fds and write streams. */
const QUALIFIED_ACQUIRE_SRC = String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*(fs\s*\.\s*(?:openSync|createWriteStream))\s*\(`;
const BARE_ACQUIRE_SRC = String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*((?<![\w.$])(?:openSync|createWriteStream))\s*\(`;
/** Bare-name matches only count when the file actually imports node:fs. */
const FS_IMPORT_RE = /from\s+["'](?:node:)?fs(?:\/promises)?["']|require\(\s*["'](?:node:)?fs["']\s*\)/;

/** True when the post-declaration window releases or hands off the handle. */
function handleIsReleasedOrHandedOff(window: string, varName: string): boolean {
	const v = escapeForRegex(varName);
	const releasedRe = new RegExp(
		String.raw`\b${v}\s*\.\s*(?:close|destroy|end)\s*\(|\bclose(?:Sync)?\s*\(\s*${v}\b`,
	);
	const handoffRe = new RegExp(
		// returned / yielded, piped into (source end auto-ends the target),
		// passed to pipeline/finished, aliased or stored, resolved out, pushed
		// into a collection managed elsewhere.
		String.raw`\breturn\b[^;\n]*\b${v}\b|\byield\b[^;\n]*\b${v}\b|\.\s*pipe\s*\(\s*${v}\b|\b(?:pipeline|finished)\s*\([^)]*\b${v}\b|[=:]\s*${v}\s*[;,)\n\]}]|\b(?:resolve|push)\s*\(\s*${v}\b`,
	);
	return releasedRe.test(window) || handoffRe.test(window);
}

/** Run one acquire-pattern pass, appending unreleased-handle findings. */
function scanAcquisitions(
	code: string,
	rawLines: string[],
	source: string,
	matches: InlineMatch[],
	seen: Set<number>,
): void {
	const acqRe = new RegExp(source, "g");
	let m: RegExpExecArray | null = acqRe.exec(code);
	while (m !== null) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		const varName = m[1];
		const call = (m[2] ?? "").replace(/\s+/g, "");
		if (varName !== undefined) {
			const window = code.slice(m.index + m[0].length);
			if (!handleIsReleasedOrHandedOff(window, varName)) {
				recordMatch(
					code,
					rawLines,
					m.index,
					`resource_handle_leak: ${varName} from ${call}() is never closed/ended and never handed off — leaks on every path (wrap in try/finally or use \`using\`)`,
					matches,
					seen,
				);
			}
		}
		m = acqRe.exec(code);
	}
}

/**
 * Detect an acquired file handle with no release and no ownership handoff.
 *
 * Check id: `resource_handle_leak`
 *
 * Narrow slice of docs/design/effect-ts-harness-additions.md §2.5: only
 * `fs.openSync` (raw fd — nothing ever auto-closes it) and
 * `fs.createWriteStream` (must be `.end()`ed). Read streams, sockets, and
 * child processes are excluded — full consumption / connection lifecycle /
 * process exit all close those legitimately without an explicit call, which
 * would be false positives under this "no release anywhere" rule.
 * `using` declarations are inherently exempt (only const/let/var match).
 */
export function detectResourceHandleLeak(content: string, filePath: string): InlineMatch[] {
	const src = prepareJsTsSource(content, filePath);
	if (!src) return [];
	const { code, rawLines } = src;
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	scanAcquisitions(code, rawLines, QUALIFIED_ACQUIRE_SRC, matches, seen);
	// Bare `openSync(` / `createWriteStream(` only when node:fs is imported —
	// the import path is a string literal, so test the comment-stripped raw.
	if (FS_IMPORT_RE.test(stripComments(content))) {
		scanAcquisitions(code, rawLines, BARE_ACQUIRE_SRC, matches, seen);
	}
	return matches;
}
