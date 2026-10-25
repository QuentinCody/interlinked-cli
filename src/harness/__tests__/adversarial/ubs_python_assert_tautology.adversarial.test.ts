// Independent adversarial review (2026-10-21) of `ubs_python_assert_tautology`,
// a pre_block check. Each negative case is legitimate Python the original flat
// regex blocked: its `[^()]+` admitted `[` and `{`, so a comma inside a list,
// dict or set literal or a multi-index subscript read as a tuple. Probe:
// scratch/2026-10-21-round3/ubs_python_assert_tautology.probe.mts.

import { describe, expect, it } from "vitest";
import { checkPythonAssertTautology } from "../../checks/assert-side-effects.js";

const TEST_FILE = "tests/test_mod.py";
const fires = (code: string): number[] => checkPythonAssertTautology(code, TEST_FILE).map((m) => m.line);

describe("ubs_python_assert_tautology — negative (must not fire)", () => {
	it("N1: a parenthesized comparison whose RHS is a list literal", () => {
		expect(fires("assert (result == [1, 2])\n")).toEqual([]);
	});

	it("N2: a dict literal on the right of the comparison", () => {
		expect(fires('assert (payload == {"a": 1, "b": 2})\n')).toEqual([]);
	});

	it("N3: a dict literal on the left of the comparison", () => {
		expect(fires('assert ({"a": 1, "b": 2} == payload)\n')).toEqual([]);
	});

	it("N4: set-literal membership", () => {
		expect(fires("assert (state in {READY, DONE})\n")).toEqual([]);
	});

	it("N5: a numpy multi-index subscript", () => {
		expect(fires("assert (grid[i, j] == 0)\n")).toEqual([]);
	});

	it("N6: a numpy column slice", () => {
		expect(fires("assert (arr[:, 0] == 0).all()\nassert (arr[:, 0] == 0)\n")).toEqual([]);
	});

	it("N7: a slice compared with a list", () => {
		expect(fires("assert (window[1:3] == [2, 3])\n")).toEqual([]);
	});

	it("N8: a nested list-of-lists literal", () => {
		expect(fires("assert (m == [[1, 0], [0, 1]])\n")).toEqual([]);
	});

	it("N9: a generator expression (not a tuple; dropping the parens would not parse)", () => {
		expect(fires("assert (x for x, y in pairs)\n")).toEqual([]);
	});

	it("N10: pyflakes `# noqa: F631` acknowledges this exact finding", () => {
		expect(fires('assert (x, "msg")  # noqa: F631\n')).toEqual([]);
		expect(fires('assert (x, "msg")  # NOQA: E501, f631\n')).toEqual([]);
	});

	it("N11: a bare `# noqa` suppresses every finding on the line", () => {
		expect(fires('assert (x, "msg")  # noqa\n')).toEqual([]);
	});

	it("N12: a multi-line docstring that shows the footgun", () => {
		const code = ["def f():", '    """Do not write:', '    assert (x, "msg")', '    """', '    assert x, "msg"', ""].join("\n");
		expect(fires(code)).toEqual([]);
	});
});

describe("ubs_python_assert_tautology — positive (must fire)", () => {
	it("P1: the classic `assert (cond, \"msg\")` tuple", () => {
		expect(fires('assert (x == 1, "msg")\n')).toEqual([1]);
	});

	it("P2: a bare two-name tuple", () => {
		expect(fires("ok = True\nassert (a, b)\n")).toEqual([2]);
	});

	it("P3: a list-literal condition followed by a message still builds a tuple", () => {
		expect(fires('assert (result == [1, 2], "bad result")\n')).toEqual([1]);
	});

	it("P4: a dict-literal condition followed by a message", () => {
		expect(fires('assert (d == {"a": 1}, "bad")\n')).toEqual([1]);
	});

	it("P5: a multi-index subscript condition followed by an f-string message", () => {
		expect(fires('assert (grid[i, j] == 0, f"cell {i}")\n')).toEqual([1]);
	});

	it("P6: Bandit `# nosec` (bare or B101) does not suppress the tuple", () => {
		expect(fires('assert (x, "msg")  # nosec B101\n')).toEqual([1]);
		expect(fires('assert (x, "msg")  # nosec\n')).toEqual([1]);
	});

	it("P7: a `# noqa` naming an unrelated code does not suppress", () => {
		expect(fires('assert (x, "msg")  # noqa: E501\n')).toEqual([1]);
	});

	it("P8: an identifier that merely starts with `for` is not a generator", () => {
		expect(fires('assert (for_each, "msg")\n')).toEqual([1]);
	});
});
