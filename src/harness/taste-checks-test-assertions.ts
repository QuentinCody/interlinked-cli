// ===========================================
// Taste Checks — test-assertion family
// ===========================================
// Extracted from taste-checks.ts (verbatim) to keep the barrel under the
// per-file line cap. These four detectors all target test-hygiene smells
// sourced from Robert C. Martin's essays. Shared helpers live in
// ./taste-checks-shared.js; this module re-exports through taste-checks.ts so
// existing importers keep importing from "../taste-checks.js" unchanged.

import { nonNull } from "../lib/non-null.js";
import { blankJsxText } from "./checks/nan-comparison-scan.js";
import { stripComments } from "./strip-helpers.js";
import { keepsRealModule, sameDirSiblingBase } from "./taste-checks-mock-real-module.js";
import { parameterizedTestBodies, type TestBody } from "./test-parameterized-bodies.js";
import {
	findBlockEnd,
	type InlineMatch,
	isCountableTestStart,
	isJsTs,
	isTestFile,
	push,
	stripCommentsAndStrings,
} from "./taste-checks-shared.js";

// ===========================================
// 1. Assertion-Free Tests
// Uncle Bob, "Mutation Testing" (2016) + FIRST principles
// ===========================================

const ASSERT_PATTERN =
	/\b(expect|should)\s*\(|\bassert\b\s*(?:\.\s*[A-Za-z]+)?\s*\(|\.\s*(?:toBe|toEqual|toStrictEqual|toMatch|toMatchObject|toThrow|toThrowError|toHaveBeenCalled|toHaveBeenCalledWith|toHaveBeenCalledTimes|toContain|toContainEqual|toHaveLength|toHaveProperty|toBeDefined|toBeUndefined|toBeNull|toBeTruthy|toBeFalsy|toBeInstanceOf|toBeGreaterThan|toBeLessThan|toBeCloseTo|toMatchSnapshot|toMatchInlineSnapshot|resolves|rejects)\b|\bchai\.|\bsinon\.assert/;

/** A call to a function named `assertX(...)` / `expectX(...)`
 *  (`fixture.assertServed(run)`, `expectServed(run)`, vitest's
 *  `expectTypeOf(x)` / `assertType<T>(x)`, jasmine's `expectAsync(p)`) — the
 *  conventional name of an assertion helper whose body this file cannot see
 *  because it is imported. A type-argument list may sit before the paren. */
const ASSERT_HELPER_CALL = /\b(?:assert|expect)[A-Z][\w$]*\s*(?:<[^()]*>)?\s*\(/;

/** chai's should style: `result.should.equal(5)`, `should.exist(x)`,
 *  `should.not.exist(x)`, `should.Throw(fn)`. */
const CHAI_SHOULD_PATTERN = /\.should\s*\.|(?<![\w$.])should\s*\.\s*(?:exist|not|equal|Throw|throw|fail)\b/;

/** AVA / node-tap / tape assertions on the test-context object `t`: the
 *  method list is the distinctive assertion surface, not `t(` itself (which
 *  is also an i18n call) and not `t.end()` / `t.plan()` / `t.pass()`. */
const T_CONTEXT_ASSERT_PATTERN =
	/(?<![\w$.])t\s*\.\s*(?:is|not|deepEqual|notDeepEqual|like|true|false|truthy|falsy|throws|notThrows|throwsAsync|notThrowsAsync|regex|notRegex|snapshot|equal|notEqual|same|notSame|strictSame|ok|notOk|match|doesNotMatch|fail)\s*\(/;

/** The static call forms that fail the test when reached: vitest's
 *  `expect.unreachable()` and chai's `expect.fail()` — a negative-path
 *  assertion inside a listener or catch block (tinybench task-remove.test.ts). */
const EXPECT_STATIC_FAIL_PATTERN = /(?<![\w$.])expect\s*\.\s*(?:unreachable|fail)\s*\(/;

const ASSERT_PATTERNS: readonly RegExp[] = [
	ASSERT_PATTERN,
	ASSERT_HELPER_CALL,
	CHAI_SHOULD_PATTERN,
	T_CONTEXT_ASSERT_PATTERN,
	EXPECT_STATIC_FAIL_PATTERN,
];

/** A ts-expect-error directive (line or block comment form) that opens
 *  its line. tsc fails when the next line has no type error, so the directive
 *  is a compile-time assertion (zod's `.flatten() type assertion` tests). The
 *  comment-free copy must have LOST the token, which rejects a fixture string
 *  or template line that only spells the directive. A ts-ignore never fails
 *  and is not an assertion. */
const EXPECT_ERROR_DIRECTIVE_RE = /^\s*(?:\/\/|\/\*+)\s*@ts-expect-error\b/;

function expectErrorDirectiveLines(lines: readonly string[], commentFree: string): Set<number> {
	const freeLines = commentFree.split("\n");
	const found = new Set<number>();
	lines.forEach((line, i) => {
		if (EXPECT_ERROR_DIRECTIVE_RE.test(line) && !freeLines[i]?.includes("@ts-expect-error")) found.add(i);
	});
	return found;
}

function hasDirectiveBetween(directives: ReadonlySet<number>, start: number, end: number): boolean {
	for (const line of directives) if (line > start && line <= end) return true;
	return false;
}

function hasAssertion(body: string): boolean {
	return ASSERT_PATTERNS.some(re => re.test(body));
}

/** Module specifiers whose EVERY export is an assertion — `node:assert`,
 *  `assert/strict`, `uvu/assert`, `@std/assert`, `power-assert` — so a named
 *  import from one (`import { deepStrictEqual } from "node:assert/strict"`,
 *  `const { strictEqual } = require("assert")`, `import { strict } from
 *  "node:assert"` then `strict.equal(…)`) is an assertion call under its
 *  local name. Scanned on the comment-stripped ORIGINAL: the string-stripped
 *  copy has blanked the specifier. */
const ASSERTION_MODULE_RE = /^(?:(?:node|jsr):)?(?:@std\/|uvu\/|power-)?assert(?:\/strict)?$/;
const IMPORT_CLAUSE_RE = /\bimport\s+(?!type\b)([^;]*?)\s+from\s*(["'])([^"']+)\2/g;
const REQUIRE_CLAUSE_RE =
	/\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(["'])([^"']+)\2\s*\)/g;

/** Local binding names declared by one import / require clause:
 *  `{ a, b as c, d: e }` → a, c, e; `* as ns` → ns; `def` → def. */
function clauseBindings(clause: string): string[] {
	const names: string[] = [];
	const add = (piece: string): void => {
		const local = nonNull(piece.trim().split(/\s+as\s+|\s*:\s*/).pop()).trim();
		if (/^[A-Za-z_$][\w$]*$/.test(local)) names.push(local);
	};
	for (const m of clause.matchAll(/\{([^}]*)\}/g)) nonNull(m[1]).split(",").forEach(add);
	clause.replace(/\{[^}]*\}/g, "").split(",").forEach(add);
	return names;
}

/** Local names bound to an assertion-only module by import or require. */
function boundAssertionNames(commentFree: string): Set<string> {
	const names = new Set<string>();
	for (const re of [IMPORT_CLAUSE_RE, REQUIRE_CLAUSE_RE]) {
		for (const m of commentFree.matchAll(re)) {
			if (ASSERTION_MODULE_RE.test(nonNull(m[3]))) clauseBindings(nonNull(m[1])).forEach(n => names.add(n));
		}
	}
	return names;
}

/** A same-file helper declaration whose body opens on the header line. The
 *  `{` requirement keeps an expression-bodied arrow from borrowing the next
 *  block; a header these patterns miss leaves the helper unrecognized, which
 *  keeps the test flagged (the pre-change behavior). The const form admits a
 *  type annotation that itself contains `=>` and a generic arrow `<T,>(…)`. */
const HELPER_HEADERS = [
	/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(][^{]*\{/,
	/^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::(?:[^=]|=>)*)?=\s*(?:async\s+)?(?:function\b[^{]*|(?:<[^>]*>\s*)?\([^)]*\)[^=]*=>|[A-Za-z_$][\w$]*\s*=>)\s*\{/,
];

function escapeName(name: string): string {
	return name.replace(/\$/g, "\\$");
}

function callsAny(body: string, names: ReadonlySet<string>): boolean {
	for (const name of names) {
		if (new RegExp(String.raw`(?<![\w$.])${escapeName(name)}\s*\(`).test(body)) return true;
	}
	return false;
}

/** A direct or one-level member call on an import-bound assertion name:
 *  `deepStrictEqual(a, b)`, `strict.equal(a, b)`. */
function callsBinding(body: string, names: ReadonlySet<string>): boolean {
	for (const name of names) {
		const re = new RegExp(String.raw`(?<![\w$.])${escapeName(name)}\s*(?:\.\s*[A-Za-z_$][\w$]*)?\s*\(`);
		if (re.test(body)) return true;
	}
	return false;
}

interface AssertionSources {
	helpers: ReadonlySet<string>;
	bound: ReadonlySet<string>;
}

/** Names of same-file helpers that assert, directly or through another
 *  asserting helper: a test that delegates to `driver()` / `fixture()` whose
 *  body calls `assert.equal` is not assertion-free. */
function assertingHelpers(sLines: string[], bound: ReadonlySet<string>): Set<string> {
	const helpers = new Map<string, string>();
	sLines.forEach((line, i) => {
		const name = HELPER_HEADERS.map(re => line.match(re)?.[1]).find(Boolean);
		if (name) helpers.set(name, sLines.slice(i, findBlockEnd(sLines, i) + 1).join("\n"));
	});
	const asserting = new Set<string>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const [name, body] of helpers) {
			if (asserting.has(name)) continue;
			if (!(hasAssertion(body) || callsBinding(body, bound) || callsAny(body, asserting))) continue;
			asserting.add(name);
			grew = true;
		}
	}
	return asserting;
}

function isAssertionFreeBody(body: string, sources: AssertionSources): boolean {
	if (!body.includes("{")) return false;
	return !hasAssertion(body) && !callsBinding(body, sources.bound) && !callsAny(body, sources.helpers);
}

// A case EXPLICITLY named for a smoke / not-throwing check legitimately asserts
// nothing: `render(<App/>)` (or any setup that would throw on failure) IS the
// assertion. Without this exemption the pre_block error hard-blocks a common,
// valid React/RTL pattern. Deliberately narrow — only the explicit phrasings
// ("…without crashing", "does not throw", "smoke"); a bare "renders the count"
// is NOT exempt, because it should assert what it renders.
const SMOKE_TEST_NAME_RE =
	/\bsmoke\b|without\s+(?:crash(?:ing|es)?|error(?:s)?|throw(?:ing)?|incident)|does(?:\s+not|n'?t)\s+(?:throw|crash|reject|error)|\bno[\s-]?throw\b/i;

/** How many ORIGINAL lines of a test's header to search for its name string.
 *  Formatters put the name at most a line or two below `it(`; the window is
 *  generous without scanning whole bodies. */
const TEST_NAME_HEADER_LINES = 8;

/** Pull the case name from the ORIGINAL (non-stripped) test HEADER — the
 *  `it(...)`/`test(...)` start line JOINED with the following lines up to the
 *  block end (capped at {@link TEST_NAME_HEADER_LINES}), because a formatted
 *  test puts the name on the NEXT line (`it(\n  "name",\n  () => …`). Reading
 *  only the start line returned "" for those and defeated the smoke-test
 *  exemption (finding 2026-06). The stripped copy has names collapsed away, so
 *  this reads the original. Empty when the first argument isn't a string
 *  literal — the regex anchors the quote to the call's opening paren (only
 *  whitespace may intervene), so body strings can never be mistaken for a name. */
function testCaseName(lines: string[], start: number, end: number): string {
	const stop = Math.min(end, start + TEST_NAME_HEADER_LINES - 1);
	const header = lines.slice(start, stop + 1).join("\n");
	const m = header.match(/\b(?:it|test|specify)(?:\s*\.\s*\w+)*\s*\(\s*(["'`])([^"'`]*)\1/);
	return m ? nonNull(m[2]) : "";
}

interface TestSource {
	lines: string[];
	sLines: string[];
	parameterized: ReadonlyMap<number, TestBody>;
}

/** Select the real callback before looking for assertions or smoke-test names. */
function testBodyAtLine(source: TestSource, start: number): TestBody | null {
	const test = source.parameterized.get(start);
	if (test) return { ...test, body: stripCommentsAndStrings(test.body) };
	// An unparsed parameterized callback cannot prove assertion absence.
	if (/\.\s*each\s*\(/.test(nonNull(source.sLines[start]))) return null;
	const end = findBlockEnd(source.sLines, start);
	return {
		end,
		body: source.sLines.slice(start, end + 1).join("\n"),
		name: testCaseName(source.lines, start, end),
	};
}

export function checkAssertionFreeTest(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const parameterized = parameterizedTestBodies(content, filePath);
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const commentFree = stripComments(content);
	const bound = boundAssertionNames(commentFree);
	const sources: AssertionSources = { helpers: assertingHelpers(sLines, bound), bound };
	const directives = expectErrorDirectiveLines(lines, commentFree);
	const matches: InlineMatch[] = [];
	let i = 0;
	while (i < sLines.length && matches.length < 10) {
		if (!isCountableTestStart(nonNull(sLines[i]))) {
			i++;
			continue;
		}
		const test = testBodyAtLine({ lines, sLines, parameterized }, i);
		if (!test) {
			i++;
			continue;
		}
		// The name is read from the ORIGINAL header lines (stripped collapses it);
		// line indices align because stripCommentsAndStrings is line-preserving.
		const exempt = SMOKE_TEST_NAME_RE.test(test.name) || hasDirectiveBetween(directives, i, test.end);
		if (!exempt && isAssertionFreeBody(test.body, sources)) push(matches, i, lines, 10);
		i = test.end + 1;
	}
	return matches;
}

// ===========================================
// 2. Tautological Assertions
// ===========================================

const TAUTOLOGY_EXPECT =
	/expect\s*\(\s*([A-Za-z_$][\w$.[\]]*)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*([A-Za-z_$][\w$.[\]]*)\s*\)/g;
const TAUTOLOGY_ASSERT =
	/\bassert\s*\.\s*(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(\s*([A-Za-z_$][\w$.[\]]*)\s*,\s*([A-Za-z_$][\w$.[\]]*)\s*\)/g;
const SIMPLE_LITERAL = String.raw`(?:true|false|null|undefined|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;
const TAUTOLOGY_LITERAL_EXPECT = new RegExp(
	String.raw`expect\s*\(\s*(${SIMPLE_LITERAL})\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*(${SIMPLE_LITERAL})\s*\)`,
	"g",
);
const TRIVIAL_TRUTHINESS =
	/expect\s*\(\s*true\s*\)\s*\.\s*toBeTruthy\s*\(\s*\)|expect\s*\(\s*false\s*\)\s*\.\s*toBeFalsy\s*\(\s*\)|\bassert(?:\.ok)?\s*\(\s*true\s*\)/g;

function startsInCode(codeMask: string, index: number): boolean {
	return nonNull(codeMask[index]).trim() !== "";
}

function hasEqualLiteralTautology(line: string, codeMask: string): boolean {
	for (const match of line.matchAll(TAUTOLOGY_LITERAL_EXPECT)) {
		if (match[1] === match[2] && startsInCode(codeMask, match.index)) return true;
	}
	return false;
}

function hasConstantTruthiness(line: string, codeMask: string): boolean {
	for (const match of line.matchAll(TRIVIAL_TRUTHINESS)) {
		if (startsInCode(codeMask, match.index)) return true;
	}
	return false;
}

function hasTautology(line: string): boolean {
	for (const m of line.matchAll(TAUTOLOGY_EXPECT)) {
		if (m[1] === m[2]) return true;
	}
	for (const m of line.matchAll(TAUTOLOGY_ASSERT)) {
		if (m[1] === m[2]) return true;
	}
	return false;
}

export function checkTautologicalAssertion(content: string, filePath: string): InlineMatch[] {
	// JS grammar only: `isTestFile` also says yes to `test_*.py`, `*Test.java` and
	// fixtures under tests/, whose strings the strippers cannot see — JS text in a
	// Python triple-quoted string blocked a write (2026-10-21 adversarial review).
	if (!isTestFile(filePath) || !isJsTs(filePath)) return [];
	// JSX text is rendered prose that the string strippers keep by contract:
	// `<Tip>Never write expect(a).toBe(a)</Tip>` blocked a docs-component test
	// (2026-10-21 adversarial review, third pass). Output lines stay original.
	const scanned = blankJsxText(content, filePath);
	const stripped = stripCommentsAndStrings(scanned);
	const commentFree = stripComments(scanned);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const cLines = commentFree.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 10; i++) {
		if (
			hasTautology(nonNull(sLines[i])) ||
			hasEqualLiteralTautology(nonNull(cLines[i]), nonNull(sLines[i])) ||
			hasConstantTruthiness(nonNull(cLines[i]), nonNull(sLines[i]))
		) {
			push(matches, i, lines, 10);
		}
	}
	return matches;
}

// ===========================================
// 3. Mocking the System Under Test
// Uncle Bob, "The Little Mocker" (2014)
// ===========================================

const MOCK_CALL_STATIC = /\b(?:vi|jest)\s*\.\s*(?:mock|doMock|setMock)\s*\(\s*["']([^"']+)["']/;

/** The same call after STRING stripping (path text blanked, quotes kept) — what
 *  a real call looks like. A mock call that is fixture text inside a string or
 *  template literal is blanked with its enclosing literal instead (2026-10-21
 *  adversarial review: a generator test asserting `'vi.mock("./gen-mock")'`). */
const MOCK_CALL_AS_CODE = /\b(?:vi|jest)\s*\.\s*(?:mock|doMock|setMock)\s*\(\s*(["'])\s*\1/;

function mockedPathEqualsSut(mockedPath: string, sut: string): boolean {
	return sameDirSiblingBase(mockedPath) === sut;
}

export function checkMockingTheSUT(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const baseName = nonNull(filePath.split(/[/\\]/).pop());
	const sut = baseName.replace(/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
	if (!sut || sut === baseName) return [];
	const stripped = stripComments(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const codeLines = stripCommentsAndStrings(content).split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 5; i++) {
		const m = MOCK_CALL_STATIC.exec(nonNull(sLines[i]));
		if (!m || !mockedPathEqualsSut(nonNull(m[1]), sut)) continue;
		if (!MOCK_CALL_AS_CODE.test(nonNull(codeLines[i]))) continue;
		// `{ spy: true }` or a factory returning the actual module: the SUT still runs.
		if (keepsRealModule(sLines, i, m.index + m[0].length, sut)) continue;
		push(matches, i, lines, 5);
	}
	return matches;
}

// ===========================================
// 4. Private-Member Access from Tests
// Uncle Bob, "Test Contra-variance" (2017)
// ===========================================
// Lives in ./taste-checks-private-member.ts (moved 2026-10-21 to fit the
// per-file line cap); re-exported so existing importers are unchanged.
export { checkPrivateMemberTestAccess } from "./taste-checks-private-member.js";
