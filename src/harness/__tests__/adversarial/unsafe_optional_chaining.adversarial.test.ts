// Independent adversarial review of the `unsafe_optional_chaining` pre_block
// check (2026-10-21). The detector is AST-based (checks/optional-chain-boundaries.ts),
// so comments, strings, casts, `!`, `??`/`||` fallbacks and `(a?.b)?.c` were
// already quiet. The one reachable false positive was PATH-scoped: a lint
// rule's invalid-case fixture, a vendored copy or a __mocks__ sample holds the
// broken grouping deliberately, and the sibling pre_block `raw_control_bytes`
// already exempts the same paths through `isVendoredOrFixturePath`. The
// negatives pin that exemption; the positives pin that it is a DIRECTORY
// boundary, not a substring, and that the true-positive shape still fires.

import { describe, expect, it } from "vitest";
import { checkUnsafeOptionalChaining } from "../../checks/agent-safety-js-correctness.js";

const BAD = "export const v = (obj?.foo).bar;\n";

describe("unsafe_optional_chaining — negative (must not fire)", () => {
	it("N1: a lint rule's invalid-case fixture under __fixtures__/", () => {
		expect(checkUnsafeOptionalChaining(BAD, "src/rules/__fixtures__/unsafe-chain/invalid.ts")).toEqual([]);
	});

	it("N2: an invalid-case fixture under a bare fixtures/ directory (repo-relative path)", () => {
		expect(checkUnsafeOptionalChaining(BAD, "tests/fixtures/unsafe-chain/invalid.ts")).toEqual([]);
	});

	it("N3: a vendored third-party copy under vendor/", () => {
		expect(checkUnsafeOptionalChaining(BAD, "vendor/legacy-sdk/index.js")).toEqual([]);
	});

	it("N4: a __mocks__ sample that holds the shape as data", () => {
		expect(checkUnsafeOptionalChaining(BAD, "src/__mocks__/bad-shape.ts")).toEqual([]);
	});

	it("N5: a non-null assertion on the group `(a?.b)!.c`", () => {
		const content = "export function name(u?: { profile?: { name: string } }): string {\n\treturn (u?.profile)!.name;\n}\n";
		expect(checkUnsafeOptionalChaining(content, "src/profile.ts")).toEqual([]);
	});

	it("N6: an `as` cast inside the group `(a?.b as P).c`", () => {
		const content = "type P = { name: string };\nexport function name(u?: { profile?: P }): string {\n\treturn (u?.profile as P).name;\n}\n";
		expect(checkUnsafeOptionalChaining(content, "src/profile.ts")).toEqual([]);
	});

	it("N7: comments, strings, a regex literal and a template literal that mention the pattern", () => {
		const content = [
			"/** Flags `(obj?.foo).bar`, which throws when obj is nullish. */",
			"export const BAD = /\\(\\w+\\?\\.\\w+\\)\\.\\w+/;",
			'export const MSG = "Avoid (obj?.foo).bar; use obj?.foo?.bar";',
			"export const DOC = `example: (cfg?.opt).value // throws`;",
		].join("\n");
		expect(checkUnsafeOptionalChaining(content, "src/lint/no-unsafe-chain.ts")).toEqual([]);
	});

	// Round 2: a JSDoc cast is the only cast syntax plain JS has, and the
	// checker treats it exactly like `as` (N6) / `!` (N5) in a .ts file.
	it("N8: a JSDoc non-null `@type` cast on the group in a .js file", () => {
		const content = "export function val() {\n\treturn /** @type {!HTMLInputElement} */ (document?.querySelector('#q')).value;\n}\n";
		expect(checkUnsafeOptionalChaining(content, "src/dom.js")).toEqual([]);
	});

	it("N9: a JSDoc `@type` cast on the group in a .jsx file", () => {
		const content = "export function Port({ cfg }) {\n\treturn <b>{/** @type {Config} */ (cfg?.server).port}</b>;\n}\n";
		expect(checkUnsafeOptionalChaining(content, "src/Port.jsx")).toEqual([]);
	});

	it("N10: a JSDoc `@satisfies` cast on the group in a .mjs file (parity with C4 `satisfies`)", () => {
		const content = "export const port = /** @satisfies {Config} */ (globalThis?.cfg).port;\n";
		expect(checkUnsafeOptionalChaining(content, "src/cfg.mjs")).toEqual([]);
	});
});

describe("unsafe_optional_chaining — positive (must fire)", () => {
	it("P1: a product file whose NAME mentions fixtures but sits in no fixture directory still fires", () => {
		expect(checkUnsafeOptionalChaining(BAD, "src/fixtures-loader.ts")).toEqual([
			{ line: 1, text: "export const v = (obj?.foo).bar;" },
		]);
	});

	it("P2: a rule implementation directory named after the rule is not a fixture", () => {
		expect(checkUnsafeOptionalChaining(BAD, "src/rules/no-unsafe-chain/rule.ts")).toHaveLength(1);
	});

	it("P3: a cast on the RECEIVER then a chain, grouped, still fires", () => {
		const content = "type A = { b: { c: number } };\nexport const v = (({} as A)?.b).c;\n";
		expect(checkUnsafeOptionalChaining(content, "src/cfg.ts")).toEqual([
			{ line: 2, text: "export const v = (({} as A)?.b).c;" },
		]);
	});

	it("P4: a `/** @type */` comment before the group in a .ts file is NOT a cast and still fires", () => {
		const content = "export const v = /** @type {!Cfg} */ (cfg?.server).port;\n";
		expect(checkUnsafeOptionalChaining(content, "src/cfg.ts")).toEqual([
			{ line: 1, text: "export const v = /** @type {!Cfg} */ (cfg?.server).port;" },
		]);
	});

	it("P5: a plain (non-tag) JSDoc comment before the group in a .js file still fires", () => {
		const content = "export const v = /** the server */ (cfg?.server).port;\n";
		expect(checkUnsafeOptionalChaining(content, "src/cfg.js")).toHaveLength(1);
	});

	it("P6: a JSDoc cast on an INNER group does not excuse the outer group in a .js file", () => {
		const content = "export const v = (/** @type {Srv} */ (cfg?.server)?.inner).port;\n";
		expect(checkUnsafeOptionalChaining(content, "src/cfg.js")).toHaveLength(1);
	});
});
