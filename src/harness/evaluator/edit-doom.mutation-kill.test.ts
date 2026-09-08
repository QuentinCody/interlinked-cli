// Mutation-kill companion for edit-doom.ts (fleet pass-1, W6/LEAN MODE).
// Exact-observable assertions targeting the survivor set from
// `mutation survivors --file src/harness/evaluator/edit-doom.ts --json`.
// Grouped by symbol; each fixture's mapping to specific mutantIds is
// recorded in scratch/fleet-r3/receipts/edit-doom.jsonl, not repeated inline.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	analyzeApplyPatchDoom,
	analyzeStrReplaceDoom,
	formatDoomReason,
	type EditDoom,
} from "./edit-doom.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "edit-doom-mk-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

// ===========================================
// formatDoomReason via hand-built EditDoom — entryPrefix / atomicityNote /
// formatMissingReason boundary matrix. EditDoom is a plain exported
// interface, so these fixtures probe the formatter directly without going
// through the file-simulation path, pinning full exact strings.
// ===========================================
describe("formatDoomReason(missing) — entryPrefix/atomicityNote/simNote boundary matrix", () => {
	// test-contract: invariant — a bare (entryCount=1) missing-anchor reason
	// carries no entry prefix, no atomicity note, and no "checked against"
	// simulation note; the two internal "" fallbacks and the trailing
	// trimEnd() must leave exactly this text.
	it("renders the bare-Edit shape with no MultiEdit furniture", () => {
		const doom: EditDoom = {
			kind: "missing",
			filePath: "/probe/a.ts",
			oldString: "ZZZ_A",
			entryIndex: 1,
			entryCount: 1,
			content: "",
			occurrenceLines: [],
		};
		expect(formatDoomReason(doom)).toBe(
			"Edit will fail: old_string not found in /probe/a.ts. The file content differs from what this edit expected.",
		);
	});

	// test-contract: invariant — entryIndex=1 of a MultiEdit (entryCount>1)
	// shows the "entry 1 of N" prefix and the non-"first entry" atomicity
	// wording ("MultiEdit is atomic" with no "Entries 1–0 would have
	// applied" preamble), and no simulation note (entryIndex is not >1).
	it("renders the first-entry-of-a-MultiEdit shape", () => {
		const doom: EditDoom = {
			kind: "missing",
			filePath: "/probe/b.ts",
			oldString: "ZZZ_B",
			entryIndex: 1,
			entryCount: 3,
			content: "",
			occurrenceLines: [],
		};
		expect(formatDoomReason(doom)).toBe(
			"Edit will fail: entry 1 of 3: old_string not found in /probe/b.ts. The file content differs from what this edit expected.\nMultiEdit is atomic — nothing was applied. Re-issue the full call with this entry fixed.",
		);
	});

	// test-contract: invariant — entryIndex=2 of a MultiEdit shows the
	// simulation note, the "Entries 1–1 would have applied" preamble
	// (entryIndex - 1, not + 1), and the "entry 2 of 3" prefix.
	it("renders a later-entry-of-a-MultiEdit shape with the simulation note", () => {
		const doom: EditDoom = {
			kind: "missing",
			filePath: "/probe/c.ts",
			oldString: "ZZZ_C",
			entryIndex: 2,
			entryCount: 3,
			content: "",
			occurrenceLines: [],
		};
		expect(formatDoomReason(doom)).toBe(
			"Edit will fail: entry 2 of 3: old_string not found in /probe/c.ts (checked against the file with earlier entries applied). The file content differs from what this edit expected.\nEntries 1–1 would have applied, but MultiEdit is atomic — nothing was applied. Re-issue the full call with this entry fixed.",
		);
	});

	// test-contract: invariant — entryCount<=1 must suppress both the simNote and the atomicityNote regardless of entryIndex, even for a structurally-valid entryIndex > entryCount.
	it("keeps entryCount<=1 authoritative over entryIndex for both the simNote and atomicityNote", () => {
		const doom: EditDoom = {
			kind: "missing",
			filePath: "/probe/d.ts",
			oldString: "ZZZ_D",
			entryIndex: 2,
			entryCount: 1,
			content: "",
			occurrenceLines: [],
		};
		expect(formatDoomReason(doom)).toBe(
			"Edit will fail: old_string not found in /probe/d.ts. The file content differs from what this edit expected.",
		);
	});
});

