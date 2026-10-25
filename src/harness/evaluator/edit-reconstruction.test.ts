import { describe, expect, it } from "vitest";
import { reconstructEdit, reconstructMultiEdit, reconstructToolInput } from "./edit-reconstruction.js";

describe("reconstructEdit — positive (must decide)", () => {
	it("P1: replaces a unique occurrence", () => {
		expect(reconstructEdit("a b c", { old_string: "b", new_string: "B" })).toEqual({ kind: "decided", contents: ["a B c"] });
	});
	it("P2: replace_all replaces every occurrence", () => {
		expect(reconstructEdit('{"a": 1, "b": 1, "c": 1}', { old_string: ": 1,", new_string: ": 0.1,", replace_all: true })).toEqual({
			kind: "decided",
			contents: ['{"a": 0.1, "b": 0.1, "c": 1}'],
		});
	});
	it("P3: an empty new_string yields both the newline-consuming and the plain reading", () => {
		expect(reconstructEdit("x\ny\n", { old_string: "x", new_string: "" })).toEqual({ kind: "decided", contents: ["y\n", "\ny\n"] });
	});
	it("P4: replacement text with `$&` is inserted literally", () => {
		expect(reconstructEdit("a b", { old_string: "b", new_string: "$&$&" })).toEqual({ kind: "decided", contents: ["a $&$&"] });
	});
});

describe("reconstructEdit — negative (must not decide)", () => {
	it("N1: a non-unique old_string without replace_all is undecidable", () => {
		expect(reconstructEdit("1 1", { old_string: "1", new_string: "2" })).toMatchObject({ kind: "undecidable", reason: expect.stringContaining("occurs 2 times") });
	});
	it("N2: an absent old_string is undecidable", () => {
		expect(reconstructEdit("abc", { old_string: "z", new_string: "y" }).kind).toBe("undecidable");
	});
	it("N3: mistyped or empty fields are undecidable", () => {
		expect(reconstructEdit("abc", { old_string: 1, new_string: "y" }).kind).toBe("undecidable");
		expect(reconstructEdit("abc", { old_string: "a", new_string: 2 }).kind).toBe("undecidable");
		expect(reconstructEdit("abc", { old_string: "a", new_string: "y", replace_all: "yes" }).kind).toBe("undecidable");
		expect(reconstructEdit("abc", { old_string: "", new_string: "y" }).kind).toBe("undecidable");
		expect(reconstructEdit("abc", "not an object").kind).toBe("undecidable");
	});
});

describe("reconstructMultiEdit", () => {
	it("P1: applies entries sequentially against the running result", () => {
		expect(reconstructMultiEdit("1 2 3", [{ old_string: "1", new_string: "9" }, { old_string: "9 2", new_string: "x" }])).toEqual({ kind: "decided", contents: ["x 3"] });
	});
	it("N1: an entry made ambiguous by an earlier entry is undecidable", () => {
		const r = reconstructMultiEdit("a b", [{ old_string: "a", new_string: "b" }, { old_string: "b", new_string: "c" }]);
		expect(r).toMatchObject({ kind: "undecidable", reason: expect.stringContaining("edit 2") });
	});
	it("N2: an empty edits list decides the unchanged content", () => {
		expect(reconstructMultiEdit("same", [])).toEqual({ kind: "decided", contents: ["same"] });
	});
	it("P2: malformed entries are skipped, but all-malformed is undecidable", () => {
		expect(reconstructMultiEdit("a", [null, 42, { old_string: "a", new_string: "b" }])).toEqual({ kind: "decided", contents: ["b"] });
		expect(reconstructMultiEdit("a", [null, { old_string: 1, new_string: "b" }]).kind).toBe("undecidable");
	});
});

describe("reconstructToolInput", () => {
	it("P1: a Write is decided by its content even when the file is absent", () => {
		expect(reconstructToolInput(null, { content: "new" })).toEqual({ kind: "decided", contents: ["new"] });
	});
	it("P2: content plus an edit pools both readings", () => {
		expect(reconstructToolInput("a", { content: "w", old_string: "a", new_string: "b" })).toEqual({ kind: "decided", contents: ["w", "b"] });
	});
	it("N1: a shape-less input is undecidable", () => {
		expect(reconstructToolInput("a", { notebook_path: "x", new_source: "y" }).kind).toBe("undecidable");
	});
	it("N2: a non-array edits field, or an edit against an absent file, is undecidable", () => {
		expect(reconstructToolInput("a", { edits: { old_string: "a" } }).kind).toBe("undecidable");
		expect(reconstructToolInput(null, { old_string: "a", new_string: "b" }).kind).toBe("undecidable");
	});
});
