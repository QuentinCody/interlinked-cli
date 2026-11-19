// Smoke tests for project-graph/parser-imports.ts.

import { describe, expect, it } from "vitest";
import { parseImports } from "./parser-imports.js";

describe("parser-imports (smoke)", () => {
	it("exports a function", () => {
		expect(typeof parseImports).toBe("function");
	});

	it("returns an empty array for files with no imports", () => {
		expect(parseImports("const x = 1", "/tmp/foo.ts")).toEqual([]);
	});

	it("extracts a named import with symbols", () => {
		const out = parseImports(`import { foo, bar } from "./baz.js"`, "/tmp/src.ts");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			fromFile: "/tmp/src.ts",
			specifier: "./baz.js",
			symbols: ["foo", "bar"],
		});
	});

	it("marks type-only imports", () => {
		const out = parseImports(`import type { Foo } from "./foo.js"`, "/tmp/src.ts");
		expect(out[0]?.isTypeOnly).toBe(true);
	});

	it("handles require() calls", () => {
		const out = parseImports(`const x = require("./x.js")`, "/tmp/src.ts");
		expect(out).toHaveLength(1);
		expect(out[0]?.specifier).toBe("./x.js");
	});

	it("captures destructured symbols from an awaited dynamic import", () => {
		const out = parseImports(
			'const { telemetryShowCommand } = await import("./commands/telemetry.js");',
			"/tmp/src/index.ts",
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			fromFile: "/tmp/src/index.ts",
			specifier: "./commands/telemetry.js",
			symbols: ["telemetryShowCommand"],
			isTypeOnly: false,
		});
	});

	it("captures multiple destructured symbols from a dynamic import", () => {
		const out = parseImports(
			'const { checkpointListCommand, checkpointShowCommand } = await import("./commands/checkpoint.js");',
			"/tmp/src/index.ts",
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.symbols).toEqual(["checkpointListCommand", "checkpointShowCommand"]);
		expect(out[0]?.specifier).toBe("./commands/checkpoint.js");
	});

	it("captures renamed destructured symbols by their export name", () => {
		const out = parseImports(
			'const { originalName: localAlias } = await import("./mod.js");',
			"/tmp/src.ts",
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.symbols).toEqual(["originalName"]);
	});

	it("records namespace-style dynamic imports with empty symbols", () => {
		const out = parseImports(
			'const mod = await import("./commands/completions.js");',
			"/tmp/src/index.ts",
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			specifier: "./commands/completions.js",
			symbols: [],
			isTypeOnly: false,
		});
	});

	it("records non-awaited dynamic namespace imports", () => {
		const out = parseImports('const mod = import("./mod.js");', "/tmp/src.ts");
		expect(out).toHaveLength(1);
		expect(out[0]?.specifier).toBe("./mod.js");
		expect(out[0]?.symbols).toEqual([]);
	});

	it("accepts let and var destructures as well as const", () => {
		const outLet = parseImports('let { foo } = await import("./x.js");', "/tmp/src.ts");
		const outVar = parseImports('var { bar } = await import("./y.js");', "/tmp/src.ts");
		expect(outLet[0]?.symbols).toEqual(["foo"]);
		expect(outVar[0]?.symbols).toEqual(["bar"]);
	});

	it("still matches bare dynamic imports (no assignment)", () => {
		const out = parseImports('void import("./side-effect.js");', "/tmp/src.ts");
		expect(out).toHaveLength(1);
		expect(out[0]?.specifier).toBe("./side-effect.js");
		expect(out[0]?.symbols).toEqual([]);
	});

	it("does not match dynamic imports inside string literals", () => {
		const content = "const code = 'const { x } = await import(\"./nope.js\")';";
		const out = parseImports(content, "/tmp/src.ts");
		expect(out).toEqual([]);
	});

	it("parses static and dynamic imports side by side", () => {
		const content = [
			'import { staticSym } from "./static.js";',
			"export async function load() {",
			'  const { dynSym } = await import("./dyn.js");',
			"  return dynSym;",
			"}",
		].join("\n");
		const out = parseImports(content, "/tmp/src.ts");
		expect(out).toHaveLength(2);
		const byPath = Object.fromEntries(out.map((e) => [e.specifier, e]));
		expect(byPath["./static.js"]?.symbols).toEqual(["staticSym"]);
		expect(byPath["./dyn.js"]?.symbols).toEqual(["dynSym"]);
	});
});

