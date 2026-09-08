import { describe, expect, it } from "vitest";
import { findUnjustifiedCasts } from "./cast-justification.js";

const FILE = "test.ts";

function findAll(content: string): ReturnType<typeof findUnjustifiedCasts> {
	return findUnjustifiedCasts(content, FILE);
}

describe("cast-justification — hasSafetyJustification lookback window (mutant kills)", () => {
	// Kills 9a08874c848127ab (Math.max -> Math.min): a SAFETY comment more than
	// 2 lines above the cast must NOT justify it — the lookback window is exactly
	// 2 lines. Math.min would let the loop walk all the way back to line 0.
	it("does not honor a SAFETY comment more than 2 lines above the cast", () => {
		const content = [
			"// SAFETY: line0 justification far above",
			"// comment",
			"// comment",
			"// comment",
			"const y = x as Foo;",
		].join("\n");
		const result = findAll(content);
		expect(result).toHaveLength(1);
		expect(result[0]?.line).toBe(5);
	});

	// Kills 9469431626fd3de8 (removes .trim() on rawLines[j]): an indented
	// SAFETY comment line must still be recognized after trimming.
	it("recognizes an indented SAFETY comment one line above the cast", () => {
		const content = ["  // SAFETY: indented justification", "const y = x as Foo;"].join("\n");
		expect(findAll(content)).toHaveLength(0);
	});

	// Kills e403d1f08757408c (startsWith("*") -> endsWith("*")): a JSDoc
	// continuation line ("* SAFETY: ...") must count as a comment-block line.
	it("recognizes a JSDoc-style '* SAFETY' continuation line", () => {
		const content = ["/**", " * SAFETY: reason", " */", "const y = x as Foo;"].join("\n");
		expect(findAll(content)).toHaveLength(0);
	});

	// Kills 75c1e70179f6e8f2 (startsWith("/*") -> endsWith("/*")): a block
	// comment opener line with SAFETY on the same line must count.
	it("recognizes a '/* SAFETY' block-comment opener line", () => {
		const content = ["/* SAFETY: reason */", "const y = x as Foo;"].join("\n");
		expect(findAll(content)).toHaveLength(0);
	});

	// Kills 47c0b2044f90af47 (SAFETY test -> true): a plain comment line with
	// no SAFETY word must NOT justify the cast.
	it("does not treat an unrelated comment line as justification", () => {
		const content = ["// just a note", "const y = x as Foo;"].join("\n");
		expect(findAll(content)).toHaveLength(1);
	});
});

