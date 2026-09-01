// UBS language-specific detectors — JS/TS injection & security checks.
// Extracted from ubs-language-specific.ts during the 1500-line decomposition.
// Each function returns InlineMatch[]. Ext-gated to JS/TS variants.

import { nonNull } from "../../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	isVendoredOrFixturePath,
	lineHasNoqaSuppression,
	stripCommentsAndStrings,
} from "../shared.js";
import { stripCommentsPreservingStrings } from "./_shared.js";

// DOM/XSS & crypto security detectors live in the sibling leaf module.
// Re-exported here so the public barrel (ubs-language-specific.ts) and the
// test file keep importing them from this entry unchanged.
export {
	checkDocumentWrite,
	checkInsertAdjacentHtml,
	checkNodeCreateCipher,
	checkOuterHtmlAssignment,
	checkScriptWithoutSri,
	checkUncheckedRedirect,
} from "./js-security-checks-dom-crypto.js";

/** Strip comments + string literals for the eval scan, Python-aware. The shared
 *  `stripCommentsAndStrings` is JS-oriented and cannot span a multi-line string,
 *  so a Python triple-quoted DOCSTRING body would read as code and false-positive
 *  on `eval(...)` / `exec(...)` quoted in prose (e.g. a module docstring that
 *  documents what NOT to do). For `.py` we first blank triple-quoted strings and
 *  `#` line comments — preserving length + newlines so line numbers stay correct —
 *  then apply the shared single-line stripper for the remaining `'...'` / `"..."`. */
function strippedForEvalScan(content: string, isPy: boolean): string {
	if (!isPy) return stripCommentsAndStrings(content);
	const blank = (m: string): string => m.replace(/[^\n]/g, " ");
	const noDocstrings = content
		.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, blank)
		.replace(/#[^\n]*/g, blank);
	return stripCommentsAndStrings(noDocstrings);
}


/**
 * `ubs_eval_input` — `eval(...)` / `Function(...)` / `exec(...)` with a
 * non-string-literal argument. pre_block / error.
 *
 * The existing `checkEvalUsage` flags the raw keyword; this detector
 * specifically targets the tainted-input variant where an identifier
 * (likely a parameter or external value) is the first argument. Cross-
 * language: JS `eval` / `Function`; Python `eval` / `exec` / `compile`.
 * Skips test files because fixtures sometimes legitimately stress eval.
 */