describe("formatDoomReason(ambiguous) — site-list cap/join/extra-suffix matrix", () => {
	// test-contract: invariant — with more than MULTI_MATCH_SITE_CAP (5)
	// occurrences, the site list is capped at 5, comma-joined, and the
	// omitted count is reported as "(+2 more)".
	it("caps the rendered site list at 5 and reports the omitted count", () => {
		const doom: EditDoom = {
			kind: "ambiguous",
			filePath: "/probe/e.ts",
			oldString: "ZZZ_E",
			entryIndex: 1,
			entryCount: 1,
			content: "",
			occurrenceLines: [10, 20, 30, 40, 50, 60, 70],
		};
		expect(formatDoomReason(doom)).toBe(
			"Edit will fail: old_string matches 7 times in /probe/e.ts (L10, L20, L30, L40, L50 (+2 more)) and replace_all is not set. Either pass replace_all: true to change every site, or widen old_string until it is unique.",
		);
	});

	// test-contract: invariant — with occurrenceLines.length <= 5, the
	// "+N more" suffix must be fully absent (not "+0 more").
	it("omits the omitted-count suffix entirely when nothing was capped", () => {
		const doom: EditDoom = {
			kind: "ambiguous",
			filePath: "/probe/f.ts",
			oldString: "ZZZ_F",
			entryIndex: 1,
			entryCount: 1,
			content: "",
			occurrenceLines: [5, 9],
		};
		expect(formatDoomReason(doom)).toBe(
			"Edit will fail: old_string matches 2 times in /probe/f.ts (L5, L9) and replace_all is not set. Either pass replace_all: true to change every site, or widen old_string until it is unique.",
		);
	});
});

// ===========================================
// applyEntry — replaceAll branch selection, observed through a two-entry
// MultiEdit where the SECOND entry's doom kind/index reveals what the
// FIRST entry actually did to shared content.
// ===========================================
describe("applyEntry — replaceAll branch selection (via MultiEdit follow-through)", () => {
	// test-contract: invariant — replace_all:true must replace EVERY occurrence (split/join), so a follow-up entry re-targeting the replaced text finds zero anchors left, not one.
	it("replace_all:true clears every occurrence, leaving nothing for a follow-up entry to match", () => {
		const target = join(dir, "dup.js");
		writeFileSync(target, "dup\ndup\ndup\n");
		const doom = analyzeStrReplaceDoom("MultiEdit", {
			file_path: target,
			edits: [
				{ old_string: "dup", new_string: "X", replace_all: true },
				{ old_string: "dup", new_string: "Y" },
			],
		});
		expect(doom?.kind).toBe("missing");
		expect(doom?.entryIndex).toBe(2);
	});

	// test-contract: invariant — replace_all:false must use String#replace semantics (interpolating `$&`), not split/join semantics (literal `$&`), observed via a follow-up entry anchored to the interpolated result.
	it("replace_all:false uses interpolating single-replace semantics, not literal split/join", () => {
		const target = join(dir, "target.js");
		writeFileSync(target, "line1\nTARGET\nline3\n");
		const doom = analyzeStrReplaceDoom("MultiEdit", {
			file_path: target,
			edits: [
				{ old_string: "TARGET", new_string: "prefix-$&-suffix" },
				{ old_string: "prefix-TARGET-suffix", new_string: "Z" },
			],
		});
		expect(doom).toBeNull();
	});
});

// ===========================================
// replaceEntries — internal parser, exercised only through
// analyzeStrReplaceDoom's observable return value.
// ===========================================
describe("replaceEntries — bare-Edit field validation (AND vs OR / per-operand forcing)", () => {
	const FILE = [
		"function greet(name) {",
		'  const msg = "Hello, " + name;',
		"  console.log(msg);",
		"}",
		"const tail = 1;",
		"const tail = 1;",
		"",
	].join("\n");
	let target: string;

	beforeEach(() => {
		target = join(dir, "sample.js");
		writeFileSync(target, FILE);
	});

	// test-contract: invariant — old_string present without new_string must
	// fail open (both fields are required together for the bare-Edit shape;
	// a one-sided AND->OR relaxation would wrongly admit the entry).
	it("requires BOTH old_string and new_string as strings — old_string alone fails open", () => {
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: "const tail = 1;",
		});
		expect(doom).toBeNull();
	});

	// test-contract: invariant — new_string present without old_string must
	// also fail open (isolates the left AND-operand from a forced-true
	// mutation on it specifically).
	it("requires BOTH old_string and new_string as strings — new_string alone fails open", () => {
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			new_string: "y",
		});
		expect(doom).toBeNull();
	});
});

