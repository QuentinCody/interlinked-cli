// Cross-repo falsification of the `assertion_free_test` pre_block check
// (2026-10-21, scratch/2026-10-21-cross-repo/falsify-result.json). Every
// negative case is REAL test code from a foreign repository (tinybench, zod)
// that the detector flagged; the positives pin the bug class so the fix
// cannot be a blanket exemption of `expect.` members or of comment text.

import { describe, expect, it } from "vitest";
import { checkAssertionFreeTest } from "../../taste-checks-test-assertions.js";

const TINYBENCH_REMOVE = "/clones/tinybench/test/task-remove.test.ts";
const TINYBENCH_EVENTS = "/clones/tinybench/test/events-properties.test.ts";
const ZOD_ALL_ERRORS = "/clones/zod/packages/zod/src/v3/tests/all-errors.test.ts";
const ZOD_ANYUNKNOWN = "/clones/zod/packages/zod/src/v3/tests/anyunknown.test.ts";
const TEST = "/repo/src/widget.test.ts";

/** The TypeScript directive, assembled so this file does not itself carry a
 *  suppression token outside the fixtures. */
const EXPECT_ERROR = ["@ts", "expect", "error"].join("-");

describe("assertion_free_test — negative (must not fire)", () => {
	it("N1: tinybench test/task-remove.test.ts:5 — expect.unreachable() inside a listener", () => {
		const content = [
			"test('removing non-existing task should not throw', () => {",
			"  const bench = new Bench()",
			"  bench.addEventListener('remove', () => {",
			"    expect.unreachable()",
			"  })",
			"  bench.remove('non-existent')",
			"})",
		].join("\n");
		expect(checkAssertionFreeTest(content, TINYBENCH_REMOVE)).toEqual([]);
	});

	it("N2: chai expect.fail() in the catch path is the assertion", () => {
		const content = [
			"it('rejects the bad token', async () => {",
			"  try {",
			"    await login('bad')",
			"  } catch {",
			"    return",
			"  }",
			"  expect.fail('login accepted a bad token')",
			"})",
		].join("\n");
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});

	it("N3: zod v3/tests/all-errors.test.ts:49 — typed assignments plus an expect-error directive", () => {
		const content = [
			'test(".flatten() type assertion", () => {',
			"  const parsed = Test.safeParse({}) as z.SafeParseError<void>;",
			'  const validFlattenedErrors: TestFlattenedErrors = parsed.error.flatten(() => ({ message: "", code: 0 }));',
			`  // ${EXPECT_ERROR} should fail assertion between \`TestFlattenedErrors\` and unmapped \`flatten()\`.`,
			"  const invalidFlattenedErrors: TestFlattenedErrors = parsed.error.flatten();",
			"  [validFlattenedErrors, invalidFlattenedErrors];",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, ZOD_ALL_ERRORS)).toEqual([]);
	});

	it("N4: zod v3/tests/all-errors.test.ts:64 — .formErrors type assertion", () => {
		const content = [
			'test(".formErrors type assertion", () => {',
			"  const parsed = Test.safeParse({}) as z.SafeParseError<void>;",
			"  const validFormErrors: TestFormErrors = parsed.error.formErrors;",
			`  // ${EXPECT_ERROR} should fail assertion between \`TestFlattenedErrors\` and \`.formErrors\`.`,
			"  const invalidFlattenedErrors: TestFlattenedErrors = parsed.error.formErrors;",
			"  [validFormErrors, invalidFlattenedErrors];",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, ZOD_ALL_ERRORS)).toEqual([]);
	});

	it("N5: the block-comment form of the directive is also a compile-time assertion", () => {
		const content = [
			"test('rejects a number id', () => {",
			`  /* ${EXPECT_ERROR} */`,
			"  const id: UserId = 42",
			"  void id",
			"})",
		].join("\n");
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});

	it("N6: zod v3/tests/all-errors.test.ts:16 — util.assertEqual<A, B>(true) type assertions", () => {
		const content = [
			'test("default flattened errors type inference", () => {',
			"  type TestTypeErrors = { formErrors: string[] };",
			"  util.assertEqual<z.inferFlattenedErrors<typeof Test>, TestTypeErrors>(true);",
			"  util.assertEqual<z.inferFlattenedErrors<typeof Test, { message: string }>, TestTypeErrors>(false);",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, ZOD_ALL_ERRORS)).toEqual([]);
		const anyunknown = [
			'test("check any inference", () => {',
			"  const t1 = z.any();",
			"  type t1 = z.infer<typeof t1>;",
			"  util.assertEqual<t1, any>(true);",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(anyunknown, ZOD_ANYUNKNOWN)).toEqual([]);
	});

	it("N7: tinybench test/events-properties.test.ts:17 — expectTypeOf<T>() chains", () => {
		const content = [
			"test('addEventListener parameters', () => {",
			"  expectTypeOf<Parameters<Bench['addEventListener']>>()",
			"    .toEqualTypeOf<NativeAddEventListenerParameters>()",
			"})",
		].join("\n");
		expect(checkAssertionFreeTest(content, TINYBENCH_EVENTS)).toEqual([]);
	});
});

describe("assertion_free_test — positive (must fire)", () => {
	it("P1: a test that only calls the code under test", () => {
		const content = ["it('computes the total', () => {", "  computeTotal([1, 2, 3])", "})"].join("\n");
		const matches = checkAssertionFreeTest(content, TEST);
		expect(matches.map(m => m.line)).toEqual([1]);
	});

	it("P2: a test whose only 'assertion' is a console.log", () => {
		const content = [
			"it('computes the total', () => {",
			"  const total = computeTotal([1, 2, 3])",
			"  console.log(total)",
			"})",
		].join("\n");
		expect(checkAssertionFreeTest(content, TEST).map(m => m.line)).toEqual([1]);
	});

	it("P3: expect.unreachable spelled only inside a string literal is not an assertion", () => {
		const content = [
			"it('logs the hint', () => {",
			"  log('call expect.unreachable() here')",
			"})",
		].join("\n");
		expect(checkAssertionFreeTest(content, TEST).map(m => m.line)).toEqual([1]);
	});

	it("P4: a directive spelled inside a template-literal fixture is not a directive", () => {
		const content = [
			"it('writes the fixture', () => {",
			"  writeFixture(`",
			`// ${EXPECT_ERROR}`,
			"const x: number = 'a'",
			"`)",
			"})",
		].join("\n");
		expect(checkAssertionFreeTest(content, TEST).map(m => m.line)).toEqual([1]);
	});

	it("P5: a ts-ignore directive never fails, so it is not an assertion", () => {
		const content = [
			"it('accepts the id', () => {",
			`  // ${["@ts", "ignore"].join("-")}`,
			"  register(42)",
			"})",
		].join("\n");
		expect(checkAssertionFreeTest(content, TEST).map(m => m.line)).toEqual([1]);
	});

	it("P6: a directive in one test does not exempt the next test", () => {
		const content = [
			"it('rejects a number id', () => {",
			`  // ${EXPECT_ERROR}`,
			"  const id: UserId = 42",
			"})",
			"it('registers the user', () => {",
			"  register('u1')",
			"})",
		].join("\n");
		expect(checkAssertionFreeTest(content, TEST).map(m => m.line)).toEqual([5]);
	});

	it("P7: an expect.fail member on another object is not chai's static call", () => {
		const content = ["it('records the outcome', () => {", "  report.expect.fail()", "})"].join("\n");
		expect(checkAssertionFreeTest(content, TEST).map(m => m.line)).toEqual([1]);
	});
});
