// CLASS: wildcard-only assertions leave a concrete observable unpinned.
// FIRES WHEN: every recognized assertion in a test is a standalone wildcard,
// quantifier-only regex, typeof/type check, Object instance, property presence,
// or trivial numeric lower bound. Imported-export-only smoke tests are reported
// by export_existence_smoke_test instead, so the two checks do not duplicate them.
// DOES NOT FIRE: a literal/structured assertion, meaningful regex structure,
// negation, skipped case, or an imported-export smoke test owns the entire block.
// CALIBRATION (2026-09-06/07, tracked tests in this tree; historical snapshots):
// | pass | hits/files | inspected precision | correction |
// | original | 51/unknown | builder sample only | before test fixes |
// | round 1 | 25/20 | not independently measured | export smoke overlap identified |
// KNOWN GAPS: regex-based assertion traversal, custom matchers, and bindings are
// incomplete. toBeDefined by itself is NOT a wildcard matcher in this detector.
// HOW TO EXTEND: add matcher-shape P/N cases; retain literal exemptions and the
// import-aware ownership split. Census: scripts/scan-test-discrimination.ts.

import { findCallSpan } from "./test-hygiene-shared.js";
import { maskCommentsAndStrings } from "./test-hygiene-masking.js";
import { checkExportExistenceSmokeTest } from "./test-export-existence.js";
import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS, stripComments } from "./shared.js";

const MAX_MATCHES = 10;

// ===========================================
// Regex-source wildcard classification
// ===========================================

/** A character class's inner text counts as wildcard-shaped only when it is
 *  built entirely from `\d \D \w \W \s \S` shorthand escapes — a class with
 *  any other literal character (e.g. `[abc]`) pins real structure. */
function isWildcardCharClassInner(inner: string): boolean {
	return /^(?:\\[dDwWsS])*$/.test(inner);
}

/** Remove every `[...]` character class that is wildcard-shaped. Returns
 *  `null` (signalling "has literal structure") when any class is not. */
function stripWildcardCharClasses(source: string): string | null {
	let out = "";
	let i = 0;
	while (i < source.length) {
		if (source[i] === "[") {
			const end = source.indexOf("]", i);
			if (end === -1) return null;
			const inner = source.slice(i + 1, end);
			if (!isWildcardCharClassInner(inner)) return null;
			i = end + 1;
			continue;
		}
		out += source[i];
		i++;
	}
	return out;
}

/** True when a regex SOURCE (no delimiters/flags) carries no literal
 *  character outside escapes/classes/quantifiers/anchors — `^\d+$`, `.+`,
 *  `[\s\S]*`, `\w+` are wildcard; `^v\d+\.\d+\.\d+$` is not (the `v` and the
 *  escaped literal dots survive every strip below). */
function isWildcardRegexSource(source: string): boolean {
	const withoutClasses = stripWildcardCharClasses(source);
	if (withoutClasses === null) return false;
	const stripped = withoutClasses
		.replace(/\\[dDwWsS]/g, "")
		.replace(/[\^$.]/g, "")
		.replace(/[+*?]/g, "")
		.replace(/\{\d*,?\d*\}/g, "")
		.replace(/[()|:]/g, "");
	return stripped.length === 0;
}

/** Extracts the source of a regex literal that is the ENTIRE trimmed
 *  argument text (`/\d+/` → `\d+`), or null when the arg is not (only) a
 *  regex literal. */
function extractRegexLiteralSource(text: string): string | null {
	const m = /^\/((?:\\.|[^/\\])*)\/[a-zA-Z]*$/.exec(text);
	return m ? (m[1] ?? "") : null;
}

// ===========================================
// Standalone asymmetric-matcher / numeric-bound classification
// ===========================================