describe("replaceEntries — MultiEdit array element/field validation", () => {
	const FILE = [
		"function greet(name) {",
		'  const msg = "Hello, " + name;',
		"  console.log(msg);",
		"}",
	].join("\n");
	let target: string;

	beforeEach(() => {
		target = join(dir, "sample.js");
		writeFileSync(target, FILE);
	});

	// test-contract: invariant — a null array element must be rejected
	// BEFORE any property access on it; a disabled/relaxed guard reaches
	// `null.old_string` and throws instead of failing open with null.
	it("rejects a null edits[] element before any property access", () => {
		expect(() =>
			analyzeStrReplaceDoom("MultiEdit", { file_path: target, edits: [null] }),
		).not.toThrow();
		expect(
			analyzeStrReplaceDoom("MultiEdit", { file_path: target, edits: [null] }),
		).toBeNull();
	});

	// test-contract: invariant — a function-shaped element (typeof
	// "function", not "object") is rejected by the object-shape guard even
	// when it carries valid-looking old_string/new_string properties.
	it("rejects a function-shaped edits[] element even with valid-looking properties attached", () => {
		const callable = Object.assign(() => undefined, {
			old_string: "totally absent xyz",
			new_string: "x",
		});
		const doom = analyzeStrReplaceDoom("MultiEdit", {
			file_path: target,
			edits: [callable],
		});
		expect(doom).toBeNull();
	});

	// test-contract: invariant — each array element independently requires
	// BOTH old_string and new_string as strings; a wrong-typed field on
	// EITHER side of the pair must reject the whole call (fail-open,
	// atomic — never partially parse malformed MultiEdit entries).
	it("rejects when new_string is the wrong type on an otherwise-valid element", () => {
		const doom = analyzeStrReplaceDoom("MultiEdit", {
			file_path: target,
			edits: [
				{ old_string: "console.log(msg);", new_string: 42 },
				{ old_string: "not in the file", new_string: "x" },
			],
		});
		expect(doom).toBeNull();
	});

	// test-contract: invariant — the wrong-type guard covers old_string independently of new_string; a wrong-typed old_string alone must reject the whole call.
	it("rejects when old_string is the wrong type on an otherwise-valid element", () => {
		const doom = analyzeStrReplaceDoom("MultiEdit", {
			file_path: target,
			edits: [
				{ old_string: 42, new_string: "console.warn(msg);" },
				{ old_string: "not in the file", new_string: "x" },
			],
		});
		expect(doom).toBeNull();
	});
});

describe("replaceEntries — replace_all: true (strict-equality parsing)", () => {
	// test-contract: invariant — replace_all is read via strict `=== true`;
	// an explicit `replace_all: true` on a multi-occurrence entry must be
	// honored as replaceAll (no ambiguous doom), not silently coerced to
	// false or inverted.
	it("honors an explicit replace_all: true on a multi-occurrence entry (no doom)", () => {
		const target = join(dir, "dup.js");
		writeFileSync(target, "dup\ndup\ndup\n");
		const doom = analyzeStrReplaceDoom("MultiEdit", {
			file_path: target,
			edits: [{ old_string: "dup", new_string: "X", replace_all: true }],
		});
		expect(doom).toBeNull();
	});

	// test-contract: invariant — an ABSENT replace_all on a multi-occurrence
	// entry must parse as false (ambiguous doom fires), not be coerced or
	// inverted to true.
	it("treats an absent replace_all as false on a multi-occurrence entry (ambiguous doom)", () => {
		const target = join(dir, "dup.js");
		writeFileSync(target, "dup\ndup\ndup\n");
		const doom = analyzeStrReplaceDoom("MultiEdit", {
			file_path: target,
			edits: [{ old_string: "dup", new_string: "X" }],
		});
		expect(doom?.kind).toBe("ambiguous");
	});
});

// ===========================================
// analyzeStrReplaceDoom — filePath type/emptiness guard, occurrenceLines
// field on the "missing" kind, and MultiEdit entryIndex arithmetic at a
// repeated occurrence (ambiguous branch, ordinalWithinSymbol=1).
// ===========================================
describe("analyzeStrReplaceDoom — filePath guard (typeof/OR/length disjuncts)", () => {
	// test-contract: invariant — a non-string filePath (e.g. a Buffer that
	// Node's fs layer would otherwise accept as a valid path) must fail
	// open unconditionally; the guard must not depend on the buffer's
	// byte-length being nonzero to still reject it.
	it("fails open for a Buffer filePath even though Node's fs would accept it and find a real file", () => {
		const target = join(dir, "sample.js");
		writeFileSync(target, ["const tail = 1;", "const tail = 1;", ""].join("\n"));
		const bufferPath = Buffer.from(target);
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: bufferPath,
			old_string: "const tail = 1;",
			new_string: "x",
		});
		expect(doom).toBeNull();
	});
});

