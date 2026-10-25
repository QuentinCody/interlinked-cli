// interlinked-tdd: exempt
// ===========================================
// Write/Edit Content-Quality Heuristics (PreToolUse, leaf helpers)
// ===========================================
//
// The path-based scan-exemption predicate plus the legacy cross-language
// and TS/JS-only content-quality regex checks, extracted verbatim from
// write-content-guards.ts. Pure functions over `(filePath, content)`:
// callers append the returned strings to their warning list.

import { isAbsolute, resolve } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import { checkJsonParseUnsafe } from "../checks/js-ts-general.js";
import { isCliCommandModule, isCliEntrypoint } from "../checks/language-agnostic.js";
import { isTestFile } from "../checks/shared.js";
import { extractTemplateInterpolationExpressions, stripAllLiterals } from "../strip-helpers.js";

/** Minimum content length before we bother scanning for prompt injections. */
export const INJECTION_SCAN_MIN_CHARS = 10;

/** TS/JS/MJS/CJS file extensions that trigger the legacy content-quality heuristics. */
const JS_TS_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs)$/;

/** Identifiers that mark a value as a credential. The A3 Math.random() check
 *  fires only when one of these shares the Math.random() line — a whole-file
 *  scan for security-ish words made the check fire on any file containing a
 *  React `key={}` prop, a `location.hash`, or an A/B-test `pickVariant()`.
 *  Substring (not word-boundary) so camelCase compounds like `sessionToken`
 *  and `resetToken` match; bare `key`/`hash`/`auth`/`crypto` are deliberately
 *  excluded as far too common to be a reliable security signal. */
const A3_SECURITY_CONTEXT =
	/password|passwd|secret|token|credential|nonce|csrf|\bsalt\b|\bjwt\b|api[_-]?key|private[_-]?key|signing[_-]?key|access[_-]?key|session[_-]?id/i;

/**
 * Files where regex-based content-quality scans produce only false positives:
 * the dangerous patterns appear AS DATA (rule definitions, test fixtures),
 * not as live code. Scanning them turns every legitimate use of "chmod 777",
 * "Access-Control-Allow-Origin: *", or a nested-quantifier regex string into
 * a misleading warning. The exemption is path-based because content-based
 * disambiguation (is-this-inside-a-string-literal?) requires a real parser
 * for a marginal gain.
 *
 * Exempt:
 *  - Documentation / prose files (`.md`, `.mdx`, `.markdown`, `.txt`, `.rst`,
 *    `.adoc`). These routinely contain regex examples, "chmod 777" in
 *    tutorials, sample URLs, etc. — all as documentation, not code.
 *  - Interlinked CLI's own rule definition files (`src/harness/rules/**`,
 *    `check-registry/**`) via the shared package-root-scoped `isTestFile()`
 *    exemption. User projects with similarly named directories are still scanned.
 *  - Test fixtures: `*.test.*`, `*.spec.*`, files under `__tests__/`
 *  - Config/fixture sentinels: `*.config.*`, `*.fixture.*`
 *
 * Real bugs in test files still surface via tsc/biome/eslint — those run
 * regardless. Only the regex-driven content-quality heuristics are skipped.
 */
export function isContentScanExempt(filePath: string, cwd: string | undefined): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	// `.claude/workflows/` (and the session-persisted `.claude/**/workflows/`)
	// hold Workflow-sandbox orchestration scripts: top-level await/return, plus
	// example-URL arrays that are CONFIGURABLE defaults (args.repos overrides).
	// They are tooling, not shipped modules — the URL / ReDoS / task-marker
	// content-quality heuristics only ever false-fire on them.
	if (/\.claude\/(?:[^/]+\/)*workflows\//.test(normalized)) return true;
	if (/\.(md|mdx|markdown|txt|rst|adoc)$/i.test(normalized)) return true;
	if (/\.(config|fixture)\.\w+$/.test(normalized)) return true;
	if (isTestFile(normalized)) return true;
	if (!isAbsolute(filePath) && cwd && isTestFile(resolve(cwd, filePath))) return true;
	return false;
}

/** A file whose entire job is to hold constant data — `consts.ts`,
 *  `constants.ts`, and the language-agnostic equivalents. URLs in such a file
 *  are committed content (canonical links, OG images, social handles), not
 *  deployment config, so the A7 "move to env vars" advice does not apply.
 *  Stem-only exact match: a `constants.py` qualifies, an `app-constants.ts`
 *  intentionally does not (kept tight so A7 still fires on real logic files). */
