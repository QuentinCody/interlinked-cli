import { describe, expect, it } from "vitest";
import {
	countAmbientSeams,
	countAsAnyCasts,
	countAssertionStrength,
	countConsoleStatements,
	countNonNullAssertions,
	countPublicApiSurface,
	countSuppressionDirectives,
	countTodoMarkers,
	countTypeDensity,
} from "./ratchet-metrics.js";

describe("Batch 7 ratchet counters", () => {
	it("counts TODO/FIXME/HACK/XXX markers", () => {
		const code = `// TODO: x\n// FIXME y\n/* HACK z */\nconst todo = 1; // not a marker comment\n`;
		expect(countTodoMarkers(code)).toBe(3);
	});

	it("does not count TODO inside string literals", () => {
		expect(countTodoMarkers(`const msg = "TODO list"; const a = 1;`)).toBe(0);
	});

	it("counts console.* statements", () => {
		const code = `console.log("a"); console.warn("b"); console.error("c"); logger.log("d");`;
		expect(countConsoleStatements(code)).toBe(3);
	});

	it("does not count console.* inside string literals", () => {
		expect(countConsoleStatements(`const s = "console.log(x)";`)).toBe(0);
	});

	it("counts exported-symbol public API surface", () => {
		const code = `
export function foo() {}
export const bar = 1;
export class Baz {}
export interface Qux {}
function notExported() {}
`;
		expect(countPublicApiSurface(code)).toBe(4);
	});

	it("dedupes same-name exports across declarations", () => {
		const code = `export const foo = 1; export type foo = string;`;
		expect(countPublicApiSurface(code)).toBe(1);
	});
});

describe("ratchet-metrics — existing counters", () => {
	it("counts `as any` casts", () => {
		expect(countAsAnyCasts("const x = a as any; const y = b as any;")).toBe(2);
		expect(countAsAnyCasts("const x = 1;")).toBe(0);
	});

	it("counts non-null assertions", () => {
		expect(countNonNullAssertions("foo!.bar; foo![0]; foo!();")).toBe(3);
		expect(countNonNullAssertions("if (x !== y) {}")).toBe(0);
	});

	it("counts suppression directives", () => {
		expect(countSuppressionDirectives("// @ts-ignore\n// eslint-disable\n")).toBe(2);
	});

	it("counts the harness's own interlinked-ignore directive", () => {
		// The self-gaming hole: interlinked-ignore fully suppresses a finding
		// (suppressions.ts) yet was not counted, so silencing via the harness's
		// own directive bypassed the ratchet that counted every third-party one.
		expect(
			countSuppressionDirectives("// interlinked-ignore: nan_coercion_guard — fixture\n"),
		).toBe(1);
		// `interlinked: defer` stays visible by design — deliberately NOT counted.
		expect(countSuppressionDirectives("// interlinked: defer complexity -- big refactor\n")).toBe(
			0,
		);
	});
});

// Coverage-ignore pragmas suppress the COVERAGE ratchet: a pragma'd line
// leaves the denominator, so an agent can raise a file's percentage without
// writing a test. They are counted here for the same reason interlinked-ignore
// is — an uncounted full-suppression directive is a free bypass.
describe("ratchet-metrics — coverage-ignore pragmas", () => {
	// test-contract: public-api — coverage-ignore counter positive (must fire)
	it("P1: an added `/* v8 ignore next */` grows the count, so the delta ratchet fires", () => {
		const before = "export const a = 1;\n";
		const after = "/* v8 ignore next */\nexport const a = 1;\n";
		expect(countSuppressionDirectives(before)).toBe(0);
		expect(countSuppressionDirectives(after)).toBe(1);
		expect(countSuppressionDirectives(after)).toBeGreaterThan(countSuppressionDirectives(before));
	});

	// test-contract: public-api — coverage-ignore counter positive (must fire)
	it("P2: counts the c8 and istanbul spellings", () => {
		expect(countSuppressionDirectives("/* c8 ignore next */\n")).toBe(1);
		expect(countSuppressionDirectives("/* istanbul ignore else */\n")).toBe(1);
		expect(countSuppressionDirectives("// istanbul ignore file\n")).toBe(1);
	});

	// test-contract: public-api — coverage-ignore counter positive (must fire)
	it("P3: counts a justified pragma too — the reason does not exempt it from the ratchet", () => {
		expect(countSuppressionDirectives("/* v8 ignore next -- child-process-only */\n")).toBe(1);
	});

	// test-contract: public-api — coverage-ignore counter positive (must fire).
	// `node:coverage` is the fourth tool token the installed provider parses,
	// and it really suppresses (measured: the pragma'd statement leaves the
	// statementMap). An uncounted token is a free bypass of the coverage
	// ratchet, so it is counted here even though the tree does not yet use it.
	it("P4: counts the `node:coverage` spelling the provider also honors", () => {
		const before = "export const a = 1;\n";
		const after = "/* node:coverage ignore next */\nexport const a = 1;\n";
		expect(countSuppressionDirectives(before)).toBe(0);
		expect(countSuppressionDirectives(after)).toBe(1);
		expect(countSuppressionDirectives("// node:coverage ignore file\n")).toBe(1);
	});

	// test-contract: boundary — coverage-ignore counter negative (must not fire)
	it("N1: an unchanged pragma count across an edit leaves the ratchet silent", () => {
		const before = "/* v8 ignore next */\nexport const a = 1;\n";
		const after = "/* v8 ignore next */\nexport const a = 2;\n";
		expect(countSuppressionDirectives(after)).toBe(countSuppressionDirectives(before));
		expect(countSuppressionDirectives(after) > countSuppressionDirectives(before)).toBe(false);
	});

	// test-contract: boundary — coverage-ignore counter negative (must not fire)
	it("N2: the bare word `ignore` and a v8-free mention are not counted", () => {
		expect(countSuppressionDirectives("// ignore this line\n")).toBe(0);
		expect(countSuppressionDirectives("// the v8 engine is fast\n")).toBe(0);
	});

	// test-contract: boundary — coverage-ignore counter negative (must not fire)
	it("N3: an unrelated `v8` identifier next to an unrelated `ignore` identifier is not counted", () => {
		expect(countSuppressionDirectives("const v8Ignore = 1;\n")).toBe(0);
	});

	// KNOWN LIMITATION, pinned deliberately rather than asserted as a negative:
	// SUPPRESSION_PATTERN runs against RAW content — it does not call
	// stripAllLiterals the way countTodoMarkers / countConsoleStatements do.
	// So every token in the list, coverage pragmas included, is counted inside
	// a string literal or a URL. This test records the behavior that exists so
	// a future literal-stripping fix shows up as a deliberate change, not a
	// silent one. It is NOT a claim that string-insensitivity is correct.
	it("records the pre-existing string-literal blind spot shared by every token", () => {
		expect(countSuppressionDirectives(`const s = "/* v8 ignore next */";`)).toBe(1);
		// The same blind spot already applies to the tokens that predate this
		// change — the coverage pragmas inherit it, they do not introduce it.
		expect(countSuppressionDirectives(`const s = "@ts-ignore";`)).toBe(1);
	});
});