// Mutation-coverage cases: exact-output regression fixtures targeting the
// specific regex/boundary/loop decisions that a smoke-level suite doesn't
// exercise (see docs/design/per-edit-cloud-mutation-testing.md context —
// this file is parsed by structural-checks, so a silent parsing bug here
// degrades several downstream systems rather than failing loudly).
describe("parser-imports (mutation coverage)", () => {
	describe("string-literal detection boundaries", () => {
		it("treats a quote at the very start of the scanned text as opening an unterminated literal", () => {
			// lastQuote===0: the only quote before "require(" sits at index 0 of
			// the text handed to isInsideStringLiteral.
			const out = parseImports('\'aaarequire("./x.js")', "/tmp/x.ts");
			expect(out).toEqual([]);
		});

		it("scopes detection to the nearest preceding quote, not the whole line", () => {
			// A CLOSED pair ('ab') earlier on the line still marks require( as
			// embedded, because the heuristic only inspects the last quote before
			// the keyword — this pins that (documented, conservative) behavior.
			const out = parseImports("'ab'crequire(\"./x.js\")", "/tmp/x.ts");
			expect(out).toEqual([]);
		});

		it("skips a require() genuinely embedded in a string literal", () => {
			const content = 'const code = \'const x = require("./nope.js")\';';
			expect(parseImports(content, "/tmp/x.ts")).toEqual([]);
		});

		it("parses a real require() call that opens the line (reqIdx === 0)", () => {
			const out = parseImports('require("./bare.js");', "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./bare.js", symbols: [], isTypeOnly: false },
			]);
		});
	});

	describe("template-literal / multi-line collapsing", () => {
		it("collapses a 3-line named import into one edge with symbols in order", () => {
			const content = ["import {", "  fooooo,", "  barrrr", '} from "./multi.js"'].join("\n");
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{
					fromFile: "/tmp/x.ts",
					specifier: "./multi.js",
					symbols: ["fooooo", "barrrr"],
					isTypeOnly: false,
				},
			]);
		});

		it("does not mistake an import-shaped string inside a multi-line template literal for a real import", () => {
			const content = [
				"const s = `",
				'import { fake } from "./fake.js"',
				"`;",
				'import { real } from "./real.js"',
			].join("\n");
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./real.js", symbols: ["real"], isTypeOnly: false },
			]);
		});

		it("does not toggle multi-line template state on an escaped backtick", () => {
			// Two real (unescaped) backticks on one line — even count, so the
			// template stays single-line and the next line parses normally.
			const content = [
				"const t = `line with \\` escaped backtick`;",
				'import { c } from "./c.js"',
			].join("\n");
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./c.js", symbols: ["c"], isTypeOnly: false },
			]);
		});
	});

	describe("named-import regex boundaries", () => {
		it("matches through extra whitespace around every token, and marks type-only", () => {
			const out = parseImports('import  type  { Foo }  from  "./foo.js"', "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./foo.js", symbols: ["Foo"], isTypeOnly: true },
			]);
		});

		it("does not match a named-import fragment that isn't anchored at line start", () => {
			const content = 'noop(); import("./real.js"); import { a } from "./fake.js";';
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./real.js", symbols: [], isTypeOnly: false, isDynamic: true },
			]);
		});
	});

	describe("default-import regex boundaries", () => {
		it("matches a type-only default import through extra whitespace", () => {
			const out = parseImports('import  type  Foo  from  "./foo.js"', "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./foo.js", symbols: ["default"], isTypeOnly: true },
			]);
		});
	});

	describe("namespace-import regex boundaries", () => {
		it("matches `import * as name` through extra whitespace around every token", () => {
			const out = parseImports('import  *  as  mod  from  "./mod.js"', "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./mod.js", symbols: [], isTypeOnly: false },
			]);
		});
	});

	describe("side-effect import regex boundaries", () => {
		it("matches a bare side-effect import through extra whitespace", () => {
			const out = parseImports('import  "./side.js"', "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./side.js", symbols: [], isTypeOnly: false },
			]);
		});
	});

	describe("named-symbol parsing (type/as stripping)", () => {
		it("strips type prefixes and as-aliases through extra whitespace, keeping export names in order", () => {
			const content = 'import { type  A  as  B, C, type  D  as  E } from "./m.js"';
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{
					fromFile: "/tmp/x.ts",
					specifier: "./m.js",
					symbols: ["A", "C", "D"],
					isTypeOnly: false,
				},
			]);
		});
	});

	describe("destructured dynamic-import symbol parsing", () => {
		it("takes the export-side name for every renamed entry, in order", () => {
			const content = 'const { a: b, c: d } = await import("./m.js")';
			const out = parseImports(content, "/tmp/x.ts");
			expect(out[0]?.symbols).toEqual(["a", "c"]);
		});

		it("splits an unspaced rename target (a:b) on the colon boundary", () => {
			const content = 'const { a:b } = await import("./m.js")';
			const out = parseImports(content, "/tmp/x.ts");
			expect(out[0]?.symbols).toEqual(["a"]);
		});
	});

	describe("destructured dynamic-import regex boundaries", () => {
		it("matches a non-awaited destructured dynamic import", () => {
			const out = parseImports('const { x } = import("./mod.js")', "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./mod.js", symbols: ["x"], isTypeOnly: false, isDynamic: true },
			]);
		});

		it("matches with a space between the opening paren and the quote", () => {
			const out = parseImports('const { x } = await import( "./mod.js")', "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./mod.js", symbols: ["x"], isTypeOnly: false, isDynamic: true },
			]);
		});

		it("does not match a destructured-import fragment that isn't anchored at line start", () => {
			const content = 'doStuff(); const { x } = await import("./fake.js");';
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./fake.js", symbols: [], isTypeOnly: false, isDynamic: true },
			]);
		});
	});

	describe("namespace dynamic-import regex boundaries", () => {
		it("does not match a namespace dynamic-import fragment that isn't anchored at line start", () => {
			const content = 'void import("./first.js"); const y = await import("./second.js");';
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./first.js", symbols: [], isTypeOnly: false, isDynamic: true },
			]);
		});
	});

	describe("comment stripping / line-skip logic", () => {
		it("does not leak an import-shaped fragment out of a whole-line comment", () => {
			const content = [
				'// import { fake } from "./fake.js"',
				'import { real } from "./real.js";',
			].join("\n");
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./real.js", symbols: ["real"], isTypeOnly: false },
			]);
		});

		it("skips a require() embedded in a string on a line that ends with the literal word import", () => {
			const content = "'q'require(\"./z.js\");import";
			expect(parseImports(content, "/tmp/x.ts")).toEqual([]);
		});

		it("produces no entry for a malformed import line that matches neither static nor dynamic form", () => {
			expect(parseImports("import somethingWeird", "/tmp/x.ts")).toEqual([]);
		});

		it("does not mark a real named import type-only because of a later import-type fragment on the same line", () => {
			const content = 'import { a } from "./a.js"; import type X from "./b.js"';
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./a.js", symbols: ["a"], isTypeOnly: false },
			]);
		});

		it("finds a require() left unstripped by a broken comment strip, on an otherwise-malformed import line", () => {
			// If comment-stripping were skipped, the unanchored require() regex
			// would find this fake call sitting in the trailing comment.
			const content = 'import somethingMalformed // require("./fake.js")';
			expect(parseImports(content, "/tmp/x.ts")).toEqual([]);
		});
	});

	describe("collapseImportLines backtick-count fallback and trim", () => {
		it("does not let a backtick-free line spuriously toggle multi-line template state", () => {
			const content = 'const x = 5;\nimport { a } from "./a.js"';
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./a.js", symbols: ["a"], isTypeOnly: false },
			]);
		});

		it("recognizes an indented multi-line named import as a buffer start", () => {
			const content = ["function f() {", "  import {", "    a,", '  } from "./ind.js";', "}"].join(
				"\n",
			);
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./ind.js", symbols: ["a"], isTypeOnly: false },
			]);
		});
	});

	describe("collapseImportLines buffer-start and buffer-flush conditions", () => {
		it("does not buffer a non-import brace line (object literal) as a multi-line import", () => {
			const content = ["const obj = {", "  foo: 1", "};", 'import { a } from "./a.js"'].join(
				"\n",
			);
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./a.js", symbols: ["a"], isTypeOnly: false },
			]);
		});

		it("flushes the buffer only once both a quoted value and 'from' are present, not on bare quotes alone", () => {
			// Pins current (quirky) behavior: a quoted default value on a
			// continuation line, before "from" ever appears, breaks this
			// multi-line named import — the whole thing parses to nothing.
			const content = ["import {", '  a = "default",', "  b", '} from "./m.js"'].join("\n");
			expect(parseImports(content, "/tmp/x.ts")).toEqual([]);
		});

		it("resets the buffer to empty after a flush, not to leftover text", () => {
			const content = [
				"import {",
				"  a",
				'} from "./first.js"',
				'import { b } from "./second.js"',
			].join("\n");
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./first.js", symbols: ["a"], isTypeOnly: false },
				{ fromFile: "/tmp/x.ts", specifier: "./second.js", symbols: ["b"], isTypeOnly: false },
			]);
		});
	});

	describe("named-symbol type-prefix stripping is anchored", () => {
		it("does not strip a mid-word 'type ' occurrence from a symbol name", () => {
			// The strip regex is anchored (^type\s+) — it must not touch "type "
			// appearing inside a later word like "subtype".
			const out = parseImports('import { subtype value } from "./m.js"', "/tmp/x.ts");
			expect(out[0]?.symbols).toEqual(["subtype value"]);
		});

		// test-contract: boundary — /^type\s+/ must consume the FULL run of
		// whitespace after "type", not just one character. A weakened \s
		// (single-char) quantifier leaves one leading space behind; that
		// space then satisfies the as-split's OWN leading \s+ on its own,
		// so the split point shifts left by one whitespace char and real
		// content that should precede "as" is swallowed into the delimiter
		// instead of surviving as symbols[0].
		it("strips a multi-space 'type' prefix in full, not just a single whitespace char", () => {
			const out = parseImports('import {type  as  asx  } from "./m.js"', "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./m.js", symbols: ["as  asx"], isTypeOnly: false },
			]);
		});
	});

	describe("further anchor-drop regressions (default / namespace / side-effect imports)", () => {
		it("does not match a default-import fragment that isn't anchored at line start", () => {
			const content = 'noop(); import("./real.js"); import Foo from "./fake.js";';
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./real.js", symbols: [], isTypeOnly: false, isDynamic: true },
			]);
		});

		it("does not match a namespace-import fragment that isn't anchored at line start", () => {
			const content = 'noop(); import("./real2.js"); import * as mod from "./fake2.js";';
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./real2.js", symbols: [], isTypeOnly: false, isDynamic: true },
			]);
		});

		it("does not match a side-effect import fragment that isn't anchored at line start", () => {
			const content = 'noop(); import("./real3.js"); import "./fake3.js";';
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./real3.js", symbols: [], isTypeOnly: false, isDynamic: true },
			]);
		});
	});

	describe("destructured dynamic-import regex boundaries (all quantifier positions at once)", () => {
		it("matches through extra whitespace at every quantified position", () => {
			const content = 'const  { xx }  =  await  import(  "./dd.js"  )';
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./dd.js", symbols: ["xx"], isTypeOnly: false, isDynamic: true },
			]);
		});
	});

	describe("parseDestructuredSymbols drops empty entries", () => {
		it("filters out the empty entry produced by a trailing comma", () => {
			const out = parseImports('const { a, } = await import("./m.js")', "/tmp/x.ts");
			expect(out[0]?.symbols).toEqual(["a"]);
		});
	});

	describe("namespace dynamic-import regex boundaries (all quantifier positions at once)", () => {
		// The destructured-dynamic-import form already has an equivalent
		// all-quantifiers test; the plain-identifier ("namespace") dynamic
		// import form did not, so every \s+/\s* boundary in that regex
		// (after const/let/var, around =, after await, inside the parens)
		// stayed unpinned. Because the identifier itself is discarded from
		// the output either way, a single space at each of those spots
		// leaves the fallback bare-`import(...)` regex able to mask a
		// broken boundary; only interior parens whitespace defeats that
		// fallback too, which is why every \s spot here uses two spaces.
		it("matches through extra whitespace at every quantified position (no await)", () => {
			const out = parseImports("const  modSpacey  =  import(  'modSpacey'  );", "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "modSpacey", symbols: [], isTypeOnly: false, isDynamic: true },
			]);
		});

		it("matches through extra whitespace at every quantified position (with await)", () => {
			const out = parseImports("const mod2 = await  import(  'module2'  );", "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "module2", symbols: [], isTypeOnly: false, isDynamic: true },
			]);
		});
	});

	describe("default-import regex keeps the 'type' keyword optional", () => {
		it("matches a plain (non-type) default import", () => {
			// The existing default-import coverage only exercises the
			// type-only form (`import type Foo from …`), so a mutation that
			// makes the `(?:type\s+)?` group MANDATORY still passed every
			// existing case — this pins the plain form the group is meant
			// to make optional.
			const out = parseImports("import Foo from './foo';", "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./foo", symbols: ["default"], isTypeOnly: false },
			]);
		});
	});

	describe("isInsideStringLiteral backslash-run direction", () => {
		it("counts the backslash run immediately BEFORE the matched quote, not after", () => {
			// Only one quote precedes "require(" here (the backtick is a
			// different quote kind, so it never becomes `lastQuote`), and
			// that quote is immediately followed by one backslash. The
			// escape-parity loop must walk backward (j = i - 1, j--) from
			// the quote to see that backslash; walking forward instead
			// finds the (non-backslash) content after "require(" and
			// misreports the quote as unescaped/closed.
			const out = parseImports('bbbb`\\require("./z.js")', "/tmp/x.ts");
			expect(out).toEqual([]);
		});
	});

	describe("comment-skip applies even when the comment text itself contains require(/import(", () => {
		it("does not parse a require() call that only exists inside a // comment", () => {
			// The comment-skip check only fires after a line has already
			// survived the initial "does this look import-related" filter —
			// which it does here, because "require(" appears in the comment
			// text. This reaches the `startsWith("//")` skip that the
			// existing whole-line-comment test (using a fake `import {…}`
			// comment) never reaches, because that one is filtered out one
			// step earlier.
			const out = parseImports("// x = require('y');", "/tmp/x.ts");
			expect(out).toEqual([]);
		});

		it("does not parse an import() call that only exists inside a // comment", () => {
			const out = parseImports("// x = import('y');", "/tmp/x.ts");
			expect(out).toEqual([]);
		});
	});

	// collapseImportLines' buffer-flush test (line ~70) is
	// `/from\s+['"][^'"]+['"]/.test(buffer) || /['"][^'"]+['"]/.test(buffer)`.
	// Every case below plants a decoy on the FIRST continuation line that must
	// NOT satisfy either regex (so the buffer keeps accumulating past it), then
	// closes with a real `} from "./m.js"` on the last line. A weakened first
	// regex fires on the decoy line instead, flushing the buffer early and
	// splitting the accumulated text into two dead (unparseable) fragments —
	// collapsing the whole result to `[]` instead of the one real edge below.
	describe("collapseImportLines flush-regex precision (early-flush decoys)", () => {
		it("does not flush on a 'from' keyword with no opening quote after it (open-quote class must require an actual quote)", () => {
			const content = ["import {", '  from XY"', '} from "./m.js"'].join("\n");
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{
					fromFile: "/tmp/x.ts",
					specifier: "./m.js",
					symbols: ['from XY"'],
					isTypeOnly: false,
				},
			]);
		});

		it("does not flush on quote characters standing in for the quoted body (body class must require NON-quote content)", () => {
			const content = ["import {", "  from '''", '} from "./m.js"'].join("\n");
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{
					fromFile: "/tmp/x.ts",
					specifier: "./m.js",
					symbols: ["from '''"],
					isTypeOnly: false,
				},
			]);
		});

		it("does not flush on an opening quote with no closing quote (closing-quote class must require an actual quote)", () => {
			const content = ["import {", "  from 'xy", '} from "./m.js"'].join("\n");
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{
					fromFile: "/tmp/x.ts",
					specifier: "./m.js",
					symbols: ["from 'xy"],
					isTypeOnly: false,
				},
			]);
		});

		it("does not flush on an unpaired quote with no 'from' anywhere (the 'from' literal in the first regex is load-bearing)", () => {
			const content = ["import {", "  aXY'", '} from "./m.js"'].join("\n");
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{
					fromFile: "/tmp/x.ts",
					specifier: "./m.js",
					symbols: ["aXY'"],
					isTypeOnly: false,
				},
			]);
		});

		it("does not flush on an unpaired quote via the bare-quote alternative either (its closing-quote class must require an actual quote)", () => {
			const content = ["import {", "  'abc", '} from "./m.js"'].join("\n");
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{
					fromFile: "/tmp/x.ts",
					specifier: "./m.js",
					symbols: ["'abc"],
					isTypeOnly: false,
				},
			]);
		});
	});

	describe("parseDestructuredSymbols rename-split is not bypassable", () => {
		it("still splits on the colon when the rename has no surrounding whitespace at all", () => {
			// Regression net for the colon-split step: asserts the export-side
			// name alone survives, not the raw "a:b" segment, across several
			// spacing shapes so a mutant collapsing the split-then-take-[0]
			// chain down to the raw segment cannot pass by matching only one
			// shape.
			const out = parseImports('const { a:b } = await import("./m1.js")', "/tmp/x.ts");
			expect(out[0]?.symbols).toEqual(["a"]);
		});

		it("splits on the colon with heavy internal spacing on both sides", () => {
			const out = parseImports('const { a  :  b } = await import("./m2.js")', "/tmp/x.ts");
			expect(out[0]?.symbols).toEqual(["a"]);
		});

		it("splits every entry in a multi-symbol rename list, not just the first", () => {
			const out = parseImports(
				'const { first: renamedFirst, second: renamedSecond } = await import("./m3.js")',
				"/tmp/x.ts",
			);
			expect(out[0]?.symbols).toEqual(["first", "second"]);
		});
	});

	describe("collapseImportLines buffer-start does not re-open on an already-complete import", () => {
		it("keeps two consecutive complete single-line named imports as two separate edges", () => {
			const content = ['import { a } from "./m.js"', 'import { b } from "./n.js"'].join("\n");
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./m.js", symbols: ["a"], isTypeOnly: false },
				{ fromFile: "/tmp/x.ts", specifier: "./n.js", symbols: ["b"], isTypeOnly: false },
			]);
		});

		it("keeps a complete single-line named import separate from a following default import", () => {
			const content = ['import { a } from "./m.js"', 'import Def from "./def.js"'].join("\n");
			const out = parseImports(content, "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./m.js", symbols: ["a"], isTypeOnly: false },
				{ fromFile: "/tmp/x.ts", specifier: "./def.js", symbols: ["default"], isTypeOnly: false },
			]);
		});
	});

	describe("isStringEmbeddedKeyword only fires when a keyword is genuinely preceded by a quote", () => {
		it("parses a require() call reached with zero quote characters anywhere earlier on the line", () => {
			const out = parseImports('if (cond) require("./real.js")', "/tmp/x.ts");
			expect(out).toEqual([
				{ fromFile: "/tmp/x.ts", specifier: "./real.js", symbols: [], isTypeOnly: false },
			]);
		});

		it("parses a dynamic import() call reached with zero quote characters anywhere earlier on the line", () => {
			const out = parseImports('if (cond) { x = import("./real2.js"); }', "/tmp/x.ts");
			expect(out).toEqual([
				{
					fromFile: "/tmp/x.ts",
					specifier: "./real2.js",
					symbols: [],
					isTypeOnly: false,
					isDynamic: true,
				},
			]);
		});
	});
});

