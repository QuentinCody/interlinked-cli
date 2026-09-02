import { describe, expect, it } from "vitest";
import { reconstructProposedBaseline } from "./baseline-integrity-proposal.js";

describe("reconstructProposedBaseline", () => {
	it("returns Write content verbatim when `content` is a string", () => {
		expect(reconstructProposedBaseline("old", { content: "brand new" })).toBe("brand new");
	});

	it("returns an empty-string content rather than treating it as absent", () => {
		expect(reconstructProposedBaseline("old", { content: "" })).toBe("");
	});

	it("applies a single old_string/new_string edit", () => {
		expect(reconstructProposedBaseline("a b c", { old_string: "b", new_string: "B" })).toBe("a B c");
	});

	it("returns null when a single edit's old_string is absent from the source", () => {
		expect(reconstructProposedBaseline("a b c", { old_string: "zz", new_string: "B" })).toBeNull();
	});

	it("returns null when neither content nor an edit pair is present", () => {
		expect(reconstructProposedBaseline("a b c", {})).toBeNull();
		expect(reconstructProposedBaseline("a b c", { old_string: "b" })).toBeNull();
		expect(reconstructProposedBaseline("a b c", { new_string: "B" })).toBeNull();
	});

	it("applies MultiEdit edits in order", () => {
		const out = reconstructProposedBaseline("1 2 3", {
			edits: [
				{ old_string: "1", new_string: "one" },
				{ old_string: "3", new_string: "three" },
			],
		});
		expect(out).toBe("one 2 three");
	});

	it("skips MultiEdit entries with non-string members and keeps the rest", () => {
		const out = reconstructProposedBaseline("1 2 3", {
			edits: [{ old_string: 1, new_string: "one" }, { old_string: "2", new_string: "two" }],
		});
		expect(out).toBe("1 two 3");
	});

	it("returns null when any MultiEdit step fails to reconstruct", () => {
		const out = reconstructProposedBaseline("1 2 3", {
			edits: [
				{ old_string: "nope", new_string: "x" },
				{ old_string: "2", new_string: "two" },
			],
		});
		expect(out).toBeNull();
	});

	it("returns the source unchanged for an empty edits array", () => {
		expect(reconstructProposedBaseline("1 2 3", { edits: [] })).toBe("1 2 3");
	});

	it("prefers `content` over an edits array when both are present", () => {
		const out = reconstructProposedBaseline("1 2 3", {
			content: "written",
			edits: [{ old_string: "1", new_string: "one" }],
		});
		expect(out).toBe("written");
	});
});
