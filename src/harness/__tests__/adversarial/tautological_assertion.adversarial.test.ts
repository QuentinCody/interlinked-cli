// Independent adversarial review of the `tautological_assertion` pre_block check
// (2026-10-21). Probes: scratch/2026-10-21-adversarial/tautological_assertion.probe.mts
// (14 candidates) and tautological_assertion.extra.probe.mts (20 candidates).
// The detector's grammar is JavaScript's (`expect(x).toBe(x)`,
// `assert.equal(x, x)`), but it gated only on "is this a test file", which the
// predicate answers YES for `test_*.py`, `*_test.go`, `*Test.java`,
// `tests/README.md` and `__tests__/fixtures/*.{txt,yaml,html}`. The TS-parser
// stripper cannot parse those, and the line-scanner fallback knows nothing
// about Python's triple-quoted strings, YAML or Markdown prose — so JS text
// quoted INSIDE a Python test fired the block. The refinement gates the scan
// on a JS/TS extension; the positives pin that nothing a JS test file can hold
// was weakened. Known gap left alone (a false NEGATIVE, out of this review's
// mandate): `isTestFile` in taste-checks-shared.ts does not recognize
// `.test.mts` / `.test.cts`, so those files are never scanned. A third pass
// (tautological_assertion.round3.probe.mts) found JSX text in `.tsx`/`.jsx`
// tests firing; the scan now blanks it with the shared `blankJsxText` (N11, N12).

import { describe, expect, it } from "vitest";
import { checkTautologicalAssertion } from "../../taste-checks-test-assertions.js";

describe("tautological_assertion — negative (must not fire)", () => {
	it("N1: a Python codegen test quoting JS inside a triple-quoted string", () => {
		const content = [
			"def test_emits_identity_check():",
			'    expected = """',
			"    it('x', () => { expect(a).toBe(a); });",
			'    """',
			"    assert emit() == expected",
		].join("\n");
		expect(checkTautologicalAssertion(content, "/repo/tests/test_codegen.py")).toEqual([]);
	});

	it("N2: a Markdown guide under tests/ naming the anti-pattern in plain prose", () => {
		// No backtick fence: nothing shields the text from the line scanner.
		const content = [
			"# Writing tests",
			"",
			"Never write expect(result).toBe(result) — it compares a value with itself.",
		].join("\n");
		expect(checkTautologicalAssertion(content, "/repo/tests/README.md")).toEqual([]);
	});

	it("N3: a plain-text lint fixture under __tests__ holding a sample tautology", () => {
		const content = 'it("x", () => { expect(a).toBe(a); });\n';
		expect(checkTautologicalAssertion(content, "/repo/src/__tests__/fixtures/bad.txt")).toEqual([]);
	});

	it("N4: a Go test whose assert.Equal grammar is not JavaScript's", () => {
		const content = ["func TestX(t *testing.T) {", "\tassert.Equal(t, a, a)", "}"].join("\n");
		expect(checkTautologicalAssertion(content, "/repo/pkg/foo_test.go")).toEqual([]);
	});

	it("N5: a snapshot file of a code printer is printed text, not an assertion", () => {
		const content = [
			"// Vitest Snapshot v1",
			"",
			"exports[`prints a tautology example 1`] = `",
			'it("x", () => { expect(a).toBe(a); });',
			"`;",
		].join("\n");
		expect(
			checkTautologicalAssertion(content, "/repo/src/__tests__/__snapshots__/printer.test.ts.snap"),
		).toEqual([]);
	});

	it("N6: a Flow-typed .test.js (TS parse fails) keeps its template-literal fixture shielded", () => {
		const content = [
			"/** @flow */",
			"type Opts = {| strict: boolean |};",
			"const src = `",
			'  it("x", () => { expect(foo).toBe(foo); });',
			"`;",
			'it("rewrites", () => { expect(codemod(src)).not.toContain("toBe(foo)"); });',
		].join("\n");
		expect(checkTautologicalAssertion(content, "/repo/src/__tests__/codemod.test.js")).toEqual([]);
	});

	it("N7: YAML and HTML fixtures under test directories quoting a JS assertion", () => {
		expect(
			checkTautologicalAssertion("- code: expect(a).toBe(a)\n", "/repo/src/__tests__/fixtures/cases.yaml"),
		).toEqual([]);
		expect(
			checkTautologicalAssertion("<script>expect(a).toBe(a)</script>", "/repo/tests/fixtures/page.html"),
		).toEqual([]);
	});

	it("N8: a Java test file (isTestFile says yes) with assert.equal(a, a) text", () => {
		const content = "assertEquals(a, a);\nassert.equal(a, a);\n";
		expect(checkTautologicalAssertion(content, "/repo/src/test/java/FooTest.java")).toEqual([]);
	});

	it("N9: a negated identity and TS operators between the operands", () => {
		const content = [
			'it("nan", () => { expect(nan).not.toBe(nan); });',
			'it("cast", () => { expect(x).toBe(x as Foo); expect(y!).toBe(y); });',
		].join("\n");
		expect(checkTautologicalAssertion(content, "/repo/src/foo.test.ts")).toEqual([]);
	});

	it("N10: the pattern as text in an assertion argument, a title template, or a trailing comment", () => {
		const content = [
			'it("x", () => { expect(out).toBe("expect(a).toBe(a)"); });',
			"it(\"y\", () => { expect(out).toBe('expect(1).toBe(1)'); });",
			"it(`rejects expect(${name}).toBe(${name})`, () => { expect(lint(src)).toHaveLength(1); });",
			'it("z", () => { expect(a).toBe(b); // never expect(a).toBe(a)',
			"});",
		].join("\n");
		expect(checkTautologicalAssertion(content, "/repo/src/foo.test.ts")).toEqual([]);
	});

	// Third pass (tautological_assertion.round3.probe.mts, 10 candidates): JSX
	// text is rendered prose that the string strippers keep by contract.
	it("N11: JSX text in a docs-component test naming an identifier or literal tautology", () => {
		const inline = [
			'it("tip", () => { render(<Tip>Never write expect(a).toBe(a)</Tip>); expect(screen.getByRole("note")).toBeVisible(); });',
			'it("rule", () => { render(<Rule>expect(1).toBe(1)</Rule>); expect(screen.getByText(/toBe/)).toBeTruthy(); });',
		].join("\n");
		expect(checkTautologicalAssertion(inline, "/repo/src/Snippet.test.tsx")).toEqual([]);
	});

	it("N12: multi-line JSX text holding assert(true) in a .test.jsx highlighter test", () => {
		const content = [
			'it("highlights", () => {',
			"\trender(",
			'\t\t<Code lang="js">',
			"\t\t\tassert(true)",
			"\t\t</Code>,",
			"\t);",
			'\texpect(screen.getByText("assert")).toHaveClass("kw");',
			"});",
		].join("\n");
		expect(checkTautologicalAssertion(content, "/repo/src/Code.test.jsx")).toEqual([]);
	});
});

