// Cross-repo false-positive calibration of the `duplicate_describe` pre_warn
// check (2026-10-21, `scratch/2026-10-21-cross-repo/falsify-result.json`): the
// detector fired 10 times on real foreign repositories and 10/10 were confirmed
// false positives of two classes. Each negative below is the REAL snippet from
// the cited location (trimmed, attributed). The positives pin the bug class so
// the fix cannot be a blanket exemption.

import { describe, expect, it } from "vitest";
import { checkDuplicateDescribe } from "../../taste-checks-checks-2-clumps.js";

const FILE = "/repo/tests/foo.test.ts";

describe("duplicate_describe — negative (must not fire)", () => {
	// zod packages/zod/src/v4/classic/tests/to-json-schema.test.ts:3066-3067
	// (`field.describe("d")` is the schema-metadata setter, not a suite).
	it("N1: zod to-json-schema.test.ts:3066 — member call `field.describe(\"d\")` inside `z.object({...})` is not a suite declaration", () => {
		const content = [
			`test("reused", () => {`,
			`  const b = z.toJSONSchema(`,
			`    z.object({`,
			`      d: field.describe("d"),`,
			`      e: field.describe("e"),`,
			`    }),`,
			`    { reused: "ref" },`,
			`  );`,
			`});`,
			`describe("d", () => { it("x", () => {}); });`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toEqual([]);
	});

	it("N2: zod to-json-schema.test.ts:3067 — a second `.describe(\"e\")` member call beside a real `describe(\"e\")` suite", () => {
		const content = [
			`describe("e", () => { it("x", () => {}); });`,
			`test("reused", () => {`,
			`  const b = z.toJSONSchema(z.object({ d: field.describe("d"), e: field.describe("e") }));`,
			`});`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toEqual([]);
	});

	// zod packages/zod/src/v4/classic/tests/to-json-schema.test.ts:3444-3462
	// (three schemas deliberately share the description "a").
	it("N3: zod to-json-schema.test.ts:3444 — `z.string().describe(\"a\")` repeated three times is metadata, not three suites", () => {
		const content = [
			`test("_ref", () => {`,
			`  // const a = z.promise(z.string().describe("a"));`,
			`  const a = z.toJSONSchema(z.promise(z.string().describe("a")));`,
			`  expect(a).toMatchInlineSnapshot(\`{ "description": "a" }\`);`,
			`  const b = z.toJSONSchema(z.lazy(() => z.string().describe("a")));`,
			`  expect(b).toMatchInlineSnapshot(\`{ "description": "a" }\`);`,
			`  const c = z.toJSONSchema(z.optional(z.string().describe("a")));`,
			`  expect(c).toMatchInlineSnapshot(\`{ "description": "a" }\`);`,
			`});`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toEqual([]);
	});

	it("N4: zod to-json-schema.test.ts:3453 — `.describe(\"a\")` inside a `z.lazy(() => ...)` thunk", () => {
		const content = [
			`describe("a", () => { it("x", () => {}); });`,
			`test("_ref", () => {`,
			`  const b = z.toJSONSchema(z.lazy(() => z.string().describe("a")));`,
			`  expect(b).toBeDefined();`,
			`});`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toEqual([]);
	});

	it("N5: zod to-json-schema.test.ts:3462 — optional-chained `?.describe(\"a\")` and `.describe` split across lines", () => {
		const content = [
			`describe("a", () => { it("x", () => {}); });`,
			`const c = z.toJSONSchema(z.optional(z.string().describe("a")));`,
			`const d = maybeSchema?.describe("a");`,
			`const e = z.string()`,
			`  .describe("a");`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toEqual([]);
	});

	// zustand tests/devtools.test.tsx:741 vs :1107 (nested at depth 2 under 951 > 971).
	it("N6: zustand devtools.test.tsx:1107 — `with redux middleware` top-level and again nested under two other suites", () => {
		const content = [
			`describe('with redux middleware', () => {`,
			`  it('works', () => {});`,
			`});`,
			"describe('when redux connection was called on multiple stores with `name` provided in `devtools` options', () => {",
			"  describe('when different `name` props were provided for different group of stores in devtools options', () => {",
			`    describe('with redux middleware', () => {`,
			`      it('works', () => {});`,
			`    });`,
			`  });`,
			`});`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toEqual([]);
	});

	// zustand tests/devtools.test.tsx:164 vs :1216 (nested under 1215).
	it("N7: zustand devtools.test.tsx:1216 — `When state changes...` top-level and nested under a `name` option undefined suite", () => {
		const content = [
			`describe('When state changes...', () => {`,
			`  it('logs', () => {});`,
			`});`,
			"describe('when create devtools was called multiple times with `name` option undefined', () => {",
			`  describe('When state changes...', () => {`,
			`    it('logs', () => {});`,
			`  });`,
			`});`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toEqual([]);
	});

	// zustand tests/devtools.test.tsx:372/373/486 vs :1270/1271/1582.
	it("N8: zustand devtools.test.tsx:1270 — a whole `when it receives a message of type...` subtree repeated under another parent", () => {
		const content = [
			`describe('when it receives a message of type...', () => {`,
			`  describe('ACTION...', () => {`,
			`    it('does nothing', () => {});`,
			`  });`,
			`  describe('DISPATCH and payload of type...', () => {`,
			`    it('RESET', () => {});`,
			`  });`,
			`});`,
			"describe('when create devtools was called multiple times with `name` option undefined', () => {",
			`  describe('when it receives a message of type...', () => {`,
			`    describe('ACTION...', () => {`,
			`      it('does nothing', () => {});`,
			`    });`,
			`    describe('DISPATCH and payload of type...', () => {`,
			`      it('RESET', () => {});`,
			`    });`,
			`  });`,
			`});`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toEqual([]);
	});

	it("N9: zustand devtools.test.tsx:1271 — `ACTION...` at depth 1 and at depth 2 under different chains", () => {
		const content = [
			`describe('msg', () => {`,
			`  describe('ACTION...', () => { it('a', () => {}); });`,
			`});`,
			`describe('multi', () => {`,
			`  describe('msg', () => {`,
			`    describe('ACTION...', () => { it('a', () => {}); });`,
			`  });`,
			`});`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toEqual([]);
	});

	it("N10: zustand devtools.test.tsx:1582 — a one-liner suite closes its scope without a body brace, so the next suite is not its child", () => {
		const content = [
			`describe('DISPATCH and payload of type...', () => it('RESET', () => {}));`,
			`describe('outer', () => {`,
			`  describe('DISPATCH and payload of type...', () => { it('RESET', () => {}); });`,
			`});`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toEqual([]);
	});
	it("N11: a `.describe(...)` on a receiver that merely ENDS in `test` (`schema.test.describe`, `mytest.describe`) is still a member call", () => {
		const content = [
			`describe("a", () => { it("x", () => {}); });`,
			`const s = schema.test.describe("a");`,
			`const t = mytest.describe("a");`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toEqual([]);
	});
});

describe("duplicate_describe — positive (must fire)", () => {
	it("P1: two top-level suites with the same title still fire", () => {
		const content = [
			`describe("with redux middleware", () => { it("a", () => {}); });`,
			`describe("with redux middleware", () => { it("b", () => {}); });`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toHaveLength(1);
	});

	it("P2: two sibling suites with the same title under the SAME parent fire (same full path)", () => {
		const content = [
			`describe("outer", () => {`,
			`  describe("inner", () => { it("a", () => {}); });`,
			`  describe("inner", () => { it("b", () => {}); });`,
			`});`,
		].join("\n");
		const hits = checkDuplicateDescribe(content, FILE);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.line).toBe(3);
	});

	it("P3: a top-level title repeated after a nested subtree closes still fires (scope is popped correctly)", () => {
		const content = [
			`describe("a", () => {`,
			`  describe("b", () => { it("x", () => {}); });`,
			`});`,
			`describe("a", () => { it("y", () => {}); });`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toHaveLength(1);
	});

	it("P4: member-call noise in the file does not mask a real duplicate suite", () => {
		const content = [
			`const s = z.string().describe("a");`,
			`describe("a", () => { it("x", () => {}); });`,
			`describe("a", () => { it("y", () => {}); });`,
		].join("\n");
		expect(checkDuplicateDescribe(content, FILE)).toHaveLength(1);
	});

	it("P5: repair — Playwright member-call suites `test.describe(\"x\")` repeated at top level still fire", () => {
		const content = [
			`test.describe("checkout", () => { test("a", async () => {}); });`,
			`test.describe("checkout", () => { test("b", async () => {}); });`,
		].join("\n");
		const hits = checkDuplicateDescribe(content, FILE);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.line).toBe(2);
	});

	it("P6: repair — `test.describe` nests like `describe`: same title twice under one `test.describe` parent fires", () => {
		const content = [
			`test.describe("orders", () => {`,
			`  test.describe("create", () => { test("a", async () => {}); });`,
			`  test`,
			`    .describe("create", () => { test("b", async () => {}); });`,
			`});`,
			`test.describe("other", () => {`,
			`  test.describe("create", () => { test("c", async () => {}); });`,
			`});`,
		].join("\n");
		const hits = checkDuplicateDescribe(content, FILE);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.line).toBe(3);
	});
});
