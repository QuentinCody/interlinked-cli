import { describe, expect, it } from "vitest";
import { asCanonicalPath } from "./path-rules.js";
import { blobDigestOf, byteLengthOf } from "./post-image-apply.js";
import { projectPostImages } from "./post-image-projector.js";
import type { PreImageInputV1, ProjectedPostImageV1 } from "./post-image-projector.js";
import type { MultiEditEntryV1, NormalizedToolInputV1 } from "./types-core.js";

// ── input builders ─────────────────────────────────────────────────────────
function writeInput(path: string, content: string): NormalizedToolInputV1 {
	return {
		schema: "shadow-tool-input-v1",
		client: "claude-code",
		tool: "Write",
		semantics_version: 1,
		file_path: asCanonicalPath(path),
		content,
	};
}

function editInput(path: string, oldString: string, newString: string, replaceAll = false): NormalizedToolInputV1 {
	return {
		schema: "shadow-tool-input-v1",
		client: "claude-code",
		tool: "Edit",
		semantics_version: 1,
		file_path: asCanonicalPath(path),
		old_string: oldString,
		new_string: newString,
		replace_all: replaceAll,
	};
}

function multiEditInput(path: string, edits: readonly MultiEditEntryV1[]): NormalizedToolInputV1 {
	return {
		schema: "shadow-tool-input-v1",
		client: "claude-code",
		tool: "MultiEdit",
		semantics_version: 1,
		file_path: asCanonicalPath(path),
		edits,
	};
}

function patchInput(patch: string): NormalizedToolInputV1 {
	return {
		schema: "shadow-tool-input-v1",
		client: "codex",
		tool: "apply_patch",
		semantics_version: 1,
		patch,
		raw_source_field: "command",
	};
}

function pre(entries: Record<string, PreImageInputV1>): Map<string, PreImageInputV1> {
	return new Map(Object.entries(entries));
}

/** The projected images — throws when the projector refused, so no test body
 *  needs a branch. */
function projected(
	input: NormalizedToolInputV1,
	preImages: ReadonlyMap<string, PreImageInputV1>,
): readonly ProjectedPostImageV1[] {
	const result = projectPostImages(input, preImages);
	if (!result.ok) throw new Error(`expected a projection, got: ${result.reason} — ${result.detail}`);
	return result.images;
}

/** A compact view of the projection: tag, path, mode, and the exact bytes. */
function shape(images: readonly ProjectedPostImageV1[]): unknown[] {
	return images.map((image) =>
		image.entry.tag === "W"
			? { tag: "W", path: image.entry.path, mode: image.entry.mode, content: image.content }
			: { tag: "D", path: image.entry.path },
	);
}

function rejection(
	input: NormalizedToolInputV1,
	preImages: ReadonlyMap<string, PreImageInputV1>,
): { reason: string; detail: string } {
	const result = projectPostImages(input, preImages);
	if (result.ok) throw new Error("expected a rejection, got a projection");
	return { reason: result.reason, detail: result.detail };
}

const PATCH_UPDATE = ["*** Begin Patch", "*** Update File: src/a.ts", "@@", "-const a = 1;", "+const a = 2;", "*** End Patch"].join("\n");