describe("countTypeDensity", () => {
	it("counts bare `: any` annotations", () => {
		const result = countTypeDensity("function f(x: any) { return x; }\nconst y: any = 1;");
		expect(result.anyAnnotations).toBe(2);
	});

	it("counts `: unknown` annotations", () => {
		const result = countTypeDensity("function f(x: unknown) { return x; }");
		expect(result.unknownAnnotations).toBe(1);
	});

	it("counts bare `Function` type annotations", () => {
		const result = countTypeDensity("const f: Function = () => 1;");
		expect(result.functionType).toBe(1);
	});

	it("does not count Function constructor or class call", () => {
		// `Function(...)` and `new Function(...)` are runtime calls, not type annotations.
		const result = countTypeDensity("const f = new Function('x', 'return x'); const g = Function();");
		expect(result.functionType).toBe(0);
	});

	it("counts empty-object `: {}` annotations", () => {
		const result = countTypeDensity("function f(x: {}) { return x; }");
		expect(result.emptyObjectType).toBe(1);
	});

	it("counts exported function parameters that lack type annotations", () => {
		const result = countTypeDensity("export function f(x, y: number, z) { return x; }");
		// `x` and `z` are untyped; `y` is typed.
		expect(result.untypedExportedParams).toBe(2);
	});

	it("counts exported functions missing a return-type annotation", () => {
		const result = countTypeDensity(
			"export function withRet(x: number): number { return x; }\n" +
				"export function noRet(x: number) { return x; }\n",
		);
		expect(result.missingExportedReturnType).toBe(1);
	});

	it("ignores non-exported functions for export-related counters", () => {
		const result = countTypeDensity("function inner(x) { return x; }");
		expect(result.untypedExportedParams).toBe(0);
		expect(result.missingExportedReturnType).toBe(0);
	});

	it("ignores patterns in strings/comments via offset-preserving strip", () => {
		const result = countTypeDensity('const note = "use : any sparingly"; // : any is bad');
		expect(result.anyAnnotations).toBe(0);
	});

	it("returns zero counts on empty input", () => {
		const result = countTypeDensity("");
		expect(result).toEqual({
			anyAnnotations: 0,
			unknownAnnotations: 0,
			functionType: 0,
			emptyObjectType: 0,
			untypedExportedParams: 0,
			missingExportedReturnType: 0,
		});
	});
});

