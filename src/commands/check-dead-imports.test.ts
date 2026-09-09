import { describe, expect, it, vi } from "vitest";
import * as ast from "../harness/checks/cyclomatic-ast.js";

import { extractBindings, findDeadImports } from "./check-dead-imports.js";

describe("findDeadImports", () => {
    it("does not call an annotated, used import dead", () => {
        const content = "import { /* tree-shaking no-side-effects-when-called */ isOneOf } from './isOneOf.js';\nexport const nullable = isOneOf(isNull, isUndefined);";
        expect(findDeadImports(content)).toEqual([]);
    });

    it("extracts real aliases when comments contain commas, braces and as", () => {
        const content = "import { /* }, fake as wrong */ original as Used, /* explain */ Unused } from './source';\nconsole.log(Used);";
        expect(findDeadImports(content)).toEqual(["Unused"]);
    });
	it.each([
		["blank line", ""],
		["JSDoc continuation", "* documentation"],
		["block-comment opener", "/* documentation"],
		["block-comment closer", "*/ documentation"],
		["shebang", "#!/usr/bin/env node"],
	])("keeps scanning imports after a %s prefix line", (_label, prefix) => {
		const content = [
			"import { First } from './first';",
			prefix,
			"import { Second } from './second';",
			"",
		].join("\n");

		expect(findDeadImports(content)).toEqual(["First", "Second"]);
	});

	it("distinguishes a prefix that starts with a marker from one that merely ends with it", () => {
		const content = [
			"import { Star } from './star';",
			"* documentation", // startsWith("*") but does not endWith("*")
			"import { Open } from './open';",
			"/* documentation", // startsWith("/*") but does not endWith("/*")
			"import { Close } from './close';",
			"*/ documentation", // startsWith("*/") but does not endWith("*/")
			"import { Bang } from './bang';",
			"",
		].join("\n");

		expect(findDeadImports(content)).toEqual(["Star", "Open", "Close", "Bang"]);
	});

	it("requires the buffered import terminator and preserves the buffer reset", () => {
		const content = [
			"import { Used }",
			"from './source';",
			"console.log(Used);",
		].join("\n");

		expect(findDeadImports(content)).toEqual([]);
	});

	it("uses a quote in a buffered line as the completion signal", () => {
		const content = [
			"import { Dead",
			"  'documentation",
			"} from './source';",
		].join("\n");

		// The scanner intentionally treats any quote as enough evidence that the
		// buffered import reached its module specifier. This also distinguishes
		// the OR from a mutated AND in that completion condition.
		expect(findDeadImports(content)).toEqual([]);
	});

	it("recognizes multiple spaces around the buffered from clause", () => {
		const content = [
			"import { Used",
			"} from   './source';",
			"console.log(Used);",
		].join("\n");

		expect(findDeadImports(content)).toEqual([]);
	});

	it("ignores import-looking text after the import section ends", () => {
		const content = [
			"import { Used } from './source';",
			"const value = 1;",
			"import { NotAnImport } from './ignored';",
			"console.log(Used);",
		].join("\n");

		expect(findDeadImports(content)).toEqual([]);
	});

	it("does not let non-import text enter the multiline-import branches", () => {
		const content = [
			"import { Used } from './source';",
			"not import {",
			"} from './ignored';",
			"console.log(Used);",
		].join("\n");

		expect(findDeadImports(content)).toEqual([]);
	});

	it("handles an ordinary single-line import and its used binding", () => {
		expect(findDeadImports("import { Used } from './source';\nconsole.log(Used);")).toEqual([]);
	});

	it("strips an inline comment before deciding whether a buffered import is complete", () => {
		const content = [
			"import { Dead",
			"// \"quoted comment\"",
			"} from './source';",
		].join("\n");

		expect(findDeadImports(content)).toEqual(["Dead"]);
	});

	it("treats a comment replacement as an empty prefix line", () => {
		const content = [
			"// comment",
			"import { Dead } from './source';",
		].join("\n");

		expect(findDeadImports(content)).toEqual(["Dead"]);
	});

	it("does not merge adjacent body lines when checking a binding", () => {
		const content = ["import { foo } from './source';", "fo", "o"].join("\n");

		expect(findDeadImports(content)).toEqual(["foo"]);
	});

	it("accepts a two-character binding while ignoring a one-character binding", () => {
		expect(findDeadImports("import { ab } from './source';")).toEqual(["ab"]);
		expect(findDeadImports("import { a } from './source';")).toEqual([]);
	});

	it("keeps regex metacharacters in an aliased binding escaped", () => {
		const content = "import { original as foo$bar } from './source';\nconsole.log(foo$bar);";

		expect(findDeadImports(content)).toEqual([]);
	});

	it("extracts an unterminated buffered named import at EOF", () => {
		expect(findDeadImports("import {\n  Dead,\n}")).toEqual(["Dead"]);
	});
});

describe("extractBindings", () => {
	it.each([
		["import './setup';", []],
		["import * as source from './source';", []],
		["/* documentation only */", []],
		["const value = 1; /* not an import */", []],
		["import /* startup side effects */ './setup';", []],
		["import /* package default */ Default from './source';", ["Default"]],
		["import /* type keyword */ type from './source';", []],
		["import /* namespace */ * as source from './source';", []],
		["import { /* type keyword */ type } from './source';", []],
	])("extracts only supported bindings while ignoring import trivia: %s", (content, expected) => {
		const bindings: string[] = [];
		extractBindings(content, bindings);
		expect(bindings).toEqual(expected);
	});

	it("does not invent dead bindings when the optional TypeScript parser is unavailable", () => {
		const parser = vi.spyOn(ast, "parseTsSource").mockReturnValueOnce(null);
		try {
			expect(findDeadImports("import { /* annotation */ PotentiallyUsed } from './source';\n")).toEqual([]);
		} finally {
			parser.mockRestore();
		}
	});

	it("trims the source line before parsing", () => {
		const bindings: string[] = [];

		extractBindings("   import { Foo } from './source'   ", bindings);

		expect(bindings).toEqual(["Foo"]);
	});

	it("ignores comments and non-import text without throwing", () => {
		const bindings: string[] = [];

		extractBindings("// import { Fake } from './ignored'", bindings);
		extractBindings("not an import", bindings);

		expect(bindings).toEqual([]);
	});

	it("supports extra whitespace in named and type imports", () => {
		const bindings: string[] = [];

		extractBindings("import   { Named } from './named'", bindings);
		extractBindings("import type   { Typed } from './typed'", bindings);

		expect(bindings).toEqual(["Named", "Typed"]);
	});

	it("does not report the named binding literally called type", () => {
		const bindings: string[] = [];

		extractBindings("import { type } from './source'", bindings);

		expect(bindings).toEqual([]);
	});

	it("parses aliases with flexible whitespace around as", () => {
		const bindings: string[] = [];

		extractBindings("import { original   as   Alias } from './source'", bindings);

		expect(bindings).toEqual(["Alias"]);
	});

	it("parses default imports with flexible whitespace", () => {
		const bindings: string[] = [];

		extractBindings("import   Default   from './source'", bindings);

		expect(bindings).toEqual(["Default"]);
	});

	it("does not report a default binding literally called type", () => {
		const bindings: string[] = [];

		extractBindings("import type from './source'", bindings);

		expect(bindings).toEqual([]);
	});
});