describe("projectPostImages — positive (must accept)", () => {
	it("P1: Write of a NEW file — absence proven by an explicit null — emits one W at mode 100644 with the exact bytes", () => {
		const images = projected(writeInput("src/new.ts", "export const n = 1;\n"), pre({ "src/new.ts": null }));
		expect(shape(images)).toEqual([
			{ tag: "W", path: "src/new.ts", mode: "100644", content: "export const n = 1;\n" },
		]);
	});

	it("P2: the emitted entry carries the digest and UTF-8 byte count of the projected bytes", () => {
		const images = projected(writeInput("src/new.ts", "héllo"), pre({ "src/new.ts": null }));
		expect(images[0]?.entry).toEqual({
			tag: "W",
			path: "src/new.ts",
			mode: "100644",
			blob_digest: blobDigestOf("héllo"),
			bytes: byteLengthOf("héllo"),
		});
	});

	it("P3: Write OVER an existing file preserves that file's mode", () => {
		const images = projected(writeInput("bin/run.sh", "new\n"), pre({ "bin/run.sh": { mode: "100755", content: "old\n" } }));
		expect(shape(images)).toEqual([{ tag: "W", path: "bin/run.sh", mode: "100755", content: "new\n" }]);
	});

	it("P4: Edit of a single occurrence replaces exactly that occurrence", () => {
		const images = projected(editInput("src/a.ts", "one", "two"), pre({ "src/a.ts": "a one b\n" }));
		expect(shape(images)).toEqual([{ tag: "W", path: "src/a.ts", mode: "100644", content: "a two b\n" }]);
	});

	it("P5: Edit with replace_all replaces every one of three occurrences", () => {
		const images = projected(editInput("src/a.ts", "x", "y", true), pre({ "src/a.ts": "x-x-x" }));
		expect(shape(images)).toEqual([{ tag: "W", path: "src/a.ts", mode: "100644", content: "y-y-y" }]);
	});

	it("P6: a `$&` in new_string is inserted literally — never treated as a replacement pattern", () => {
		const images = projected(editInput("src/a.ts", "one", "$& $1"), pre({ "src/a.ts": "one" }));
		expect(shape(images)).toEqual([{ tag: "W", path: "src/a.ts", mode: "100644", content: "$& $1" }]);
	});

	it("P7: Edit preserves the existing mode of the edited file", () => {
		const images = projected(editInput("bin/run.sh", "old", "new"), pre({ "bin/run.sh": { mode: "100755", content: "old\n" } }));
		expect(shape(images)).toEqual([{ tag: "W", path: "bin/run.sh", mode: "100755", content: "new\n" }]);
	});

	it("P8: MultiEdit applies edits IN ORDER — edit 2 sees edit 1's result", () => {
		const images = projected(
			multiEditInput("src/a.ts", [
				{ old_string: "alpha", new_string: "beta", replace_all: false },
				{ old_string: "beta", new_string: "gamma", replace_all: false },
			]),
			pre({ "src/a.ts": "alpha\n" }),
		);
		expect(shape(images)).toEqual([{ tag: "W", path: "src/a.ts", mode: "100644", content: "gamma\n" }]);
	});

	it("P9: apply_patch Add File emits a W at 100644 whose bytes are the added line PLUS its newline", () => {
		// Codex appends a newline after every `+` line, so one added line is
		// the line plus "\n" — corrected 2026-09-05 after the review measured
		// the real tool (`+shadow-review-probe` => 20 bytes, not 19). The
		// earlier expectation here joined with "\n" and pinned the defect.
		const images = projected(
			patchInput(["*** Begin Patch", "*** Add File: src/new.ts", "+export const n = 1;", "*** End Patch"].join("\n")),
			pre({ "src/new.ts": null }),
		);
		expect(shape(images)).toEqual([{ tag: "W", path: "src/new.ts", mode: "100644", content: "export const n = 1;\n" }]);
	});

	it("P9a: the reviewer's measured probe reproduces byte for byte — 20 bytes, sha256 b552907b…", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Add File: src/probe.txt", "+shadow-review-probe", "*** End Patch"].join("\n")),
			pre({ "src/probe.txt": null }),
		);
		expect(images[0]?.content).toBe("shadow-review-probe\n");
		expect(images[0]?.entry).toMatchObject({
			bytes: 20,
			blob_digest: "b552907b209538ebb94283b8f808edf1d559c1d419faa36deb1d819863f89b5b",
		});
	});

	it("P9b: EVERY added line carries its own newline, the last one included", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Add File: src/two.ts", "+a", "+b", "*** End Patch"].join("\n")),
			pre({ "src/two.ts": null }),
		);
		expect(images[0]?.content).toBe("a\nb\n");
	});

	it("P9c: an Add File with no `+` line at all is the EMPTY file, not a lone newline", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Add File: src/empty.ts", "*** End Patch"].join("\n")),
			pre({ "src/empty.ts": null }),
		);
		expect(shape(images)).toEqual([{ tag: "W", path: "src/empty.ts", mode: "100644", content: "" }]);
	});

	it("P10: apply_patch Update File emits the exact post bytes against the pre-image", () => {
		const images = projected(patchInput(PATCH_UPDATE), pre({ "src/a.ts": "const a = 1;\n" }));
		expect(shape(images)).toEqual([{ tag: "W", path: "src/a.ts", mode: "100644", content: "const a = 2;\n" }]);
	});

	it("P11: apply_patch Delete File emits a D for the removed path", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Delete File: src/gone.ts", "*** End Patch"].join("\n")),
			pre({ "src/gone.ts": "bye\n" }),
		);
		expect(shape(images)).toEqual([{ tag: "D", path: "src/gone.ts" }]);
	});

	it("P12: apply_patch Move is a D for the source plus a W for the destination, and the NEW destination is 100644", () => {
		// Corrected 2026-09-05 (D34). This case used to expect 100755 — the
		// source's mode carried across. The reviewer measured the real tool
		// moving a 100755 file to an absent destination and landing at 100644:
		// `write_file` writes bytes and never chmods, so a created destination
		// gets the default mode.
		const images = projected(
			patchInput(
				[
					"*** Begin Patch",
					"*** Update File: src/old.ts",
					"*** Move to: src/new.ts",
					"@@",
					"-const a = 1;",
					"+const a = 2;",
					"*** End Patch",
				].join("\n"),
			),
			pre({ "src/old.ts": { mode: "100755", content: "const a = 1;\n" }, "src/new.ts": null }),
		);
		expect(shape(images)).toEqual([
			{ tag: "W", path: "src/new.ts", mode: "100644", content: "const a = 2;\n" },
			{ tag: "D", path: "src/old.ts" },
		]);
	});

	it("P27: a Move onto an EXISTING destination keeps the DESTINATION's mode, not the source's", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Update File: src/old.ts", "*** Move to: bin/run.sh", "@@", "-a", "+b", "*** End Patch"].join("\n")),
			pre({ "src/old.ts": { mode: "100644", content: "a\n" }, "bin/run.sh": { mode: "100755", content: "#!/bin/sh\n" } }),
		);
		expect(shape(images)).toEqual([
			{ tag: "W", path: "bin/run.sh", mode: "100755", content: "b\n" },
			{ tag: "D", path: "src/old.ts" },
		]);
	});

	it("P28: an IN-PLACE update (no Move) still keeps the file's own mode", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Update File: bin/run.sh", "@@", "-a", "+b", "*** End Patch"].join("\n")),
			pre({ "bin/run.sh": { mode: "100755", content: "a\n" } }),
		);
		expect(shape(images)).toEqual([{ tag: "W", path: "bin/run.sh", mode: "100755", content: "b\n" }]);
	});

	it("P29: two ordered hunks in one Update section both apply against the pre-image", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Update File: src/a.ts", "@@", "-one", "+ONE", "@@", "-three", "+THREE", "*** End Patch"].join("\n")),
			pre({ "src/a.ts": "one\ntwo\nthree\n" }),
		);
		expect(shape(images)).toEqual([{ tag: "W", path: "src/a.ts", mode: "100644", content: "ONE\ntwo\nTHREE\n" }]);
	});

	it("P30: a pure-insertion hunk appends at end of file", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Update File: src/a.ts", "@@", "+tail", "*** End Patch"].join("\n")),
			pre({ "src/a.ts": "head\n" }),
		);
		expect(shape(images)).toEqual([{ tag: "W", path: "src/a.ts", mode: "100644", content: "head\ntail\n" }]);
	});

	it("P13: create-then-delete in one patch produces NO record", () => {
		const images = projected(
			patchInput(
				[
					"*** Begin Patch",
					"*** Add File: tmp/scratch.txt",
					"+temporary",
					"*** Delete File: tmp/scratch.txt",
					"*** End Patch",
				].join("\n"),
			),
			pre({ "tmp/scratch.txt": null }),
		);
		expect(images).toEqual([]);
	});

	it("P14: records are sorted by path BYTES, ascending", () => {
		const images = projected(
			patchInput(
				["*** Begin Patch", "*** Add File: z.ts", "+z", "*** Add File: a.ts", "+a", "*** End Patch"].join("\n"),
			),
			pre({ "z.ts": null, "a.ts": null }),
		);
		expect(images.map((image) => image.entry.path)).toEqual(["a.ts", "z.ts"]);
	});

	it("P16: an `@@` anchor lands the hunk on the SECOND of two identical blocks", () => {
		const images = projected(
			patchInput(
				["*** Begin Patch", "*** Update File: src/anchored.ts", "@@ function b() {", "-\treturn 1;", "+\treturn 2;", "*** End Patch"].join("\n"),
			),
			pre({ "src/anchored.ts": "function a() {\n\treturn 1;\n}\nfunction b() {\n\treturn 1;\n}\n" }),
		);
		expect(shape(images)).toEqual([
			{
				tag: "W",
				path: "src/anchored.ts",
				mode: "100644",
				content: "function a() {\n\treturn 1;\n}\nfunction b() {\n\treturn 2;\n}\n",
			},
		]);
	});

	it("P17: a bare hunk whose block occurs exactly once is accepted at that single site", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Update File: src/dup.ts", "@@", "-same(1);", "+other(1);", "*** End Patch"].join("\n")),
			pre({ "src/dup.ts": "same();\nsame(1);\n" }),
		);
		expect(shape(images)).toEqual([{ tag: "W", path: "src/dup.ts", mode: "100644", content: "same();\nother(1);\n" }]);
	});

	it("P18: a stray trailing blank line after `*** End Patch` is still a complete envelope", () => {
		const images = projected(patchInput(`${PATCH_UPDATE}\n\n`), pre({ "src/a.ts": "const a = 1;\n" }));
		expect(shape(images)).toEqual([{ tag: "W", path: "src/a.ts", mode: "100644", content: "const a = 2;\n" }]);
	});

	it("P15: a D record carries no content — a deletion has no bytes", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Delete File: src/gone.ts", "*** End Patch"].join("\n")),
			pre({ "src/gone.ts": "bye\n" }),
		);
		expect(images[0]?.content).toBeNull();
	});

	it("P19: a Move whose destination already EXISTS overwrites it — one W for the destination, one D for the source", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Update File: src/old.ts", "*** Move to: src/new.ts", "@@", "-a", "+b", "*** End Patch"].join("\n")),
			pre({ "src/old.ts": "a\n", "src/new.ts": "stale\n" }),
		);
		expect(shape(images)).toEqual([
			{ tag: "W", path: "src/new.ts", mode: "100644", content: "b\n" },
			{ tag: "D", path: "src/old.ts" },
		]);
	});

	it("P20: an Add of a path an earlier Delete in the same patch removed is known — the patch's own sections prove its state", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Delete File: a.ts", "*** Add File: a.ts", "+fresh", "*** End Patch"].join("\n")),
			pre({ "a.ts": "old\n" }),
		);
		expect(shape(images)).toEqual([{ tag: "W", path: "a.ts", mode: "100644", content: "fresh\n" }]);
	});

	it("P21: an Update of a pre-image with NO final newline emits bytes that end in exactly one", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Update File: src/a.ts", "@@", "-const a = 1;", "+const a = 2;", "*** End Patch"].join("\n")),
			pre({ "src/a.ts": "const a = 1;" }),
		);
		expect(images[0]?.content).toBe("const a = 2;\n");
	});

	it("P22: an Update of a pre-image ending in TWO newlines collapses them to one", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Update File: src/a.ts", "@@", "-const a = 1;", "+const a = 2;", "*** End Patch"].join("\n")),
			pre({ "src/a.ts": "const a = 1;\n\n" }),
		);
		expect(images[0]?.content).toBe("const a = 2;\n");
	});

	it("P23: a hunk deleting the file's only line leaves the EMPTY file — a W of 0 bytes, not a D", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Update File: src/a.ts", "@@", "-gone", "*** End Patch"].join("\n")),
			pre({ "src/a.ts": "gone\n" }),
		);
		expect(shape(images)).toEqual([{ tag: "W", path: "src/a.ts", mode: "100644", content: "" }]);
		expect(images[0]?.entry).toMatchObject({ bytes: 0 });
	});

	it("P24: a patch that deletes a file and then adds a path UNDER it is allowed — the draft no longer holds the file", () => {
		const images = projected(
			patchInput(["*** Begin Patch", "*** Delete File: src/a.ts", "*** Add File: src/a.ts/child.ts", "+child", "*** End Patch"].join("\n")),
			pre({ "src/a.ts": "old\n", "src/a.ts/child.ts": null }),
		);
		expect(shape(images)).toEqual([
			{ tag: "D", path: "src/a.ts" },
			{ tag: "W", path: "src/a.ts/child.ts", mode: "100644", content: "child\n" },
		]);
	});

	it("P25: a path whose only relation to a known file is a string prefix is NOT a conflict", () => {
		const images = projected(writeInput("src/ab.ts", "x\n"), pre({ "src/a.ts": "old\n", "src/ab.ts": null }));
		expect(shape(images)).toEqual([{ tag: "W", path: "src/ab.ts", mode: "100644", content: "x\n" }]);
	});

	it("P26: a write UNDER a path whose state the map never stated is allowed — the projector never invents a pre-image", () => {
		// `src/a.ts` is not in the map at all, so nothing is known about it.
		// Only the full-tree validators can settle that case; guessing here
		// would reject a legitimate write into an ordinary directory.
		const images = projected(writeInput("src/a.ts/child.ts", "x\n"), pre({ "src/a.ts/child.ts": null }));
		expect(shape(images)).toEqual([{ tag: "W", path: "src/a.ts/child.ts", mode: "100644", content: "x\n" }]);
	});
});

