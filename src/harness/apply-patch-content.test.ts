import { describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	type ApplyPatchSection,
	looksLikeApplyPatch,
	parseApplyPatchSections,
	reconstructAfterContent,
} from "./apply-patch-content.js";

describe("looksLikeApplyPatch", () => {
	it("recognizes a V4A patch payload", () => {
		expect(looksLikeApplyPatch("*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch")).toBe(
			true,
		);
		expect(looksLikeApplyPatch("*** Update File: src/a.ts\n@@\n-a\n+b")).toBe(true);
	});

	it("rejects a plain Write content payload", () => {
		expect(looksLikeApplyPatch("export function f() { return 1; }")).toBe(false);
		expect(looksLikeApplyPatch("")).toBe(false);
	});
});

describe("parseApplyPatchSections", () => {
	it("parses multiple file sections in order", () => {
		const raw = [
			"*** Begin Patch",
			"*** Add File: src/a.ts",
			"+const a = 1;",
			"*** Update File: src/b.ts",
			"@@",
			" keep",
			"-old",
			"+new",
			"*** Delete File: src/c.ts",
			"*** End Patch",
		].join("\n");
		const sections = parseApplyPatchSections(raw);
		expect(sections.map((s) => [s.op, s.path])).toEqual([
			["add", "src/a.ts"],
			["update", "src/b.ts"],
			["delete", "src/c.ts"],
		]);
	});

	it("retargets a section path via Move to AND retains the source path (finding 9)", () => {
		const raw = ["*** Update File: src/old.ts", "*** Move to: src/new.ts", "@@", " a", "+b"].join(
			"\n",
		);
		const sections = parseApplyPatchSections(raw);
		expect(sections).toHaveLength(1);
		expect(nonNull(sections[0]).path).toBe("src/new.ts"); // destination
		expect(nonNull(sections[0]).fromPath).toBe("src/old.ts"); // source retained (was lost before)
		expect(nonNull(sections[0]).op).toBe("update");
	});

	it("does NOT set fromPath when Move to targets the same path", () => {
		const raw = ["*** Update File: src/a.ts", "*** Move to: src/a.ts", "@@", " x", "+y"].join("\n");
		expect(nonNull(parseApplyPatchSections(raw)[0]).fromPath).toBeUndefined();
	});

	it("excludes directive lines from the body", () => {
		const raw = "*** Begin Patch\n*** Add File: a.ts\n+line\n*** End Patch";
		const [section] = parseApplyPatchSections(raw);
		expect(nonNull(section).body).toEqual(["+line"]);
	});
});

describe("reconstructAfterContent", () => {
	const add = (body: string[]): ApplyPatchSection => ({ op: "add", path: "a.ts", body });
	const update = (body: string[]): ApplyPatchSection => ({ op: "update", path: "a.ts", body });

	it("reconstructs an Add File from its + lines", () => {
		const section = add(["+export const a = 1;", "+export const b = 2;"]);
		expect(reconstructAfterContent(section, "")).toBe("export const a = 1;\nexport const b = 2;");
	});

	it("returns empty string for a Delete File", () => {
		expect(reconstructAfterContent({ op: "delete", path: "a.ts", body: [] }, "before")).toBe("");
	});

	it("applies a single Update hunk via context matching", () => {
		const before = "line1\nold line\nline3";
		const section = update(["@@", " line1", "-old line", "+new line", " line3"]);
		expect(reconstructAfterContent(section, before)).toBe("line1\nnew line\nline3");
	});

	it("applies multiple hunks in order", () => {
		const before = "a\nb\nc\nd\ne";
		const section = update(["@@", " a", "-b", "+B", "@@", " d", "-e", "+E"]);
		expect(reconstructAfterContent(section, before)).toBe("a\nB\nc\nd\nE");
	});

	it("preserves the tail after the last hunk", () => {
		const before = "keep1\ntarget\nkeep2\nkeep3";
		const section = update(["@@", " keep1", "-target", "+changed"]);
		expect(reconstructAfterContent(section, before)).toBe("keep1\nchanged\nkeep2\nkeep3");
	});

	// --- Conservative fail-open (null) — a no-override gate must not false-block ---

	it("fails open (null) when context is not found", () => {
		const section = update(["@@", " missing-context", "-x", "+y"]);
		expect(reconstructAfterContent(section, "totally\ndifferent\nfile")).toBeNull();
	});

	it("appends an unanchored insertion at EOF like native apply_patch", () => {
		const section = update(["@@", "+just an insert with no anchor"]);
		expect(reconstructAfterContent(section, "a\nb\nc")).toBe("a\nb\nc\njust an insert with no anchor\n");
		expect(reconstructAfterContent(section, "a\nb\nc\n")).toBe("a\nb\nc\njust an insert with no anchor\n");
	});

	it("fails open (null) on an unknown line prefix", () => {
		const section = update(["@@", " a", "?weird", "+b"]);
		expect(reconstructAfterContent(section, "a\nb\nc")).toBeNull();
	});

	it("fails open (null) on an Add section containing a non-addition line", () => {
		expect(reconstructAfterContent(add(["+ok", "-unexpected removal"]), "")).toBeNull();
	});

	it("fails open (null) when a later hunk is a pure insertion with no context", () => {
		// First hunk has real context so the whole-body appendUnanchoredInsertion
		// shortcut does not apply; the second hunk is addition-only (no "-" or
		// " " lines), so its oldBlock is empty — ambiguous position, must bail.
		const before = "line1\nold\nline3";
		const section = update(["@@", " line1", "-old", "+new", "@@", "+onlyadded"]);
		expect(reconstructAfterContent(section, before)).toBeNull();
	});
});
