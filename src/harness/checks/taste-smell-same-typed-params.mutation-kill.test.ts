// ===========================================
// taste-smell-same-typed-params — targeted mutation-kill cases (pass-1, W6)
// ===========================================
// Constructions were verified against a faithful hand-reimplementation of
// the pristine + single-mutant logic before being committed here (see
// scratch/fleet-r3/w6-verify/verify.mjs and the receipts jsonl for the
// mutantId -> disposition mapping). Each receipt names the observable
// contract the case pins, not the mutant that motivated writing it.

import { describe, expect, it } from "vitest";
import { checkSameTypedPrimitiveParams } from "./taste-smell-same-typed-params.js";

const SRC_PATH = "src/lib/transfer.ts";

describe("checkSameTypedPrimitiveParams — mutation-kill: classifyParamChar bracket-depth tracking", () => {
	// Two independently balanced 3-deep generics (each opens then fully
	// closes) must never accumulate depth across siblings.
	// test-contract: invariant — angle-bracket depth resets after a balanced close
	it("tracks angle-bracket depth correctly across two independently closed sibling generics", () => {
		const content = [
			"export function calc(m: A<B<C<string>>>, n: A<B<C<string>>>,",
			"  fromId: string, toId: string) {}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([
			{
				line: 1,
				text: "[2 same-typed string params (fromId, toId) → use branded types or a struct param] export function calc(m: A<B<C<string>>>, n: A<B<C<string>>>,",
			},
		]);
	});

	// Depth 3 -> one close -> 3 more opens must reach 5 (over the 4-deep cap).
	// test-contract: boundary — a close decrements angle depth by exactly one, not toward a floor
	it("decrements angle-bracket depth by exactly one per close, not toward a floor", () => {
		const content = [
			"export function calc(m: A<B<C<D>E<F<G<",
			"  string>>>>>, fromId: string, toId: string) {}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	// Same accumulate-across-siblings guard as the angle case, for braces.
	// test-contract: invariant — brace depth resets after a balanced close
	it("tracks brace depth correctly across two independently closed sibling object types", () => {
		const content = [
			"export function calc(m: { p: { q: { r: string } } }, n: { p: { q: { r: string } } },",
			"  fromId: string, toId: string) {}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([
			{
				line: 1,
				text: "[2 same-typed string params (fromId, toId) → use branded types or a struct param] export function calc(m: { p: { q: { r: string } } }, n: { p: { q: { r: string } } },",
			},
		]);
	});

	// 3 opens, 1 close, 3 more opens must reach 5 (over cap).
	// test-contract: boundary — a close decrements brace depth by exactly one, not toward a floor
	it("decrements brace depth by exactly one per close, not toward a floor", () => {
		const content = ["export function calc(m: {{{}{{{", "  string}}}}}, fromId: string, toId: string) {}"].join(
			"\n",
		);
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	// Same open/close/reopen shape as brace, for square brackets.
	// test-contract: boundary — a close decrements bracket depth by exactly one, not toward a floor
	it("decrements bracket depth by exactly one per close, not toward a floor", () => {
		const content = ["export function calc(m: [[[][[[", "  string]]]]], fromId: string, toId: string) {}"].join(
			"\n",
		);
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	// A genuinely 6-deep unclosed chain (correctly discarded) must not
	// survive just because interspersed letters spuriously drain the count.
	// test-contract: invariant — only a literal ']' decrements bracket depth
	it("only a literal ']' character decrements bracket depth (interspersed letters must not)", () => {
		const content = [
			"export function calc(m: [a[a[a[a[a[",
			"  string]]]]]], fromId: string, toId: string) {}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	// Same accumulate-across-siblings guard as angle/brace, for brackets.
	// test-contract: invariant — bracket depth resets after a balanced close
	it("tracks bracket depth correctly across two independently closed sibling tuple types", () => {
		const content = [
			"export function calc(m: [[[string]]], n: [[[string]]],",
			"  fromId: string, toId: string) {}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([
			{
				line: 1,
				text: "[2 same-typed string params (fromId, toId) → use branded types or a struct param] export function calc(m: [[[string]]], n: [[[string]]],",
			},
		]);
	});
});

describe("checkSameTypedPrimitiveParams — mutation-kill: collectParamList sanity-check boundaries", () => {
	// A genuinely 6-deep unclosed brace chain must be discarded, not parsed.
	// test-contract: invariant — brace-open must raise depth so the sanity cap can trip
	it("brace-open branch must increment depth so a 6-deep unclosed chain trips the sanity cap", () => {
		const content = [
			"export function calc(m: { p: { q: { r: { s: { t: {",
			"  u: string } } } } } }, fromId: string, toId: string) {}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	// A signature that peaks at exactly 4 must still parse.
	// test-contract: boundary — brace sanity check is strictly greater-than 4
	it("does not bail when brace nesting is exactly at the sanity cap (4, not exceeding)", () => {
		const content = [
			"export function calc(m: { p: { q: { r: {",
			"  u: string } } } }, fromId: string, toId: string) {}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([
			{
				line: 1,
				text: "[2 same-typed string params (fromId, toId) → use branded types or a struct param] export function calc(m: { p: { q: { r: {",
			},
		]);
	});

	// Same >4 (not >=4) boundary, for square brackets.
	// test-contract: boundary — bracket sanity check is strictly greater-than 4
	it("does not bail when bracket nesting is exactly at the sanity cap (4, not exceeding)", () => {
		const content = ["export function calc(m: [[[[", "  string]]]], fromId: string, toId: string) {}"].join(
			"\n",
		);
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([
			{
				line: 1,
				text: "[2 same-typed string params (fromId, toId) → use branded types or a struct param] export function calc(m: [[[[",
			},
		]);
	});

	// An unclosed 6-deep generic type-annotation PREFIX sits before the real
	// paren and must never be scanned at all.
	// test-contract: boundary — the param scan starts at the real opening paren, not column 0
	it("scans from the real opening paren, not from column 0 of the signature line", () => {
		const content = [
			"export const transfer: A<B<C<D<E<F< = (fromId: string,",
			"  toId: string) => {};",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([
			{
				line: 1,
				text: "[2 same-typed string params (fromId, toId) → use branded types or a struct param] export const transfer: A<B<C<D<E<F< = (fromId: string,",
			},
		]);
	});
});

describe("checkSameTypedPrimitiveParams — mutation-kill: splitTopLevelParams depth gate", () => {
	// A comma nested inside an (intentionally unclosed) generic type
	// annotation must not be treated as a top-level parameter separator.
	// test-contract: invariant — a comma only splits the param list at depth zero
	it("does not split on a comma nested inside an unclosed generic type annotation", () => {
		const content = "export function calc(cb: Foo<junk, fromId: string, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});
});

describe("checkSameTypedPrimitiveParams — mutation-kill: EXPORTED_FUNCTION_PATTERNS[2] (arrow const) regex", () => {
	// The pattern must tolerate whitespace between the const name and a
	// following ':' type annotation.
	// test-contract: boundary — whitespace before the type-annotation colon is optional
	it("recognizes an exported const arrow function with a space before the type-annotation colon", () => {
		const content = "export const transfer : TransferFn = (fromId: string, toId: string) => {};\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([
			{
				line: 1,
				text: "[2 same-typed string params (fromId, toId) → use branded types or a struct param] export const transfer : TransferFn = (fromId: string, toId: string) => {};",
			},
		]);
	});

	// A malformed line with no valid whitespace-then-'=' run anywhere before
	// the real paren must not match at all — the gap must stay whitespace-only
	// so it cannot backtrack across a literal '=' inside the annotation text.
	// test-contract: invariant — the inner colon gap accepts only whitespace, never '='
	it("does not let the inner colon gap swallow a literal '=' inside the type annotation", () => {
		const content = "export const transfer:Foo=Bar = (fromId: string, toId: string) => {};\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	// Same requirement for the outer pre-equals gap: it must not leap over
	// arbitrary junk characters to find a different '='.
	// test-contract: invariant — the outer pre-equals gap accepts only whitespace
	it("does not let the outer pre-equals gap swallow junk characters before '='", () => {
		const content = "export const transfer!!!=(fromId: string, toId: string) => {};\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});
});

describe("checkSameTypedPrimitiveParams — mutation-kill: classifyParamEntry name:type regex", () => {
	// test-contract: boundary — the name:type regex does not require a space after the colon
	it("recognizes a name:type pair with no space after the colon", () => {
		const content = "export function foo(fromId:string, toId:string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([
			{
				line: 1,
				text: "[2 same-typed string params (fromId, toId) → use branded types or a struct param] export function foo(fromId:string, toId:string) {}",
			},
		]);
	});
});

describe("checkSameTypedPrimitiveParams — mutation-kill: classifyParamEntry destructure anchors", () => {
	// A real string param's default value can legitimately contain a '{'
	// (e.g. building an object) without the param itself being a destructure.
	// test-contract: boundary — the curly destructure check is anchored to the start of the entry
	it("does not classify a real string param as a destructure just because '{' appears in its default value", () => {
		const content = "export function foo(a: string = f({x}), fromId: string, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([
			{
				line: 1,
				text: "[2 same-typed string params (a, fromId) → use branded types or a struct param] export function foo(a: string = f({x}), fromId: string, toId: string) {}",
			},
		]);
	});

	// Same anchoring requirement for square brackets.
	// test-contract: boundary — the square destructure check is anchored to the start of the entry
	it("does not classify a real string param as a destructure just because '[' appears in its default value", () => {
		const content = "export function foo(count: string = f([x]), fromId: string, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([
			{
				line: 1,
				text: "[2 same-typed string params (count, fromId) → use branded types or a struct param] export function foo(count: string = f([x]), fromId: string, toId: string) {}",
			},
		]);
	});
});

describe("checkSameTypedPrimitiveParams — mutation-kill: identifyPublicFunctionName constructor exclusion", () => {
	// A `static` modifier makes the leading-keyword exclusion regex (which
	// does not list "static") fail to match even though the captured method
	// name is literally "constructor" — the dedicated captured-name check is
	// the only remaining gate against reporting a constructor as a finding.
	// test-contract: security — a captured method name of "constructor" is always excluded
	it("excludes a 'static constructor(...)' method even though the modifier bypasses the leading-keyword exclusion", () => {
		const content = ["export class Wallet {", "  static constructor(fromId: string, toId: string) {}", "}"].join(
			"\n",
		);
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});
});