describe("tautological_assertion — positive (must fire)", () => {
	it("P1: still fires on a real tautology in every JS/TS test extension the predicate recognizes", () => {
		const content = 'it("x", () => { expect(foo).toBe(foo); });';
		for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
			expect(checkTautologicalAssertion(content, `/repo/src/foo.test${ext}`)).toHaveLength(1);
		}
	});

	it("P2: still fires on a tautology in a JS file under a tests/ directory", () => {
		const content = 'it("x", () => { assert.equal(a, a); });';
		expect(checkTautologicalAssertion(content, "/repo/tests/foo.js")).toHaveLength(1);
	});

	it("P3: still fires on a literal tautology and constant truthiness", () => {
		const content = ['it("x", () => { expect(1).toBe(1); });', 'it("y", () => { expect(true).toBeTruthy(); });'].join(
			"\n",
		);
		expect(checkTautologicalAssertion(content, "/repo/src/foo.test.ts")).toHaveLength(2);
	});

	it("P4: still fires on a member-expression tautology (the same getter read twice)", () => {
		const content = 'it("memo", () => { expect(store.items).toBe(store.items); });';
		expect(checkTautologicalAssertion(content, "/repo/src/memo.test.ts")).toHaveLength(1);
	});

	it("P5: a JSX file still fires on a real tautology beside rendered JSX and comparison operators", () => {
		const content = [
			'it("x", () => {',
			"\texpect(a).toBe(a);",
			"\trender(<p>ok</p>);",
			"\tif (a < b) { expect(x).toBe(x); } else if (c > d) {}",
			"});",
		].join("\n");
		expect(checkTautologicalAssertion(content, "/repo/src/Snippet.test.tsx")).toHaveLength(2);
	});

	it("P6: a .test.ts type assertion <Foo>a is not read as JSX", () => {
		const content = 'it("cast", () => { expect(a).toBe(a); const b = <Foo>a; });';
		expect(checkTautologicalAssertion(content, "/repo/src/cast.test.ts")).toHaveLength(1);
	});
});