describe("parseImports — default imports, inline type specifiers, comments, dynamic edges", () => {
	describe("A1 positive: default imports record the export name", () => {
		it("P1: a default import is recorded as the export name 'default', not the local binding", () => {
			const out = parseImports(`import App from "./App"`, "/tmp/x.ts");
			expect(out).toHaveLength(1);
			expect(out[0]?.symbols).toEqual(["default"]);
		});

		it("P2: `import X, { a, b as c } from` records default plus the named export names", () => {
			const out = parseImports(`import X, { a, b as c } from "./m"`, "/tmp/x.ts");
			expect(out).toHaveLength(1);
			expect(out[0]).toMatchObject({ specifier: "./m", symbols: ["default", "a", "b"] });
		});

		it("P3: `import X, * as ns from` records only the default", () => {
			const out = parseImports(`import X, * as ns from "./m"`, "/tmp/x.ts");
			expect(out[0]).toMatchObject({ specifier: "./m", symbols: ["default"] });
		});
	});

	describe("A4 positive: runtime edges must stay runtime", () => {
		it("P4: a mixed inline clause `{ type A, b }` stays a runtime edge", () => {
			const out = parseImports(`import { type A, b } from "./m"`, "/tmp/x.ts");
			expect(out[0]).toMatchObject({ symbols: ["A", "b"], isTypeOnly: false });
		});

		it("P5: a default plus an inline type specifier stays a runtime edge", () => {
			const out = parseImports(`import X, { type A } from "./m"`, "/tmp/x.ts");
			expect(out[0]?.isTypeOnly).toBe(false);
		});

		it("P6: an awaited import() is flagged isDynamic but stays an edge", () => {
			const out = parseImports(`const m = await import("./user.js");`, "/tmp/x.ts");
			expect(out).toHaveLength(1);
			expect(out[0]).toMatchObject({ specifier: "./user.js", isDynamic: true });
		});

		it("P7: a destructured and a bare import() are flagged isDynamic", () => {
			const out = parseImports(
				['const { a } = await import("./a.js");', 'load(() => import("./b.js"));'].join("\n"),
				"/tmp/x.ts",
			);
			expect(out.map((e) => e.isDynamic)).toEqual([true, true]);
		});

		it("P8: a static import and require() carry no isDynamic flag", () => {
			const out = parseImports(`import { a } from "./a.js"\nconst b = require("./b.js")`, "/tmp/x.ts");
			expect(out.map((e) => e.isDynamic)).toEqual([undefined, undefined]);
		});

		it("P9: a real import after a closed block comment is still parsed", () => {
			const out = parseImports(`/** doc */\nimport { a } from "./a.js"`, "/tmp/x.ts");
			expect(out.map((e) => e.specifier)).toEqual(["./a.js"]);
		});
	});

	describe("A4 negative: no import edge", () => {
		it("N1: JSDoc @param {import('...')} in a block comment is not an edge", () => {
			const code = ["/**", " * @param {import('../plot.js').Plot} plot", " */", "export function f(plot) {}"].join("\n");
			expect(parseImports(code, "/tmp/x.js")).toEqual([]);
		});

		it("N2: an inline JSDoc cast on a code line is not an edge", () => {
			const code = `const x = /** @type {import('./t.js').T} */ (y);`;
			expect(parseImports(code, "/tmp/x.js")).toEqual([]);
		});

		it("N3: every inline specifier `type` makes the edge type-only", () => {
			const out = parseImports(`import { type Selection, type Other } from "./Selection.js"`, "/tmp/x.ts");
			expect(out[0]).toMatchObject({ symbols: ["Selection", "Other"], isTypeOnly: true });
		});

		it("N4: a '/*' inside a string does not hide a later real import", () => {
			const code = ['const g = "src/**/*.ts";', 'import { a } from "./a.js"'].join("\n");
			expect(parseImports(code, "/tmp/x.ts").map((e) => e.specifier)).toEqual(["./a.js"]);
		});
	});
});
