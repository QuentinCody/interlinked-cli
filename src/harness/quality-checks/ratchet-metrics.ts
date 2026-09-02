// ===========================================
// Ratchet Metrics — countable quality metrics that must not regress
// ===========================================
// Extracted from quality-checks.ts. Each helper counts occurrences of a
// specific pattern (suppression directives, `as any` casts, non-null
// assertions) in a file's text. The quality-checks runner compares pre-edit
// and post-edit counts and flags any increase as a ratchet violation.

import { nonNull } from "../../lib/non-null.js";
import { stripAllLiterals } from "../strip-helpers.js";

// `interlinked-ignore` is the harness's OWN fully-suppressing directive
// (suppressions.ts) — leaving it uncounted meant an agent could silence
// unlimited interlinked findings without tripping any ratchet, while the same
// move via @ts-ignore was counted. `interlinked: defer` is deliberately NOT
// counted: defers keep the finding visible and are loud audit signal by design.
const SUPPRESSION_PATTERN =
	/@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|biome-ignore|interlinked-ignore/g;
const AS_ANY_PATTERN = /\bas\s+any\b/g;
// Non-null assertion: identifier followed by `!` then `.`, `[`, `(`, or `)` —
// the positions that distinguish a type assertion from boolean negation /
// `!=` / `!==`. `(` catches `foo!()` (call after assertion); `)` catches
// `bar(foo!)` (assertion on the last argument).
const NON_NULL_ASSERTION_PATTERN = /\w!\s*[.[()]/g;

/**
 * Public API — consumed by quality-checks.runQualityChecks and verify.ts.
 *
 * Count suppression directives in file content (@ts-ignore, @ts-expect-error,
 * @ts-nocheck, eslint-disable, biome-ignore, interlinked-ignore).
 */
export function countSuppressionDirectives(content: string): number {
	return (content.match(SUPPRESSION_PATTERN) || []).length;
}

/**
 * Public API — consumed by quality-checks.runQualityChecks and verify.ts.
 *
 * Count `as any` casts in file content.
 */
export function countAsAnyCasts(content: string): number {
	return (content.match(AS_ANY_PATTERN) || []).length;
}

/**
 * Public API — consumed by quality-checks.runQualityChecks and verify.ts.
 *
 * Count non-null assertions (`foo!.bar` / `foo![x]` / `foo!()`) in file
 * content. Used by the ratchet to block edits that add more non-null
 * assertions to a file than were present before.
 */
export function countNonNullAssertions(content: string): number {
	return (content.match(NON_NULL_ASSERTION_PATTERN) || []).length;
}

// ===========================================
// Batch 7 ratchets — TODO/FIXME, console.log, public-API surface count.
// Each is a strict-monotone ratchet: post-edit count must not exceed pre-edit.
// ===========================================
// All counters strip strings/comments via stripAllLiterals first so embedded
// mentions in prose / data don't poison the metric.

const TODO_MARKER_PATTERN = /\b(?:TODO|FIXME|HACK|XXX)\b/g;
const CONSOLE_STATEMENT_PATTERN = /\bconsole\s*\.\s*(?:log|debug|info|warn|error|trace)\s*\(/g;
const EXPORTED_NAME_PATTERN =
	/\b(?:export\s+(?:async\s+)?(?:function\s+\*?|class\s+|const\s+|let\s+|var\s+|interface\s+|type\s+|enum\s+))([A-Za-z_$][\w$]*)/g;

/** Public API — ratchet for TODO/FIXME/HACK/XXX markers.
 *  TODO markers live in comments, so we only strip strings (preserving
 *  comments) before matching. Otherwise stripAllLiterals would erase the
 *  comment contents we're trying to count. */
export function countTodoMarkers(content: string): number {
	const stripped = content.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\]|\\.)*'/g, "''")
		.replace(/`(?:[^`\\]|\\.)*`/g, "``");
	return countMatches(stripped, TODO_MARKER_PATTERN);
}

/** Public API — ratchet for console.* statements. */
export function countConsoleStatements(content: string): number {
	const stripped = stripAllLiterals(content);
	return countMatches(stripped, CONSOLE_STATEMENT_PATTERN);
}

/** Public API — ratchet for exported-symbol count (public API surface). */
export function countPublicApiSurface(content: string): number {
	const stripped = stripAllLiterals(content);
	const names = new Set<string>();
	EXPORTED_NAME_PATTERN.lastIndex = 0;
	let m: RegExpExecArray | null = EXPORTED_NAME_PATTERN.exec(stripped);
	while (m !== null) {
		names.add(nonNull(m[1]));
		m = EXPORTED_NAME_PATTERN.exec(stripped);
	}
	return names.size;
}

// ===========================================
// Type-density ratchet — composite metric over six type-erasure shapes.
// ===========================================
// One ratchet, six counters. The post-edit ratchet check fires once if any
// counter increases; the message lists which dimension regressed and by how
// much. Mirrors the existing as-any / non-null / suppression pattern but
// rolls up six related metrics so the agent gets a single actionable line
// instead of six warnings ("noise floor" matters more than "granularity").
//
// All counters strip strings/comments via stripAllLiterals before matching
// so prose like `// this uses : any` doesn't show up as a regression.

