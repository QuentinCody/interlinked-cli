// Unit pins for tsconfig-text-parse.ts: TypeScript's own reading of a tsconfig
// text, the JSONC fallback when `typescript` is unavailable, and the
// "existing parseable tsconfig → unparseable post-image" loosening rule.

import { afterEach, describe, expect, it } from "vitest";
import {
	__setTsconfigTypescriptForTesting,
	parseTsconfig,
	parseTsconfigObject,
	safeJsonParse,
	tsconfigParserKind,
	unparseablePostImage,
} from "./tsconfig-text-parse.js";

const STRICT = '{\n  "compilerOptions": { "strict": true }\n}\n';

afterEach(() => {
	__setTsconfigTypescriptForTesting(undefined);
});

describe("parseTsconfig with TypeScript — positive (must fire)", () => {
	it("P1: reads empty and whitespace-only text as an empty options object, with no error", () => {
		expect(tsconfigParserKind()).toBe("typescript");
		expect(parseTsconfig("")).toEqual({ kind: "object", value: {} });
		expect(parseTsconfig("   \n")).toEqual({ kind: "object", value: {} });
	});

	it("P2: reports null, garbage, a lone brace and a non-object root as unparseable", () => {
		for (const text of ["null", "garbage", "{", "[]", "1"]) {
			const parsed = parseTsconfig(text);
			expect(parsed.kind, text).toBe("unparseable");
		}
		expect(parseTsconfig("null")).toEqual({
			kind: "unparseable",
			detail: "The root value of a 'tsconfig.json' file must be an object.",
		});
	});

	it("P3: an existing parseable tsconfig replaced by text TypeScript rejects is a loosening", () => {
		for (const text of ["null", "garbage", "{"]) {
			expect(unparseablePostImage(STRICT, text), text).toMatch(/cannot be parsed by TypeScript/);
		}
	});
});

describe("parseTsconfig with TypeScript — negative (must not fire)", () => {
	it("N1: JSONC comments, a trailing comma and a string holding // are read as TypeScript reads them", () => {
		const text = '{\n  // c\n  "compilerOptions": { "strict": true, "outDir": "a//b", },\n}\n';
		expect(parseTsconfigObject(text)).toEqual({ compilerOptions: { strict: true, outDir: "a//b" } });
	});

	it("N2: a creation, a deletion and an unparseable pre-image are not this finding", () => {
		expect(unparseablePostImage(null, "garbage")).toBeNull();
		expect(unparseablePostImage(STRICT, null)).toBeNull();
		expect(unparseablePostImage("garbage", "{")).toBeNull();
		expect(unparseablePostImage(STRICT, '{"compilerOptions":{"strict":true}}')).toBeNull();
	});

	it("N3: empty text is parseable for TypeScript, so it is judged by its flags, not as a parse failure", () => {
		expect(unparseablePostImage(STRICT, "")).toBeNull();
	});
});

describe("parseTsconfig without TypeScript (JSONC fallback)", () => {
	it("P4: empty and whitespace-only post-images are unparseable, so they are a loosening", () => {
		__setTsconfigTypescriptForTesting(null);
		expect(tsconfigParserKind()).toBe("jsonc-fallback");
		expect(parseTsconfig("").kind).toBe("unparseable");
		expect(unparseablePostImage(STRICT, "")).toMatch(/JSONC fallback reader/);
		expect(unparseablePostImage(STRICT, "   \n")).toMatch(/JSONC fallback reader/);
	});

	it("N4: a valid JSONC tsconfig still parses to its options", () => {
		__setTsconfigTypescriptForTesting(null);
		expect(parseTsconfigObject(STRICT)).toEqual({ compilerOptions: { strict: true } });
		expect(safeJsonParse("")).toBeNull();
	});
});
