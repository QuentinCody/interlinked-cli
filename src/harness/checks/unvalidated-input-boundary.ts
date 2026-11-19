// unvalidated_input_boundary (Plan 25 lane 8,
// docs/plans/25-refactor-readiness-program.md). Extends the boundary-parser
// family alongside the existing `unvalidated_json_boundary`
// (checks/agent-safety-advanced-style.ts::checkUnvalidatedJsonBoundary),
// which tracks `const v = JSON.parse(...)` / `const v = await x.json()`
// ASSIGNED to a named variable, then scans forward up to 15 lines for a
// validator call before the variable's first property access.
//
// This check covers two DIFFERENT shapes that detector doesn't reach:
//   1. `.json()` used inline or chained (not bound to a `const/let/var`
//      matching `[\w.]+\.json(` — e.g. `(await fetch(url)).json()`), checked
//      against a tight same-or-next-2-lines window instead of a 15-line
//      variable-scoped forward scan.
//   2. Direct `process.argv[<number>]` indexing outside a bin/cli entry
//      file — an input-boundary shape the JSON detector never considered.
//
// It deliberately NEVER matches `JSON.parse(` — the trigger requires the
// literal `.json(` method call (lower-case, matching Fetch/undici
// `Response.prototype.json`), which is syntactically disjoint from
// `JSON.parse(` (upper-case receiver, `.parse` not `.json`). The validator
// vocabulary mirrors the sibling check's style (parse/safeParse/decode/
// check/validate/normalize, plus bare `isFoo(`/`parseFoo(`-shaped local
// helpers) so the two checks agree on what counts as "validated".
//
// CALIBRATED (2026-08-17, scratch/plan25-lanes-6-8-calibration.mts): the
// first cut of the argv sub-detector matched `process.argv[<n>]` regardless
// of read/write position, which flagged a dozen `process.argv[1] = ...`
// test-fixture assignments (mocking argv for an integration test — writing
// a value INTO argv, not reading an unvalidated one FROM it) across
// hooks.test.ts/inference-proxy.test.ts/session-end-batch.test.ts/etc. The
// negative lookahead below excludes exactly the assignment-target shape
// while still catching a genuine read used in a comparison (`=== `/`!==`,
// which start with `=`/`!` followed by ANOTHER `=`, so they don't match the
// excluded single-`=` shape).

import { getExtension, type InlineMatch, JS_TS_ALL_EXTS, stripCommentsAndStrings } from "./shared.js";
import { maskDiscardedValidators } from "./discarded-validation.js";
import { checkMatchLimit } from "./check-scan-policy.js";

const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;
/** Validator search window: the `.json()` line itself plus this many lines after. */
const VALIDATOR_LOOKAHEAD_LINES = 2;

// Non-global — used only via `.test()` on a single line/window, never `.exec()`
// in a loop, so there is no `lastIndex` state to reset between calls.
const AWAIT_RE = /\bawait\b/;
const JSON_CALL_RE = /\.json\s*\(\s*\)/;
/** A schema-parse-shaped call: a dotted `.parse(`/`.safeParse(`/`.decode(`/
 *  `.check(`/`.validate(`/`.normalize(` NOT preceded by "JSON" (excludes
 *  `JSON.parse(`, which asserts nothing about shape), OR a bare local helper
 *  call shaped like `isFoo(`/`parseFoo(`/`validateFoo(`/`normalizeFoo(`. */