describe("projectPostImages — negative (must reject)", () => {
	it("N1: an Edit whose old_string does not occur is a projection error, never a guess", () => {
		expect(rejection(editInput("src/a.ts", "missing", "x"), pre({ "src/a.ts": "a\n" }))).toEqual({
			reason: "projection",
			detail: expect.stringContaining("not found"),
		});
	});

	it("N2: an Edit whose old_string occurs twice without replace_all is ambiguous and rejected", () => {
		expect(rejection(editInput("src/a.ts", "x", "y"), pre({ "src/a.ts": "x-x" })).detail).toContain("2");
	});

	it("N3: an Edit with an EMPTY old_string is rejected — the insertion point is undetermined", () => {
		expect(rejection(editInput("src/a.ts", "", "y"), pre({ "src/a.ts": "x" })).detail).toContain("empty");
	});

	it("N3b: an Edit whose old_string EQUALS its new_string is rejected as identical_edit_strings — never projected as an unchanged W", () => {
		expect(rejection(editInput("src/a.ts", "x", "x"), pre({ "src/a.ts": "x" }))).toEqual({
			reason: "projection",
			detail: "Edit on src/a.ts: identical_edit_strings",
		});
	});

	it("N3c: a MultiEdit ENTRY whose old_string equals its new_string is rejected, naming that entry", () => {
		const result = rejection(
			multiEditInput("src/a.ts", [
				{ old_string: "x", new_string: "y", replace_all: false },
				{ old_string: "y", new_string: "y", replace_all: false },
			]),
			pre({ "src/a.ts": "x" }),
		);
		expect(result.detail).toBe("edit 2 on src/a.ts: identical_edit_strings");
	});

	it("N4: an Edit of a file absent locally is rejected", () => {
		expect(rejection(editInput("src/a.ts", "x", "y"), pre({ "src/a.ts": null })).detail).toContain("src/a.ts");
	});

	it("N5: replace_all with zero occurrences is still rejected", () => {
		expect(rejection(editInput("src/a.ts", "missing", "y", true), pre({ "src/a.ts": "a" })).detail).toContain("not found");
	});

	it("N6: a MultiEdit whose Nth edit no longer applies is rejected, naming the edit index", () => {
		const result = rejection(
			multiEditInput("src/a.ts", [
				{ old_string: "alpha", new_string: "beta", replace_all: false },
				{ old_string: "alpha", new_string: "gamma", replace_all: false },
			]),
			pre({ "src/a.ts": "alpha\n" }),
		);
		expect(result.detail).toContain("edit 2");
	});

	it("N7: an apply_patch whose context does not match the pre-image is rejected", () => {
		expect(rejection(patchInput(PATCH_UPDATE), pre({ "src/a.ts": "const b = 9;\n" })).detail).toContain("src/a.ts");
	});

	it("N8: an apply_patch Update of a file absent locally (explicit null) is rejected", () => {
		expect(rejection(patchInput(PATCH_UPDATE), pre({ "src/a.ts": null })).detail).toContain("absent locally");
	});

	it("N9: an apply_patch Delete of an absent path is rejected", () => {
		expect(
			rejection(patchInput(["*** Begin Patch", "*** Delete File: nope.ts", "*** End Patch"].join("\n")), pre({ "nope.ts": null }))
				.detail,
		).toContain("nope.ts");
	});

	it("N10: an apply_patch Add over an existing path is rejected", () => {
		expect(
			rejection(
				patchInput(["*** Begin Patch", "*** Add File: a.ts", "+x", "*** End Patch"].join("\n")),
				pre({ "a.ts": "already here\n" }),
			).detail,
		).toContain("a.ts");
	});

	it("N11: an apply_patch carrying no file section is rejected", () => {
		expect(rejection(patchInput("*** Begin Patch\n*** End Patch"), pre({})).detail).toContain("no file section");
	});

	it("N12: a non-canonical patch path is rejected as invalid_tree", () => {
		expect(
			rejection(
				patchInput(["*** Begin Patch", "*** Add File: ../escape.ts", "+x", "*** End Patch"].join("\n")),
				pre({}),
			).reason,
		).toBe("invalid_tree");
	});

	it("N15: an `@@` anchor that matches no line is rejected as anchor_not_found", () => {
		expect(
			rejection(
				patchInput(
					["*** Begin Patch", "*** Update File: src/anchored.ts", "@@ function c() {", "-\treturn 1;", "+\treturn 2;", "*** End Patch"].join("\n"),
				),
				pre({ "src/anchored.ts": "function a() {\n\treturn 1;\n}\nfunction b() {\n\treturn 1;\n}\n" }),
			).detail,
		).toContain("anchor_not_found");
	});

	it("N16: an `@@` anchor that matches TWO lines is rejected as ambiguous_anchor", () => {
		expect(
			rejection(
				patchInput(["*** Begin Patch", "*** Update File: src/dup.ts", "@@ dup", "-tail", "+TAIL", "*** End Patch"].join("\n")),
				pre({ "src/dup.ts": "dup\nmid\ndup\ntail\n" }),
			).detail,
		).toContain("ambiguous_anchor");
	});

	it("N17: a bare hunk whose block matches TWICE is rejected as ambiguous_context, never applied to the first", () => {
		expect(
			rejection(
				patchInput(["*** Begin Patch", "*** Update File: src/dup.ts", "@@", "-same();", "+other();", "*** End Patch"].join("\n")),
				pre({ "src/dup.ts": "same();\nsame();\n" }),
			).detail,
		).toContain("ambiguous_context");
	});

	it("N18: a patch with no `*** End Patch` is TRUNCATED and is rejected before any section is projected", () => {
		expect(rejection(patchInput("*** Begin Patch\n*** Delete File: src/keep.ts"), pre({ "src/keep.ts": "keep\n" }))).toEqual({
			reason: "projection",
			detail: expect.stringContaining("missing_end_marker"),
		});
	});

	it("N13: a Write under a SYMLINK mode is rejected as symlink_escape, not projected", () => {
		expect(rejection(writeInput("link.ts", "x"), pre({ "link.ts": { mode: "120000", content: "target" } }))).toEqual({
			reason: "symlink_escape",
			detail: expect.stringContaining("link.ts"),
		});
	});

	it("N14: any other rejected mode in the pre-image is invalid_tree", () => {
		expect(
			rejection(writeInput("sub", "x"), pre({ sub: { mode: "160000", content: "" } })).reason,
		).toBe("invalid_tree");
	});

	it("N27: a Write UNDER a path the map says is a regular file is a file/directory conflict", () => {
		expect(rejection(writeInput("src/a.ts/child.ts", "x\n"), pre({ "src/a.ts": "old\n", "src/a.ts/child.ts": null }))).toEqual({
			reason: "projection",
			detail: "file/directory conflict: src/a.ts is a file and an ancestor of src/a.ts/child.ts",
		});
	});

	it("N28: a Write OVER a path that known entries already sit under is the same conflict, the other way round", () => {
		expect(rejection(writeInput("src/a.ts", "x\n"), pre({ "src/a.ts": null, "src/a.ts/child.ts": "child\n" }))).toEqual({
			reason: "projection",
			detail: "file/directory conflict: src/a.ts is a file and an ancestor of src/a.ts/child.ts",
		});
	});

	it("N29: an apply_patch Add under a known regular file is rejected too — every write goes through the same rule", () => {
		expect(
			rejection(
				patchInput(["*** Begin Patch", "*** Add File: src/a.ts/child.ts", "+x", "*** End Patch"].join("\n")),
				pre({ "src/a.ts": "old\n", "src/a.ts/child.ts": null }),
			).detail,
		).toContain("file/directory conflict");
	});

	it("N34: a Move UNDER the source is a file/directory conflict — the destination is written while the source is still a file", () => {
		// The reviewer measured the real tool failing this move: Codex writes
		// the destination FIRST, and `a.txt` still occupies the parent path.
		// This module used to release the source first and project D + W.
		expect(
			rejection(
				patchInput(["*** Begin Patch", "*** Update File: a.txt", "*** Move to: a.txt/b.txt", "@@", "-alpha", "+bravo", "*** End Patch"].join("\n")),
				pre({ "a.txt": "alpha\nomega\n", "a.txt/b.txt": null }),
			),
		).toEqual({
			reason: "projection",
			detail: "file/directory conflict: a.txt is a file and an ancestor of a.txt/b.txt",
		});
	});

	it("N35: a Move onto a destination that known entries already sit under is the same conflict", () => {
		expect(
			rejection(
				patchInput(["*** Begin Patch", "*** Update File: src/old.ts", "*** Move to: src/dir", "@@", "-a", "+b", "*** End Patch"].join("\n")),
				pre({ "src/old.ts": "a\n", "src/dir": null, "src/dir/child.ts": "child\n" }),
			).detail,
		).toContain("file/directory conflict");
	});

	it("N36: a Move onto ITSELF is refused — Codex writes then unlinks the same path, a shape v0 makes no claim about", () => {
		expect(
			rejection(
				patchInput(["*** Begin Patch", "*** Update File: src/a.ts", "*** Move to: src/a.ts", "@@", "-a", "+b", "*** End Patch"].join("\n")),
				pre({ "src/a.ts": "a\n" }),
			),
		).toEqual({ reason: "projection", detail: "apply_patch moves src/a.ts onto itself, which shadow v0 makes no claim about" });
	});

	it("N37: DEPENDENT hunks are rejected — hunk 2 may not match what hunk 1 wrote", () => {
		// The reviewer's reproduction: the real tool answers "Failed to find
		// expected lines … bravo"; this projector used to answer `charlie`.
		expect(
			rejection(
				patchInput(["*** Begin Patch", "*** Update File: a.txt", "@@", "-alpha", "+bravo", "@@", "-bravo", "+charlie", "*** End Patch"].join("\n")),
				pre({ "a.txt": "alpha\nomega\n" }),
			).detail,
		).toContain("do not match its pre-image content");
	});
});