describe("countAmbientSeams (plan 25 lane 2)", () => {
	// test-contract: behavior — each seam dimension counts direct ambient reads
	it("P1: counts clock, random, and env reads in a plain source file", () => {
		const src =
			"const t = Date.now();\nconst d = new Date();\nconst r = Math.random();\nconst k = process.env.API_KEY;\nconst j = process.env['MODE'];\n";
		expect(countAmbientSeams(src, "src/service.ts")).toEqual({ clock: 2, random: 1, env: 2 });
	});

	// test-contract: boundary — env reads are the config boundary's JOB
	it("N1: a config-boundary file's env reads do not count", () => {
		const src = "export const MODE = process.env.MODE;\n";
		expect(countAmbientSeams(src, "src/lib/config.ts").env).toBe(0);
		expect(countAmbientSeams(src, "vitest.config.ts").env).toBe(0);
		expect(countAmbientSeams(src, "src/test-setup/home-sandbox.ts").env).toBe(0);
	});

	// test-contract: boundary — string/comment mentions are not seams, and a
	// constructed Date with arguments is deterministic input, not a clock read
	it("N2: literals, comments, and new Date(arg) do not count", () => {
		const src =
			'// call Date.now() sparingly\nconst s = "Math.random()";\nconst d = new Date(1700000000000);\n';
		expect(countAmbientSeams(src, "src/service.ts")).toEqual({ clock: 0, random: 0, env: 0 });
	});

	// test-contract: behavior — Python parity (plan 25): .py files count their
	// own ambient idioms — time/datetime clocks, random.*, os.environ/getenv
	it("P2: counts Python clock, random, and env reads in a .py file", () => {
		const src =
			"t = time.time()\nd = datetime.now()\nr = random.random()\nk = random.randint(1, 5)\ne = os.environ['MODE']\ng = os.getenv('API_KEY')\n";
		expect(countAmbientSeams(src, "pkg/service.py")).toEqual({ clock: 2, random: 2, env: 2 });
	});

	// test-contract: boundary — Python config-boundary files keep their env reads
	it("N3: settings.py / conftest.py env reads do not count", () => {
		const src = "MODE = os.environ.get('MODE')\n";
		expect(countAmbientSeams(src, "pkg/settings.py").env).toBe(0);
		expect(countAmbientSeams(src, "tests/conftest.py").env).toBe(0);
	});

	// test-contract: boundary — JS patterns must not fire inside .py content
	it("N4: a .py file never counts JS idioms and vice versa", () => {
		expect(countAmbientSeams("t = Date.now()\n", "pkg/x.py")).toEqual({
			clock: 0,
			random: 0,
			env: 0,
		});
		expect(countAmbientSeams("const t = time.time();\n", "src/x.ts").clock).toBe(0);
	});
});

describe("countAssertionStrength — Python parity (plan 25)", () => {
	// test-contract: behavior — pytest/unittest forms map onto weak vs exact:
	// bare truthy asserts and membership are weak; == and the *Equal family pin
	it("P: counts weak (assertTrue/bare/in) and exact (==/assertEqual) forms in .py", () => {
		const src =
			"assert result\nassert item in bag\nself.assertTrue(ok)\nassert total == 41\nself.assertEqual(name, 'x')\n";
		expect(countAssertionStrength(src, "tests/test_service.py")).toEqual({ weak: 3, exact: 2 });
	});

	// test-contract: boundary — vitest matcher names inside .py never count,
	// and .py idioms never count for a TS path
	it("N: idiom sets never cross the language boundary", () => {
		expect(countAssertionStrength("expect(x).toContain('y')\n", "tests/test_a.py")).toEqual({
			weak: 0,
			exact: 0,
		});
		expect(countAssertionStrength("assert a == b\n", "src/a.test.ts")).toEqual({
			weak: 0,
			exact: 0,
		});
	});
});

describe("countAssertionStrength (plan 25 lane 4)", () => {
	// test-contract: behavior — each weak/exact matcher counts its calls in test content
	it("P1: counts weak and exact matcher calls", () => {
		const src =
			'expect(x).toContain("a");\nexpect(y).toMatch(/foo/);\nexpect(z).toBeTruthy();\n' +
			"expect(w).toBeDefined();\nexpect(a).toBe(1);\nexpect(b).toEqual({ c: 1 });\n" +
			"expect(c).toStrictEqual([1]);\n";
		expect(countAssertionStrength(src)).toEqual({ weak: 4, exact: 3 });
	});

	// test-contract: boundary — matchers deliberately left OFF the "use exactly"
	// list (toBeFalsy/toBeUndefined) must not count toward weak
	it("N1: matchers excluded from the exact list are not counted", () => {
		const src = "expect(x).toBeFalsy();\nexpect(y).toBeUndefined();\n";
		expect(countAssertionStrength(src)).toEqual({ weak: 0, exact: 0 });
	});

	// test-contract: boundary — string/comment mentions of matcher names are not calls
	it("N2: literals and comments do not count", () => {
		const src = '// use toBe() and toContain() here\nconst s = "call toEqual(x) in your test";\n';
		expect(countAssertionStrength(src)).toEqual({ weak: 0, exact: 0 });
	});

	// test-contract: boundary — toBeTruthy/toBeDefined must not also register as
	// a `toBe(` exact match (substring-overlap regression guard)
	it("N3: toBeTruthy/toBeDefined are not double-counted as toBe", () => {
		const src = "expect(x).toBeTruthy();\nexpect(y).toBeDefined();\n";
		expect(countAssertionStrength(src)).toEqual({ weak: 2, exact: 0 });
	});

	it("returns zero counts on empty input", () => {
		expect(countAssertionStrength("")).toEqual({ weak: 0, exact: 0 });
	});
});
