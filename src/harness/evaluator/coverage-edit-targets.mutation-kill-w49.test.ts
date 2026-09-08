// Mutation-kill suite for coverage-edit-targets.ts (wave pass1_w49).
// Each test is designed to fail if the specific mutant listed in its comment
// were applied to the source. Where the differentiating input required
// careful DP-table construction (the LCS mutants), the exact before/after
// pairs were derived and verified with a standalone script, not by hand.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { coverageEditPlan, coverageTargetsFor } from "./coverage-edit-targets.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cov-targets-w49-"));
	mkdirSync(join(root, "src"), { recursive: true });
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const CFG = ({
	enabled: true,
	mode: "block",
	budget_ms: 25_000,
	languages: ["js", "ts", "python"],
} satisfies NonNullable<GuardRulesConfig["per_edit_coverage"]>);

function event(toolName: string, toolInput: Record<string, unknown>): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: toolName,
		tool_input: toolInput,
		timestamp: "2026-06-07T00:00:00.000Z",
		cwd: root,
	};
}

function writeFile(rel: string, content: string): void {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

/** Assemble a V4A apply_patch payload from its body lines. */
function patch(...lines: string[]): string {
	return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

// ---------------------------------------------------------------------------
// toProjectRel (via applyPatchOverlayFiles, which uses `relPath === null`
// rather than a falsy check — so a "" result instead of null is observable).
// Kills: b6e13c796b061a25 (rel === "" -> false), a5111cefd7dbb8b7
// (StringLiteral "" -> "Stryker was here!" for that same comparison).
// ---------------------------------------------------------------------------

describe("toProjectRel — rel === '' guard rejects a path that normalizes to the root", () => {
	it("an Add File section whose path resolves to the project root yields NO overlay entry", () => {
		// "src/.." resolves (via resolve(root, "src/..")) to `root` itself, so the
		// project-relative path is "" — must be rejected, not treated as a real file.
		const plan = coverageEditPlan(
			event("apply_patch", { command: patch("*** Add File: src/..", "+hello") }),
			root,
			CFG,
		);
		expect(plan.overlayFiles).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// toProjectRel — the `.replace(/\\/g, "/")` normalization.
// Kills: 85cf49d610f53d23 ("/" -> "" in the replacement string).
// ---------------------------------------------------------------------------

describe("toProjectRel — backslashes in a resolved path are converted to forward slashes", () => {
	it("a literal backslash in the file name becomes a forward slash in relPath", () => {
		// On POSIX, backslash is just a filename character (not a separator), so
		// `relative()` can return a string containing one, which toProjectRel must
		// convert via replace(/\\/g, "/") rather than delete.
		const targets = coverageTargetsFor(
			event("Write", { file_path: `${root}/src\\weird.ts`, content: "export const a = 1;\n" }),
			root,
			CFG,
		);
		expect(targets).toHaveLength(1);
		expect(nonNull(targets[0]).relPath).toBe("src/weird.ts");
	});
});

// ---------------------------------------------------------------------------
// safeReadFile — both "" defaults (missing file, and the catch branch).
// Kills: 110b6229fe72c75f (else-branch "" -> "Stryker was here!"),
//        944f4f835760aded (catch-branch "" -> "Stryker was here!").
// A blank-context hunk (" " / bare-blank context line) only matches an
// EMPTY before-content — any other before text makes indexOfBlock fail and
// the whole reconstruction bail to null, which is exactly the observable
// difference between "" and a non-empty placeholder.
// ---------------------------------------------------------------------------

describe("safeReadFile — missing/unreadable files read as empty string, not a placeholder", () => {
	it("a nonexistent file's before-content is truly empty (else branch)", () => {
		const targets = coverageTargetsFor(
			event("apply_patch", {
				command: patch("*** Update File: src/newctx.ts", "@@", "", "+hello"),
			}),
			root,
			CFG,
		);
		expect(targets).toHaveLength(1);
		expect(nonNull(targets[0]).proposed).toBe("\nhello");
	});

	it("an unreadable (directory-shadowed) file's before-content is truly empty (catch branch)", () => {
		mkdirSync(join(root, "src", "cantread2.ts"), { recursive: true });
		const targets = coverageTargetsFor(
			event("apply_patch", {
				command: patch("*** Update File: src/cantread2.ts", "@@", "", "+hello"),
			}),
			root,
			CFG,
		);
		expect(targets).toHaveLength(1);
		expect(nonNull(targets[0]).proposed).toBe("\nhello");
	});
});

// ---------------------------------------------------------------------------
// addedLineNumbers (the LCS diff). Each case below was derived (and checked
// against the mutated formula) with a standalone script before being copied
// in, since hand-deriving DP tables is error-prone.
// ---------------------------------------------------------------------------

describe("addedLineNumbers — LCS_CELL_BUDGET boundary is a strict '>' (not '>=')", () => {
	// Kills: db1dc748c8b760d9 (n * m > LCS_CELL_BUDGET -> >=).
	it("exactly n*m == LCS_CELL_BUDGET still uses the precise LCS diff, not the fallback", () => {
		const lineCount = 2000; // 2000 * 2000 == LCS_CELL_BUDGET (4_000_000) exactly
		const beforeLines = Array.from({ length: lineCount }, (_, i) => `line${i}`);
		writeFile("src/boundary.ts", beforeLines.join("\n")); // no trailing newline: n === lineCount
		const targets = coverageTargetsFor(
			event("apply_patch", {
				command: patch("*** Update File: src/boundary.ts", "@@", "-line1000", "+line1000_changed"),
			}),
			root,
			CFG,
		);
		expect(targets).toHaveLength(1);
		const target = nonNull(targets[0]);
		expect(target.proposed).toContain("line1000_changed");
		// The fallback (triggered by the >= mutant) marks EVERY one of the 2000
		// after-lines as edited; the precise diff marks only the one that changed.
		expect(target.editedLines?.size).toBeLessThan(10);
		expect(target.editedLines?.has(1001)).toBe(true);
	});
});

describe("addedLineNumbers — the j >= 0 fill-loop bound (not j > 0)", () => {
	// Kills: 40729be9bcda560e (j >= 0 -> j > 0 in the DP fill loop).
	// Verified with a standalone DP simulation: skipping j===0 corrupts
	// dp[*][0], which the walk queries whenever it's deciding at the first
	// (leftmost) after-line — before="Q\nY", after="Y\nY" gives edited={2}
	// under the correct fill and edited={1} once column 0 is left at its
	// zero-initialized default.
	it("a full DP fill (including j===0) yields the correct edited-line set", () => {
		writeFile("src/jbound.ts", "Q\nY");
		const targets = coverageTargetsFor(
			event("apply_patch", { command: patch("*** Update File: src/jbound.ts", "@@", "-Q", " Y", "+Y") }),
			root,
			CFG,
		);
		expect(targets).toHaveLength(1);
		expect(nonNull(targets[0]).editedLines).toEqual(new Set([2]));
	});
});

describe("addedLineNumbers — a[i] === b[j] must be a REAL equality check", () => {
	// Kills: e68fc33b21be4ea0 (a[i] === b[j] -> true, unconditional match).
	it("a genuinely different single line is reported as edited, not silently matched", () => {
		writeFile("src/onelineA.ts", "A");
		const targets = coverageTargetsFor(
			event("apply_patch", { command: patch("*** Update File: src/onelineA.ts", "@@", "-A", "+B") }),
			root,
			CFG,
		);
		expect(targets).toHaveLength(1);
		expect(nonNull(targets[0]).editedLines).toEqual(new Set([1]));
	});
});

describe("addedLineNumbers — the DP recurrence takes Math.max, not Math.min", () => {
	// Kills: cc15417c91f3c302 (Math.max -> Math.min).
	// Verified with a standalone DP simulation: before=["A","A"],
	// after=["A","C","B","A"] gives edited={2,3} under Math.max and the
	// spurious edited={2,3,4} under Math.min.
	it("a duplicated line with two genuinely-new lines inserted marks exactly the new lines", () => {
		writeFile("src/maxmin.ts", "A\nA");
		const targets = coverageTargetsFor(
			event("apply_patch", {
				command: patch("*** Update File: src/maxmin.ts", "@@", " A", "+C", "+B", " A"),
			}),
			root,
			CFG,
		);
		expect(targets).toHaveLength(1);
		const target = nonNull(targets[0]);
		expect(target.proposed).toBe("A\nC\nB\nA");
		expect(target.editedLines).toEqual(new Set([2, 3]));
	});
});

describe("addedLineNumbers — the trailing while (j < m) loop", () => {
	// Kills: 804993c7053cb09c (j < m -> true, which never terminates once the
	// main alignment loop exits with a trailing after-line still pending —
	// any test that reaches this branch times out under that mutant).
	// Kills: b00f8bb0ff187687 (j < m -> j <= m, which appends one spurious
	// out-of-range edited entry beyond the real trailing insertion).
	it("a single trailing inserted line marks exactly that line, nothing past it", () => {
		writeFile("src/trailing.ts", "A\nB");
		const targets = coverageTargetsFor(
			event("apply_patch", { command: patch("*** Update File: src/trailing.ts", "@@", " A", " B", "+C") }),
			root,
			CFG,
		);
		expect(targets).toHaveLength(1);
		expect(nonNull(targets[0]).editedLines).toEqual(new Set([3]));
	});
});

describe("addedLineNumbers — the delete-vs-insert tie-break is >=, not strict >", () => {
	// Kills: f41fcc43f3161673 (>= -> > in the walk's delete/insert decision).
	// Verified with a standalone DP simulation: before=["B","C","A"],
	// after=["A","B","B"] gives edited={2,3} under >= and edited={1,3} under >.
	it("a case with a genuine DP tie resolves to the >= (delete-preferring) branch", () => {
		writeFile("src/tie.ts", "B\nC\nA");
		const targets = coverageTargetsFor(
			event("apply_patch", {
				command: patch("*** Update File: src/tie.ts", "@@", "-B", "-C", "-A", "+A", "+B", "+B"),
			}),
			root,
			CFG,
		);
		expect(targets).toHaveLength(1);
		expect(nonNull(targets[0]).proposed).toBe("A\nB\nB");
		expect(nonNull(targets[0]).editedLines).toEqual(new Set([2, 3]));
	});
});

// ---------------------------------------------------------------------------
// targetForSection — the delete/language filters.
// Kills: 94c6943758e4fffa (section.op === "delete" -> false),
//        b5f7f14334da7f78 (StringLiteral "delete" -> "").
// ---------------------------------------------------------------------------

describe("targetForSection — a delete section is never a coverage TARGET", () => {
	it("a Delete File section yields zero coverage targets", () => {
		writeFile("src/gone.ts", "export const a = 1;\n");
		const targets = coverageTargetsFor(
			event("apply_patch", { command: patch("*** Delete File: src/gone.ts") }),
			root,
			CFG,
		);
		expect(targets).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// targetForSection / singleFileTargets — the language-allowlist filter.
// Kills (targetForSection, apply_patch route): 6b196254bd5d59ad
// (!language || !includes -> false), 0ef2ee320e49d921 (|| -> &&).
// Kills (singleFileTargets, Write route): e8ff4e08b80c7ba8 (-> false),
// 524c2ecf1c39bbe9 (|| -> &&).
// ---------------------------------------------------------------------------

describe("language allowlist — a recognized-but-disallowed language is filtered out", () => {
	const cfgTsOnly = ({ ...CFG, languages: ["ts"] } satisfies NonNullable<GuardRulesConfig["per_edit_coverage"]>);

	it("apply_patch: a .py Add section is dropped when cfg.languages excludes python", () => {
		const targets = coverageTargetsFor(
			event("apply_patch", { command: patch("*** Add File: src/new.py", "+x = 1") }),
			root,
			cfgTsOnly,
		);
		expect(targets).toEqual([]);
	});

	it("Write: a .py file is dropped when cfg.languages excludes python", () => {
		const targets = coverageTargetsFor(
			event("Write", { file_path: join(root, "src/new.py"), content: "x = 1\n" }),
			root,
			cfgTsOnly,
		);
		expect(targets).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// applyPatchOverlayFiles.
// ---------------------------------------------------------------------------

describe("applyPatchOverlayFiles — the accumulator starts as a real empty array", () => {
	// Kills: 6d3a6dc03adbab46 ([] -> ["Stryker was here"]).
	it("a patch whose only section is confinement-rejected yields an EMPTY overlay", () => {
		const plan = coverageEditPlan(
			event("apply_patch", { command: patch("*** Add File: ../escape.ts", "+export const x = 1;") }),
			root,
			CFG,
		);
		expect(plan.overlayFiles).toEqual([]);
	});
});

describe("applyPatchOverlayFiles — a deleted file's overlay content is truly empty", () => {
	// Kills: 27f7c70bb3cc0172 (StringLiteral "" -> "Stryker was here!", the
	// delete-op content field).
	it("a Delete File section's overlay entry carries content: ''", () => {
		const plan = coverageEditPlan(
			event("apply_patch", { command: patch("*** Delete File: src/gone.ts") }),
			root,
			CFG,
		);
		const gone = plan.overlayFiles.find((f) => f.relPath === "src/gone.ts");
		expect(gone?.delete).toBe(true);
		expect(gone?.content).toBe("");
	});
});

describe("applyPatchOverlayFiles — after === null must actually skip the section", () => {
	// Kills: a26b52ef2ae0dd86 (after === null -> false).
	it("an unreconstructable Update section is dropped from the overlay entirely", () => {
		const plan = coverageEditPlan(
			event("apply_patch", {
				command: patch("*** Update File: src/missing.ts", "@@", "-not present", "+changed"),
			}),
			root,
			CFG,
		);
		expect(plan.overlayFiles).toEqual([]);
	});
});

describe("applyPatchOverlayFiles — a non-moved section never emits a spurious source-vacate entry", () => {
	// Kills: 71be647cb6735e06 (fromRel !== null -> true),
	//        0a81ae8ddef98022 (whole condition -> true),
	//        75935f234810349d (&& -> ||).
	it("a plain (non-move) Update produces exactly one overlay entry", () => {
		writeFile("src/plain.ts", "export const a = 1;\n");
		const plan = coverageEditPlan(
			event("apply_patch", {
				command: patch(
					"*** Update File: src/plain.ts",
					"@@",
					"-export const a = 1;",
					"+export const a = 2;",
				),
			}),
			root,
			CFG,
		);
		expect(plan.overlayFiles).toHaveLength(1);
		expect(nonNull(plan.overlayFiles[0]).relPath).toBe("src/plain.ts");
		expect(nonNull(plan.overlayFiles[0]).delete).toBeFalsy();
	});
});

describe("applyPatchOverlayFiles — fromRel !== relPath must be evaluated for real, not assumed", () => {
	// Kills: b03fee1bb18c4418 (fromRel !== relPath -> true).
	// "src/./old.ts" and "src/old.ts" differ as RAW strings (so the parser sets
	// fromPath) but normalize to the SAME project-relative path, so a
	// source-vacate entry must NOT be pushed on top of the destination entry.
	it("a move whose source normalizes to the same path as the destination emits ONE entry, not two", () => {
		writeFile("src/old.ts", "export const a = 1;\n");
		const plan = coverageEditPlan(
			event("apply_patch", {
				command: patch(
					"*** Update File: src/./old.ts",
					"*** Move to: src/old.ts",
					"@@",
					"-export const a = 1;",
					"+export const a = 2;",
				),
			}),
			root,
			CFG,
		);
		const matching = plan.overlayFiles.filter((f) => f.relPath === "src/old.ts");
		expect(matching).toHaveLength(1);
		expect(nonNull(matching[0]).delete).toBeFalsy();
	});
});

describe("applyPatchOverlayFiles — a real move's vacated source content is truly empty", () => {
	// Kills: d3d2d2a9e9a0f60b (StringLiteral "" -> "Stryker was here!", the
	// move-source-removal content field).
	it("the vacated source overlay entry carries content: ''", () => {
		writeFile("src/old2.ts", "export const a = 1;\n");
		const plan = coverageEditPlan(
			event("apply_patch", {
				command: patch(
					"*** Update File: src/old2.ts",
					"*** Move to: src/new2.ts",
					"@@",
					"-export const a = 1;",
					"+export const a = 2;",
				),
			}),
			root,
			CFG,
		);
		const src = plan.overlayFiles.find((f) => f.relPath === "src/old2.ts");
		expect(src?.delete).toBe(true);
		expect(src?.content).toBe("");
	});
});

// ---------------------------------------------------------------------------
// patchFullSuiteReason — the fromPath test-path check is a DISTINCT branch
// from the later unconditional "moves" branch: disabling it changes the
// REASON TEXT (still non-null, but via a different message) whenever a
// section moves a TEST file to a non-test destination.
// Kills: a0ac7e1d09e60bb7 (section.fromPath && isTestPath(section.fromPath) -> false).
// ---------------------------------------------------------------------------

describe("patchFullSuiteReason — moving a test file is flagged via the test-file branch", () => {
	it("reports the 'touches test file' reason, not the generic 'moves' reason", () => {
		writeFile("src/old.test.ts", "old\n");
		const plan = coverageEditPlan(
			event("apply_patch", {
				command: patch(
					"*** Update File: src/old.test.ts",
					"*** Move to: src/renamed.ts",
					"@@",
					"-old",
					"+new",
				),
			}),
			root,
			CFG,
		);
		expect(plan.fullSuiteReason).toContain("touches test file");
	});
});

// ---------------------------------------------------------------------------
// coverageEditPlan's single-file (non-patch) overlayFiles mapper.
// Kills: 96038561dadb9423 (arrow body -> () => undefined),
//        754ed8eb0ee4d3fc (ObjectLiteral -> {}).
// ---------------------------------------------------------------------------

describe("coverageEditPlan — the single-file overlay entry carries relPath AND content", () => {
	it("a plain Write's overlayFiles entry matches its target exactly", () => {
		const plan = coverageEditPlan(
			event("Write", { file_path: join(root, "src/single.ts"), content: "export const a = 1;\n" }),
			root,
			CFG,
		);
		expect(plan.overlayFiles).toEqual([{ relPath: "src/single.ts", content: "export const a = 1;\n" }]);
	});
});