const WILDCARD_ANY_RE = /^expect\.any\(\s*(?:Number|String|Object|Function|Array|Boolean)\s*\)$/;
const WILDCARD_ANYTHING_RE = /^expect\.anything\(\s*\)$/;
const WILDCARD_EMPTY_STRING_RE = /^expect\.stringContaining\(\s*(["'])\1\s*\)$/;
const WILDCARD_EMPTY_OBJECT_RE = /^expect\.objectContaining\(\s*\{\s*\}\s*\)$/;

/** True when the WHOLE trimmed argument is one of the four asymmetric
 *  matchers that match almost any value — NOT when one is merely nested
 *  inside a larger object literal alongside a pinned field. */
function isStandaloneWildcardArg(text: string): boolean {
	return (
		WILDCARD_ANY_RE.test(text) ||
		WILDCARD_ANYTHING_RE.test(text) ||
		WILDCARD_EMPTY_STRING_RE.test(text) ||
		WILDCARD_EMPTY_OBJECT_RE.test(text)
	);
}

const NUMBER_LITERAL_RE = /^-?\d+(?:\.\d+)?$/;

function numberLiteralValue(text: string): number | null {
	return NUMBER_LITERAL_RE.test(text) ? Number(text) : null;
}

/** e.g. `toBeGreaterThan(-1)` — any negative bound is trivially true for a
 *  non-negative count/length. */
function isTrivialLowerBound(text: string): boolean {
	const n = numberLiteralValue(text);
	return n !== null && n < 0;
}

/** e.g. `toBeGreaterThanOrEqual(0)` — a zero-or-negative floor is trivially
 *  true for a non-negative count/length. */
function isTrivialLowerOrEqualBound(text: string): boolean {
	const n = numberLiteralValue(text);
	return n !== null && n <= 0;
}

// ===========================================
// Per-matcher and typeof-subject dispatch
// ===========================================

/** `expect(typeof x === "number").toBe(true)` or `expect(typeof x).toBe("number")` —
 *  both check only the runtime type, never a value. */
function isTypeofAssertion(subjectText: string, matcherName: string, argText: string): boolean {
	if (matcherName !== "toBe") return false;
	const subject = subjectText.trim();
	const arg = argText.trim();
	if (/^typeof\s+.+===/.test(subject)) return arg === "true" || arg === "false";
	if (/^typeof\b/.test(subject)) return /^(["']).+\1$/.test(arg);
	return false;
}

/** Classify one matcher call's argument text as wildcard-shaped or not. */
function isWildcardMatcherArg(matcherName: string, argText: string, topLevelCommas: number): boolean {
	const arg = argText.trim();
	switch (matcherName) {
		case "toMatch": {
			const source = extractRegexLiteralSource(arg);
			return source !== null && isWildcardRegexSource(source);
		}
		case "toBeTypeOf":
			return arg.length > 0;
		case "toBeInstanceOf":
			return arg === "Object";
		case "toHaveProperty":
			return topLevelCommas === 0 && arg.length > 0;
		case "toBeGreaterThan":
			return isTrivialLowerBound(arg);
		case "toBeGreaterThanOrEqual":
			return isTrivialLowerOrEqualBound(arg);
		default:
			return isStandaloneWildcardArg(arg);
	}
}

/** True when this one assertion (`expect(subject).chain(args)`) is
 *  wildcard-shaped. A `.not` anywhere in the chain always reads as a real,
 *  literal-pinning assertion (negation is meaningful evidence). */
function isWildcardAssertion(
	subjectText: string,
	matcherName: string,
	argText: string,
	topLevelCommas: number,
	negated: boolean,
): boolean {
	if (negated) return false;
	if (isTypeofAssertion(subjectText, matcherName, argText)) return true;
	return isWildcardMatcherArg(matcherName, argText, topLevelCommas);
}

// ===========================================
// Assertion + test-block extraction (regex/shape-based, no AST dependency)
// ===========================================

interface AssertionInfo {
	isWildcard: boolean;
	matcherName: string;
}

const EXPECT_CALL_RE = /\bexpect\s*\(/g;
const MATCHER_CHAIN_RE = /^((?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\(/;

/** Walk every `expect(subject).chain(args)` assertion in a test block's
 *  (masked) body, classifying each as wildcard-shaped or not. An `expect(...)`
 *  with no recognizable matcher call (dynamic chain, assertion-less probe) is
 *  skipped rather than counted either way. */
function collectBlockAssertions(body: string): AssertionInfo[] {
	const out: AssertionInfo[] = [];
	EXPECT_CALL_RE.lastIndex = 0;
	let m: RegExpExecArray | null = EXPECT_CALL_RE.exec(body);
	while (m !== null) {
		const subjectStart = m.index + m[0].length;
		const subjectSpan = findCallSpan(body, subjectStart);
		if (subjectSpan === null) break;
		const rest = body.slice(subjectSpan.end + 1);
		const chainMatch = MATCHER_CHAIN_RE.exec(rest);
		if (chainMatch === null) {
			EXPECT_CALL_RE.lastIndex = subjectSpan.end + 1;
			m = EXPECT_CALL_RE.exec(body);
			continue;
		}
		const chainText = chainMatch[1] ?? "";
		const segments = chainText
			.split(".")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const matcherName = segments[segments.length - 1] ?? "";
		const negated = segments.includes("not");
		const argsStart = subjectSpan.end + 1 + chainMatch[0].length;
		const matcherSpan = findCallSpan(body, argsStart);
		if (matcherSpan === null) break;
		const subjectText = body.slice(subjectStart, subjectSpan.end);
		const argText = body.slice(argsStart, matcherSpan.end);
		out.push({
			isWildcard: isWildcardAssertion(
				subjectText,
				matcherName,
				argText,
				matcherSpan.topLevelCommas.length,
				negated,
			),
			matcherName,
		});
		EXPECT_CALL_RE.lastIndex = matcherSpan.end + 1;
		m = EXPECT_CALL_RE.exec(body);
	}
	return out;
}

interface WildcardTestBlock {
	line: number;
	body: string;
}

const TEST_CALL_RE = /\b(?:it|test)((?:\s*\.\s*[A-Za-z_$][\w$]*(?:\([^)]*\))?)*)\s*\(/g;
const SKIP_CHAIN_RE = /\.\s*(?:skip|todo)\b/;

/** Find every non-skipped `it()`/`test()` call's line + body span. Modifier
 *  chains such as `.each(...)` are tolerated on the callee; `.skip`/`.todo`
 *  drop the block entirely (its assertions never run). */
function findTestBlocks(masked: string): WildcardTestBlock[] {
	const blocks: WildcardTestBlock[] = [];
	const code = maskCommentsAndStrings(masked);
	TEST_CALL_RE.lastIndex = 0;
	let m: RegExpExecArray | null = TEST_CALL_RE.exec(code);
	while (m !== null) {
		const chain = m[1] ?? "";
		const argsStart = m.index + m[0].length;
		const span = findCallSpan(masked, argsStart);
		if (span === null) break;
		if (!SKIP_CHAIN_RE.test(chain)) {
			const line = (masked.slice(0, m.index).match(/\n/g) ?? []).length + 1;
			blocks.push({ line, body: masked.slice(argsStart, span.end) });
		}
		TEST_CALL_RE.lastIndex = span.end + 1;
		m = TEST_CALL_RE.exec(code);
	}
	return blocks;
}

/**
 * Flag test blocks whose every assertion is wildcard-shaped. Returns [] when
 * the file is not a test file or is not JS/TS.
 */
export function checkWildcardInObservable(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	// Comments removed, string/regex literals left intact — we need to see
	// inside string args ("") and regex literals to classify them.
	const masked = stripComments(content);
	const matches: InlineMatch[] = [];
	const smokeLines = new Set(checkExportExistenceSmokeTest(content, filePath).map((match) => match.line));

	for (const block of findTestBlocks(masked)) {
		if (matches.length >= MAX_MATCHES) break;
		if (smokeLines.has(block.line)) continue;
		const assertions = collectBlockAssertions(block.body);
		if (assertions.length === 0) continue;
		if (!assertions.every((a) => a.isWildcard)) continue;
		const matcherNames = [...new Set(assertions.map((a) => a.matcherName).filter((n) => n.length > 0))];
		const label = matcherNames.length > 0 ? matcherNames.join(", ") : "wildcard matcher";
		matches.push({
			line: block.line,
			text: `wildcard_in_observable: every assertion (${label}) matches almost any value — assert a specific literal instead.`,
		});
	}
	return matches;
}