const VALIDATOR_NEARBY_RE =
	/(?<!JSON)\.(?:parse|safeParse|decode|check|validate|normalize)\s*\(|(?<![.\w$])(?:is|parse|validate|normalize)[A-Za-z_$][\w$]*\s*\(/;

/** `process.argv[<n>]` NOT immediately followed by a single `=` (assignment) —
 *  the trailing negative lookahead excludes `process.argv[1] = "x"` (a
 *  test-fixture write) while still matching a read used in a comparison
 *  (`===`/`!==` start with a SECOND `=`/`!`, which the inner `(?!=)` lets
 *  through). */
const ARGV_INDEX_RE = /\bprocess\.argv\[\s*(?:[2-9]|\d{2,})\s*\](?!\s*=(?!=))/g;

/** True for a bin/cli entry file: a `bin/` path segment, or a basename of
 *  exactly `index.<ext>` / `cli.<ext>`. */
function isEntryFilePath(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	if (/(^|\/)bin\//.test(norm)) return true;
	const base = norm.split("/").pop() ?? "";
	return /^(?:index|cli)\.(?:ts|js|mjs|cjs)$/.test(base);
}

/** Scan for an awaited, empty-parens `.json()` call with no validator call
 *  in the same-or-next-2-lines window. Empty parens is the load-bearing
 *  discriminator against Express-style `res.json(payload)` (always takes an
 *  argument, and is a SEND not a parse). */
function scanJsonBoundary(
	strippedLines: string[],
	rawLines: string[],
	matches: InlineMatch[],
	seen: Set<number>,
): void {
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= checkMatchLimit(MAX_MATCHES_PER_FILE)) return;
		const line = strippedLines[i];
		if (line === undefined) continue;
		if (!AWAIT_RE.test(line) || !JSON_CALL_RE.test(line)) continue;

		const windowEnd = Math.min(strippedLines.length, i + 1 + VALIDATOR_LOOKAHEAD_LINES);
		const window = strippedLines.slice(i, windowEnd).join("\n");
		if (VALIDATOR_NEARBY_RE.test(window)) continue;

		const lineNo = i + 1;
		if (seen.has(lineNo)) continue;
		seen.add(lineNo);
		const text = (rawLines[i] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
		matches.push({
			line: lineNo,
			text: `unvalidated_input_boundary: .json() result used with no schema-parse call on the same or adjacent 2 lines — ${text}`,
		});
	}
}

/** Scan for `process.argv[<number>]` indexing, skipped entirely for
 *  bin/cli entry files (their whole job is reading raw argv). */
function scanArgvIndexing(
	stripped: string,
	rawLines: string[],
	matches: InlineMatch[],
	seen: Set<number>,
): void {
	const local = new RegExp(ARGV_INDEX_RE.source, ARGV_INDEX_RE.flags);
	let m: RegExpExecArray | null;
	while ((m = local.exec(stripped))) {
		if (matches.length >= checkMatchLimit(MAX_MATCHES_PER_FILE)) return;
		const lineNo = stripped.slice(0, m.index).split("\n").length;
		if (seen.has(lineNo)) continue;
		seen.add(lineNo);
		const text = (rawLines[lineNo - 1] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
		matches.push({
			line: lineNo,
			text: `unvalidated_input_boundary: process.argv indexed directly outside a bin/cli entry file — ${text}`,
		});
	}
}

/**
 * Detect two unparsed-input-boundary shapes: (1) an awaited `.json()` call
 * with no schema-parse call nearby, and (2) direct `process.argv[<n>]`
 * indexing outside a recognized entry file. Never fires on `JSON.parse(` —
 * see file header.
 */
export function detectUnvalidatedInputBoundary(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_ALL_EXTS.includes(getExtension(filePath))) return [];
	if (content.length === 0) return [];

	const stripped = stripCommentsAndStrings(maskDiscardedValidators(content, filePath, "unvalidated_input_boundary"));
	const strippedLines = stripped.split("\n");
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seenJson = new Set<number>();
	const seenArgv = new Set<number>();

	scanJsonBoundary(strippedLines, rawLines, matches, seenJson);
	if (matches.length < checkMatchLimit(MAX_MATCHES_PER_FILE) && !isEntryFilePath(filePath)) {
		scanArgvIndexing(stripped, rawLines, matches, seenArgv);
	}

	return matches;
}
