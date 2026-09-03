// Agent Safety Checks — JS/TS type-safety, security, and correctness.
// Deterministic regex/heuristic checks targeting common AI agent mistakes.
// Extracted from agent-safety.ts to stay under the per-file line ceiling.

import { nonNull } from "../../lib/non-null.js";
import { stripTemplateLiterals } from "../strip-helpers.js";
import {
	getExtension,
	type InlineMatch,
	isGeneratedFile,
	isTestFile,
	JS_TS_EXTS,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// --- 3. Type Safety ---

/**
 * Detect non-null assertions (the `!` operator in TypeScript).
 * Skips test files (tests use `!` for brevity).
 */
export function checkNonNullAssertions(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".ts" && ext !== ".tsx") return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= 10) break;
		// Match identifier! followed by . or [ or ) — but not !== or !=
		if (/\w!\.|\w!\[|\w!\)/.test(line) && !/!==|!=/.test(line.replace(/\w!\./g, ""))) {
			// Verify it's actually a non-null assertion (not a boolean negation)
			const nnaMatch = line.match(/(\w+)!\s*[.[)]/);
			if (nnaMatch) {
				matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
			}
		}
	}
	return matches;
}

/**
 * Detect magic literals used in conditionals without a named constant.
 * Flags: `if (x === <literal>)`, `if (x !== <literal>)`, `switch (x) { case <literal>: }`.
 *
 * A literal is considered "magic" when:
 *   - It is a number > 1 (0 and 1 are common length/index checks, low signal).
 *   - It is a string with length > 2, excluding empty, `"0"`, `"1"`, trivial
 *     tokens like `"true"` / `"false"` / `"null"` / `"undefined"`.
 *
 * The fix-instruction asks the author to extract a named constant or enum —
 * cold readers see `if (status === ORDER_FULFILLED)` and know what branch
 * they're in without jumping anywhere.
 */
// --- checkMagicLiteralInConditional support (module-private) ---
//
// Comparison literals — number > 1 or string longer than 2 chars excluding
// trivial values. Capture groups: 1=number, 2=double-quoted, 3=single-quoted.
const MAGIC_LITERAL_NUM_CMP =
	/(?:===|!==|==|!=)\s*(-?\d+(?:\.\d+)?)(?!\w)|(?:===|!==|==|!=)\s*"([^"\\]{3,})"|(?:===|!==|==|!=)\s*'([^'\\]{3,})'/;
const MAGIC_LITERAL_CASE_CMP = /^\s*case\s+(?:(-?\d+(?:\.\d+)?)(?!\w)|"([^"\\]{3,})"|'([^'\\]{3,})')\s*:/;

// Trivial strings that look long enough to match `[^"]{3,}` but shouldn't
// be flagged: keywords that appear in type comparisons.
const MAGIC_LITERAL_TRIVIAL_STRINGS = new Set(["true", "false", "null", "undefined"]);

// `typeof x === "string"` is THE canonical TS narrowing idiom — the RHS is
// drawn from a fixed, language-defined set of 8 strings. Hoisting any of
// them to a constant (`STRING_TYPE = "string"`) is pure noise. Skip the
// comparison-literal hit when the operand is `typeof`.
const MAGIC_LITERAL_TYPEOF_RESULTS = new Set([
	"string",
	"number",
	"bigint",
	"boolean",
	"symbol",
	"undefined",
	"object",
	"function",
]);

// Self-describing identifier-like string literals. The literal IS the name
// — hoisting it to a constant (`const CODEX = "codex"; x === CODEX`) is pure
// noise, because the string token already reads as its own intent. Matches a
// single contiguous token: word chars / `_` / `-` / `.`, no whitespace, no
// sentence structure. Covers shell names (`bash`), runner ids (`codex`),
// tool names (`apply_patch`), event kinds (`session_end`), enum members
// (`fulfilled`, `pre-commit`), namespaced ids (`mcp__foo`), dotted paths,
// SCREAMING_CASE constants (`SESSION_END`), and camelCase. It deliberately
// does NOT match opaque phrases with spaces/punctuation
// (`"Order fulfilled successfully"`) — those carry no self-documenting
// token and stay flagged. Applies to BOTH `=== "..."` comparisons and
// `case "...":` labels: the value of this check is opaque NUMERIC codes
// (`status === 2`) and opaque string phrases, not readable string tokens.
const MAGIC_LITERAL_SELF_DESCRIBING_TOKEN = /^[A-Za-z][\w.-]*$/;
const MAGIC_LITERAL_SELF_DESCRIBING_ALLOWLIST = new Set([
	// HTTP methods are all-caps and already flow through the token regex,
	// but kept explicit so the intent is documented and future
	// multi-token additions have a home.
	"GET",
	"POST",
	"PUT",
	"DELETE",
	"PATCH",
	"HEAD",
	"OPTIONS",
]);

