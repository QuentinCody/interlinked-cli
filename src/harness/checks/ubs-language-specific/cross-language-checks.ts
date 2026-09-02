// UBS language-specific detectors — cross-language checks. Extracted from
// ubs-language-specific.ts during the 1500-line decomposition. Each function
// returns InlineMatch[]. Multi-language; ext-gated per check.

import { nonNull } from "../../../lib/non-null.js";
import { stripRegexLiterals } from "../../strip-helpers.js";
import { getExtension, type InlineMatch, isTestFile } from "../shared.js";
import { MATCH_LIMIT, stripCommentsPreservingStrings } from "./_shared.js";

/**
 * `ubs_sql_string_concat` — SQL keyword in a quoted string immediately
 * followed by JS/Py concatenation/interpolation with an identifier.
 * pre_block / error.
 *
 * Detects:
 *   - `"SELECT * FROM " + table` (string +)
 *   - `` `SELECT * WHERE id = ${userId}` `` (template literal injection)
 *   - `"SELECT " + col + " FROM " + table` (Python-style)
 *
 * Does NOT fire on parameterized queries (`db.query("...$1...", [v])`),
 * which are the safe form. Skips test files.
 */
// Source extensions the SQL-concat check scans. Kept as a Set so the
// extension check is a single membership test instead of a long `||` chain —
// extracted to keep the orchestrator's cyclomatic count low, matching the
// pattern already used for `LOCALHOST_SOURCE_EXTS` below.
const SQL_CONCAT_SOURCE_EXTS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".swift",
]);

// Tightened verb forms — earlier `UPDATE` / `DROP` / `TRUNCATE` matched
// plain English ("dirty update:", "drop the file", etc.). Each verb now
// requires the syntactic neighbor that disambiguates SQL from prose.
const SQL_CONCAT_VERB_RE =
	/\b(?:SELECT\s+(?:\*|DISTINCT\s|[\w,\s]+\s+FROM)|INSERT\s+INTO\s+\w+|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\s+\w+|DROP\s+(?:TABLE|INDEX|DATABASE|SCHEMA|VIEW)\b|TRUNCATE\s+TABLE\b)/i;