const MISSING = (path: string) => ({ reason: "projection", detail: `missing_pre_image: ${path}` });

describe("projectPostImages — negative (must reject): an OMITTED pre-image is not proven absence", () => {
	it("N19: a Write whose target is omitted from the map is missing_pre_image, never a new file", () => {
		expect(rejection(writeInput("src/new.ts", "x"), pre({}))).toEqual(MISSING("src/new.ts"));
	});

	it("N20: an Edit whose target is omitted is missing_pre_image, not `absent locally`", () => {
		expect(rejection(editInput("src/a.ts", "x", "y"), pre({ "other.ts": "x" }))).toEqual(MISSING("src/a.ts"));
	});

	it("N21: a MultiEdit whose target is omitted is missing_pre_image", () => {
		expect(rejection(multiEditInput("src/a.ts", [{ old_string: "x", new_string: "y", replace_all: false }]), pre({}))).toEqual(MISSING("src/a.ts"));
	});

	it("N22: an apply_patch Add whose target is omitted is missing_pre_image", () => {
		expect(rejection(patchInput(["*** Begin Patch", "*** Add File: src/new.ts", "+x", "*** End Patch"].join("\n")), pre({}))).toEqual(MISSING("src/new.ts"));
	});

	it("N23: an apply_patch Delete whose target is omitted is missing_pre_image", () => {
		expect(rejection(patchInput(["*** Begin Patch", "*** Delete File: nope.ts", "*** End Patch"].join("\n")), pre({}))).toEqual(MISSING("nope.ts"));
	});

	it("N24: an apply_patch Update whose target is omitted is missing_pre_image", () => {
		expect(rejection(patchInput(PATCH_UPDATE), pre({}))).toEqual(MISSING("src/a.ts"));
	});

	it("N25: a Move whose SOURCE is present but whose destination is omitted is missing_pre_image for the destination", () => {
		expect(
			rejection(
				patchInput(["*** Begin Patch", "*** Update File: src/old.ts", "*** Move to: src/new.ts", "@@", "-a", "+b", "*** End Patch"].join("\n")),
				pre({ "src/old.ts": "a\n" }),
			),
		).toEqual(MISSING("src/new.ts"));
	});

	it("N26: a Move whose source is omitted names the SOURCE, before the destination is looked at", () => {
		expect(
			rejection(
				patchInput(["*** Begin Patch", "*** Update File: src/old.ts", "*** Move to: src/new.ts", "@@", "-a", "+b", "*** End Patch"].join("\n")),
				pre({}),
			),
		).toEqual(MISSING("src/old.ts"));
	});
});

