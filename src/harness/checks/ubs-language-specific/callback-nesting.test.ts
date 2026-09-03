import { describe, expect, it } from "vitest";
import { findDeeplyNestedCallbackLines } from "./callback-nesting.js";

const lines = (src: string): string[] => src.split("\n");

describe("findDeeplyNestedCallbackLines — positive (must fire)", () => {
	it("P1: reports the lines inside a 4-deep callback chain", () => {
		const src = [
			"a(function () {",
			"  b(function () {",
			"    c(function () {",
			"      d(function () {",
			"        work();",
			"      });",
			"    });",
			"  });",
			"});",
		].join("\n");
		expect(findDeeplyNestedCallbackLines(lines(src), 20)).toEqual([3, 4]);
	});

	it("P2: reports arrow-function chains the same way", () => {
		const src = [
			"a(() => {",
			"  b(() => {",
			"    c(() => {",
			"      d(() => {",
			"        work();",
			"      });",
			"    });",
			"  });",
			"});",
		].join("\n");
		expect(findDeeplyNestedCallbackLines(lines(src), 20)).toEqual([3, 4]);
	});

	it("P3: stops collecting once the limit is reached", () => {
		const src = [
			"a(() => {",
			"  b(() => {",
			"    c(() => {",
			"      d(() => {",
			"        one();",
			"        two();",
			"        three();",
			"      });",
			"    });",
			"  });",
			"});",
		].join("\n");
		expect(findDeeplyNestedCallbackLines(lines(src), 2)).toEqual([3, 4]);
	});
});

describe("findDeeplyNestedCallbackLines — negative (must not fire)", () => {
	it("N1: three nesting levels stay under the limit", () => {
		const src = [
			"a(() => {",
			"  b(() => {",
			"    c(() => {",
			"      work();",
			"    });",
			"  });",
			"});",
		].join("\n");
		expect(findDeeplyNestedCallbackLines(lines(src), 20)).toEqual([]);
	});

	it("N2: sequential (non-nested) callbacks never accumulate depth", () => {
		const src = [
			"a(() => {",
			"  work();",
			"});",
			"b(() => {",
			"  work();",
			"});",
			"c(() => {",
			"  work();",
			"});",
			"d(() => {",
			"  work();",
			"});",
		].join("\n");
		expect(findDeeplyNestedCallbackLines(lines(src), 20)).toEqual([]);
	});

	it("N3: an empty file yields no lines", () => {
		expect(findDeeplyNestedCallbackLines([], 20)).toEqual([]);
	});
});
