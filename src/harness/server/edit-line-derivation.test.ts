import { describe, expect, it } from "vitest";
import { deriveEditedLineNumbers } from "./edit-line-derivation.js";

describe("deriveEditedLineNumbers", () => {
	it("withholds line attribution for incomplete edit payloads and preserves deletion semantics", () => {
		expect(deriveEditedLineNumbers("Edit", { old_string: "before" }, "after")).toBeUndefined();
		expect(deriveEditedLineNumbers("MultiEdit", { edits: null }, "after")).toBeUndefined();
		expect(deriveEditedLineNumbers("Edit", { old_string: "removed", new_string: "" }, "remaining")?.size).toBe(0);
	});

	it("returns every line for a Write (whole-file rewrite)", () => {
		const content = "line1\nline2\nline3\n";
		const result = deriveEditedLineNumbers("Write", { content }, content);
		expect(result).toBeDefined();
		expect(Array.from(result ?? []).sort((a: number, b: number) => a - b)).toEqual([1, 2, 3, 4]);
	});

	it("returns the line range spanned by Edit's new_string", () => {
		const post = "a\nb\nINSERTED\nMORE\nc\n";
		const result = deriveEditedLineNumbers(
			"Edit",
			{ old_string: "X", new_string: "INSERTED\nMORE" },
			post,
		);
		expect(result).toBeDefined();
		expect(Array.from(result ?? []).sort((a: number, b: number) => a - b)).toEqual([3, 4]);
	});

	it("returns a single line for a one-line Edit", () => {
		const post = "a\nb\nINSERTED\nc\n";
		const result = deriveEditedLineNumbers(
			"Edit",
			{ old_string: "X", new_string: "INSERTED" },
			post,
		);
		expect(Array.from(result ?? [])).toEqual([3]);
	});

	it("unions every edit's line range for MultiEdit", () => {
		const post = "a\nFIRST\nb\nc\nSECOND\nd\n";
		const result = deriveEditedLineNumbers(
			"MultiEdit",
			{
				edits: [
					{ old_string: "X", new_string: "FIRST" },
					{ old_string: "Y", new_string: "SECOND" },
				],
			},
			post,
		);
		expect(Array.from(result ?? []).sort((a: number, b: number) => a - b)).toEqual([2, 5]);
	});

	it("returns undefined when new_string is missing from the post-edit content", () => {
		// `Edit` whose new_string isn't in the file we can find — fail open.
		const post = "a\nb\nc\n";
		const result = deriveEditedLineNumbers(
			"Edit",
			{ old_string: "X", new_string: "MISSING" },
			post,
		);
		expect(result).toBeDefined();
		expect(result?.size).toBe(0);
	});

	it("returns undefined for tools without a derivable edit shape", () => {
		expect(deriveEditedLineNumbers("Bash", { command: "ls" }, "a\nb\n")).toBeUndefined();
		expect(deriveEditedLineNumbers("Read", { file_path: "x" }, "a\nb\n")).toBeUndefined();
	});

	it("returns undefined when toolInput or postEditContent is missing", () => {
		expect(deriveEditedLineNumbers("Edit", undefined, "a")).toBeUndefined();
		expect(deriveEditedLineNumbers("Edit", { new_string: "x" }, undefined)).toBeUndefined();
	});

	it("handles MultiEdit with no decodable edits by returning undefined", () => {
		const post = "a\nb\n";
		const result = deriveEditedLineNumbers(
			"MultiEdit",
			{ edits: [{ old_string: "x" }, null] },
			post,
		);
		expect(result).toBeUndefined();
	});
});