const SQL_CONCAT_SELECT_PREFIX_RE = /\bSELECT\s*["'`]\s*[+,]/i;
// JS/Py/Go/Rust: `"…" + ident` or `` `…${expr}…` ``.
// Swift: `"…\(ident)…"` — Swift's string interpolation uses `\(expr)`.
//
// FP fix (2026-06): the concat token must be ADJACENT to the string
// delimiter (`["'`]\s*[+,]`) so a comma INSIDE the literal — a SQL column
// list like `"SELECT id, name FROM users"` — is not read as JS
// concatenation. The earlier `["'`].*[+,]` greedily spanned into the
// literal and FP'd on every multi-column SELECT.
const SQL_CONCAT_INTERPOLATION_RE =
	/["'`]\s*[+,]\s*[A-Za-z_$]\w*|`[^`]*\$\{[^}]*\}[^`]*`|"[^"]*\\\([^)]+\)/;

// Helicone audit (2026-05): the check was firing 66 times on
// `WHERE id = $1` style PARAMETERIZED queries — the `$N` placeholder
// IS the safe form. Same for `?` (positional) and `:name` (named).
// Skip any line that contains a recognizable parameterized-query
// placeholder, regardless of what follows it.
//
// The `?` placeholder accepts any closing context (whitespace, comma,
// `)`, `"`, `'`) so Swift / Java forms like `"WHERE id = ?"` are
// recognized as parameterized — the placeholder sits at the END of
// the string literal, immediately followed by the closing quote.
const SQL_CONCAT_PLACEHOLDER_RE = /\$\d+\b|[=(,\s]\?[\s,)"']|:\w+\b/;
// Event-handler shapes that look SQL-y because of an interpolated
// callback arg ("`click`", "${selector}") but are not SQL.
const SQL_CONCAT_EVENT_LISTENER_RE =
	/\.\s*(?:on|once|addEventListener|removeEventListener)\s*\(/;

/**
 * True when `filePath` is a source file the SQL-concat check should scan — a
 * recognized code extension, not a test file. Extracted from
 * `checkSqlStringConcat` so the extension `||` chain lives in its own scope.
 */
function isSqlConcatScannableFile(filePath: string): boolean {
	if (!SQL_CONCAT_SOURCE_EXTS.has(getExtension(filePath))) return false;
	return !isTestFile(filePath);
}

/**
 * True when `line` looks like a SQL statement with unsafe string
 * concatenation/interpolation of an identifier, after the parameterized-query
 * and event-listener exemptions. Extracted from `checkSqlStringConcat` so its
 * chain of guard conditions lives in its own scope.
 */
function isUnsafeSqlConcatLine(line: string): boolean {
	if (!SQL_CONCAT_VERB_RE.test(line) && !SQL_CONCAT_SELECT_PREFIX_RE.test(line)) return false;
	if (!SQL_CONCAT_INTERPOLATION_RE.test(line)) return false;
	// Tightening: parameterized queries are safe — skip them.
	if (SQL_CONCAT_PLACEHOLDER_RE.test(line)) return false;
	// Tightening: event-handler shapes aren't SQL — skip them.
	if (SQL_CONCAT_EVENT_LISTENER_RE.test(line)) return false;
	return true;
}

export function checkSqlStringConcat(content: string, filePath: string): InlineMatch[] {
	if (!isSqlConcatScannableFile(filePath)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(originalLines[i]);
		if (!isUnsafeSqlConcatLine(line)) continue;
		matches.push({ line: i + 1, text: line.trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `sql_escape_hatch_non_literal` — SQL libraries expose a single "unsafe"
 * escape hatch reserved for compile-time constants (Effect's `sql.unsafe`,
 * Drizzle's `sql.raw`, Kysely's `sql.lit`). Passing a runtime expression
 * into it almost always means a SQL-injection vector — bypasses the
 * library's parameterization guarantee for a value that should have been
 * a parameter.
 *
 * Effect-TS lessons port (docs/design/effect-ts-harness-additions.md §2.6).
 *
 * Flags: `sql.unsafe(`/`sql.raw(`/`sql.lit(` whose first argument is NOT a
 * string literal (single quote, double quote, or template literal opening
 * backtick) or a recognized literal-template-tag pattern.
 *
 * Skips: test files, non-JS/TS files.
 */
const SQL_ESCAPE_HATCH_RE = /\b(?:sql|db|orm)\.(?:unsafe|raw|lit)\s*\(\s*/g;

export function checkSqlEscapeHatchNonLiteral(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	const isCode =
		ext === ".ts" ||
		ext === ".tsx" ||
		ext === ".js" ||
		ext === ".jsx" ||
		ext === ".mjs" ||
		ext === ".cjs" ||
		ext === ".mts" ||
		ext === ".cts";
	if (!isCode) return [];
	if (isTestFile(filePath)) return [];

	// Strip comments only — preserve string contents so we can read the
	// character right after the opening paren and decide literal-vs-not.
	const stripped = stripCommentsPreservingStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const re = new RegExp(SQL_ESCAPE_HATCH_RE.source, "g");
	let m: RegExpExecArray | null = re.exec(stripped);
	while (m !== null) {
		if (matches.length >= MATCH_LIMIT) break;
		// The match ends right at the first non-whitespace position after `(`.
		const firstChar = stripped[m.index + m[0].length];
		const isLiteralOpen =
			firstChar === '"' || firstChar === "'" || firstChar === "`";
		if (!isLiteralOpen) {
			const lineNum = stripped.slice(0, m.index).split("\n").length;
			matches.push({
				line: lineNum,
				text: `SQL escape hatch (${m[0].trim()}) called with non-literal argument — should only wrap compile-time constants (schema names, etc.): ${(originalLines[lineNum - 1] ?? "").trim().slice(0, 120)}`,
			});
		}
		m = re.exec(stripped);
	}

	return matches;
}

// Source-code extensions where a hardcoded localhost is a real shipped-config
// bug. The original detector had no extension gate and FP'd on docs (.md plan
// files referencing the literal token), configuration manifests (.yaml/.toml
// deploy configs that legitimately pin localhost for local dev), and JSONL log
// lines. Restrict to these source types. Kept as a Set so the extension check
// is a single membership test (no `||` chain) — keeping the orchestrator's
// cyclomatic count low.
const LOCALHOST_SOURCE_EXTS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
	".py", ".pyi",
	".go", ".rs",
	".java", ".kt", ".swift",
	".rb", ".php",
	".c", ".cc", ".cpp", ".cxx",
	".h", ".hpp", ".hxx",
]);

/**
 * True when `filePath` is a source file whose committed localhost literals are
 * worth flagging — a recognized source extension, not a test file, and not in
 * an example/fixture/dev/config path. Extracted from
 * `checkUbsHardcodedLocalhost` so its many `||`/`if` gates form their own
 * function scope (keeps the orchestrator under the cyclomatic cap).
 */
function isLocalhostScannableFile(filePath: string): boolean {
	if (!LOCALHOST_SOURCE_EXTS.has(getExtension(filePath))) return false;
	if (isTestFile(filePath)) return false;
	const normalized = filePath.replace(/\\/g, "/").toLowerCase();
	// Match "example", "examples", "fixtures", "dev" as path segments — leading
	// slash is optional so a top-level `examples/` directory is excluded too.
	if (
		/(^|\/)examples?\//.test(normalized) ||
		normalized.includes("/fixtures/") ||
		/(^|\/)dev\//.test(normalized) ||
		normalized.includes("config") ||
		normalized.endsWith(".env") ||
		normalized.endsWith(".env.example")
	) {
		return false;
	}
	return true;
}

// A real hardcoded-localhost bug is an ENDPOINT: a URL (`//localhost`), a
// host:port (`localhost:3000`), or a bare quoted host (`"localhost"`). Plain
// prose that merely mentions the word — e.g. a user-facing message like
// "auth is optional on localhost." — is not a config bug, so require an
// endpoint shape rather than matching the bare token.
const LOCALHOST_ENDPOINT_RE =
	/(?:\/\/|@)(?:localhost|127\.0\.0\.1)\b|\b(?:localhost|127\.0\.0\.1):\d|["'`](?:localhost|127\.0\.0\.1)["'`]/;

/**
 * Per-line exemptions for the localhost scan, run against the comment-stripped
 * line. Returns true when a matched endpoint line is a legitimate pattern
 * (metadata string, RegExp construction, configurable default, detection test)
 * rather than a baked endpoint. Extracted so its `||` chain lives in its own
 * scope.
 */
function isExemptStrippedLocalhostLine(strippedLine: string): boolean {
	// Metadata-shape lines (description / label / noun / fix_instruction
	// strings in registry & check-metadata files) legitimately contain the
	// literal token because they describe the check itself. Skipping these
	// drops the self-FP rate to ~0 without weakening detection on real
	// network-config bugs (`url = "http://localhost:3000"`-style).
	const metadataAssignment =
		/\b(?:label|noun|description|passLabel|fix_instruction|name|comment|summary|fix|msg|message)\s*[:=]\s*["'`]/;
	// `new RegExp(...)` and `RegExp(...)` invocations are by construction
	// pattern-matchers, not endpoint configs.
	const regExpConstructor = /\bRegExp\s*\(/;
	// A localhost literal that is a *configurable default* or a *detection
	// test* is not a baked endpoint — it is exactly the shape this check's own
	// fix_instruction endorses ("a clear default for local dev").
	//   1. fallback default after `||` / `??`  — `flag || "http://localhost:8787"`
	const localhostAsDefault = /(?:\|\||\?\?)\s*["'`][^"'`]*(?:localhost|127\.0\.0\.1)/;
	//   2. membership / equality test  — `url.includes("localhost")`, `h === "localhost"`
	const localhostAsTest =
		/(?:\.(?:includes|indexOf|startsWith|endsWith|search|match)\s*\(|[=!]==?)\s*["'`][^"'`]*(?:localhost|127\.0\.0\.1)/;
	//   3. a default-/fallback-named declaration  — `const DEFAULT_SERVER = "...localhost"`
	const localhostNamedDefault = /\b(?:const|let|var)\s+\w*(?:default|fallback)\w*\s*=/i;
	return (
		metadataAssignment.test(strippedLine) ||
		regExpConstructor.test(strippedLine) ||
		localhostAsDefault.test(strippedLine) ||
		localhostAsTest.test(strippedLine) ||
		localhostNamedDefault.test(strippedLine)
	);
}

/**
 * Pattern-building exemption keyed on the ORIGINAL (unstripped) line. The
 * previous blanket "any interpolated template containing localhost" rule was
 * too broad: it hid real production endpoints like
 * `fetch(\`http://localhost:${port}/api\`)`. This fires only when the template
 * literal also carries a regex-shape signal (regex metacharacters or a
 * pattern-named target):
 *   - assigned/declared as `*_RE`, `*Re`, `*Pattern`, `*Regex`
 *   - contains common regex metacharacters or escape sequences
 *   - argument to a regex method: `.test(`, `.match(`, `.replace(`, `.exec(`, `.search(`
 * Lines without those signals fall through to the matcher, so a real localhost
 * URL inside an interpolated template (real bug) is flagged.
 */
function isRegexPatternLocalhostLine(originalLine: string): boolean {
	const localhostInsideTemplate = /`[^`]*\b(?:localhost|127\.0\.0\.1)\b[^`]*`/;
	const looksLikeRegexPattern =
		// eslint-disable-next-line no-template-curly-in-string -- regex source intentionally contains `${` as a literal metachar pattern, not a template placeholder
		/(?:[A-Z][A-Za-z0-9_]*_RE\b|[A-Za-z][A-Za-z0-9_]*(?:Re|Pattern|Regex)\b\s*=)|\\(?:b|d|s|w|S|D|W|B|n|r|t)\b|\[\^?\\?[a-zA-Z0-9]|\(\?:|\.\s*(?:test|match|replace|exec|search)\s*\(/;
	return localhostInsideTemplate.test(originalLine) && looksLikeRegexPattern.test(originalLine);
}

/**
 * Multi-line RegExp guard: true when the nearest non-empty line before index
 * `i` ends with an open `RegExp(` call — i.e. line `i` is its argument
 * continuation, so a localhost literal there is regex source, not an endpoint.
 * Extracted so the `while`/`&&` scan lives in its own scope.
 */
function isPrevLineRegExpOpen(strippedLines: string[], i: number): boolean {
	let prev = i - 1;
	while (prev >= 0 && nonNull(strippedLines[prev]).trim() === "") prev--;
	return prev >= 0 && /\bRegExp\s*\(\s*$/.test(nonNull(strippedLines[prev]));
}

// A dev-shaped identifier or environment gate: `devPort` / `devMode` /
// `dev_mode` / `DEV_URL` / `isDev` / `config.dev` / `NODE_ENV` /
// `import.meta.env.DEV`. `dev` must end at a word or case boundary, so
// `deviceUrl` / `developer` do NOT match.
const DEV_TOKEN_RE =
	/\b(?:is_?[Dd]ev\w*|dev(?:[_A-Z][A-Za-z0-9_]*)?\b|DEV(?:_[A-Z0-9_]+)?\b|\w+\.dev\b|NODE_ENV|import\.meta\.env\.DEV)/;

/** Branch shape — the guard half of a dev-gated conditional. */
const BRANCH_SHAPE_RE = /\bif\b|\bswitch\b|\bcase\b|\?|&&|\|\|/;

/**
 * Dev-gated localhost is a DECLARED local-dev value, not a leaked default —
 * exactly the shape this check's own fix_instruction endorses ("a clear
 * default for local dev"). True when the endpoint line itself names a dev
 * token, or when one of the previous three non-empty stripped lines is a
 * dev-gated conditional (dev token + branch shape). The canonical FP this
 * exempts (mcp-client-bio, 2026-07 — a guarded dev-mode resolver):
 *     if (devMode && config.devPort) {
 *       return `http://localhost:${config.devPort}/mcp`;
 *     }
 * Runs on comment-stripped lines, so prose mentions of "dev" cannot exempt.
 */
function isDevGuardedLocalhostLine(strippedLines: string[], i: number): boolean {
	if (DEV_TOKEN_RE.test(nonNull(strippedLines[i]))) return true;
	let seen = 0;
	for (let j = i - 1; j >= 0 && seen < 3; j--) {
		const line = nonNull(strippedLines[j]);
		if (line.trim() === "") continue;
		seen++;
		if (DEV_TOKEN_RE.test(line) && BRANCH_SHAPE_RE.test(line)) return true;
	}
	return false;
}

/**
 * `ubs_hardcoded_localhost` — `localhost` / `127.0.0.1` baked into source
 * outside of test/config/example files. Often committed dev defaults that
 * break in deploy. pre_block / error.
 *
 * Distinct from `checks/supply-chain.ts:checkHardcodedLocalhost` (JS/TS
 * only, requires explicit port). This UBS variant is cross-language and
 * matches plain `localhost` / `127.0.0.1` outside known config/test paths.
 */
export function checkUbsHardcodedLocalhost(content: string, filePath: string): InlineMatch[] {
	if (!isLocalhostScannableFile(filePath)) return [];

	const originalLines = content.split("\n");
	// Strip regex literals BEFORE comments so /…localhost…/ doesn't survive into
	// the match pass — without this, the check FPs on its own implementation
	// (this file + checks/supply-chain.ts both contain `/…localhost…/`).
	const strippedLines = stripCommentsPreservingStrings(stripRegexLiterals(content)).split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!LOCALHOST_ENDPOINT_RE.test(nonNull(strippedLines[i]))) continue;
		// Metadata strings, RegExp constructors, configurable defaults, and
		// detection tests are not baked endpoints (see helper).
		if (isExemptStrippedLocalhostLine(nonNull(strippedLines[i]))) continue;
		// Multi-line RegExp: the constructor is on one line and the literal
		// argument is on the next. Skip when the previous non-empty line
		// ends with `RegExp(` (its argument continuation).
		if (isPrevLineRegExpOpen(strippedLines, i)) continue;
		// Narrowed template-literal exemption: only skip when there's a
		// pattern-building signal alongside the interpolated localhost.
		if (isRegexPatternLocalhostLine(nonNull(originalLines[i]))) continue;
		// Dev-gated line or guarding conditional: a declared dev-mode value,
		// not a leaked default (see helper).
		if (isDevGuardedLocalhostLine(strippedLines, i)) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}
