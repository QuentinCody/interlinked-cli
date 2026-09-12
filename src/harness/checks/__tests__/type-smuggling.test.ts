// Type-smuggling detector tests.
//
// Positive cases (check fires):
//   1. Primitive → unrelated object shape: `"hello" as { id: number }`
//   2. Two distinct object shapes: `userObj as ProductObj`
//   3. Double-cast escape hatch: `someValue as unknown as Specific`
//
// Negative cases (check does NOT fire):
//   1. `unknownVal as User` — source is `unknown` (allowed escape hatch)
//   2. `"foo" as const` — `as const` is exempt
//   3. `animal as Dog` where `Dog extends Animal` — narrowing
//   4. Structurally-overlapping shapes — both directions assignable
//   5. Cast target is `any` — allowed widening
//   6. Test files — skipped entirely
//
// Runtime-loading cases (Path C — createRequire optional load):
//   1. Cache survives reset and reloads on next call
//   2. (Failure-mode test not included — simulating "typescript not in
//       project node_modules" requires either mocking node:module or a
//       fake project setup; covered by the tarball install smoke in CI
//       which proves install-hooks succeeds without bundled TS.)

import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import type { InlineMatch } from "../shared.js";
import { __resetTsCacheForTests, checkTypeSmuggling } from "../type-smuggling.js";

const TS = "src/lib/foo.ts";
const TEST_FILE = "src/lib/foo.test.ts";

// ===========================================
// Positive cases — check FIRES
// ===========================================

describe("checkTypeSmuggling — positive cases", () => {
	it.each(["\r", "\u2028", "\u2029"])("retains an incompatible cast's source context after separator %j", (separator) => {
		const code = `const heading = 1;${separator}const observed = "x" as { id: number };`;
		expect(checkTypeSmuggling(code, TS)).toEqual([
			expect.objectContaining({ line: 2, text: expect.stringContaining('const observed = "x" as { id: number };') }),
		]);
	});

	it.each(["\r", "\u2028", "\u2029"])("retains a double cast's source context after separator %j", (separator) => {
		const code = `const heading = 1;${separator}const observed = {} as unknown as { id: number };`;
		expect(checkTypeSmuggling(code, TS)).toEqual([
			expect.objectContaining({ line: 2, text: expect.stringContaining("const observed = {} as unknown as { id: number };") }),
		]);
	});

	it("flags a string-literal cast to an unrelated object shape", () => {
		const code = [
			'const x = "hello" as { id: number };',
			"export { x };",
		].join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(matches[0]).text).toContain("type-smuggling cast");
	});

	it("truncates a long source type name in the report text (safeTypeToString > 40 chars)", () => {
		const code = [
			"interface ReallyLongInterfaceNameForTruncationTestPurposesHere {",
			"  fieldOne: number; fieldTwo: string; fieldThree: boolean;",
			"}",
			"interface Unrelated { totallyDifferentShape: symbol; }",
			"declare const src: ReallyLongInterfaceNameForTruncationTestPurposesHere;",
			"const out = src as Unrelated;",
			"export { out };",
		].join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(matches[0]).text).toContain("...`");
	});

	it("flags a cast on the last line with no trailing newline (lines[line] fallback)", () => {
		// No trailing "\n" after the final statement — exercises the
		// `lines[line] || ""` defensive fallback in the report builders.
		const code = [
			"interface UserObj { id: number; name: string; }",
			"interface ProductObj { sku: string; price: number; }",
			"declare const userObj: UserObj;",
			"const product = userObj as ProductObj;",
		].join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches.length).toBeGreaterThanOrEqual(1);
	});

	it("flags a double-cast on the last line with no trailing newline (lines[line] fallback)", () => {
		const code = [
			"interface Specific { id: number; }",
			"declare const someValue: number;",
			"const v = someValue as unknown as Specific;",
		].join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches.some((m: InlineMatch) => m.text.includes("double-cast detected"))).toBe(true);
	});

	it("flags a cast between two distinct object shapes", () => {
		const code = [
			"interface UserObj { id: number; name: string; }",
			"interface ProductObj { sku: string; price: number; }",
			"declare const userObj: UserObj;",
			"const product = userObj as ProductObj;",
			"export { product };",
		].join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(matches[0]).text).toContain("type-smuggling cast");
	});

	it("flags a smuggling cast in a .tsx file (ternary: TSX vs TS script kind)", () => {
		const code = [
			'const x = "hello" as { id: number };',
			"export { x };",
		].join("\n");
		const matches = checkTypeSmuggling(code, "src/lib/foo.tsx");
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(matches[0]).text).toContain("type-smuggling cast");
	});

	it("flags `as unknown as Specific` double-cast escape with a distinct message", () => {
		const code = [
			"interface Specific { id: number; }",
			"declare const someValue: number;",
			"const v = someValue as unknown as Specific;",
			"export { v };",
		].join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(matches.some((m: InlineMatch) => m.text.includes("double-cast detected"))).toBe(true);
	});
});