describe("analyzeStrReplaceDoom — missing-kind occurrenceLines field", () => {
	// test-contract: invariant — a "missing" doom's occurrenceLines is
	// always exactly [] (there are zero occurrences to line-number by
	// definition); it must not be a placeholder non-empty array.
	it("reports an empty occurrenceLines array for a missing-kind doom", () => {
		const target = join(dir, "sample.js");
		writeFileSync(target, "one\ntwo\nthree\n");
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: "absent xyz",
			new_string: "x",
		});
		expect(doom?.kind).toBe("missing");
		expect(doom?.occurrenceLines).toEqual([]);
	});
});

describe("analyzeStrReplaceDoom — entryIndex arithmetic on the ambiguous branch", () => {
	// test-contract: invariant — entryIndex is 1-based (i + 1) on the
	// AMBIGUOUS branch specifically (not just the missing branch): a
	// second MultiEdit entry (i=1) that dooms as ambiguous must report
	// entryIndex 2, not 0.
	it("reports entryIndex 2 (not 0) when the SECOND MultiEdit entry dooms as ambiguous", () => {
		const target = join(dir, "sample.js");
		writeFileSync(
			target,
			["function greet(name) {", "const tail = 1;", "const tail = 1;", ""].join("\n"),
		);
		const doom = analyzeStrReplaceDoom("MultiEdit", {
			file_path: target,
			edits: [
				{ old_string: "function greet(name) {", new_string: "function greet(who) {" },
				{ old_string: "const tail = 1;", new_string: "const tail = 2;" },
			],
		});
		expect(doom?.kind).toBe("ambiguous");
		expect(doom?.entryIndex).toBe(2);
	});
});

// ===========================================
// analyzeApplyPatchDoom — tool/op filters, warning cap boundary, and the
// Add-File-section-is-exempt behavior.
// ===========================================
describe("analyzeApplyPatchDoom — wrong toolName fails open even with a real mismatch payload", () => {
	// test-contract: invariant — the toolName filter must reject BEFORE any
	// parsing occurs; a payload that WOULD produce a doom under
	// "apply_patch" must still yield [] under any other tool name.
	it("returns [] for a non-apply_patch tool even when the patch body would otherwise doom", () => {
		const target = join(dir, "sample.txt");
		writeFileSync(target, "real file content here\n");
		const patch = [
			"*** Begin Patch",
			`*** Update File: ${target}`,
			" this context does not match",
			"*** End Patch",
		].join("\n");
		expect(analyzeApplyPatchDoom("Edit", { command: patch })).toEqual([]);
	});
});

describe("analyzeApplyPatchDoom — non-update sections are exempt regardless of existence", () => {
	// test-contract: invariant — an Add File section is exempt from the
	// doom check entirely (its op !== "update"), even when its target path
	// does not exist on disk — the op-filter must run before any fs check.
	it("does not doom an Add File section pointing at a path that does not exist yet", () => {
		const patch = [
			"*** Begin Patch",
			`*** Add File: ${join(dir, "never-created.js")}`,
			"+new content",
			"*** End Patch",
		].join("\n");
		expect(analyzeApplyPatchDoom("apply_patch", { command: patch })).toEqual([]);
	});
});

describe("analyzeApplyPatchDoom — warning cap boundary (exactly APPLY_PATCH_WARNING_CAP + 1 sections)", () => {
	// test-contract: invariant — the cap check runs BEFORE each push, using
	// >= (not >): with exactly 4 doomed sections, the 4th must be dropped
	// by the break, leaving exactly 3 — not 4.
	it("caps at exactly 3 warnings for a 4-section all-missing patch", () => {
		const patch = [
			"*** Begin Patch",
			...Array.from({ length: 4 }, (_, i) => [
				`*** Update File: ${join(dir, `missing-${i}.js`)}`,
				" ctx",
				"-old",
				"+new",
			]).flat(),
			"*** End Patch",
		].join("\n");
		const dooms = analyzeApplyPatchDoom("apply_patch", { command: patch });
		expect(dooms).toHaveLength(3);
	});
});

