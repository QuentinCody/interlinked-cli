// Unit tests for taste-checks.ts
//
// checkHybridClass:
//   P1  a class whose only unmatched member line is a multi-line method
//       signature (name+"(" on one line, the closing "{" on another) does
//       not get misread as a "method" member — classifyMember's fallthrough
//       must classify it as "other", so a field-only class with no true
//       method line is not flagged as hybrid.

import { describe, expect, it } from "vitest";
import { checkHybridClass } from "./taste-checks.js";

describe("checkHybridClass", () => {
	it("does not treat a multi-line method signature's opening line as a method member", () => {
		// `value = 1;` is a real field. `process(` / `x: number,` / `) {` are
		// each, on their own line, unclassifiable as field/method/accessor —
		// they must fall through to classifyMember's final "other" arm. If
		// that fallthrough instead read "process(" as a method, hasField +
		// hasMethod would both be true and this class would be flagged.
		const content = [
			"class Foo {",
			"\tvalue = 1;",
			"\tprocess(",
			"\t\tx: number,",
			"\t) {",
			"\t\treturn x;",
			"\t}",
			"}",
		].join("\n");
		expect(checkHybridClass(content, "/x/foo.ts")).toEqual([]);
	});
});