const ANY_ANNOTATION_PATTERN = /:\s*any\b/g;
const UNKNOWN_ANNOTATION_PATTERN = /:\s*unknown\b/g;
const FUNCTION_TYPE_PATTERN = /:\s*Function\b/g;
const EMPTY_OBJECT_TYPE_PATTERN = /:\s*\{\s*\}/g;

/** Match an exported function declaration: `export function name(params): returnType`.
 *  Captures the parameter list and the optional return-type annotation. We
 *  intentionally don't try to handle every TS syntax (arrow exports, class
 *  methods, overloads) — the metric is a ratchet, not a lint. The cases we
 *  miss are uniformly missed on both sides of the diff, so the delta is
 *  still correct. */
const EXPORTED_FUNCTION_PATTERN =
	/\bexport\s+(?:async\s+)?function\s+\w+\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(:\s*[^{;]+)?/g;

export interface TypeDensityCounts {
	anyAnnotations: number;
	unknownAnnotations: number;
	functionType: number;
	emptyObjectType: number;
	untypedExportedParams: number;
	missingExportedReturnType: number;
}

/** Public API — ratchet baseline for the composite type-density metric.
 *  Consumed by `server.ts` (baseline capture) and `quality-checks.ts`
 *  (post-edit comparison).
 *
 *  Strings and comments are stripped before counting so embedded mentions
 *  in messages / docs don't poison the metric. */
export function countTypeDensity(content: string): TypeDensityCounts {
	const stripped = stripAllLiterals(content);
	return {
		anyAnnotations: countMatches(stripped, ANY_ANNOTATION_PATTERN),
		unknownAnnotations: countMatches(stripped, UNKNOWN_ANNOTATION_PATTERN),
		functionType: countMatches(stripped, FUNCTION_TYPE_PATTERN),
		emptyObjectType: countMatches(stripped, EMPTY_OBJECT_TYPE_PATTERN),
		...countExportShape(stripped),
	};
}

function countMatches(content: string, pattern: RegExp): number {
	pattern.lastIndex = 0;
	return (content.match(pattern) || []).length;
}

function countExportShape(stripped: string): {
	untypedExportedParams: number;
	missingExportedReturnType: number;
} {
	let untyped = 0;
	let missingReturn = 0;
	EXPORTED_FUNCTION_PATTERN.lastIndex = 0;
	let m: RegExpExecArray | null = EXPORTED_FUNCTION_PATTERN.exec(stripped);
	while (m !== null) {
		const paramList = m[1] ?? "";
		const returnAnnotation = m[2];
		untyped += countUntypedParams(paramList);
		if (!returnAnnotation || returnAnnotation.trim() === "") missingReturn++;
		m = EXPORTED_FUNCTION_PATTERN.exec(stripped);
	}
	return { untypedExportedParams: untyped, missingExportedReturnType: missingReturn };
}

/** Count parameters in a comma-separated TS parameter list that lack a
 *  type annotation. Handles default values (`x = 1`), rest params (`...rest`),
 *  destructuring patterns (`{ a, b }: Foo` is typed; bare `{ a, b }` is not). */
function countUntypedParams(paramList: string): number {
	const trimmed = paramList.trim();
	if (trimmed === "") return 0;
	let depth = 0;
	let untyped = 0;
	let buf = "";
	for (let i = 0; i <= trimmed.length; i++) {
		const ch = trimmed[i];
		const isEnd = i === trimmed.length;
		depth += paramBracketDelta(isEnd, ch);
		if ((ch === "," && depth === 0) || isEnd) {
			untyped += untypedParamIncrement(buf);
			buf = "";
		} else {
			buf += ch;
		}
	}
	return untyped;
}

/** Depth delta for one character of a parameter list: opening brackets/generics
 *  push depth, closing ones pop it, everything else (including the end-of-string
 *  sentinel) leaves depth unchanged. */
function paramBracketDelta(isEnd: boolean, ch: string | undefined): number {
	if (isEnd) return 0;
	if (ch === "<" || ch === "(" || ch === "{" || ch === "[") return 1;
	if (ch === ">" || ch === ")" || ch === "}" || ch === "]") return -1;
	return 0;
}

/** 1 if the buffered parameter text is non-empty and lacks a `:` type
 *  annotation, else 0. Mirrors the original inline "skip blank, else check
 *  for a colon" logic. */
function untypedParamIncrement(buf: string): number {
	const param = buf.trim();
	if (param === "") return 0;
	return param.includes(":") ? 0 : 1;
}

// Re-export the unjustified-cast counter (defined in checks/cast-justification.ts)
// so the ratchet baseline, capture, and comparison can use it alongside the
// as-any and non-null counters.
export { countUnjustifiedCasts } from "../checks/cast-justification.js";

// ===========================================
// Ambient-seam counters (plan 25, lane 2)
// ===========================================
// A "seam" read is a direct call into ambient global state — wall clock,
// randomness, process environment — instead of an injected dependency. Each
// one makes the surrounding code harder to test, non-hermetic, and harder to
// port (the seam is exactly what a new language rebinds). The ratchet holds
// the per-file count: an edit may remove seams freely and may never add one.
// The always-on advisory detectors (`untestable_time_in_source`,
// `process_env_outside_config`) cover diff scope; this ratchet adds the
// hold-the-line semantics in whole-file scope.

const CLOCK_SEAM_PATTERN = /\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)/g;
const RANDOM_SEAM_PATTERN = /\bMath\s*\.\s*random\s*\(/g;
const ENV_SEAM_PATTERN = /\bprocess\s*\.\s*env\s*[.[]/g;
// Python parity (plan 25): the same three seam classes in Python idiom.
const PY_CLOCK_SEAM_PATTERN =
	/\btime\s*\.\s*time\s*\(|\bdatetime\s*\.\s*(?:now|utcnow|today)\s*\(/g;
const PY_RANDOM_SEAM_PATTERN =
	/\brandom\s*\.\s*(?:random|randint|randrange|choice|choices|shuffle|uniform|sample)\s*\(/g;
const PY_ENV_SEAM_PATTERN = /\bos\s*\.\s*environ\b|\bos\s*\.\s*getenv\s*\(/g;
/** Files whose JOB is the config boundary — env reads belong there. Mirrors
 *  the `process_env_outside_config` check's boundary wording: a config
 *  module, a `.config.*` file, a `/config/` directory, a setup/bootstrap
 *  file — plus Python's settings.py / conftest.py conventions. */
const CONFIG_BOUNDARY_PATH_RE =
	/\.config\.[a-z]+$|(^|\/)config[^/]*\.[a-z]+$|(^|\/)config\/|(^|\/)(?:test-)?setup(\/|[^/]*\.[a-z]+$)|(^|\/)bootstrap[^/]*\.[a-z]+$|(^|\/)(?:settings|conftest)[^/]*\.py$/i;

export interface AmbientSeamCounts {
	clock: number;
	random: number;
	env: number;
}

/** The seam idiom set for a path: `.py` gets the Python patterns, everything
 *  else the JS/TS patterns — so neither language false-counts in the other. */
function seamPatternsFor(posix: string): { clock: RegExp; random: RegExp; env: RegExp } {
	if (/\.py$/i.test(posix)) {
		return { clock: PY_CLOCK_SEAM_PATTERN, random: PY_RANDOM_SEAM_PATTERN, env: PY_ENV_SEAM_PATTERN };
	}
	return { clock: CLOCK_SEAM_PATTERN, random: RANDOM_SEAM_PATTERN, env: ENV_SEAM_PATTERN };
}

/** Count ambient-seam reads in `content`. The extension picks the language's
 *  idiom set via {@link seamPatternsFor}; `filePath` also decides the env
 *  exemption: config-boundary files legitimately read the environment. */
export function countAmbientSeams(content: string, filePath: string): AmbientSeamCounts {
	const stripped = stripAllLiterals(content);
	const posix = filePath.replace(/\\/g, "/");
	const p = seamPatternsFor(posix);
	return {
		clock: (stripped.match(p.clock) || []).length,
		random: (stripped.match(p.random) || []).length,
		env: CONFIG_BOUNDARY_PATH_RE.test(posix) ? 0 : (stripped.match(p.env) || []).length,
	};
}

// ===========================================
// Assertion-strength counters (plan 25, lane 4)
// ===========================================
// A WEAK matcher (toContain/toMatch/toBeTruthy/toBeDefined) accepts a wide
// range of post-mutation values, so a mutant that corrupts the exact result
// can still slip past it. An EXACT matcher (toBe/toEqual/toStrictEqual) pins
// one specific observable, so mutation testing kills more of what it should.
// The ratchet (in ratchet-comparison.ts) reads these counts and fires only
// on pure weakening; this module only counts — the test-file scope filter
// lives at the comparison layer, so capturing counts for any file is safe.

const WEAK_MATCHER_PATTERN = /\b(?:toContain|toMatch|toBeTruthy|toBeDefined)\s*\(/g;
const EXACT_MATCHER_PATTERN = /\b(?:toBe|toEqual|toStrictEqual)\s*\(/g;
// Python parity (plan 25): unittest matchers plus pytest's plain asserts —
// a bare truthy `assert x` and membership `assert a in b` are the weak forms;
// `assert a == b` and the *Equal family pin exact observables.
const PY_WEAK_MATCHER_PATTERN =
	/\bassert(?:True|False|In|NotIn)\s*\(|^\s*assert\s+[A-Za-z_][\w.]*(?:\(\))?\s*$|\bassert\s+\S+\s+(?:not\s+)?in\s+/gm;
const PY_EXACT_MATCHER_PATTERN =
	/\bassert(?:Equal|NotEqual|Is|IsNot|DictEqual|ListEqual|SetEqual|TupleEqual)\s*\(|^\s*assert\s+[^\n#]*[=!]=/gm;

export interface AssertionStrengthCounts {
	weak: number;
	exact: number;
}

/** Count weak and exact assertion forms in `content`. Strings/comments are
 *  stripped first so a matcher name mentioned in prose doesn't count. The
 *  optional `filePath` picks the idiom set: `.py` counts unittest/pytest
 *  forms; everything else counts the vitest/jest matchers. */
export function countAssertionStrength(
	content: string,
	filePath = "",
): AssertionStrengthCounts {
	const stripped = stripAllLiterals(content);
	if (/\.py$/i.test(filePath)) {
		return {
			weak: countMatches(stripped, PY_WEAK_MATCHER_PATTERN),
			exact: countMatches(stripped, PY_EXACT_MATCHER_PATTERN),
		};
	}
	return {
		weak: countMatches(stripped, WEAK_MATCHER_PATTERN),
		exact: countMatches(stripped, EXACT_MATCHER_PATTERN),
	};
}
