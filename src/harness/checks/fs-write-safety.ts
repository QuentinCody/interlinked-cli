// fs-write-safety inline check.
//
// Detects: a `writeFileSync` / `appendFileSync` / `writeFile` /
// `createWriteStream` call whose path argument is a *nested* path (built with
// `join(...)` with ≥2 arguments, or a string literal containing a `/`)
// without a prior `mkdirSync(..., { recursive: true })` or
// `mkdir(..., { recursive: true })` or `existsSync(<dir>)` guard in the
// same function-level scope.
//
// Real example: `writeFileSync(join(cwd, ".interlinked", "metric-caps.json"),
// ...)` threw ENOENT when `.interlinked/` didn't exist.
//
// Design decisions:
//   - Line-based approach: we locate write calls by scanning the stripped
//     (no-strings, no-comments) source for their line numbers, then operate
//     on those line numbers in the other source views (raw, comment-stripped).
//     This avoids offset-mismatch bugs between stripped views that replace
//     content at different byte lengths.
//   - Path argument analysis: we scan raw lines (string content visible) to
//     detect `join(…,…)` with ≥2 args or a string literal with a `/`.
//   - Guard detection: we scan comment-stripped (string-preserving) lines from
//     function start to the write line for `mkdirSync`/`mkdir` + `recursive`
//     or `existsSync`. String content survives so `{ recursive: true }` is
//     visible; comments are gone so commented-out guards don't suppress.
//   - Function boundary: we walk backward from the write line in the comment-
//     stripped source to find the nearest unmatched `{`, using line granularity.
//   - Max 10 findings per file; JS/TS only.