function isMagicNumber(raw: string): boolean {
	const n = Number(raw);
	return Number.isFinite(n) && Math.abs(n) > 1;
}
// A string literal is self-describing (NOT magic) when it is a single
// readable identifier-like token. Trivial keywords (`true`/`false`/
// `null`/`undefined`) are already excluded upstream; here we additionally
// spare any contiguous token. Opaque phrases (spaces, sentence text) and
// genuinely cryptic short codes that aren't identifier-shaped still fire.
function isSelfDescribingToken(raw: string): boolean {
	return (
		MAGIC_LITERAL_SELF_DESCRIBING_TOKEN.test(raw) ||
		MAGIC_LITERAL_SELF_DESCRIBING_ALLOWLIST.has(raw)
	);
}
function isMagicString(raw: string): boolean {
	if (MAGIC_LITERAL_TRIVIAL_STRINGS.has(raw)) return false;
	// Readable identifier-like tokens ARE the intent — not magic.
	if (isSelfDescribingToken(raw)) return false;
	return true;
}
// Shared "does this captured literal deserve a flag" decision. Both the
// `===`/`!==`/`==`/`!=` comparison branch and the `case` label branch parse
// into the same (num, dq, sq) capture triple from NUM_CMP / CASE_CMP, so the
// hit logic (opaque number OR opaque quoted string) lives here once instead
// of being duplicated at each call site.
function isMagicLiteralHit(
	num: string | undefined,
	dq: string | undefined,
	sq: string | undefined,
): boolean {
	return (
		(num !== undefined && isMagicNumber(num)) ||
		(dq !== undefined && isMagicString(dq)) ||
		(sq !== undefined && isMagicString(sq))
	);
}

// Per-line decision, extracted from the scan loop in
// checkMagicLiteralInConditional below: at most one magic-literal hit per
// line, checked in order (comparison, then case label) — mirrors the
// original inline control flow exactly, including the eq-branch
// short-circuit that skips the case check once an eq hit fires.
function findMagicLiteralOnLine(
	line: string,
	i: number,
	originalLines: string[],
): InlineMatch | undefined {
	// `if (x === 2)` / `x !== "Order fulfilled successfully"`
	const eqMatch = MAGIC_LITERAL_NUM_CMP.exec(line);
	if (eqMatch) {
		const [, num, dq, sq] = eqMatch;
		const strLiteral = dq ?? sq;
		// `typeof x === "string"` exemption — see the TYPEOF_RESULTS comment
		// above. We only need to check when there's a string capture;
		// numeric comparisons are never typeof results.
		const isTypeofCheck =
			strLiteral !== undefined &&
			MAGIC_LITERAL_TYPEOF_RESULTS.has(strLiteral) &&
			/\btypeof\b/.test(line);
		if (!isTypeofCheck && isMagicLiteralHit(num, dq, sq)) {
			return { line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) };
		}
	}

	// `case 2:` / `case "Order fulfilled successfully":`
	const caseMatch = MAGIC_LITERAL_CASE_CMP.exec(line);
	if (caseMatch) {
		const [, num, dq, sq] = caseMatch;
		if (isMagicLiteralHit(num, dq, sq)) {
			return { line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) };
		}
	}
	return undefined;
}

export function checkMagicLiteralInConditional(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	// Keep regular-quoted string literals intact — the whole point of this
	// check is to inspect what's INSIDE `=== "..."`. But template-literal
	// bodies are DATA at the call-site level (e.g. the hook template's
	// `\`case "SessionStart": ...\``) and routinely contain generated
	// switch/case scaffolding that isn't a real conditional in THIS file,
	// so we blank them before scanning. Line comments are stripped for the
	// same reason as before — `// if (x === 42)` is documentation, not code.
	const stripped = stripTemplateLiterals(stripComments(content));
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= 10) break;
		const match = findMagicLiteralOnLine(line, i, originalLines);
		if (match) matches.push(match);
	}

	return matches;
}