export function checkEvalInputTainted(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isJs = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
	const isTs = ext === ".ts" || ext === ".tsx";
	const isPy = ext === ".py";
	if (!isJs && !isTs && !isPy) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = strippedForEvalScan(content, isPy);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// 139-repo audit (2026-05): cross-language gate. In JS/TS, bare
	// `exec(cmd)` is almost always Node `child_process.exec` (shell-out,
	// caught separately by `child_process_exec_user_input`). Bare
	// `compile(...)` doesn't exist as a global in JS. Restrict the JS/TS
	// match to `eval` / `Function` only — the true eval-class. Python
	// keeps the full `eval` / `exec` / `compile` set.
	//
	// `(?<![.\w])` excludes member-call forms (`.exec(input)` /
	// `.compile(input)` — regex methods, NOT global eval) and identifier-
	// prefix forms (`fooexec(...)` is a custom function, not the eval-
	// class). `\b` alone treated `.` as a word boundary and produced FPs
	// on every `re.exec(x)`.
	const re = isPy
		? /(?<![.\w])(?:eval|exec|compile)\s*\(\s*(?!["'`])([A-Za-z_$]\w*)/g
		: /(?<![.\w])(?:eval|Function)\s*\(\s*(?!["'`])([A-Za-z_$]\w*)/g;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		re.lastIndex = 0;
		if (!re.test(nonNull(strippedLines[i]))) continue;
		// 139-repo audit: respect Bandit `# noqa: S307 / S102` on the
		// same line. Supermodel's mcpbr/custom_metrics.py:347 was the
		// canonical case (sandboxed eval + intent comment). The check
		// anchors on the call line, so a same-line noqa is sufficient
		// (Python convention).
		if (lineHasNoqaSuppression(nonNull(originalLines[i]), "ubs_eval_input_tainted")) continue;
		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * `child_process_exec_user_input` — Node's `child_process.exec(userInput)`
 * family with a non-literal first argument. Command-injection vector.
 * pre_block / error.
 *
 * Complements `ubs_subprocess_shell_true` (Python-only) and
 * `ubs_eval_input_tainted` (which catches bare `exec(x)` after destructuring
 * but skips namespaced forms because of the negative-lookbehind on `.`).
 *
 * Detects the namespaced shapes:
 *   child_process.exec(userInput)
 *   cp.execSync(req.body)
 *   childProcess.spawn(input, args, { shell: true })   (when first arg is a var)
 *
 * The `(?!["'\`])` excludes string literals — a hardcoded command string is
 * not the user-input form. Skips test files because fixtures stress this.
 */
export function checkChildProcessExecUserInput(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isJs = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
	const isTs = ext === ".ts" || ext === ".tsx";
	if (!isJs && !isTs) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const commentStripped = stripCommentsPreservingStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const matchedLines = new Set<number>();

	// `(child_process|cp|childProcess).<fn>(<identifier>` — must be namespaced
	// AND first arg must be an identifier (not a string literal). The
	// `(?!["'\`])` after the open-paren excludes literal-only invocations.
	const re =
		/\b(?:child_process|childProcess|cp)\.(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*(?!["'`])([A-Za-z_$]\w*)/g;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		re.lastIndex = 0;
		if (!re.test(nonNull(strippedLines[i]))) continue;
		matchedLines.add(i + 1);
		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}

	const templateRe =
		/\b(?:child_process|childProcess|cp)\.(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*`(?:\\[\s\S]|[^`\\])*?\$\{(?:\\[\s\S]|[^`\\])*?`/g;
	for (const m of commentStripped.matchAll(templateRe)) {
		if (matches.length >= 10) break;
		const idx = m.index;
		const lineNum = commentStripped.slice(0, idx).split("\n").length;
		if (matchedLines.has(lineNum)) continue;
		matchedLines.add(lineNum);
		matches.push({
			line: lineNum,
			text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * `mixed_sync_async_file_api` — function body contains both `fs.*Sync` calls
 * and `await fs.*` / `await fsp.*` calls. Almost always a partial-conversion
 * bug where someone migrated some calls to async but missed others.
 * pre_block / error.
 *
 * Detection per function: split content into function-shaped chunks, then
 * for each chunk check that BOTH a `\b\w+Sync\s*\(` (any identifier ending
 * in Sync) AND an `await\s+\w+\.(?:read|write|stat|...)` co-occur AND at
 * least one of the references is to fs/fsp/promises. Conservative — false
 * negatives are fine; the FP rate must stay zero.
 */
export function checkMixedSyncAsyncFileApi(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isJs = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
	const isTs = ext === ".ts" || ext === ".tsx";
	if (!isJs && !isTs) return [];
	if (isTestFile(filePath)) return [];
	if (!/\bfs\b|\bfsp\b|node:fs|"fs"|'fs'/.test(content)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const fsApiCalls = new Set([
		"readFile", "writeFile", "readdir", "stat", "lstat", "open",
		"close", "unlink", "mkdir", "rmdir", "rm", "rename", "copyFile",
		"chmod", "chown", "appendFile", "access", "readlink", "symlink",
	]);
	const syncRe = new RegExp(`\\b(?:fs|fsp)\\.(?:${[...fsApiCalls].join("|")})Sync\\s*\\(`, "g");
	const awaitRe = new RegExp(`\\bawait\\s+(?:fs|fsp)\\.(?:${[...fsApiCalls].join("|")})\\s*\\(`, "g");

	// pre_block/error: the FP budget is zero. A sliding window cross-flags
	// sibling helpers (one with `fs.readFileSync`, the next with
	// `await fs.readFile`) even when no single function mixes the two. Scope
	// to function bodies via brace-balanced extraction, then mask out nested
	// function bodies so a child function's `await` doesn't taint its parent.
	const bodies = findFunctionBodies(stripped);
	const seenLines = new Set<number>();
	for (const body of bodies) {
		if (matches.length >= 10) break;
		const localBody = maskNestedBodies(stripped, body, bodies);
		if (!syncRe.test(localBody)) continue;
		syncRe.lastIndex = 0;
		const awaitMatch = awaitRe.exec(localBody);
		awaitRe.lastIndex = 0;
		if (!awaitMatch) continue;
		const absoluteIdx = body.start + awaitMatch.index;
		const lineNum = stripped.slice(0, absoluteIdx).split("\n").length;
		if (seenLines.has(lineNum)) continue;
		seenLines.add(lineNum);
		matches.push({
			line: lineNum,
			text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150),
		});
	}
	return matches;
}

interface FunctionBody {
	start: number;
	end: number;
}

/**
 * Extract function/method/arrow body byte ranges from `src`. Ranges are
 * (open-brace + 1, close-brace) — i.e. the body interior. Caller is
 * responsible for filtering nested bodies when analyzing a single body.
 */
function findFunctionBodies(src: string): FunctionBody[] {
	const ranges: FunctionBody[] = [];
	const controlKeyword = /\b(?:if|while|for|switch|catch|do|else)\s*$/;
	// Match `)` or `=>` followed by an optional return-type annotation and `{`.
	const re = /(\)|=>)\s*(?::[^{=;]+)?\{/g;
	for (const m of src.matchAll(re)) {
		const matchIdx = m.index;
		const openIdx = matchIdx + m[0].length - 1;
		// Skip control-flow constructs whose `) {` looks like a function start.
		if (m[1] === ")") {
			const before = src.slice(Math.max(0, matchIdx - 32), matchIdx);
			if (controlKeyword.test(before)) continue;
		}
		let depth = 1;
		let j = openIdx + 1;
		while (j < src.length && depth > 0) {
			const c = src[j];
			if (c === "{") depth++;
			else if (c === "}") depth--;
			j++;
		}
		if (depth === 0) ranges.push({ start: openIdx + 1, end: j - 1 });
	}
	return ranges;
}

/**
 * Return the body slice with strictly-nested function bodies blanked out
 * (newlines preserved). A nested helper's `await` cannot taint its parent
 * function once its body is masked.
 */
function maskNestedBodies(src: string, body: FunctionBody, all: FunctionBody[]): string {
	const slice = src.slice(body.start, body.end).split("");
	for (const inner of all) {
		if (inner.start <= body.start || inner.end >= body.end) continue;
		const localStart = inner.start - body.start;
		const localEnd = inner.end - body.start;
		for (let i = localStart; i < localEnd; i++) {
			if (slice[i] !== "\n") slice[i] = " ";
		}
	}
	return slice.join("");
}

// Upper bound on how far `sliceBalancedParens` will scan from the opening
// paren when searching for its match. Most call expressions close within a
// few hundred characters; the bound exists to keep the scan O(maxLen) on
// pathologically long single-line code rather than O(file).
const BALANCED_PARENS_MAX_SCAN = 2000;

/**
 * Walk forward from the position of an opening `(` and return the substring
 * between the parens, balanced. Returns null if the call doesn't close within
 * `maxLen` characters or runs to EOF unmatched.
 */
function sliceBalancedParens(
	src: string,
	openIdx: number,
	maxLen = BALANCED_PARENS_MAX_SCAN,
): string | null {
	if (src[openIdx] !== "(") return null;
	let depth = 1;
	let j = openIdx + 1;
	const end = Math.min(src.length, openIdx + maxLen);
	while (j < end && depth > 0) {
		const c = src[j];
		if (c === "(") depth++;
		else if (c === ")") depth--;
		j++;
	}
	if (depth !== 0) return null;
	return src.slice(openIdx + 1, j - 1);
}

/**
 * Given a function-call argument list, extract the body of the first
 * top-level `{...}` object literal so security flags can be inspected even
 * when nested calls or arrays appear before/after it.
 */
function extractTopLevelObject(args: string): string {
	const openIdx = args.indexOf("{");
	if (openIdx < 0) return "";
	let depth = 1;
	let j = openIdx + 1;
	while (j < args.length && depth > 0) {
		const c = args[j];
		if (c === "{") depth++;
		else if (c === "}") depth--;
		j++;
	}
	if (depth !== 0) return args.slice(openIdx + 1);
	return args.slice(openIdx + 1, j - 1);
}

/**
 * Cohesive sub-block of `checkCookieMissingSecurityFlags`: scans
 * `res.cookie(...)` / `cookies.set(...)` call sites and appends a match for
 * each one whose options object doesn't declare both `httpOnly: true` AND
 * `secure: true`. Mutates `matches` in place (shared 10-match budget with the
 * `setHeader` sibling collector, so the cap must read the live array length).
 *
 * Balances parens forward from the opening `(` rather than a non-greedy
 * `.*?\)` regex, because the latter stops at the first `)` — common secure
 * cookies whose options object contains nested calls (e.g.
 * `expires: new Date(...)`) would get truncated before the security flags
 * can be inspected, producing a pre_block false positive.
 */
function collectCookieCallViolations(
	stripped: string,
	originalLines: string[],
	matches: InlineMatch[],
): void {
	const cookieCallRe = /\b(?:res\.cookie|cookies\.set)\s*\(/g;
	for (const m of stripped.matchAll(cookieCallRe)) {
		if (matches.length >= 10) break;
		const openIdx = m.index + m[0].length - 1;
		const args = sliceBalancedParens(stripped, openIdx);
		if (args === null) continue;
		const opts = extractTopLevelObject(args);
		const hasHttpOnly = /\bhttpOnly\s*:\s*true\b/i.test(opts);
		const hasSecure = /\bsecure\s*:\s*true\b/i.test(opts);
		if (hasHttpOnly && hasSecure) continue;
		const idx = m.index;
		const lineNum = stripped.slice(0, idx).split("\n").length;
		matches.push({
			line: lineNum,
			text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150),
		});
	}
}

/**
 * Cohesive sub-block of `checkCookieMissingSecurityFlags`: scans
 * `res.setHeader('Set-Cookie', ...)` call sites and appends a match for each
 * one whose header-value text doesn't mention both `HttpOnly` AND `Secure`.
 * Mutates `matches` in place — reads the shared 10-match budget AND dedupes
 * against lines the `res.cookie`/`cookies.set` collector already flagged (a
 * single call site can be caught by both regexes).
 */
function collectSetHeaderCookieViolations(
	stripped: string,
	originalLines: string[],
	matches: InlineMatch[],
): void {
	const setHeaderRe =
		/\b(?:[A-Za-z_$]\w*\.)?setHeader\s*\(\s*(['"`])Set-Cookie\1\s*,\s*([\s\S]{0,400}?)\)/g;
	for (const m of stripped.matchAll(setHeaderRe)) {
		if (matches.length >= 10) break;
		const headerValue = m[2] || "";
		const hasHttpOnly = /\bHttpOnly\b/i.test(headerValue);
		const hasSecure = /\bSecure\b/i.test(headerValue);
		if (hasHttpOnly && hasSecure) continue;
		const idx = m.index;
		const lineNum = stripped.slice(0, idx).split("\n").length;
		if (matches.some((match) => match.line === lineNum)) continue;
		matches.push({
			line: lineNum,
			text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150),
		});
	}
}

/**
 * `cookie_missing_security_flags` — `Set-Cookie` written via `res.cookie(...)`
 * / `res.setHeader('Set-Cookie', ...)` / `cookies.set(...)` without both
 * `httpOnly: true` AND `secure: true`. Session-fixation / theft vector.
 * pre_block / error.
 *
 * Detection flags cookie-set calls that either omit an options object entirely
 * or include same-call options/header text missing one or both flags. Skips
 * test files.
 */
export function checkCookieMissingSecurityFlags(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isJs = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
	const isTs = ext === ".ts" || ext === ".tsx";
	if (!isJs && !isTs) return [];
	if (isTestFile(filePath)) return [];
	if (!/cookie/i.test(content)) return [];

	const stripped = stripCommentsPreservingStrings(content);
	const matches: InlineMatch[] = [];
	const originalLines = content.split("\n");

	collectCookieCallViolations(stripped, originalLines, matches);
	collectSetHeaderCookieViolations(stripped, originalLines, matches);
	return matches;
}

/**
 * `logger_format_user_input` — `logger.<level>(userInput, ...)` where the
 * first argument is a non-literal expression that references a request-bound
 * identifier. Format-string injection / log poisoning vector. pre_block /
 * error.
 *
 * Narrow seed list: logger / log / console with the suspicious-source
 * identifiers (req, ctx, input, user, params, body, query) on the first
 * argument. Conservative; expand only if FP rate stays at 0 in dogfood.
 */
export function checkLoggerFormatUserInput(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isJs = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
	const isTs = ext === ".ts" || ext === ".tsx";
	if (!isJs && !isTs) return [];
	if (isTestFile(filePath)) return [];
	if (!/\b(?:logger|log|console)\.(?:info|warn|error|debug|trace|fatal)\b/.test(content)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `logger.<level>(<sourceIdent>...` where <sourceIdent> starts with one
	// of the request-bound prefixes. Excludes string-literal first arg via
	// the negative lookahead.
	const re =
		/\b(?:logger|log|console)\.(?:info|warn|error|debug|trace|fatal)\s*\(\s*(?!["'`])(req|ctx|input|user|params|body|query|userInput|userMsg)\b/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!re.test(nonNull(strippedLines[i]))) continue;
		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}
	return matches;
}
