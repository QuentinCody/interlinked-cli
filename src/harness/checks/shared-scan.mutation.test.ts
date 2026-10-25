import { describe, expect, it } from "vitest";
import {
	collectElapsedTimeAnchors,
	findEnclosingScope,
	isTypeOnlyModule,
} from "./shared-scan.js";

// Mutation-hardening tests for shared-scan.ts. Each test pins one behavior the
// original shared-scan.test.ts left unpinned. Basis for every case is the
// module header / JSDoc of shared-scan.ts (cited per test).

describe("isTypeOnlyModule — mutation hardening", () => {
	// shared-scan.ts:11-19 — TS-only "by extension"; the extension test is
	// written case-insensitively (line 27), so an upper-case extension counts.
	it("treats an upper-case TypeScript extension as TypeScript", () => {
		expect(isTypeOnlyModule("Types.TS", "type X = string;\n")).toBe(true);
	});

	// shared-scan.ts:21-23 — any top-level runtime statement marks the module
	// NOT type-only. An identifier that merely starts with `import` + `type`
	// (no separator) is runtime code, not an `import type` statement.
	it("does not mistake an identifier starting with `importtype` for an `import type` statement", () => {
		expect(isTypeOnlyModule("a.ts", "type X = string;\nimporttype();\n")).toBe(false);
	});

	// Same conservative rule: an identifier that starts with `interface` is a
	// runtime expression statement, not an interface declaration.
	it("does not mistake an identifier starting with `interface` for an interface declaration", () => {
		expect(isTypeOnlyModule("b.ts", "type X = string;\ninterfaceFoo();\n")).toBe(false);
	});

	// shared-scan.ts:73-74 — `interfaceSawBody` distinguishes `interface X {}`
	// completion from a stray brace; a stray `}` with no body must not complete.
	it("does not treat a stray closing brace as the end of a bodiless interface", () => {
		expect(isTypeOnlyModule("c.ts", "interface Foo }\n")).toBe(false);
	});

	// shared-scan.ts:186 — an `import type` split before its `from` clause
	// continues; a following line that only STARTS with the letters `from`
	// (an identifier) is a new statement, which is runtime code.
	it("treats a line beginning with an identifier like `fromage` as a new statement after `import type`", () => {
		expect(
			isTypeOnlyModule("d.ts", "type X = string;\nimport type Foo\nfromage;\n"),
		).toBe(false);
	});

	// shared-scan.ts:187-190 — a next line beginning with a continuation
	// keyword (`unique`, `typeof`, ...) continues the type; an identifier that
	// merely starts with those letters is a new runtime statement.
	it("treats a next line starting with an identifier like `uniqueName` as a new statement", () => {
		expect(isTypeOnlyModule("e.ts", "type X = string\nuniqueName();\n")).toBe(false);
	});

	// shared-scan.ts:101-104 + 188 — brackets are tracked with a floor at zero
	// and a next line opening with `]` is a continuation, so a stray `]` stays
	// attached to the preceding type statement rather than starting a new one.
	it("keeps a next line starting with `]` attached to the preceding type statement", () => {
		expect(isTypeOnlyModule("f.ts", "type X = string\n]\n")).toBe(true);
	});
});

describe("findEnclosingScope — mutation hardening", () => {
	// shared-scan.ts:234 — "for a 1-based line number". Line 2 is the closing
	// brace of `a`, so the enclosing scope reported must be `a`, not the
	// declaration that starts on the following line.
	it("reports the scope of the given 1-based line, not of the line after it", () => {
		const content = "function a() {\n}\nfunction b() {\n  x;\n}\n";
		expect(findEnclosingScope(content, 2)).toBe("a");
	});
});

describe("collectElapsedTimeAnchors — mutation hardening", () => {
	// shared-scan.ts:295-298 — an anchor counts only when the file subtracts
	// THAT identifier from a second clock read. `total` is a different
	// identifier from `t`, so `t` is not an elapsed-time anchor.
	it("does not treat a longer identifier as a subtraction of the anchor", () => {
		const src = "const t = Date.now();\nconst e = Date.now() - total;\n";
		expect(collectElapsedTimeAnchors(src)).toEqual(new Set());
	});
});