/**
 * Detect broad/opaque object types that hide shape information from cold
 * readers (including cold agents). Flags:
 *   - `Record<K, any>` — wide mapping whose VALUE is `any` (no shape, no narrowing).
 *   - `{ [key: string]: any }` index signature to `any`.
 *   - Bare `Function` type annotation (`: Function`, `as Function`).
 *   - Bare `object` type annotation (`: object`, `as object`).
 *
 * Each of these loses enough type information that a reader has to guess the
 * shape. The `unknown` value form (`Record<K, unknown>`, `{ [k]: unknown }`) is
 * deliberately NOT flagged: `unknown` is the type-SAFE wide map — it forces
 * narrowing at every use site (the honest type for dynamic SQL rows / parsed
 * JSON), the opposite of `any`'s shapelessness (finding 2026-06: it was firing
 * on legitimate `Record<string, unknown>`). Skips test/generated/non-TS files.
 */
export function checkBroadObjectTypes(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".ts" && ext !== ".tsx") return [];
	if (isTestFile(filePath)) return [];
	// 139-repo audit: OpenAPI Generator output emits `Record<string, any>`
	// and `: any` extensively by design; flagging it produces only FPs (the
	// fix is to change generator config, not the file).
	if (isGeneratedFile(content)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `Record<…, any>` where the VALUE type is `any`. `unknown` is intentionally
	// NOT matched — it is the type-safe wide map (forces narrowing), unlike
	// shapeless `any`. Accepts any key-type identifier (string/number/symbol/alias).
	const RECORD_ANY = /\bRecord\s*<\s*[\w.|&\s]+,\s*any\s*>/;
	// `{ [k: string]: any }` index signature to `any` (again, `unknown` is exempt).
	const INDEX_ANY = /\{\s*\[\s*\w+\s*:\s*(?:string|number|symbol)\s*\]\s*:\s*any\s*\}/;
	// `: Function` or `as Function` — bare Function type.
	const BARE_FUNCTION = /(?::|\bas)\s+Function\b/;
	// `: object` or `as object` — bare object type. Excludes `Object` (the wrapper).
	const BARE_OBJECT = /(?::|\bas)\s+object\b/;

	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= 10) break;
		if (
			RECORD_ANY.test(line) ||
			INDEX_ANY.test(line) ||
			BARE_FUNCTION.test(line) ||
			BARE_OBJECT.test(line)
		) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

// --- 4. Security ---

/**
 * Detect eval/implied-eval in JavaScript/TypeScript.
 * Catches: eval(), Function(), setTimeout/setInterval with string arg.
 */
