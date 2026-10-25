// Companion test for eval-definition-scan.ts: the "can a class / interface /
// object MEMBER start here?" decision that eval_usage uses to read
// `eval(...): T` as a member signature instead of a call. A wrong `true`
// hides a real global eval call (eval_usage is pre_block), so every
// expression context below must stay `false`.

import { describe, expect, it } from "vitest";
import { memberMayStartAfter } from "./eval-definition-scan.js";

describe("memberMayStartAfter — positive (a member may start: must return true)", () => {
	it("P1: start of content and the member separators `{ } ; ,`", () => {
		for (const head of ["", "class A {", "foo() {}", "x = 1;", "{ a: 1,"]) {
			expect(memberMayStartAfter(head), head).toBe(true);
		}
	});

	it("P2: modifier keywords before the member name", () => {
		for (const head of ["{\n\tstatic", "{\n\tasync", "{\n\tget", "{\n\tpublic", "{\n\toverride"]) {
			expect(memberMayStartAfter(head), head).toBe(true);
		}
	});

	it("P3: decorators — `@memo()`, `@cached` and a same-line `@HostListener(\"\")`", () => {
		for (const head of ["{\n\t@memo()", "{\n\t@cached", '{\n\t@HostListener("")']) {
			expect(memberMayStartAfter(head), head).toBe(true);
		}
	});

	it("P4: a previous member with no semicolon (ASI style) ending in a value or a type", () => {
		for (const head of [
			"{\n  x = 1",
			"{\n  run(): void",
			"{\n  onDone: () => void",
			"{\n  get(): Map<K, Array<V>>",
			"{\n  items: string[]",
			'{\n  name = ""',
		]) {
			expect(memberMayStartAfter(head), head).toBe(true);
		}
	});

	it("P5: a generator `*` after a member separator or a modifier", () => {
		for (const head of ["class A {\n\t*", "class A {\n\tasync *", "x = 1;\n\t*"]) {
			expect(memberMayStartAfter(head), head).toBe(true);
		}
	});
});

describe("memberMayStartAfter — negative (an expression continues: must return false)", () => {
	it("N1: a ternary `?`, a ternary `:` and a binary operator", () => {
		for (const head of ["const r = c ?", "const r = a ? b ? f() :", "const r = a +", "x ="]) {
			expect(memberMayStartAfter(head), head).toBe(false);
		}
	});

	it("N2: operator keywords — `case`, `await`, `typeof`, `new`, `in`, `return`, and a bare `void`", () => {
		for (const head of ["switch (v) {\n\tcase", "c ? await", "c ? typeof", "c ? new", "c ? k in", "return", "c ? void"]) {
			expect(memberMayStartAfter(head), head).toBe(false);
		}
	});

	it("N3: a comparison `>` and a shift `>>` are not a generic close", () => {
		for (const head of ["c ? a >", "c ? a >> b >", "c ? a << b >"]) {
			expect(memberMayStartAfter(head), head).toBe(false);
		}
	});

	it("N4: a multiplication `*`, including after an unterminated field (no ASI before `*`)", () => {
		for (const head of ["c ? a *", "{\n  x = 1\n  *"]) {
			expect(memberMayStartAfter(head), head).toBe(false);
		}
	});
});