describe("analyzeApplyPatchDoom — genuinely empty rescue (no fabricated trailing newline)", () => {
	// test-contract: invariant — when no near-miss span clears MIN_SIMILARITY, the warning ends exactly at the trailing period; this template has no trimEnd() to absorb a stray rescue newline.
	it("ends cleanly with no rescue content and no trailing newline when nothing is similar enough", () => {
		const target = join(dir, "sample.txt");
		writeFileSync(target, "alpha bravo charlie\ndelta echo foxtrot\ngolf hotel india\n");
		const patch = [
			"*** Begin Patch",
			`*** Update File: ${target}`,
			" zzzzz totally dissimilar qqqqq wwwww",
			"-yyyyy nonmatching xxxxx vvvvv",
			"+replacement",
			"*** End Patch",
		].join("\n");
		const dooms = analyzeApplyPatchDoom("apply_patch", { command: patch });
		expect(dooms).toEqual([
			{
				path: target,
				warning: `[interlinked:apply-patch-doom][heuristic] The hunk context for ${target} does not match the live file (or is ambiguous) — apply_patch will likely fail. Re-read the file and rebuild the hunk from current content.`,
			},
		]);
	});
});

// ===========================================
// firstOldBlock (private) — exercised only through analyzeApplyPatchDoom's
// rescue text. Fixtures embed the CORRECT firstOldBlock output verbatim as
// a uniquely-matching span in the file, so any mutation to the extraction
// (break condition, prefix stripping, blank-line handling, join separator)
// changes the derived target text and therefore the exact rescue text.
// ===========================================
describe("firstOldBlock — break-on-second-hunk + addition-line exclusion + prefix stripping", () => {
	// test-contract: invariant — the rescue target stops at the first "@@", excludes "+" lines, and strips the "-"/" " prefix; the file embeds that exact 2-line result for a 100%-similar, unambiguous match.
	it("derives exactly the first hunk's context+deletion text (no addition line, no dash/space kept, no second hunk)", () => {
		const target = join(dir, "sample.txt");
		writeFileSync(
			target,
			"zqx filler noise aaa\nzqx filler noise bbb\nCTX_LINE_ONE\nDEL_LINE_TWO\nzqx filler noise ccc\nzqx filler noise ddd",
		);
		const patch = [
			"*** Begin Patch",
			`*** Update File: ${target}`,
			" CTX_LINE_ONE",
			"+ADDED_SHOULD_EXCLUDE",
			"-DEL_LINE_TWO",
			"@@ second hunk marker",
			" HUNK2_CONTEXT_MISSING",
			"*** End Patch",
		].join("\n");
		const dooms = analyzeApplyPatchDoom("apply_patch", { command: patch });
		expect(dooms).toEqual([
			{
				path: target,
				warning:
					`[interlinked:apply-patch-doom][heuristic] The hunk context for ${target} does not match the live file (or is ambiguous) — apply_patch will likely fail. Re-read the file and rebuild the hunk from current content.\n` +
					"Closest match — lines 3–4 (100% similar). Current file content for that range — copy it EXACTLY (including whitespace) as your old_string:\n" +
					"```\nCTX_LINE_ONE\nDEL_LINE_TWO\n```",
			},
		]);
	});
});

describe("firstOldBlock — blank-line continuation inside a single hunk", () => {
	// test-contract: invariant — a bare blank line (no prefix) between two context lines must be preserved as "" in the rescue target once collection has started, not dropped.
	it("preserves a mid-block blank line as an empty string, not dropping it", () => {
		const target = join(dir, "sample.txt");
		writeFileSync(
			target,
			"zqx filler alpha\nzqx filler beta\nTOP_LINE_X\n\nBOTTOM_LINE_Y\nzqx filler gamma\nzqx filler delta",
		);
		const patch = [
			"*** Begin Patch",
			`*** Update File: ${target}`,
			" TOP_LINE_X",
			"",
			" BOTTOM_LINE_Y",
			"@@ marker2",
			" UNFINDABLE_CONTEXT",
			"*** End Patch",
		].join("\n");
		const dooms = analyzeApplyPatchDoom("apply_patch", { command: patch });
		expect(dooms).toEqual([
			{
				path: target,
				warning:
					`[interlinked:apply-patch-doom][heuristic] The hunk context for ${target} does not match the live file (or is ambiguous) — apply_patch will likely fail. Re-read the file and rebuild the hunk from current content.\n` +
					"Closest match — lines 3–5 (100% similar). Current file content for that range — copy it EXACTLY (including whitespace) as your old_string:\n" +
					"```\nTOP_LINE_X\n\nBOTTOM_LINE_Y\n```",
			},
		]);
	});
});