import {
	getExtension,
	type InlineMatch,
	JS_TS_ALL_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;

// ─── Regexes ─────────────────────────────────────────────────────────────────

/**
 * Matches the start of any of the four write-family calls in fully-stripped
 * (no-strings, no-comments) source. Used to detect write call sites.
 */
const WRITE_STRIPPED_RE =
	/\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream)\s*\(/g;

/** Detects a `join(` call — we then count commas to see if ≥2 args. */
const JOIN_CALL_RE = /\bjoin\s*\(/;

/**
 * Detects a string literal containing a `/` — e.g. `'logs/out.log'`.
 * Applied to raw line content where strings are not stripped.
 */
const NESTED_LITERAL_RE = /["'`][^"'`]*\/[^"'`]*["'`]/;

/**
 * Detects an `existsSync(` call — a common directory-existence guard.
 */
const EXISTS_SYNC_RE = /\bexistsSync\s*\(/;

/**
 * Detects a `mkdirSync(` or `mkdir(` call opener. We then look ahead for
 * the `recursive` keyword within the call.
 */
const MKDIR_CALL_RE = /\b(?:mkdirSync|mkdir)\s*\(/g;

/**
 * Matches `<name> = mkdtempSync(...)` / `<name> = await mkdtemp(...)` /
 * `<name> = fs.mkdtempSync(...)` — with or without a leading `const`/`let`/
 * `var`, so both the declaration site and a later `beforeEach` reassignment
 * (`let dir; beforeEach(() => { dir = mkdtempSync(...); })`) are caught.
 * `mkdtempSync`/`mkdtemp` themselves create the directory, so any name bound
 * to their result is a directory KNOWN to exist for the rest of the file.
 */
const MKDTEMP_ASSIGN_RE =
	/\b([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:fs\.)?mkdtemp(?:Sync)?\s*\(/g;

/**
 * Matches a bare `mkdirSync(<identifier>)` — a single-argument call with no
 * `recursive` option. It creates exactly `<identifier>` (one level), so a
 * write placed directly inside it can't ENOENT even without `recursive`.
 */
const BARE_MKDIR_RE = /\bmkdirSync\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;

/**
 * Collect directory names known to exist by the time any write in this file
 * runs: names bound to `mkdtempSync`/`mkdtemp`, and names created via a bare
 * `mkdirSync(<name>)` (no options — the directory itself, one level). Scanned
 * across the whole file (not per-function-scope) so a `beforeEach`/`beforeAll`
 * setup outside the write's enclosing function still counts — the real shape
 * this guards against.
 */
function collectKnownDirNames(commentStrippedLines: string[]): Set<string> {
	const names = new Set<string>();
	for (const line of commentStrippedLines) {
		MKDTEMP_ASSIGN_RE.lastIndex = 0;
		let mk: RegExpExecArray | null;
		while ((mk = MKDTEMP_ASSIGN_RE.exec(line)) !== null) {
			if (mk[1]) names.add(mk[1]);
		}
		BARE_MKDIR_RE.lastIndex = 0;
		let bm: RegExpExecArray | null;
		while ((bm = BARE_MKDIR_RE.exec(line)) !== null) {
			if (bm[1]) names.add(bm[1]);
		}
	}
	return names;
}

/**
 * True when `argWindow` places exactly ONE path segment directly inside a
 * name in `knownDirs` — `join(dir, "f")`, `` `${dir}/f` ``, or
 * `dir + "/f"` — which can't ENOENT because `dir` is known to already exist.
 * A second segment below `dir` (`join(dir, "sub", "f")`) still can, so this
 * stays false whenever more than one segment separates the write from the
 * known directory.
 */
function isSingleSegmentIntoKnownDir(argWindow: string, knownDirs: Set<string>): boolean {
	if (knownDirs.size === 0) return false;
	const dirAlt = Array.from(knownDirs)
		.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");

	const joinIdx = argWindow.search(JOIN_CALL_RE);
	if (joinIdx !== -1) {
		const openIdx = argWindow.indexOf("(", joinIdx);
		if (openIdx === -1) return false;
		const inner = argWindow.slice(openIdx + 1);
		const firstArg = new RegExp(`^\\s*(${dirAlt})\\s*,`).exec(inner);
		if (!firstArg) return false;
		return countTopLevelArgs(argWindow, openIdx + 1, 300) === 2;
	}

	// Template literal: `${dir}/seg` — no further `/` before the closing quote.
	const tplRe = new RegExp("`\\$\\{\\s*(?:" + dirAlt + ")\\s*\\}\\/[^`/]+`");
	if (tplRe.test(argWindow)) return true;

	// String concat: dir + "/seg"
	const concatRe = new RegExp("\\b(?:" + dirAlt + ")\\s*\\+\\s*[\"'`]\\/[^\"'`/]+[\"'`]");
	return concatRe.test(argWindow);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Count top-level arguments of the call starting at `afterOpenParen` in `text`
 * (depth already 1 on entry). Returns commas-at-depth-1 + 1.
 */
function countTopLevelArgs(text: string, afterOpenParen: number, budget: number): number {
	let depth = 1;
	let commas = 0;
	const end = Math.min(text.length, afterOpenParen + budget);
	for (let i = afterOpenParen; i < end; i++) {
		const ch = text.charAt(i);
		// interlinked: defer else_if_chain -- canonical bracket-depth walk; a dispatch table would hide the paired depth mutations
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
		} else if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			if (depth === 0) break;
		} else if (ch === "," && depth === 1) {
			commas++;
		}
	}
	return commas + 1;
}

/**
 * Detect a write call on `lineText` (raw or comment-stripped line). Returns
 * true when:
 *   - a `join(` with ≥2 arguments appears as the first argument, OR
 *   - a string literal containing `/` appears as the first argument.
 *
 * We extract the first argument by walking forward from the write call's `(`.
 */
function hasNestedPathArg(lineText: string, knownDirs: Set<string>): boolean {
	// Find the write function call
	const writeMatch = /\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream)\s*\(/.exec(lineText);
	if (writeMatch === null) return false;

	const afterOpen = writeMatch.index + writeMatch[0].length;
	const argWindow = lineText.slice(afterOpen, afterOpen + 300);

	// A file placed directly inside a directory already known to exist
	// (mkdtemp*, or a bare mkdirSync(name)) can't ENOENT — not a nested path.
	if (isSingleSegmentIntoKnownDir(argWindow, knownDirs)) return false;

	// Check for join(…, …) with ≥2 args
	const joinIdx = argWindow.search(JOIN_CALL_RE);
	if (joinIdx !== -1) {
		const openIdx = argWindow.indexOf("(", joinIdx);
		if (openIdx !== -1 && countTopLevelArgs(argWindow, openIdx + 1, 300) >= 2) {
			return true;
		}
	}

	// Check for string literal containing /
	return NESTED_LITERAL_RE.test(argWindow);
}

/**
 * Walk backward through `lines` from `writeLineIdx` (0-based) to find the
 * 0-based index of the line that opens the enclosing function body.
 * Counts `{` and `}` characters (brace-balance). Returns 0 when the opening
 * brace is not found (treats the whole file prefix as the scope, which is
 * conservative: may suppress some true positives at module scope but never
 * adds false positives).
 */
function findEnclosingFunctionStartLine(lines: string[], writeLineIdx: number): number {
	let depth = 0;
	for (let i = writeLineIdx - 1; i >= 0; i--) {
		const line = lines[i] ?? "";
		for (let j = line.length - 1; j >= 0; j--) {
			const ch = line.charAt(j);
			if (ch === "}") {
				depth++;
			} else if (ch === "{") {
				if (depth === 0) {
					// Opening brace found — function body starts on the next line
					return i + 1;
				}
				depth--;
			}
		}
	}
	return 0;
}

/**
 * Scan `lines[startLineIdx..endLineIdx)` (0-based, exclusive end) for any
 * mkdir/existsSync guard. Uses comment-stripped lines so `{ recursive: true }`
 * is visible but commented-out guards don't count.
 *
 * For `mkdirSync`/`mkdir` calls: we require `recursive` to appear within the
 * same line or in the subsequent ~5 lines (covers multi-line calls).
 */
function hasPriorGuardInLines(
	commentStrippedLines: string[],
	startLineIdx: number,
	endLineIdx: number,
): boolean {
	for (let i = startLineIdx; i < endLineIdx; i++) {
		const line = commentStrippedLines[i] ?? "";

		// existsSync anywhere in the line is a guard
		if (EXISTS_SYNC_RE.test(line)) return true;

		// mkdir/mkdirSync call: look for `recursive` in the call body (same line
		// or up to 5 subsequent lines for multi-line call style)
		MKDIR_CALL_RE.lastIndex = 0;
		if (MKDIR_CALL_RE.test(line)) {
			// Collect up to 5 lines after the opener (inclusive) for `recursive`
			const lookaheadEnd = Math.min(endLineIdx, i + 6);
			for (let k = i; k < lookaheadEnd; k++) {
				if (/\brecursive\b/.test(commentStrippedLines[k] ?? "")) return true;
			}
		}
	}
	return false;
}

// ─── Exported detector ───────────────────────────────────────────────────────

/**
 * Detect `writeFileSync` / `appendFileSync` / `writeFile` / `createWriteStream`
 * calls that operate on a detectably nested path without a prior mkdir guard in
 * the same function scope.
 *
 * Returns an array of `InlineMatch` objects with fields `line` (1-based) and
 * `text` (raw line content, trimmed, truncated to 150 chars).
 *
 * check id: `write_without_mkdir`
 */
export function detectWriteWithoutMkdir(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	// Fully stripped source — used to locate write call line numbers without
	// triggering on write calls mentioned inside strings or comments.
	const stripped = stripCommentsAndStrings(content);
	// Comment-stripped (strings preserved) — used for path analysis and guard
	// detection where string literal content must be visible.
	const commentStrippedLines = stripComments(content).split("\n");
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();
	const knownDirs = collectKnownDirNames(commentStrippedLines);

	WRITE_STRIPPED_RE.lastIndex = 0;
	let m: RegExpExecArray | null;

	while ((m = WRITE_STRIPPED_RE.exec(stripped)) !== null) {
		// Compute 0-based line index from character offset in stripped source
		const lineIdx = stripped.slice(0, m.index).split("\n").length - 1;
		const lineNo = lineIdx + 1; // 1-based for output

		if (seen.has(lineNo)) continue;

		// Analyse the raw line for the path argument (strings visible)
		const rawLine = rawLines[lineIdx] ?? "";
		if (!hasNestedPathArg(rawLine, knownDirs)) continue;

		// Find enclosing function start in comment-stripped lines (brace balance)
		const fnStartLineIdx = findEnclosingFunctionStartLine(commentStrippedLines, lineIdx);

		// Check for a guard between function start and this write line
		if (hasPriorGuardInLines(commentStrippedLines, fnStartLineIdx, lineIdx)) continue;

		seen.add(lineNo);
		matches.push({
			line: lineNo,
			text: rawLine.trim().slice(0, REPORT_LINE_TRUNC),
		});

		if (matches.length >= MAX_MATCHES_PER_FILE) break;
	}

	return matches;
}

// ─── homedir write escape ────────────────────────────────────────────────────
// Class source (2026-08-10): Stryker mutants of `INTERLINKED_HOME ?? homedir()`
// routed test-suite corpus writes into the REAL ~/.interlinked — 1443 fixture
// rows in the user's cross-repo findings corpus. Per-test env redirects are
// cooperative and break under mutation, so any production write that resolves
// under the user's home needs the TEST RUNNER to sandbox HOME itself. This
// detector surfaces those writes so the sandbox gets added before the class
// bites.

/** homedir() call, or the HOME/USERPROFILE env vars it reads. */
const HOME_SOURCE_RE =
	/\bhomedir\s*\(|\bprocess\.env\.(?:HOME|USERPROFILE)\b|\bprocess\.env\[\s*["'](?:HOME|USERPROFILE)["']\s*\]/;

/** Write-family calls whose PATH argument matters (includes dir creation and
 *  deletion — mkdir/rm against the real home are the same escape). */
const HOME_WRITE_RE =
	/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|cpSync|renameSync|rmSync)\s*\(/;

const HOME_WRITE_STRIPPED_RE = new RegExp(HOME_WRITE_RE.source, "g");

/** A `const`/`let`/`var` or `function` declaration that binds a name. */
const HOME_DECL_RE =
	/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;

/** Test paths are the sandbox's job (home-sandbox.ts), not this detector's. */
const HOME_TEST_PATH_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__(?:tests|fixtures|mocks)__\//;

/**
 * Find the 0-based inclusive end line of the statement/block starting at
 * `startIdx` by bracket balance over fully-stripped lines. Budget-bounded.
 */
function statementEndLine(strippedLines: string[], startIdx: number): number {
	let depth = 0;
	const budgetEnd = Math.min(strippedLines.length, startIdx + 60);
	for (let i = startIdx; i < budgetEnd; i++) {
		const line = strippedLines[i] ?? "";
		for (const ch of line) {
			if (ch === "(" || ch === "[" || ch === "{") depth++;
			else if (ch === ")" || ch === "]" || ch === "}") depth--;
		}
		if (depth <= 0) return i;
	}
	return budgetEnd - 1;
}

/**
 * Collect names bound to home-derived values: directly (`join(homedir(), …)`,
 * `process.env.HOME`), or transitively through an already-collected name
 * (`const gpath = globalCorpusPath()`). Runs on fully-stripped lines so
 * comments and string literals can never taint a name. Fixpoint capped at 3
 * passes — one direct pass plus two hops covers the corpus.ts incident shape.
 */
/** True when any of `strippedLines[start..end]` mentions a home source or an
 *  already-tainted name (`alt`). */
// interlinked: defer function_arg_count -- private helper with one caller; (lines, start, end, taint-alt) as a struct is pure ceremony
function windowHasHomeSource(
	strippedLines: string[],
	start: number,
	end: number,
	alt: RegExp | null,
): boolean {
	for (let k = start; k <= end; k++) {
		const line = strippedLines[k] ?? "";
		if (HOME_SOURCE_RE.test(line)) return true;
		if (alt !== null && alt.test(line)) return true;
	}
	return false;
}

/** One taint pass: add every declared name whose statement window mentions a
 *  home source or an already-tainted name. Returns true when the set grew. */
function growHomeNames(strippedLines: string[], names: Set<string>): boolean {
	const alt = names.size > 0 ? new RegExp(`\\b(?:${Array.from(names).join("|")})\\b`) : null;
	let grew = false;
	for (let i = 0; i < strippedLines.length; i++) {
		const decl = HOME_DECL_RE.exec(strippedLines[i] ?? "");
		const name = decl?.[1] ?? decl?.[2];
		if (!name || names.has(name)) continue;
		if (windowHasHomeSource(strippedLines, i, statementEndLine(strippedLines, i), alt)) {
			names.add(name);
			grew = true;
		}
	}
	return grew;
}

function collectHomeDerivedNames(strippedLines: string[]): Set<string> {
	const names = new Set<string>();
	for (let pass = 0; pass < 3; pass++) {
		if (!growHomeNames(strippedLines, names)) break;
	}
	return names;
}

/**
 * Slice the FIRST argument of the call opening at `afterOpen` in `text`.
 * Bounding the scan to the path argument is what keeps read-only home use
 * clean: `writeFileSync(join(cwd, "out.json"), credsFromHome)` must not fire.
 */
function firstArgWindow(text: string, afterOpen: number): string {
	let depth = 1;
	const end = Math.min(text.length, afterOpen + 300);
	for (let i = afterOpen; i < end; i++) {
		const ch = text.charAt(i);
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			if (depth === 0) return text.slice(afterOpen, i);
		} else if (ch === "," && depth === 1) {
			return text.slice(afterOpen, i);
		}
	}
	return text.slice(afterOpen, end);
}

/**
 * Detect write-family calls whose path argument derives from the user's real
 * home directory (directly, or through up to two local bindings).
 *
 * check id: `homedir_write_escape`
 */
export function detectHomedirWriteEscape(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];
	if (HOME_TEST_PATH_RE.test(filePath.replace(/\\/g, "/"))) return [];

	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const rawLines = content.split("\n");
	const names = collectHomeDerivedNames(strippedLines);
	const nameAlt =
		names.size > 0 ? new RegExp(`\\b(?:${Array.from(names).join("|")})\\b`) : null;

	const matches: InlineMatch[] = [];
	const seen = new Set<number>();
	HOME_WRITE_STRIPPED_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = HOME_WRITE_STRIPPED_RE.exec(stripped)) !== null) {
		const lineIdx = stripped.slice(0, m.index).split("\n").length - 1;
		const lineNo = lineIdx + 1;
		if (seen.has(lineNo)) continue;

		// Re-locate the call on the RAW line so template-literal paths
		// (`${process.env.HOME}/…`) are visible in the argument window.
		const rawLine = rawLines[lineIdx] ?? "";
		const rawCall = HOME_WRITE_RE.exec(rawLine);
		if (rawCall === null) continue;
		const window = firstArgWindow(rawLine, rawCall.index + rawCall[0].length);
		if (!HOME_SOURCE_RE.test(window) && !(nameAlt !== null && nameAlt.test(window))) continue;

		seen.add(lineNo);
		matches.push({ line: lineNo, text: rawLine.trim().slice(0, REPORT_LINE_TRUNC) });
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
	}
	return matches;
}
