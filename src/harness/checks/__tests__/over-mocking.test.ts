import { nonNull } from "../../../lib/non-null.js";
// Over-mocking detector tests.
//
// checkOverMocking(content, filePath) flags test files whose mock/spy call
// count (vi.mock / jest.mock / vi.spyOn / jest.spyOn) reaches the 8+ warning
// threshold — a smell that the suite tests its mocks rather than real behavior.
//
// Branch map (every path asserted behaviorally below):
//   1. Non-test file path                         -> [] (gate at isTestFile)
//   2. Test file but non-JS/TS extension (.mjs)   -> [] (extension guard)
//   3. Test file but unhandled extension (.py)    -> [] (extension guard)
//   4. count < 8                                  -> [] (under threshold)
//   5. count === 8 (boundary)                     -> one match
//   6. count > 8                                  -> one match, correct total
//   7. all four mock/spy verbs counted            -> total reflects each
//   8. anchor = FIRST matching line, text carries the running total
//   9. anchor text truncated to 100 chars of the trimmed line
//  10. indentation-insensitive matching (lines[i].trim())

import { describe, expect, it } from "vitest";
import { checkOverMocking } from "../over-mocking.js";

const TEST_TS = "src/lib/widget.test.ts";
const TEST_TSX = "src/ui/widget.test.tsx";
const TEST_JS = "src/lib/widget.test.js";
const TEST_JSX = "src/ui/widget.spec.jsx";

/** Build a body of `n` distinct mock-call lines using the given verb. */
function mockLines(n: number, verb = "vi.mock"): string {
	const out: string[] = [];
	for (let i = 0; i < n; i++) {
		out.push(`${verb}("./dep-${i}.js");`);
	}
	return out.join("\n");
}

// ===========================================
// Gate: non-test files are skipped entirely
// ===========================================

describe("checkOverMocking — file gating", () => {
	it("returns [] for a non-test source path even when it is mock-heavy", () => {
		// Source file (not *.test / *.spec, not under a tests dir). Even with
		// 20 mock calls the check must not fire — isTestFile gate at the top.
		const matches = checkOverMocking(mockLines(20), "src/lib/widget.ts");
		expect(matches).toEqual([]);
	});

	it("returns [] for a test file with a non-JS/TS extension (.mjs)", () => {
		// `widget.test.mjs` IS a recognized test file by name, but getExtension
		// yields `.mjs`, which the extension guard rejects -> []. This proves
		// the guard is reached *after* the test-file check passes.
		const matches = checkOverMocking(mockLines(12), "src/lib/widget.test.mjs");
		expect(matches).toEqual([]);
	});

	it("returns [] for a Python test file (extension guard)", () => {
		// `test_widget.py` passes isStrictTestFile (Python convention) but the
		// extension `.py` is not in the JS/TS set -> [].
		const py = Array.from({ length: 12 }, (_, i) => `mocker.patch("dep_${i}")`).join("\n");
		const matches = checkOverMocking(py, "src/lib/test_widget.py");
		expect(matches).toEqual([]);
	});
});

// ===========================================
// Threshold behavior
// ===========================================

describe("checkOverMocking — threshold", () => {
	it("does NOT fire at 7 mock calls (one below threshold)", () => {
		const matches = checkOverMocking(mockLines(7), TEST_TS);
		expect(matches).toEqual([]);
	});

	it("P1: fires at exactly 8 mock calls (boundary, count >= 8)", () => {
		const matches = checkOverMocking(mockLines(8), TEST_TS);
		expect(matches).toHaveLength(1);
		const m = nonNull(matches[0]);
		expect(m.text).toContain("[8 mock/spy calls");
	});

	it("does not fire on an empty file", () => {
		expect(checkOverMocking("", TEST_TS)).toEqual([]);
	});

	it("does not fire on a test file with zero mock calls", () => {
		const code = ['import { add } from "./math.js";', "expect(add(1, 2)).toBe(3);"].join("\n");
		expect(checkOverMocking(code, TEST_JS)).toEqual([]);
	});
});

// ===========================================
// Counting: every supported verb, every JS/TS extension
// ===========================================