// ===========================================
// Negative cases — check DOES NOT FIRE
// ===========================================

describe("checkTypeSmuggling — negative cases (must NOT fire)", () => {
	it("does not fire when source is `unknown` — legitimate widening escape", () => {
		const code = [
			"interface User { id: number; }",
			"declare const unknownVal: unknown;",
			"const u = unknownVal as User;",
			"export { u };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire on `as const` literal-narrowing", () => {
		const code = ['const b = "foo" as const;', "export { b };"].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire on subtype narrowing — Dog from Animal-typed source", () => {
		const code = [
			"interface Animal { name: string; }",
			"interface Dog extends Animal { breed: string; }",
			"declare const animal: Animal;",
			"const z = animal as Dog;",
			"export { z };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire when source and target overlap structurally (both directions)", () => {
		const code = [
			"interface ApiSchema { id: number; name: string; }",
			"declare const response: { id: number; name: string };",
			"const d = response as ApiSchema;",
			"export { d };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire when the cast target is `any` — allowed widening", () => {
		const code = [
			"declare const x: { id: number };",
			"const wide = x as any;",
			"export { wide };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire when the cast target is `unknown` — allowed widening", () => {
		const code = [
			"declare const x: { id: number };",
			"const wide = x as unknown;",
			"export { wide };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire when source is `any` via type inference (escape hatch 1, Any flag)", () => {
		// Source is inferred `any` (not literal `unknown`), so it exercises the
		// `sourceType.flags & ts.TypeFlags.Any` branch distinctly from the
		// `unknown` case above.
		const code = [
			"interface Specific { id: number; }",
			"declare const x: any;",
			"const y = x as Specific;",
			"export { y };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire when target resolves to `any` through a type ALIAS (not literal `any` syntax)", () => {
		// `targetIsAnyOrUnknownSyntax` only catches literal `as any`/`as
		// unknown` syntax — an alias whose underlying type is `any` bypasses
		// that fast path and must be caught by the checker's resolved
		// TypeFlags.Any branch instead.
		const code = [
			"type MyAny = any;",
			"declare const x: { id: number };",
			"const y = x as MyAny;",
			"export { y };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire when target resolves to `unknown` through a type ALIAS", () => {
		const code = [
			"type MyUnknown = unknown;",
			"declare const x: { id: number };",
			"const y = x as MyUnknown;",
			"export { y };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("skips test files entirely", () => {
		const code = [
			'const x = "hello" as { id: number };',
			"export { x };",
		].join("\n");
		expect(checkTypeSmuggling(code, TEST_FILE)).toEqual([]);
	});

	it("skips plain JavaScript files (no .ts/.tsx/.mts/.cts)", () => {
		const code = ['const x = "hello" as { id: number };'].join("\n");
		expect(checkTypeSmuggling(code, "src/foo.js")).toEqual([]);
		expect(checkTypeSmuggling(code, "src/foo.jsx")).toEqual([]);
	});

	it("does not fire on files with no `as` expression at all", () => {
		const code = [
			"const x = 1;",
			'const y = "foo";',
			"export { x, y };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire on `as <SameType>` casts (identity)", () => {
		const code = [
			"interface User { id: number; }",
			"declare const u: User;",
			"const v = u as User;",
			"export { v };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire when source type is `never` (escape hatch 3)", () => {
		const code = [
			"declare const n: never;",
			"const y = n as string;",
			"export { y };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire on widening through a union — value already part of target", () => {
		const code = [
			'type Status = "ok" | "error" | "pending";',
			'const s: "ok" = "ok";',
			"const t = s as Status;",
			"export { t };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("silently skips files whose content cannot be parsed (broken syntax)", () => {
		// Broken source — the compiler will still produce SOMETHING, but the
		// checker may not be able to resolve types. Per the spec, we should
		// not false-fire on broken type info.
		const code = ['const x = "hello" as ;'].join("\n"); // missing target type
		const out = checkTypeSmuggling(code, TS);
		// The detector may legitimately return [] here. We assert nothing
		// fires on the bad cast — the parse error is its own signal.
		expect(out).toEqual([]);
	});
});

// ===========================================
// Performance / scope guards
// ===========================================

describe("checkTypeSmuggling — scope guards", () => {
	it("bails out on files larger than the line cap (>1000 lines)", () => {
		const long = Array(1001)
			.fill('const x = "hello" as { id: number };')
			.join("\n");
		expect(checkTypeSmuggling(long, TS)).toEqual([]);
	});

	it("caps reported matches at 10 per file", () => {
		const lines: string[] = [];
		for (let i = 0; i < 20; i++) {
			lines.push(`const x${i} = "hello" as { id: number };`);
		}
		const code = lines.join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches.length).toBeLessThanOrEqual(10);
		expect(matches.length).toBeGreaterThanOrEqual(1);
	});

	it("returns an empty array on empty content", () => {
		expect(checkTypeSmuggling("", TS)).toEqual([]);
	});
});

// ===========================================
// Runtime-loading (createRequire + cache)
// ===========================================

describe("checkTypeSmuggling — runtime-loaded TypeScript", () => {
	it("re-resolves TypeScript after the cache is reset (cache survives across calls)", () => {
		const code = [
			'const x = "hello" as { id: number };',
			"export { x };",
		].join("\n");

		// First call: cache populated.
		const first = checkTypeSmuggling(code, TS);
		expect(first.length).toBeGreaterThanOrEqual(1);

		// Reset and call again: cache is rebuilt, behavior is unchanged.
		__resetTsCacheForTests();
		const second = checkTypeSmuggling(code, TS);
		expect(second.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(second[0]).text).toEqual(nonNull(first[0]).text);
	});
});

// ===========================================
// Mutation-hardening: exact report shape, escape-hatch/checker-fallback
// invariants, and boundary conditions (all exact-value assertions).
// ===========================================

describe("checkTypeSmuggling — exact report shape (line + text)", () => {
	// test-contract: public-api — a regular smuggling match's report must
	// carry the exact 1-indexed line number and the exact message text
	// (source type, target text, and the trimmed source line), not just
	// "some non-empty result".
	it("reports the exact line and text for a plain smuggling cast", () => {
		const code = [
			"interface UserObj { id: number; name: string; }",
			"interface ProductObj { sku: string; price: number; }",
			"declare const userObj: UserObj;",
			"const product = userObj as ProductObj;",
			"export { product };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([
			{
				line: 4,
				text: "type-smuggling cast: source `UserObj` has no structural overlap with target `ProductObj` — const product = userObj as ProductObj;",
			},
		]);
	});

	// test-contract: public-api — a double-cast match's report must carry
	// the exact 1-indexed line number and exact message text, mirroring the
	// plain-smuggling case above for the `as unknown as T` shape.
	it("reports the exact line and text for a double-cast escape", () => {
		const code = [
			"interface Specific { id: number; }",
			"declare const someValue: number;",
			"const v = someValue as unknown as Specific;",
			"export { v };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([
			{
				line: 3,
				text: "double-cast detected: `as unknown as Specific` bypasses the type system — const v = someValue as unknown as Specific;",
			},
		]);
	});

	// test-contract: public-api — the double-cast report's line number,
	// target-text cap (40 chars), trimmed-line content (no stray leading
	// whitespace), and overall message cap (REPORT_LINE_TRUNC=150) must all
	// hold exactly, even under a long target name and a long padded line.
	it("caps the double-cast report at exactly REPORT_LINE_TRUNC with a 40-char target", () => {
		const longTarget = `T${"x".repeat(60)}`;
		const code = [
			`interface ${longTarget} { id: number; }`,
			"declare const someValue: number;",
			"function wrapper() {",
			`\tconst v = someValue as unknown as ${longTarget}; // padding padding padding padding padding padding padding`,
			"\treturn v;",
			"}",
			"export { wrapper };",
		].join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches).toEqual([
			{
				line: 4,
				text: "double-cast detected: `as unknown as Txxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` bypasses the type system — const v = someValue as unknown as Txxxxxxxxx",
			},
		]);
		expect(matches[0]?.text.length).toBe(150);
	});

	// test-contract: public-api — same three invariants (line, 40-char
	// target cap, 150-char overall cap) for the regular smuggling report
	// builder, which is a SEPARATE code path from the double-cast one.
	it("caps the regular smuggling report at exactly REPORT_LINE_TRUNC with a 40-char target", () => {
		const longTarget = `T${"x".repeat(60)}`;
		const code = [
			`interface ${longTarget} { sku: string; price: number; }`,
			"interface UserObj { id: number; name: string; }",
			"declare const userObj: UserObj;",
			"function wrapper2() {",
			`\tconst product = userObj as ${longTarget}; // padding padding padding padding padding padding padding`,
			"\treturn product;",
			"}",
			"export { wrapper2 };",
		].join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches).toEqual([
			{
				line: 5,
				text: "type-smuggling cast: source `UserObj` has no structural overlap with target `Txxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` — const product = userObj as Tx",
			},
		]);
		expect(matches[0]?.text.length).toBe(150);
	});
});

describe("checkTypeSmuggling — safeTypeToString truncation boundary", () => {
	// test-contract: boundary — safeTypeToString's truncation condition is
	// `s.length > 40`, strictly greater-than; a name of EXACTLY 40 chars
	// must be shown in full, with no "..." suffix.
	it("does not truncate a source type name of exactly 40 characters", () => {
		const name40 = `N${"a".repeat(39)}`;
		expect(name40.length).toBe(40);
		const code = [
			`interface ${name40} { id: number; }`,
			"interface Unrelated40 { totallyDifferentField: symbol; }",
			`declare const src: ${name40};`,
			"const out = src as Unrelated40;",
			"export { out };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([
			{
				line: 4,
				text: "type-smuggling cast: source `Naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` has no structural overlap with target `Unrelated40` — const out = src as Unrela",
			},
		]);
	});

	// test-contract: boundary — once a source type name exceeds 40 chars,
	// safeTypeToString must cut it to EXACTLY the first 37 characters before
	// appending the 3-character "..." suffix (40 total), not the full name.
	it("truncates a 45-char source type name to exactly 37 chars plus an ellipsis", () => {
		const name45 = `N${"a".repeat(44)}`;
		expect(name45.length).toBe(45);
		const code = [
			`interface ${name45} { id: number; }`,
			"interface Unrelated45 { totallyDifferentField: symbol; }",
			`declare const src: ${name45};`,
			"const out = src as Unrelated45;",
			"export { out };",
		].join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches).toEqual([
			{
				line: 4,
				text: "type-smuggling cast: source `Naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa...` has no structural overlap with target `Unrelated45` — const out = src as Unrela",
			},
		]);
		const backtickedSource = matches[0]?.text.match(/source `([^`]+)`/)?.[1];
		expect(backtickedSource).toBe(`${"N"}${"a".repeat(36)}...`);
		expect(backtickedSource?.length).toBe(40);
	});
});

describe("checkTypeSmuggling — checker-fallback and escape-hatch invariants", () => {
	// test-contract: invariant — TypeScript's non-strict mode treats `null`
	// as assignable to (and from) every type; this must stay true for the
	// single-file program's compilerOptions (strict:false), or a bare
	// `null`-typed source would start reading as smuggling against any
	// unrelated target.
	it("does not fire when the source type is exactly `null`", () => {
		const code = ["declare const x: null;", "const y = x as string;", "export { y };"].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	// test-contract: invariant — createSingleFileProgram sets noResolve:true
	// so that import specifiers are NEVER resolved, even when the imported
	// module genuinely exists in node_modules; the imported type must stay
	// an unresolved escape-hatch rather than a real, structurally-comparable
	// type.
	it("does not resolve a real, installed module's import — the imported type stays unresolved", () => {
		const code = [
			'import type { IncomingMessage } from "node:http";',
			"declare const x: IncomingMessage;",
			"const y = x as { neverMatchesThisShapeAtAll: symbol };",
			"export { y };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	// test-contract: invariant — the in-memory CompilerHost's getSourceFile
	// override must defer to the REAL host for any path other than the
	// synthetic target file, so lib-defined global types (Array<T>, drawn
	// from the real default lib) resolve to their genuine structure instead
	// of silently becoming an unresolved/any-like type.
	it("resolves a lib-defined global type (Array<T>) through the real default lib", () => {
		const code = [
			"declare const arr: Array<number>;",
			"const y = arr as { totallyUnrelatedField: symbol };",
			"export { y };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([
			{
				line: 2,
				text: "type-smuggling cast: source `number[]` has no structural overlap with target `{ totallyUnrelatedField: symbol }` — const y = arr as { totallyUnrelated",
			},
		]);
	});

	// test-contract: invariant — `x as any as Other` is NOT the double-cast
	// escape pattern (that is specifically `as unknown as T`); the
	// any-typed inner cast legitimately escape-hatches the OUTER comparison
	// via isSmugglingCast's source-is-Any rule, so this must report nothing.
	it("does not fire on `x as any as Other` (any-typed intermediate, not a double-cast)", () => {
		const code = [
			"interface Other { foo: string; }",
			"declare const x: { a: number };",
			"const v = x as any as Other;",
			"export { v };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	// test-contract: public-api — still matches `as` followed by MORE THAN
	// one whitespace character; the pre-scan regex is `\bas\s+`, one-or-
	// more, not exactly one.
	it("still matches `as` followed by multiple whitespace characters", () => {
		const code = ['const x = "hello"  as   { id: number };', "export { x };"].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([
			{
				line: 1,
				text: 'type-smuggling cast: source `"hello"` has no structural overlap with target `{ id: number }` — const x = "hello"  as   { id: number };',
			},
		]);
	});
});

describe("checkTypeSmuggling — .mts/.cts extensions and ScriptKind selection", () => {
	// test-contract: public-api — .mts is a first-class TS_EXTS member
	// alongside .ts/.tsx/.cts, not merely tolerated by accident.
	it("processes a .mts file", () => {
		const code = [
			"interface UserObj { id: number; name: string; }",
			"interface ProductObj { sku: string; price: number; }",
			"declare const userObj: UserObj;",
			"const product = userObj as ProductObj;",
			"export { product };",
		].join("\n");
		expect(checkTypeSmuggling(code, "src/lib/foo.mts")).toEqual([
			{
				line: 4,
				text: "type-smuggling cast: source `UserObj` has no structural overlap with target `ProductObj` — const product = userObj as ProductObj;",
			},
		]);
	});

	// test-contract: public-api — .cts is a first-class TS_EXTS member
	// alongside .ts/.tsx/.mts, not merely tolerated by accident.
	it("processes a .cts file", () => {
		const code = [
			"interface UserObj { id: number; name: string; }",
			"interface ProductObj { sku: string; price: number; }",
			"declare const userObj: UserObj;",
			"const product = userObj as ProductObj;",
			"export { product };",
		].join("\n");
		expect(checkTypeSmuggling(code, "src/lib/foo.cts")).toEqual([
			{
				line: 4,
				text: "type-smuggling cast: source `UserObj` has no structural overlap with target `ProductObj` — const product = userObj as ProductObj;",
			},
		]);
	});

	// test-contract: public-api — a .ts file uses ScriptKind.TS, under
	// which the legacy `<T>expr` type-assertion syntax IS recognized
	// (unlike .tsx, where it is parser-disallowed — see the next test).
	// Both casts in this file must be found.
	it("recognizes legacy `<T>expr` type assertions in a .ts file (ScriptKind.TS)", () => {
		const code = [
			"declare const foo: number;",
			"const y = foo as string;",
			'const x = <{ id: number }>"hello";',
			"export { x, y };",
		].join("\n");
		expect(checkTypeSmuggling(code, "src/lib/foo.ts")).toEqual([
			{
				line: 2,
				text: "type-smuggling cast: source `number` has no structural overlap with target `string` — const y = foo as string;",
			},
			{
				line: 3,
				text: 'type-smuggling cast: source `"hello"` has no structural overlap with target `{ id: number }` — const x = <{ id: number }>"hello";',
			},
		]);
	});

	// test-contract: public-api — a .tsx file uses ScriptKind.TSX, under
	// which the legacy `<T>expr` syntax is disallowed by the parser (it
	// would collide with JSX); only the `as`-cast is found, NOT the legacy
	// one. Same source as the .ts case above, different filePath.
	it("does not recognize legacy `<T>expr` type assertions in a .tsx file (ScriptKind.TSX)", () => {
		const code = [
			"declare const foo: number;",
			"const y = foo as string;",
			'const x = <{ id: number }>"hello";',
			"export { x, y };",
		].join("\n");
		expect(checkTypeSmuggling(code, "src/lib/foo.tsx")).toEqual([
			{
				line: 2,
				text: "type-smuggling cast: source `number` has no structural overlap with target `string` — const y = foo as string;",
			},
		]);
	});
});

describe("checkTypeSmuggling — file-size gate boundary (exactly MAX_LINES_PER_FILE)", () => {
	// test-contract: boundary — the size gate rejects content strictly OVER
	// 1000 lines (`lineCount > MAX_LINES_PER_FILE`); content at EXACTLY
	// 1000 lines must still be processed normally, not rejected.
	it("still processes content at exactly the 1000-line cap", () => {
		const padding = Array(996).fill("// padding line to reach exactly 1000 total lines");
		const code = [
			"interface UserObj999 { id: number; name: string; }",
			"interface ProductObj999 { sku: string; price: number; }",
			"declare const userObj999: UserObj999;",
			...padding,
			"const product999 = userObj999 as ProductObj999;",
		].join("\n");
		expect(code.split("\n").length).toBe(1000);
		expect(checkTypeSmuggling(code, TS)).toEqual([
			{
				line: 1000,
				text: "type-smuggling cast: source `UserObj999` has no structural overlap with target `ProductObj999` — const product999 = userObj999 as ProductObj999;",
			},
		]);
	});

	// test-contract: invariant — the size gate's line count must come from
	// splitting on newlines, not characters; content with many short lines
	// can exceed 1000 CHARACTERS while staying far under 1000 LINES, and
	// must still be processed normally.
	it("does not mistake character count for line count", () => {
		const padLines: string[] = [];
		for (let i = 0; i < 20; i++) {
			padLines.push(`// padding line ${i} to inflate character count well past a thousand chars total`);
		}
		padLines.push("interface UserObjChar { id: number; name: string; }");
		padLines.push("interface ProductObjChar { sku: string; price: number; }");
		padLines.push("declare const userObjChar: UserObjChar;");
		padLines.push("const productChar = userObjChar as ProductObjChar;");
		padLines.push("export { productChar };");
		const code = padLines.join("\n");
		expect(code.length).toBeGreaterThan(1000);
		expect(code.split("\n").length).toBeLessThan(1000);
		expect(checkTypeSmuggling(code, TS)).toEqual([
			{
				line: 24,
				text: "type-smuggling cast: source `UserObjChar` has no structural overlap with target `ProductObjChar` — const productChar = userObjChar as ProductObjChar;",
			},
		]);
	});
});
