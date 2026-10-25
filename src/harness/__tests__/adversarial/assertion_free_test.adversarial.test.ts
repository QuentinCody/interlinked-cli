// Independent adversarial review of the `assertion_free_test` pre_block check
// (2026-10-21). Every negative case below is LEGITIMATE test code that the
// detector flagged before the same-day refinement: assertion surfaces outside
// the jest/vitest `expect(` + `assert.` vocabulary, and same-file helper
// headers the recognizer missed. The positives pin that the refinement did
// not open a hole for look-alike names.
import { describe, expect, it } from "vitest";
import { checkAssertionFreeTest } from "../../taste-checks-test-assertions.js";

describe("assertion_free_test — negative (must not fire)", () => {
	it("N1: a named import from node:assert/strict is an assertion under its local name", () => {
		const content = [
			'import { test } from "node:test";',
			'import { deepStrictEqual, ok } from "node:assert/strict";',
			'test("parses", () => {',
			"  const out = parse(input);",
			"  deepStrictEqual(out, expected);",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, "src/__tests__/parse.test.ts")).toEqual([]);
	});

	it("N2: chai should-style assertions (`r.should.equal`, `should.exist`)", () => {
		const content = [
			'const should = require("chai").should();',
			'it("adds", () => {',
			"  const r = add(2, 3);",
			"  r.should.equal(5);",
			"});",
			'it("exists", () => {',
			"  should.exist(make());",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, "test/calc.spec.js")).toEqual([]);
	});

	it("N3: vitest type-level assertions (`expectTypeOf`, `assertType<T>`)", () => {
		const content = [
			'import { expectTypeOf, assertType, it } from "vitest";',
			'it("returns a number", () => {',
			"  expectTypeOf(compute).returns.toEqualTypeOf<number>();",
			"});",
			'it("accepts the shape", () => {',
			"  assertType<Promise<void>>(compute());",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, "src/__tests__/types.test-d.ts")).toEqual([]);
	});

	it("N4: AVA / node-tap assertions on the `t` context object", () => {
		const content = [
			'import test from "ava";',
			'test("sums", (t) => {',
			"  t.is(sum(1, 2), 3);",
			"});",
			'test("tap style", (t) => {',
			"  t.equal(sum(2, 2), 4);",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, "test/sum.test.js")).toEqual([]);
	});

	it("N5: an imported `expectX` assertion helper, bare or as a member call", () => {
		const content = [
			'import { expectServed, fixture } from "./helpers.js";',
			'it("serves the session", async () => {',
			"  expectServed(await fixture.hook());",
			"});",
			'it("is ok", async () => {',
			"  fixture.expectOk(await fixture.run());",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, "src/__tests__/run.test.ts")).toEqual([]);
	});

	it("N6: a generic arrow same-file helper that asserts", () => {
		const content = [
			"const check = <T,>(value: T): void => {",
			"  expect(value).toBeDefined();",
			"};",
			'it("checks", () => {',
			"  check(compute());",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, "src/__tests__/gen.test.ts")).toEqual([]);
	});

	it("N7: a same-file helper that delegates to an imported assertX helper", () => {
		const content = [
			'import { assertServed } from "./helpers.js";',
			"function verifyRun(run: Run) {",
			"  assertServed(run);",
			"}",
			'it("serves", async () => {',
			"  verifyRun(await start());",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, "src/__tests__/delegate.test.ts")).toEqual([]);
	});

	it("N8: jasmine's `expectAsync`", () => {
		const content = ['it("resolves", async () => {', "  await expectAsync(load()).toBeResolved();", "});"].join("\n");
		expect(checkAssertionFreeTest(content, "spec/load.spec.js")).toEqual([]);
	});

	it("N9: an explicitly typed const arrow helper whose annotation contains `=>`", () => {
		const content = [
			"const check: (x: number) => void = (x) => {",
			"  expect(x).toBeGreaterThan(0);",
			"};",
			'it("checks", () => {',
			"  check(compute());",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, "src/__tests__/typed.test.ts")).toEqual([]);
	});

	it("N10: the `strict` namespace imported from node:assert, called as a member", () => {
		const content = ['import { strict } from "node:assert";', 'it("equals", () => {', "  strict.equal(compute(), 1);", "});"].join(
			"\n",
		);
		expect(checkAssertionFreeTest(content, "src/__tests__/strict.test.ts")).toEqual([]);
	});

	it("N11: a CommonJS destructured require of node:assert", () => {
		const content = ['const { strictEqual } = require("node:assert");', 'it("x", () => {', "  strictEqual(compute(), 1);", "});"].join(
			"\n",
		);
		expect(checkAssertionFreeTest(content, "test/cjs.test.js")).toEqual([]);
	});

	it("N12: a multi-line named import with an alias from assert/strict", () => {
		const content = [
			"import {",
			"  deepStrictEqual as same,",
			"  ok,",
			'} from "assert/strict";',
			'it("x", () => {',
			"  same(compute(), 1);",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, "src/__tests__/alias.test.ts")).toEqual([]);
	});
});

describe("assertion_free_test — positive (must fire)", () => {
	it("P1: a named import from a NON-assertion module is not an assertion", () => {
		const content = ['import { deepStrictEqual } from "./my-utils.js";', 'it("x", () => {', "  deepStrictEqual(compute(), 1);", "});"].join(
			"\n",
		);
		expect(checkAssertionFreeTest(content, "src/__tests__/x.test.ts")).toEqual([{ line: 2, text: 'it("x", () => {' }]);
	});

	it("P2: `t(\"key\")` (i18n) and `t.end()` / `t.plan()` are not assertions", () => {
		const content = ['test("renders", (t) => {', '  render(t("title"));', "  t.plan(1);", "  t.end();", "});"].join("\n");
		expect(checkAssertionFreeTest(content, "test/i18n.test.js")).toEqual([{ line: 1, text: 'test("renders", (t) => {' }]);
	});

	it("P3: a lower-case `expected(...)` / `assertion(...)` call is not an expectX helper", () => {
		const content = ['it("x", () => {', "  const v = expected(compute());", "  assertion(v);", "});"].join("\n");
		expect(checkAssertionFreeTest(content, "src/__tests__/x.test.ts")).toEqual([{ line: 1, text: 'it("x", () => {' }]);
	});

	it("P4: a generic arrow helper that does NOT assert still leaves the test flagged", () => {
		const content = ["const run = <T,>(v: T): T => {", "  return v;", "};", 'it("runs", () => {', "  run(compute());", "});"].join(
			"\n",
		);
		expect(checkAssertionFreeTest(content, "src/__tests__/gen.test.ts")).toEqual([{ line: 4, text: 'it("runs", () => {' }]);
	});

	it("P5: a type-only import from node:assert binds nothing", () => {
		const content = ['import type { AssertPredicate } from "node:assert";', 'it("x", () => {', "  AssertPredicate(compute());", "});"].join(
			"\n",
		);
		expect(checkAssertionFreeTest(content, "src/__tests__/x.test.ts")).toEqual([{ line: 2, text: 'it("x", () => {' }]);
	});
});