function isUrlDataFile(filePath: string): boolean {
	const base = (filePath.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
	const stem = base.replace(/\.[^.]+$/, "");
	return stem === "const" || stem === "consts" || stem === "constant" || stem === "constants";
}

/** Content-quality regex checks shared across all languages plus a TS/JS-only block.
 *  Pure function over `(filePath, content)` — callers append to their warning list. */
export function collectContentQualityWarnings(
	filePath: string,
	content: string,
	cwd: string | undefined,
): string[] {
	const warnings: string[] = [];

	// Files in this list legitimately contain dangerous-looking strings as
	// data — short-circuit the entire content-quality scan for them.
	if (isContentScanExempt(filePath, cwd)) return warnings;

	// TS/JS content checks
	if (JS_TS_EXTENSIONS.test(filePath) && content.length > INJECTION_SCAN_MIN_CHARS) {
		warnings.push(...collectTsJsQualityWarnings(filePath, content, cwd));
	}

	// Cross-language A7-A11 heuristics.
	warnings.push(...collectUrlAndSqlWarnings(filePath, content));
	warnings.push(...collectPermissionsRedosJsdocWarnings(filePath, content));

	return warnings;
}

/** A7: hardcoded non-localhost URLs (all file types; dedicated constant/content
 *  modules are exempt — they hold URLs as committed data) and A8: SQL-injection
 *  template-literal interpolation in `.exec`/`.query`/`sql`` calls (TS/JS/PY). */
function collectUrlAndSqlWarnings(filePath: string, content: string): string[] {
	const warnings: string[] = [];
	if (!isUrlDataFile(filePath)) {
		const urlMatches = content.match(/https?:\/\/(?!localhost|127\.0\.0\.1)[^\s"'`>)}\]]+/g);
		if (urlMatches && urlMatches.length > 3) {
			warnings.push(
				`[interlinked:content-quality] ${urlMatches.length} hardcoded URLs in ${filePath}. Consider using configuration or environment variables.`,
			);
		}
	}
	if (
		/\.(tsx?|jsx?|py)$/.test(filePath) &&
		(/\.exec\s*\(\s*`[^`]*\$\{/.test(content) ||
			/\.query\s*\(\s*`[^`]*\$\{/.test(content) ||
			/\bsql\s*`[^`]*\$\{/.test(content))
	) {
		warnings.push(
			`[interlinked:content-quality] Possible SQL injection in ${filePath}. Use parameterized queries instead of template literal interpolation.`,
		);
	}
	return warnings;
}

/** A9 overly-permissive CORS/chmod, A10 ReDoS nested quantifiers, and A11 JSDoc
 *  premature-close ("*​/" inside a single-line JSDoc body). A10 is a coarse
 *  shape-match by design; ReDoS-detector files carry such shapes as data (a
 *  known-FP class accepted as the cost of broad coverage). */
function collectPermissionsRedosJsdocWarnings(filePath: string, content: string): string[] {
	const warnings: string[] = [];
	// A9: Overly permissive CORS/chmod
	if (
		/Access-Control-Allow-Origin:\s*\*/.test(content) ||
		/['"]Access-Control-Allow-Origin['"]\s*[,:]\s*['"]\*['"]/.test(content)
	) {
		warnings.push(
			`[interlinked:content-quality] Wildcard CORS (Access-Control-Allow-Origin: *) in ${filePath}. Restrict to specific origins in production.`,
		);
	}
	if (/\bchmod\s+777\b/.test(content) || /\b0o777\b/.test(content)) {
		warnings.push(
			`[interlinked:content-quality] chmod 777 / 0o777 in ${filePath}. Use more restrictive permissions.`,
		);
	}
	// A10: Regex DoS — nested quantifiers
	if (/\([^)]*[+*][^)]*\)[+*]/.test(content)) {
		warnings.push(
			`[interlinked:content-quality] Potential ReDoS pattern (nested quantifiers) in ${filePath}. Simplify the regex to avoid catastrophic backtracking.`,
		);
	}
	warnings.push(...collectJsdocPrematureCloseWarnings(filePath, content));
	return warnings;
}

/**
 * A single-line JSDoc whose terminator is formed by an embedded glob, with
 * orphaned text left after it on the same line. The trailing non-space char is
 * what separates a premature close from a legitimate decorative one: a comment
 * ending in a doubled star and nothing else closed exactly where intended.
 */
const PREMATURE_JSDOC_CLOSE_RE = /\/\*\*.*?\*\*\/\S/;

/**
 * A11: a JSDoc terminated early by an embedded glob, leaving the rest of the
 * line outside the comment as syntax errors.
 *
 * Scoped to JS/TS because JSDoc is a JS/TS construct. The previous version ran
 * on every file type and fired on a `.json` manifest whose string values held
 * comment text.
 *
 * The previous matcher was greedy, spanning from the FIRST opener to the LAST
 * terminator on a line, so two valid single-line JSDocs on one line reported
 * each other as a premature close.
 */
function collectJsdocPrematureCloseWarnings(filePath: string, content: string): string[] {
	if (!JS_TS_EXTENSIONS.test(filePath)) return [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		if (PREMATURE_JSDOC_CLOSE_RE.test(nonNull(lines[i]))) {
			return [
				`[interlinked:content-quality] JSDoc at line ${i + 1} in ${filePath} is closed early by an embedded glob, leaving the rest of the line outside the comment. Globs break parsers (tsc, biome, esbuild) — escape the star or move the pattern into a backticked code span.`,
			];
		}
	}
	return [];
}

/** Comment- and string-stripped view of `content`, including the code inside
 *  template-literal `${...}` interpolations. A real `as any` / `as unknown`
 *  cast or `console.log` call is always code, so the bare words inside a doc
 *  comment (e.g. "Count of `as any` casts") or a string literal are not the
 *  pattern — counting those was a recurring FP on type-definition / detector
 *  files that document the ratchet metrics. */
function stripCommentsAndStrings(content: string): string {
	const interpolationCode = extractTemplateInterpolationExpressions(content)
		.map((expr) => stripAllLiterals(expr))
		.join("\n");
	return `${stripAllLiterals(content)}\n${interpolationCode}`;
}

/** as-any / as-unknown unsafe assertions + console.log debug logging. Both
 *  scan the comment-/string-stripped `codeOnly` view so only real code counts.
 *  `cliEntrypoint` (see `isCliEntrypoint`) mutes ONLY the console.log warning:
 *  an entrypoint's console.log IS its output, but its `as any` casts are still
 *  casts. */
function collectAssertionAndLogWarnings(
	filePath: string,
	codeOnly: string,
	cliEntrypoint: boolean,
): string[] {
	const warnings: string[] = [];
	const asAnyCount = (codeOnly.match(/\bas\s+any\b/g) || []).length;
	const asUnknownCount = (codeOnly.match(/\bas\s+unknown\b/g) || []).length;
	const parts: string[] = [];
	if (asAnyCount > 0) parts.push(`${asAnyCount} "as any"`);
	if (asUnknownCount > 0) parts.push(`${asUnknownCount} "as unknown"`);
	if (parts.length > 0) {
		warnings.push(
			`[interlinked:content-quality] ${parts.join(" + ")} assertion(s) in ${filePath}. Prefer proper typing (interfaces, generics, branded types).`,
		);
	}
	// console.log left in production code (not test files, not CLI entrypoints —
	// shebang / package.json-bin target / scripts|bin path segment — whose
	// console.log is the program's output; field report 2026-07-06)
	if (!/\.(test|spec)\.\w+$/.test(filePath) && !cliEntrypoint) {
		const consoleLogs = (codeOnly.match(/\bconsole\.(log|debug|info)\b/g) || []).length;
		if (consoleLogs > 2) {
			warnings.push(
				`[interlinked:content-quality] ${consoleLogs} console.log statements in ${filePath}. Remove debug logging before committing.`,
			);
		}
	}
	return warnings;
}

/** Unresolved task markers (in COMMENTS only), empty catch blocks, and A2
 *  eval / new Function(). Task markers require a comment lead-in (// or /* or
 *  jsdoc *) so the marker vocabulary inside string literals (e.g. "TICKET-XXX")
 *  and a detector's own /TODO|FIXME/ regex is not miscounted.
 *
 *  Refined (2026-06): a marker word mid-enumeration in a comment that DESCRIBES
 *  marker detection (`* stub / TODO / disabled-test patterns`, `// scans for
 *  TODO and FIXME markers`, `// the FIXME handler runs here`) is not a real
 *  task marker. It now fires only when the marker is the FIRST content token of
 *  the comment (lead-in + optional whitespace) OR is immediately followed by
 *  `:` or `(` (the `// TODO:` / `/* FIXME(alice):` shapes). */
function collectMarkerEvalWarnings(filePath: string, content: string): string[] {
	const warnings: string[] = [];
	// A marker immediately preceded by a backtick/quote/backslash is DOCUMENTING
	// the pattern (a detector's own `TODO:` example or a /TODO/ regex literal), not
	// a real task marker — the negative lookbehind excludes those. Fixes the FP
	// where a TODO/FIXME detector's own source flagged its detection strings
	// (e.g. verification-stop-checks-predicates.ts's `// \`TODO:\` / \`TODO(name):\``).
	const taskMarkerPattern = new RegExp(
		"(?:\\/\\/|\\/\\*|\\*)(?:\\s*(?<![`'\"\\\\])(?:TODO|FIXME|HACK|XXX)\\b|[^\\n]*?(?<![`'\"\\\\])\\b(?:TODO|FIXME|HACK|XXX)\\s*[:(])",
		"g",
	);
	const taskMarkers = (content.match(taskMarkerPattern) || []).length;
	if (taskMarkers > 0) {
		warnings.push(
			`[interlinked:content-quality] ${taskMarkers} unresolved task marker${taskMarkers > 1 ? "s" : ""} in ${filePath}. Resolve before committing or create a tracking issue.`,
		);
	}
	// Task markers live in comments by definition; the empty-catch and eval checks
	// read only code, so a comment or string that mentions the pattern (e.g. the
	// doc comment "Operating points from the eval (see header)") is not a finding.
	const code = stripCommentsAndStrings(content);
	if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(code)) {
		warnings.push(
			`[interlinked:content-quality] Empty catch block in ${filePath}. Silent error swallowing hides bugs — at minimum log the error.`,
		);
	}
	// A2: eval / Function constructor
	if (/\beval\s*\(/.test(code) || /\bnew\s+Function\s*\(/.test(code)) {
		warnings.push(
			`[interlinked:content-quality] eval() or new Function() in ${filePath}. These enable code injection — use safer alternatives.`,
		);
	}
	return warnings;
}

/** A3: Math.random() feeding a security-sensitive value (predictable tokens).
 *  Scoped to the Math.random() line itself (plus the line above, for multi-line
 *  assignments): a whole-file scan fired on any file that merely contained
 *  "key"/"hash"/"auth" elsewhere — a React `key={}` prop or an A/B-test
 *  `pickVariant()` that uses Math.random() for bucketing, where crypto-grade
 *  randomness is genuinely unnecessary. */
function collectInsecureRandomWarning(filePath: string, content: string): string | null {
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (!/\bMath\.random\b/.test(nonNull(lines[i]))) continue;
		const ctx = (i > 0 ? `${lines[i - 1]}\n` : "") + lines[i];
		if (A3_SECURITY_CONTEXT.test(ctx)) {
			return `[interlinked:content-quality] Math.random() used to derive a security-sensitive value in ${filePath} (line ${i + 1}). Use crypto.randomUUID() or crypto.getRandomValues() instead.`;
		}
	}
	return null;
}

/** A5: the first JSON.parse() not protected by an enclosing try block. Delegates
 *  to the brace-tracked `checkJsonParseUnsafe` (strips comments/strings, tracks
 *  try-depth) so a parse guarded by an enclosing-function try — even when the
 *  catch sits many lines below — is not flagged, and a JSON.parse appearing only
 *  inside a string or comment is ignored. The previous "is there a try in the 5
 *  lines above" heuristic false-flagged both shapes. */
function collectUnguardedJsonParseWarning(filePath: string, content: string): string | null {
	const [first] = checkJsonParseUnsafe(content, filePath);
	if (!first) return null;
	return `[interlinked:content-quality] JSON.parse() without try-catch at line ${first.line} in ${filePath}. Wrap in try-catch to handle malformed input.`;
}

/** Upper bound on continuation lines scanned for one statement's chain. */
const CHAIN_SCAN_MAX_LINES = 200;

/** Net `(`/`[`/`{` minus `)`/`]`/`}` on a stripped line — bracket characters
 *  inside strings/comments are already blanked in the caller's stripped view. */
function bracketDelta(line: string): number {
	let delta = 0;
	for (const ch of line) {
		if (ch === "(" || ch === "[" || ch === "{") delta++;
		else if (ch === ")" || ch === "]" || ch === "}") delta--;
	}
	return delta;
}

/**
 * Whether the statement starting at `lines[i]` is rejection-handled on a
 * LATER line of its own chain — a continuation line carrying `.catch(` or
 * `.finally(`. Continuation = lines while brackets remain open, plus
 * `.method(...)` chain segments (next non-blank line starting with `.`).
 * A same-line `main().catch(...)` is already exempted by the A4 regex; this
 * covers the multi-line form (field report 2026-07-06). `.then(`-only
 * continuations stay flagged — .then alone does not handle rejection.
 */
function chainHandledOnLaterLine(lines: string[], i: number): boolean {
	let depth = bracketDelta(nonNull(lines[i]));
	for (let j = i + 1; j < lines.length && j - i <= CHAIN_SCAN_MAX_LINES; j++) {
		const line = nonNull(lines[j]);
		const trimmed = line.trim();
		if (depth <= 0) {
			if (trimmed === "") continue;
			if (!trimmed.startsWith(".")) return false; // statement ended, no handler
		}
		if (/\.(?:catch|finally)\s*\(/.test(line)) return true;
		depth += bracketDelta(line);
	}
	return false;
}

/** A4: floating promises — async-named calls at statement position without
 *  await/void/return, no `.then/.catch/.finally` on the same line, and no
 *  `.catch(`/`.finally(` on a continuation line of the same chain. */
function collectFloatingPromiseWarning(filePath: string, codeOnly: string): string | null {
	const floatingLineRe =
		/^\s*(?!.*\b(?:await|void|return)\b)(?!.*\.(?:then|catch|finally)\s*\().*\b\w*(?:Async|async)\w*\s*\(/;
	const lines = codeOnly.split("\n");
	let count = 0;
	for (let i = 0; i < lines.length; i++) {
		if (!floatingLineRe.test(nonNull(lines[i]))) continue;
		if (chainHandledOnLaterLine(lines, i)) continue;
		count++;
	}
	if (count === 0) return null;
	return `[interlinked:content-quality] ${count} potential floating promise(s) in ${filePath}. Add await, void, or .catch() to handle rejections.`;
}

/** A3-A6 runtime-risk heuristics: insecure Math.random(), A4 floating promises
 *  (async-named calls without await/void/return/.then/.catch), A5 unguarded
 *  JSON.parse(), and A6 mixed import/require module systems. */
function collectRuntimeRiskWarnings(
	filePath: string,
	content: string,
	codeOnly: string,
): string[] {
	const warnings: string[] = [];
	const insecureRandom = collectInsecureRandomWarning(filePath, content);
	if (insecureRandom !== null) warnings.push(insecureRandom);
	// A4: Floating promises — chain-aware across lines: a multi-line
	// `main()\n  .catch(...)` chain is handled at the call site, not floating.
	const floatingWarning = collectFloatingPromiseWarning(filePath, codeOnly);
	if (floatingWarning !== null) warnings.push(floatingWarning);
	const unguardedParse = collectUnguardedJsonParseWarning(filePath, content);
	if (unguardedParse !== null) warnings.push(unguardedParse);
	// A6: Import/require mixing
	if (!/\.cjs$/.test(filePath) && /\bimport\s+/.test(content) && /\brequire\s*\(/.test(content)) {
		warnings.push(
			`[interlinked:content-quality] Mixed import/require in ${filePath}. Use one module system consistently (prefer ES imports).`,
		);
	}
	return warnings;
}

/** TS/JS-specific content-quality heuristics (A2-A6 plus the older as-any /
 *  console.log set). Thin orchestrator over the per-family collectors. `cwd`
 *  resolves relative paths for the entrypoint bin-map lookup. */
function collectTsJsQualityWarnings(
	filePath: string,
	content: string,
	cwd: string | undefined,
): string[] {
	const codeOnly = stripCommentsAndStrings(content);
	return [
		...collectAssertionAndLogWarnings(filePath, codeOnly, isCliEntrypoint(filePath, content, cwd) || isCliCommandModule(filePath, cwd)),
		...collectMarkerEvalWarnings(filePath, content),
		...collectRuntimeRiskWarnings(filePath, content, codeOnly),
	];
}