describe("projectPostImages — negative (must reject): strict section grammar", () => {
	function sectionRejection(...inner: readonly string[]): { reason: string; detail: string } {
		return rejection(patchInput(["*** Begin Patch", ...inner, "*** End Patch"].join("\n")), pre({ "a.ts": "a\n", "b.ts": null }));
	}

	it("N27: an unknown `*** ` directive is rejected as unknown_section_header, never dropped", () => {
		expect(sectionRejection("*** Bogus Directive: x", "*** Delete File: a.ts").detail).toContain("unknown_section_header");
	});

	it("N28: a body line before the first section is body_before_section", () => {
		expect(sectionRejection("+stray", "*** Delete File: a.ts").detail).toContain("body_before_section");
	});

	it("N29: a Delete carrying a body is delete_section_has_body — the body is not ignored", () => {
		expect(sectionRejection("*** Delete File: a.ts", "+ignored").detail).toContain("delete_section_has_body");
	});

	it("N30: an Add body line without `+` is malformed_add_body", () => {
		expect(sectionRejection("*** Add File: b.ts", "+ok", "bare").detail).toContain("malformed_add_body");
	});

	it("N31: a Move after a hunk line is misplaced_move", () => {
		expect(sectionRejection("*** Update File: a.ts", "@@", "-a", "+b", "*** Move to: b.ts").detail).toContain("misplaced_move");
	});

	it("N32: a Move attached to a Delete is move_on_non_update — it does not retarget the deletion", () => {
		expect(sectionRejection("*** Delete File: a.ts", "*** Move to: b.ts").detail).toContain("move_on_non_update");
	});

	it("N33: a Move attached to an Add is move_on_non_update — it does not retarget the addition", () => {
		expect(sectionRejection("*** Add File: b.ts", "*** Move to: a.ts", "+x").detail).toContain("move_on_non_update");
	});
});