describe("cast-justification — isModuleAliasLine import/export detection (mutant kills)", () => {
	// Kills 0be5a6057e30090d (import regex \s* -> \S*): an indented import
	// line's leading whitespace must still be tolerated.
	it("treats an indented import-rename line as a module alias, not a cast", () => {
		const content = '  import { Foo as Bar } from "lib";';
		expect(findAll(content)).toHaveLength(0);
	});

	// Kills 3d0ddf589366c41a (import regex loses ^ anchor): the word "import"
	// appearing later in the line (e.g. in a comment) must NOT count as an
	// import statement when the line does not start with it.
	it("does not treat a trailing comment containing 'import' as a module alias line", () => {
		const content = "const y = x as Foo; // import note";
		expect(findAll(content)).toHaveLength(1);
	});

	// Kills c588ed223c1f9643 (export-brace condition forced false),
	// f1f655d24d017941 (\s* -> \s before export), 9c8784a74de80fa1
	// (\s* -> \S* after export), and fbbe9d4c1c9cd6dc (optional type group
	// made mandatory): a plain `export { X as Y };` re-export line (no
	// leading whitespace, no "type") must be recognized as a module alias.
	it("treats a plain export-brace rename line as a module alias, not a cast", () => {
		const content = "export { Foo as Bar };";
		expect(findAll(content)).toHaveLength(0);
	});

	// Kills 5feb3e86251c4c11 (export-brace regex loses ^ anchor): the text
	// "export {" appearing later in a comment must NOT count.
	it("does not treat a trailing comment containing 'export {' as a module alias line", () => {
		const content = "const y = x as Foo; // export { Bar }";
		expect(findAll(content)).toHaveLength(1);
	});

	// Kills f3af28b876159ecb (\s* -> \S* at the very start of the export-brace
	// regex): a genuinely indented export-brace line must still match.
	it("treats an indented export-brace rename line as a module alias", () => {
		const content = "  export { Foo as Bar };";
		expect(findAll(content)).toHaveLength(0);
	});

	// Kills 5ed67954591cc4f2 (\s* -> \s between export and the brace/type
	// group): zero whitespace between "export" and "{" must still match.
	it("treats an export-brace line with no space before the brace as a module alias", () => {
		const content = "export{ Foo as Bar };";
		expect(findAll(content)).toHaveLength(0);
	});

	// Kills baaef84d09b0e9ae (\s+ -> \s after "type") and 703166cd9f90e3ce
	// (\s+ -> \S+ after "type"): multiple spaces between "type" and the
	// brace must still match via the one-or-more whitespace quantifier.
	it("treats an 'export type' rename line with extra spacing as a module alias", () => {
		const content = "export type  { Foo as Bar };";
		expect(findAll(content)).toHaveLength(0);
	});

	// Kills da2af95988d6aaba (from-clause condition forced false) and
	// 68caaaff53b7a76f (\s* -> \s before "export" in the from-clause's own
	// export regex): a re-export-with-rename line, no leading whitespace.
	it("treats a re-export-with-rename 'from' line as a module alias", () => {
		const content = 'export { Foo as Bar } from "lib";';
		expect(findAll(content)).toHaveLength(0);
	});

	// Kills 3e2b7c2b4440793a (&& -> || around the trailing !includes("=")
	// clause), 9d39c97cd222f1c6 (export&&from sub-expression forced true),
	// and 1c10cb525fcc9eed (&& -> || between export and from): a line that
	// starts with "export" and has no "from" and no "=" must NOT be treated
	// as a module alias purely because it lacks an "=" sign.
	it("does not treat an export line without 'from' as a module alias merely for lacking '='", () => {
		const content = "export default Foo as Bar;";
		expect(findAll(content)).toHaveLength(1);
	});

	// Kills a5dd049fd7fee4e1 (from-clause's export regex loses ^ anchor): the
	// word "export" appearing later (in a comment) must not count.
	it("does not treat a trailing comment containing 'export ... from' as a module alias line", () => {
		const content = 'const y = x as Foo; // export from "lib"';
		expect(findAll(content)).toHaveLength(1);
	});

	// Kills 8aff0ba6fc16f316 (from-clause's export regex \s* -> \S* at start):
	// genuine leading whitespace before "export" must still be tolerated.
	it("treats an indented re-export-with-rename 'from' line as a module alias", () => {
		const content = '  export { Foo as Bar } from "lib";';
		expect(findAll(content)).toHaveLength(0);
	});
});

describe("cast-justification — match object construction (mutant kills)", () => {
	// Kills a9fb85b40875d84f (match object replaced with {}) and
	// f6e9fbae4998c561 (i + 1 -> i - 1): the reported line number is
	// 1-indexed and the text field carries the real trimmed line.
	it("reports the correct 1-indexed line number and text for an unjustified cast", () => {
		const content = ["// header comment", "const z = y as Something;"].join("\n");
		const result = findAll(content);
		expect(result).toHaveLength(1);
		expect(result[0]?.line).toBe(2);
		expect(result[0]?.text).toBe("const z = y as Something;");
	});

	// Kills 09cea0a8eb873f7e (removes .slice(0, 150)): the reported text is
	// truncated to 150 characters.
	it("truncates a long unjustified-cast line to 150 characters", () => {
		const pad = "x".repeat(200);
		const line = `const ${pad} = value as SomeType;`;
		const result = findAll(line);
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toHaveLength(150);
		expect(result[0]?.text).toBe(line.slice(0, 150));
	});

	// Kills 15e4e28e82d2a928 (raw.trim() -> raw, dropping the trim before
	// slicing): leading whitespace must not survive into the reported text.
	it("trims leading whitespace from the reported cast line text", () => {
		const content = "   const q = w as Thing;";
		const result = findAll(content);
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toBe("const q = w as Thing;");
	});
});

describe("cast-justification — CAST_RE whitespace requirement (mutant kills)", () => {
	// Kills d052b5daf99c93c1 (\s+ -> \s after "as"): multiple spaces between
	// "as" and the type name must still be recognized as a cast, via the
	// one-or-more whitespace quantifier.
	it("recognizes a cast with multiple spaces between 'as' and the type name", () => {
		const content = "const y = x as   Foo;";
		expect(findAll(content)).toHaveLength(1);
	});
});
