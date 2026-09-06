import { describe, expect, it } from "vitest";
import { parseStrictPatchSections } from "./post-image-sections.js";
import type { StrictPatchSectionV1 } from "./post-image-sections.js";

/** The strict parser works on the lines BETWEEN the envelope markers — the
 *  projector checks `*** Begin Patch` / `*** End Patch` before this point. */
function parsed(...lines: readonly string[]): readonly StrictPatchSectionV1[] {
	const result = parseStrictPatchSections(lines);
	if (!result.ok) throw new Error(`expected sections, got: ${result.code}`);
	return result.sections;
}

function refusedCode(...lines: readonly string[]): string {
	const result = parseStrictPatchSections(lines);
	if (result.ok) throw new Error("expected a refusal, got sections");
	return result.code;
}

describe("parseStrictPatchSections — positive (must accept)", () => {
	it("P1: an Add section yields its `+` lines with the prefix stripped", () => {
		expect(parsed("*** Add File: src/new.ts", "+one", "+", "+three")).toEqual([
			{ op: "add", path: "src/new.ts", lines: ["one", "", "three"] },
		]);
	});

	it("P2: an Add section with no body is an empty file", () => {
		expect(parsed("*** Add File: empty.txt")).toEqual([{ op: "add", path: "empty.txt", lines: [] }]);
	});

	it("P3: a Delete section carries only its path", () => {
		expect(parsed("*** Delete File: src/gone.ts")).toEqual([{ op: "delete", path: "src/gone.ts" }]);
	});

	it("P4: an Update section keeps its raw hunk lines and has no move target", () => {
		expect(parsed("*** Update File: src/a.ts", "@@", "-a", "+b")).toEqual([
			{ op: "update", path: "src/a.ts", move_to: null, body: ["@@", "-a", "+b"] },
		]);
	});

	it("P5: a Move as the FIRST body line of an Update names the destination and is not a hunk line", () => {
		expect(parsed("*** Update File: src/old.ts", "*** Move to: src/new.ts", "@@", "-a", "+b")).toEqual([
			{ op: "update", path: "src/old.ts", move_to: "src/new.ts", body: ["@@", "-a", "+b"] },
		]);
	});

	it("P6: sections are returned in source order, each with its own body", () => {
		const sections = parsed("*** Add File: z.ts", "+z", "*** Delete File: d.ts", "*** Update File: u.ts", "@@", "-u", "+U");
		expect(sections.map((section) => `${section.op}:${section.path}`)).toEqual(["add:z.ts", "delete:d.ts", "update:u.ts"]);
	});

	it("P7: an Update body keeps a blank context line and a `*** `-free line starting with a space", () => {
		expect(parsed("*** Update File: a.ts", "@@", " ctx", "", "-x", "+y")).toEqual([
			{ op: "update", path: "a.ts", move_to: null, body: ["@@", " ctx", "", "-x", "+y"] },
		]);
	});

	it("P8: the section path is taken VERBATIM after the single-space prefix — no trimming", () => {
		expect(parsed("*** Delete File: a b.ts ")).toEqual([{ op: "delete", path: "a b.ts " }]);
	});
});

describe("parseStrictPatchSections — negative (must reject)", () => {
	it("N1: an unknown `*** ` directive is unknown_section_header, never silently dropped", () => {
		expect(refusedCode("*** Bogus Directive: x", "*** Delete File: a.ts")).toBe("unknown_section_header");
	});

	it("N2: a header whose verb is known but whose separator is not exactly `: ` is unknown_section_header", () => {
		expect(refusedCode("*** Add File:src/a.ts", "+x")).toBe("unknown_section_header");
	});

	it("N3: a body line before the first section is body_before_section", () => {
		expect(refusedCode("+stray", "*** Add File: a.ts", "+x")).toBe("body_before_section");
	});

	it("N4: a Move before the first section is body_before_section", () => {
		expect(refusedCode("*** Move to: b.ts", "*** Update File: a.ts", "@@", "-a", "+b")).toBe("body_before_section");
	});

	it("N5: a Delete section carrying a body is delete_section_has_body", () => {
		expect(refusedCode("*** Delete File: a.ts", "+ignored")).toBe("delete_section_has_body");
	});

	it("N6: a Delete section carrying a blank line is still delete_section_has_body", () => {
		expect(refusedCode("*** Delete File: a.ts", "")).toBe("delete_section_has_body");
	});

	it("N7: an Add body line without a `+` prefix is malformed_add_body", () => {
		expect(refusedCode("*** Add File: a.ts", "+ok", "not-added")).toBe("malformed_add_body");
	});

	it("N8: a bare blank line inside an Add body is malformed_add_body — an empty line is written as `+`", () => {
		expect(refusedCode("*** Add File: a.ts", "+ok", "")).toBe("malformed_add_body");
	});

	it("N9: a Move after a hunk line is misplaced_move", () => {
		expect(refusedCode("*** Update File: a.ts", "@@", "-a", "+b", "*** Move to: b.ts")).toBe("misplaced_move");
	});

	it("N10: a second Move on the same Update is misplaced_move", () => {
		expect(refusedCode("*** Update File: a.ts", "*** Move to: b.ts", "*** Move to: c.ts", "@@", "-a", "+b")).toBe("misplaced_move");
	});

	it("N11: a Move attached to an Add section is move_on_non_update", () => {
		expect(refusedCode("*** Add File: a.ts", "*** Move to: b.ts", "+x")).toBe("move_on_non_update");
	});

	it("N12: a Move attached to a Delete section is move_on_non_update", () => {
		expect(refusedCode("*** Delete File: a.ts", "*** Move to: b.ts")).toBe("move_on_non_update");
	});

	it("N13: no section at all is empty_patch", () => {
		expect(refusedCode()).toBe("empty_patch");
	});

	it("N14: the FIRST failure in source order is reported — a later valid section does not rescue it", () => {
		expect(refusedCode("*** Delete File: a.ts", "+body", "*** Bogus: x")).toBe("delete_section_has_body");
	});
});
