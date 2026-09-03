import { describe, expect, it } from "vitest";
import { extractAddedLines, extractRemovedLines } from "./behavioral-checks-tdd-diff-lines.js";

const DIFF = [
	"diff --git a/foo.ts b/foo.ts",
	"index 111..222 100644",
	"--- a/foo.ts",
	"+++ b/foo.ts",
	"@@ -1,3 +1,3 @@",
	"-const x = 1;",
	"+const x = 2;",
	" const y = 3;",
	"-const removedOnly = true;",
	"+const addedOnly = true;",
].join("\n");

describe("extractAddedLines — positive (must fire)", () => {
	it("P1: collects added lines with the + marker stripped", () => {
		expect(extractAddedLines(DIFF)).toBe("const x = 2;\nconst addedOnly = true;");
	});

	it("P2: joins multiple added lines with newlines in diff order", () => {
		const diff = "+++ b/f.ts\n+one\n+two\n+three";
		expect(extractAddedLines(diff)).toBe("one\ntwo\nthree");
	});
});

describe("extractAddedLines — negative (must not fire)", () => {
	it("N1: excludes the +++ file header line", () => {
		expect(extractAddedLines("+++ b/foo.ts\n+kept")).toBe("kept");
	});

	it("N2: returns empty string for a diff with no added lines", () => {
		expect(extractAddedLines("--- a/foo.ts\n+++ b/foo.ts\n-only removed\n context")).toBe("");
	});
});

describe("extractRemovedLines — positive (must fire)", () => {
	it("P1: collects removed lines with the - marker stripped", () => {
		expect(extractRemovedLines(DIFF)).toBe("const x = 1;\nconst removedOnly = true;");
	});

	it("P2: joins multiple removed lines with newlines in diff order", () => {
		const diff = "--- a/f.ts\n-one\n-two\n-three";
		expect(extractRemovedLines(diff)).toBe("one\ntwo\nthree");
	});
});

describe("extractRemovedLines — negative (must not fire)", () => {
	it("N1: excludes the --- file header line", () => {
		expect(extractRemovedLines("--- a/foo.ts\n-kept")).toBe("kept");
	});

	it("N2: returns empty string for a diff with no removed lines", () => {
		expect(extractRemovedLines("--- a/foo.ts\n+++ b/foo.ts\n+only added\n context")).toBe("");
	});
});