export function checkEvalUsage(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= 10) break;
		const trimmed = line.trim();
		// Direct eval — negative lookbehind `(?<![.\w])` so a member method
		// named `eval` (`mathParser.eval(...)`, `vm.eval(...)`) or an
		// identifier-suffixed call is not read as the global eval. Mirrors the
		// sibling checkEvalInputTainted (js-security-checks.ts).
		if (/(?<![.\w])eval\s*\(/.test(trimmed)) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
			continue;
		}
		// new Function() — implied eval
		if (/\bnew\s+Function\s*\(/.test(trimmed)) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
			continue;
		}
		// setTimeout/setInterval with string argument (implied eval)
		if (/\b(setTimeout|setInterval)\s*\(\s*['"`]/.test(trimmed)) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect dangerouslySetInnerHTML (React) and direct innerHTML assignment.
 * Skips matches inside regex literals and test patterns (e.g., lint check implementations).
 */
export function checkInnerHtmlUsage(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= 10) break;
		const trimmed = line.trim();
		// Skip lines that are regex patterns (detecting innerHTML vs using it)
		if (/\/.*innerHTML.*\//.test(trimmed) || /\/.*dangerouslySet.*\//.test(trimmed)) continue;
		// Skip lines that are .test() or .match() calls on the pattern
		if (/\.test\(/.test(trimmed) || /\.match\(/.test(trimmed)) continue;
		if (/dangerouslySetInnerHTML/.test(trimmed) || /\.innerHTML\s*=/.test(trimmed)) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

// --- 5. Correctness ---

/**
 * Detect NaN comparison: x === NaN, x == NaN, x !== NaN, x != NaN.
 * NaN is never equal to itself. Must use Number.isNaN().
 */
export function checkNanComparison(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /[!=]==?\s*NaN\b|\bNaN\s*[!=]==?/, 10);
}

/**
 * Row 27 (Phase-1 plan 04): JS/TS loose-equality `==` / `!=`.
 *
 * Triple-equality (`===` / `!==`) is the project standard; the loose form
 * triggers JavaScript type coercion and is a documented bug source. We
 * deliberately allow the `x == null` / `x != null` idiom — it's the only loose
 * comparison Plan 04 §4.2 lists as an FP guard (matches both null AND
 * undefined in one expression, which is otherwise verbose).
 */
export function checkJsLooseEquality(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	// Also blank single-line regex literals — the operators this check looks
	// for (`==`, `!=`) commonly appear as pattern characters inside detector
	// regexes (e.g. `/===|!==|==|!=/`). The replacement preserves character
	// count so line/column offsets used downstream stay accurate. Imperfect
	// (misses multi-line regexes and constructor-form `new RegExp("...")`);
	// covers the common false-positive shape that bit this check on its own
	// source files.
	const stripped = stripCommentsAndStrings(content).replace(
		/\/(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[dgimsuy]*/g,
		(m) => " ".repeat(m.length),
	);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// Match `==` or `!=` that is NOT part of `===` / `!==`. Word-style
	// boundaries avoid matching `<=` / `>=` (those are comparison operators,
	// not equality). We capture surrounding chars so the alternation rule
	// "left side is not `=`/`!`/`<`/`>` AND right side is not `=`" is enforced
	// by the lookarounds.
	const looseEqRe = /(^|[^=!<>])([!=]=)(?!=)/;

	const matches: InlineMatch[] = [];
	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= 10) break;
		if (!looseEqRe.test(line)) continue;

		// Plan 04 documented FP guard: `x == null` / `x != null`. Skip when
		// the loose comparison is against the literal `null` keyword.
		// `x == null` covers null AND undefined; nothing equivalent in `===`.
		if (/[!=]=\s*null\b/.test(line) || /\bnull\s*[!=]=/.test(line)) {
			// If the only loose comparisons on the line are vs null, skip.
			// Strip out null comparisons and re-check.
			const withoutNullCmp = line
				.replace(/[!=]=\s*null\b/g, "")
				.replace(/\bnull\s*[!=]=/g, "");
			if (!looseEqRe.test(withoutNullCmp)) continue;
		}

		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * Detect constant conditions: if (true), if (false), while (true) without break,
 * if (0), if (""), if (1).
 */
export function checkConstantCondition(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= 10) break;
		const trimmed = line.trim();
		// if (true), if (false), if (0), if (1), if ("")
		if (/\bif\s*\(\s*(true|false|0|1|"")\s*\)/.test(trimmed)) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
			continue;
		}
		// Ternary with constant: true ? x : y
		// Exclude comparisons like `=== false ?` or `!== true ?` where the
		// literal is the right-hand side of an operator, not the condition.
		if (/\b(true|false)\s*\?\s*/.test(trimmed) && !/\/\//.test(trimmed)) {
			if (!/[=!<>]\s*(true|false)\s*\?/.test(trimmed)) {
				matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
			}
		}
	}
	return matches;
}

/**
 * Detect unsafe optional chaining: (obj?.foo).bar which throws if obj is nullish.
 * The parenthesized optional chain defeats the purpose of ?. safety.
 * Safe patterns excluded: (x?.foo || fallback).bar, (x?.foo ?? fallback).bar
 */
export function checkUnsafeOptionalChaining(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= 10) break;
		// Match (x?.y).z pattern
		if (!/\([^)]*\?\.[^)]*\)\s*\./.test(line)) continue;
		// Exclude safe patterns with fallback operators inside the parens
		// (x?.foo || default).bar and (x?.foo ?? default).bar are safe
		if (/\([^)]*\?\.[^)]*(\|\||&&|\?\?)[^)]*\)\s*\./.test(line)) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * Detect number precision loss: integer literals > 2^53 - 1 (Number.MAX_SAFE_INTEGER).
 */
export function checkNumberPrecisionLoss(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_SAFE = 9007199254740991; // 2^53 - 1
	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= 10) break;
		// Find large integer literals (not BigInt with n suffix)
		const nums = line.match(/\b(\d{16,})\b(?!n)/g);
		if (!nums) continue;
		for (const num of nums) {
			if (Number.parseInt(num, 10) > MAX_SAFE) {
				matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
				break;
			}
		}
	}
	return matches;
}