describe("checkOverMocking — counting", () => {
	it("reports the exact total when above threshold", () => {
		const matches = checkOverMocking(mockLines(11), TEST_TS);
		expect(matches).toHaveLength(1);
		expect((nonNull(matches[0])).text).toContain("[11 mock/spy calls");
	});

	it("counts vi.mock, jest.mock, vi.spyOn and jest.spyOn together", () => {
		// 2 of each verb = 8 total -> fires with [8 ...].
		const code = [
			'vi.mock("./a.js");',
			'vi.mock("./b.js");',
			'jest.mock("./c.js");',
			'jest.mock("./d.js");',
			"vi.spyOn(obj, 'one');",
			"vi.spyOn(obj, 'two');",
			"jest.spyOn(obj, 'three');",
			"jest.spyOn(obj, 'four');",
		].join("\n");
		const matches = checkOverMocking(code, TEST_TS);
		expect(matches).toHaveLength(1);
		expect((nonNull(matches[0])).text).toContain("[8 mock/spy calls");
	});

	it("fires for a .tsx test file", () => {
		const matches = checkOverMocking(mockLines(9, "vi.spyOn"), TEST_TSX);
		// vi.spyOn with one positional arg still matches /\b(vi|jest)\.(mock|spyOn)\s*\(/.
		expect(matches).toHaveLength(1);
		expect((nonNull(matches[0])).text).toContain("[9 mock/spy calls");
	});

	it("fires for a .jsx spec file", () => {
		const matches = checkOverMocking(mockLines(8, "jest.mock"), TEST_JSX);
		expect(matches).toHaveLength(1);
		expect((nonNull(matches[0])).text).toContain("[8 mock/spy calls");
	});

	it("tolerates whitespace between the verb and the paren", () => {
		// `vi.mock (` with a space still matches `\.mock\s*\(`.
		const code = Array.from({ length: 8 }, (_, i) => `vi.mock ("./d-${i}.js");`).join("\n");
		const matches = checkOverMocking(code, TEST_TS);
		expect(matches).toHaveLength(1);
		expect((nonNull(matches[0])).text).toContain("[8 mock/spy calls");
	});

	it("does NOT count look-alikes that are not vi/jest mock/spy calls", () => {
		// `mockReturnValue`, a user fn named `mock(`, `vi.fn(`, and `myvi.mock(`
		// must all be ignored. Only 7 genuine calls -> under threshold -> [].
		const code = [
			...Array.from({ length: 7 }, (_, i) => `vi.mock("./real-${i}.js");`),
			"const r = fn.mockReturnValue(1);", // method, not vi/jest.mock
			"mock('not-a-namespaced-call');", // bare mock(
			"vi.fn();", // vi.fn, not vi.mock/spyOn
			"myvi.mock('x');", // \b boundary: `myvi.mock` -> the `vi.mock` substring
		].join("\n");
		const matches = checkOverMocking(code, TEST_TS);
		// NOTE: `\b(vi|jest)\.` — in `myvi.mock` there is no word boundary
		// immediately before `vi` (preceded by `y`), so it does NOT match.
		expect(matches).toEqual([]);
	});
});

// ===========================================
// Anchor: first matching line, count prefix, truncation
// ===========================================

describe("checkOverMocking — anchor line", () => {
	it("anchors on the FIRST mock line, not a later one, with the running total", () => {
		const code = [
			'import { describe } from "vitest";', // line 1 — no mock
			'const setup = "ready";', // line 2 — no mock
			'vi.mock("./first.js");', // line 3 — FIRST mock
			...Array.from({ length: 8 }, (_, i) => `vi.mock("./later-${i}.js");`), // lines 4-11
		].join("\n");
		const matches = checkOverMocking(code, TEST_TS);
		expect(matches).toHaveLength(1);
		const m = nonNull(matches[0]);
		expect(m.line).toBe(3); // 1-based: the first mock line
		expect(m.text).toContain("[9 mock/spy calls");
		expect(m.text).toContain('vi.mock("./first.js");');
	});

	it("reports the line of an indented first mock call (trim-based detection)", () => {
		const code = [
			"describe('suite', () => {", // line 1
			'\t\tjest.spyOn(globalThis, "x");', // line 2 — indented FIRST mock
			...Array.from({ length: 7 }, (_, i) => `\t\tjest.mock("./m-${i}.js");`), // lines 3-9
			"});",
		].join("\n");
		const matches = checkOverMocking(code, TEST_TS);
		expect(matches).toHaveLength(1);
		const m = nonNull(matches[0]);
		expect(m.line).toBe(2);
		// Anchor text is the *trimmed* line, so leading tabs are gone.
		expect(m.text).toContain('jest.spyOn(globalThis, "x");');
		expect(m.text).not.toMatch(/\t/);
	});

	it("truncates the anchor's source snippet to 100 chars of the trimmed line", () => {
		// One very long first mock line + 7 short ones = 8 total -> fires.
		const longArg = "x".repeat(400);
		const longMock = `vi.mock("./${longArg}.js"); // trailing comment that should be cut off entirely`;
		const code = [longMock, ...Array.from({ length: 7 }, (_, i) => `vi.mock("./s-${i}.js");`)].join(
			"\n",
		);
		const matches = checkOverMocking(code, TEST_TS);
		expect(matches).toHaveLength(1);
		const m = nonNull(matches[0]);
		// The snippet portion after the count prefix is sliced to 100 chars.
		const prefix = "[8 mock/spy calls — tests may be testing mocks rather than real behavior] ";
		expect(m.text.startsWith(prefix)).toBe(true);
		const snippet = m.text.slice(prefix.length);
		expect(snippet).toHaveLength(100);
		// The trailing comment lived well past char 100, so it is gone.
		expect(snippet).not.toContain("trailing comment");
	});
});
