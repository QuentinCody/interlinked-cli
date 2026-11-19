import { describe, expect, it } from "vitest";
import { parseJsonc } from "./jsonc.js";

describe("parseJsonc", () => {
	it("P1: reads comments and trailing commas as tsconfig files write them", () => {
		const text = '{\n  // line\n  "a": 1, /* block */\n  "b": [1, 2,],\n}';
		expect(parseJsonc(text)).toEqual({ a: 1, b: [1, 2] });
	});
	it("P2: keeps comment-like text inside strings", () => {
		expect(parseJsonc('{"u": "http://x/*y*/", "v": "a,}"}')).toEqual({ u: "http://x/*y*/", v: "a,}" });
	});
	it("P3: drops a byte order mark", () => {
		expect(parseJsonc('﻿{"a":true}')).toEqual({ a: true });
	});
	it("N1: returns null for text that is not JSON", () => {
		expect(parseJsonc("{ nope")).toBeNull();
		expect(parseJsonc("")).toBeNull();
	});
	it("N2: handles an escaped quote before a comment marker", () => {
		expect(parseJsonc('{"a": "q\\" // not a comment"}')).toEqual({ a: 'q" // not a comment' });
	});
});
