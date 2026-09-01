import { describe, expect, it } from "vitest";
import {
	READ_EDIT_RULES,
	rebBlindEditUnreadFile,
	rebColdStartFirstEditZeroReads,
	rebImportAddedWithoutReadingModule,
	rebReadRecencyDecayEdit,
	rebReadStormNoEdit,
} from "./rules-read-edit.js";
import { applyEvent, createState } from "./state.js";
import type { ToolEvent, TrajectoryRule, Verdict } from "./types.js";

let counter = 0;
function ev(hook: string, tool: string, input: ToolEvent["input"]): ToolEvent {
	counter += 1;
	return {
		ts: `2026-07-01T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
		session: "s1",
		agent: "claude",
		tool,
		toolUseId: `u${counter}`,
		hook,
		input,
		toolOutcome: "success",
	};
}

const TWO_LINES = "line one\nline two";

function edit(file: string, oldStr = TWO_LINES, newStr = "replacement\ncode"): ToolEvent {
	return ev("PostToolUse", "Edit", { file_path: file, old_string: oldStr, new_string: newStr });
}
function read(file: string): ToolEvent {
	return ev("PostToolUse", "Read", { file_path: file });
}
function bash(command: string): ToolEvent {
	return ev("PostToolUse", "Bash", { command });
}

/** Fold every event into a fresh state, then run `rule` against the last event. */
function run(rule: TrajectoryRule, events: ToolEvent[]): Verdict | null {
	const state = createState("s1");
	for (const e of events) applyEvent(state, e);
	const last = events[events.length - 1];
	if (!last) throw new Error("run() needs at least one event");
	return rule(state, last);
}

function reads(n: number, prefix = "src/other"): ToolEvent[] {
	const out: ToolEvent[] = [];
	for (let i = 0; i < n; i++) out.push(read(`/repo/${prefix}${i}.ts`));
	return out;
}

/** n distinct reads each in its OWN directory — a directory-dispersed,
 *  low-dependency-density run (the "lost" fan-out the read-storm rule targets). */
function scatteredReads(n: number): ToolEvent[] {
	const out: ToolEvent[] = [];
	for (let i = 0; i < n; i++) out.push(read(`/repo/pkg${i}/mod.ts`));
	return out;
}

// ============================================================
// reb_blind_edit_unread_file
// ============================================================

describe("reb_blind_edit_unread_file (positive: fires)", () => {
	it("fires on a multi-line Edit to a source file never read this session", () => {
		const v = run(rebBlindEditUnreadFile, [read("/repo/src/other.ts"), edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_blind_edit_unread_file");
		expect(v?.action).toBe("nudge");
	});

	it("fires even when many OTHER files were read (only the target counts)", () => {
		const v = run(rebBlindEditUnreadFile, [...reads(5), edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_blind_edit_unread_file");
	});

	it("fires on a MultiEdit to an unread source file", () => {
		const v = run(rebBlindEditUnreadFile, [
			ev("PostToolUse", "MultiEdit", { file_path: "/repo/src/x.ts", old_string: TWO_LINES, new_string: "y\nz" }),
		]);
		expect(v?.ruleId).toBe("reb_blind_edit_unread_file");
	});
});

describe("reb_blind_edit_unread_file (negative: stays silent)", () => {
	it("does NOT fire after the file was Read", () => {
		expect(run(rebBlindEditUnreadFile, [read("/repo/src/x.ts"), edit("/repo/src/x.ts")])).toBeNull();
	});

	it("does NOT fire after a bash pseudo-read naming the file (cat with relative path)", () => {
		expect(run(rebBlindEditUnreadFile, [bash("cat src/x.ts"), edit("/repo/src/x.ts")])).toBeNull();
	});

	it("does NOT fire on a targeted single-line replacement (grep output alone locates it)", () => {
		expect(run(rebBlindEditUnreadFile, [edit("/repo/src/x.ts", "const a = 1;")])).toBeNull();
	});

	it("does NOT fire on the second edit to the same file (region already seen)", () => {
		expect(
			run(rebBlindEditUnreadFile, [edit("/repo/src/x.ts"), edit("/repo/src/x.ts", "other\nregion")]),
		).toBeNull();
	});

	it("does NOT fire on a Write (may create the file) or a non-source file", () => {
		expect(
			run(rebBlindEditUnreadFile, [
				ev("PostToolUse", "Write", { file_path: "/repo/src/new.ts", content: "a\nb" }),
			]),
		).toBeNull();
		expect(run(rebBlindEditUnreadFile, [edit("/repo/docs/notes.md")])).toBeNull();
	});
});

// ============================================================
// reb_cold_start_first_edit_zero_reads
// ============================================================

describe("reb_cold_start_first_edit_zero_reads (positive: fires)", () => {
	it("fires on the session's first Edit with zero reads and zero searches", () => {
		const v = run(rebColdStartFirstEditZeroReads, [edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_cold_start_first_edit_zero_reads");
		expect(v?.action).toBe("nudge");
		expect(v?.severity).toBe("low");
	});

	it("fires when only non-read bash ran before the first edit", () => {
		const v = run(rebColdStartFirstEditZeroReads, [bash("git status"), edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_cold_start_first_edit_zero_reads");
	});

	it("fires for a multi-line MultiEdit as the first edit", () => {
		const v = run(rebColdStartFirstEditZeroReads, [
			ev("PostToolUse", "MultiEdit", { file_path: "/repo/src/x.ts", old_string: "a\nb", new_string: "c\nd" }),
		]);
		expect(v?.ruleId).toBe("reb_cold_start_first_edit_zero_reads");
	});
});

describe("reb_cold_start_first_edit_zero_reads (negative: stays silent)", () => {
	it("does NOT fire when any file was Read first", () => {
		expect(run(rebColdStartFirstEditZeroReads, [read("/repo/src/other.ts"), edit("/repo/src/x.ts")])).toBeNull();
	});

	it("does NOT fire when a search ran first (Grep tool)", () => {
		expect(
			run(rebColdStartFirstEditZeroReads, [ev("PostToolUse", "Grep", {}), edit("/repo/src/x.ts")]),
		).toBeNull();
	});

	it("does NOT fire when a bash pseudo-read ran first", () => {
		expect(run(rebColdStartFirstEditZeroReads, [bash("cat src/x.ts"), edit("/repo/src/x.ts")])).toBeNull();
	});

	it("does NOT fire on the second edit (one-shot)", () => {
		expect(
			run(rebColdStartFirstEditZeroReads, [edit("/repo/src/x.ts"), edit("/repo/src/y.ts")]),
		).toBeNull();
	});

	it("does NOT fire on a Write create (no old_string — nothing unseen to clobber)", () => {
		expect(
			run(rebColdStartFirstEditZeroReads, [
				ev("PostToolUse", "Write", { file_path: "/repo/src/new.ts", content: "a" }),
			]),
		).toBeNull();
	});

	it("does NOT fire on a single-line first edit (verbatim/targeted patch — fully specified upfront)", () => {
		// The post-compaction/resume FP: the first action is a locatable one-line
		// replacement the user/continuation summary specified verbatim. The catalog
		// FP-guard suppresses it; a multi-line first edit would still fire.
		expect(run(rebColdStartFirstEditZeroReads, [edit("/repo/src/x.ts", "const a = 1;")])).toBeNull();
	});
});

// ============================================================
// reb_read_recency_decay_edit
// ============================================================

describe("reb_read_recency_decay_edit (positive: fires)", () => {
	it("fires when the file's read is >40 steps stale and intervening work is unrelated", () => {
		const v = run(rebReadRecencyDecayEdit, [read("/repo/src/x.ts"), ...reads(45), edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_read_recency_decay_edit");
		expect(v?.action).toBe("silent_metric");
	});

	it("fires when the original read has scrolled out of the event window entirely", () => {
		const v = run(rebReadRecencyDecayEdit, [read("/repo/src/x.ts"), ...reads(70), edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_read_recency_decay_edit");
	});

	it("fires when the intervening work is unrelated bash", () => {
		const cmds: ToolEvent[] = [];
		for (let i = 0; i < 45; i++) cmds.push(bash(`echo step-${i}`));
		const v = run(rebReadRecencyDecayEdit, [read("/repo/src/x.ts"), ...cmds, edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_read_recency_decay_edit");
	});
});

describe("reb_read_recency_decay_edit (negative: stays silent)", () => {
	it("does NOT fire when the read is recent (gap under the threshold)", () => {
		expect(
			run(rebReadRecencyDecayEdit, [read("/repo/src/x.ts"), ...reads(10), edit("/repo/src/x.ts")]),
		).toBeNull();
	});

	it("does NOT fire when the intervening work stays related to the file", () => {
		const related: ToolEvent[] = [];
		for (let i = 0; i < 45; i++) related.push(bash(`echo x.ts pass ${i}`));
		expect(
			run(rebReadRecencyDecayEdit, [read("/repo/src/x.ts"), ...related, edit("/repo/src/x.ts")]),
		).toBeNull();
	});

	it("does NOT fire for a never-read file (blind-edit territory, not decay)", () => {
		expect(run(rebReadRecencyDecayEdit, [...reads(45), edit("/repo/src/x.ts")])).toBeNull();
	});

	it("does NOT fire when a re-Read refreshed the file just before the edit", () => {
		expect(
			run(rebReadRecencyDecayEdit, [
				read("/repo/src/x.ts"),
				...reads(45),
				read("/repo/src/x.ts"),
				edit("/repo/src/x.ts"),
			]),
		).toBeNull();
	});
});

// ============================================================
// reb_read_storm_no_edit
// ============================================================

describe("reb_read_storm_no_edit (positive: fires)", () => {
	it("fires on the 10th distinct Read across unrelated directories with no edit", () => {
		const v = run(rebReadStormNoEdit, scatteredReads(10));
		expect(v?.ruleId).toBe("reb_read_storm_no_edit");
		expect(v?.action).toBe("silent_metric");
	});

	it("fires when the run starts fresh after an edit", () => {
		const v = run(rebReadStormNoEdit, [edit("/repo/src/x.ts"), ...scatteredReads(10)]);
		expect(v?.ruleId).toBe("reb_read_storm_no_edit");
	});

	it("fires once at the crossing even with an interspersed re-read", () => {
		// 9 distinct + 1 re-read of the first (no fire) + a 10th distinct → fires on the 10th.
		const v = run(rebReadStormNoEdit, [
			...scatteredReads(9),
			read("/repo/pkg0/mod.ts"),
			read("/repo/pkgTenth/mod.ts"),
		]);
		expect(v?.ruleId).toBe("reb_read_storm_no_edit");
	});
});

describe("reb_read_storm_no_edit (negative: stays silent)", () => {
	it("does NOT fire at 9 distinct reads", () => {
		expect(run(rebReadStormNoEdit, reads(9))).toBeNull();
	});

	it("does NOT fire on a re-read (not a new distinct file)", () => {
		expect(run(rebReadStormNoEdit, [...reads(9), read("/repo/src/other0.ts")])).toBeNull();
	});

	it("does NOT fire when an edit broke the run", () => {
		expect(run(rebReadStormNoEdit, [...reads(6), edit("/repo/src/x.ts"), ...reads(6, "src/late")])).toBeNull();
	});

	it("does NOT re-fire past the crossing (11th distinct read is silent)", () => {
		expect(run(rebReadStormNoEdit, reads(11))).toBeNull();
	});

	it("does NOT fire on a coherent same-directory cluster (high dependency density)", () => {
		// 10 distinct reads confined to one module directory — a focused, related
		// survey, not a scattered "lost" fan-out. The dependency-density proxy
		// (directory co-location) suppresses it even though 10 distinct files were read.
		const cluster: ToolEvent[] = [];
		for (let i = 0; i < 10; i++) cluster.push(read(`/repo/src/mod/part${i}.ts`));
		expect(run(rebReadStormNoEdit, cluster)).toBeNull();
	});
});

// ============================================================
// reb_import_added_without_reading_module
// ============================================================

describe("reb_import_added_without_reading_module (positive: fires)", () => {
	it("fires when an edit adds a relative import of a module never read or written", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("/repo/src/a.ts", "// top", 'import { x } from "./unseen.js";'),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
		expect(v?.action).toBe("silent_metric");
		expect(v?.reason).toContain("./unseen.js");
	});

	it("fires on a require() of an unseen parent-dir module", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("/repo/src/a.ts", "// top", 'const u = require("../lib/util");'),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
	});

	it("fires on a Write whose content imports an unseen sibling", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			ev("PostToolUse", "Write", {
				file_path: "/repo/src/a.ts",
				content: 'import "./side-effect.js";\nexport const a = 1;',
			}),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
	});
});

describe("reb_import_added_without_reading_module (negative: stays silent)", () => {
	it("does NOT fire when the imported module was Read (extension-insensitive)", () => {
		expect(
			run(rebImportAddedWithoutReadingModule, [
				read("/repo/src/helper.ts"),
				edit("/repo/src/a.ts", "// top", 'import { h } from "./helper.js";'),
			]),
		).toBeNull();
	});

	it("does NOT fire when the module was created by this session (exporter landed first)", () => {
		expect(
			run(rebImportAddedWithoutReadingModule, [
				ev("PostToolUse", "Write", { file_path: "/repo/src/helper.ts", content: "export const h = 1;" }),
				edit("/repo/src/a.ts", "// top", 'import { h } from "./helper.js";'),
			]),
		).toBeNull();
	});

	it("does NOT fire on package (non-relative) imports", () => {
		expect(
			run(rebImportAddedWithoutReadingModule, [
				edit("/repo/src/a.ts", "// top", 'import { program } from "commander";'),
			]),
		).toBeNull();
	});

	it("does NOT fire when the import was already present before the edit", () => {
		expect(
			run(rebImportAddedWithoutReadingModule, [
				edit(
					"/repo/src/a.ts",
					'import { x } from "./unseen.js"; // old',
					'import { x } from "./unseen.js"; // touched comment',
				),
			]),
		).toBeNull();
	});
});

// ============================================================
// Additional branch coverage — crafted-state paths + missing-field guards
// ============================================================

describe("additional branch coverage", () => {
	it("lastReadStep: does not overwrite `best` when a later-iterated match has a lower step", () => {
		// Both tokens are recorded within the SAME bash command, so they share the
		// same state.stepCount — the second matching key's `step > best` is false.
		const v = run(rebBlindEditUnreadFile, [
			bash("cat lib/x.ts other/x.ts"),
			edit("/repo/src/x.ts"),
		]);
		// Both paths suffix-match "x.ts", so the file counts as read either way.
		expect(v).toBeNull();
	});

	it("rebBlindEditUnreadFile: falls back to 0 prior edits via a crafted state with no fileEditLog entry", () => {
		const state = createState("s1");
		const event = edit("/repo/src/crafted.ts");
		// Deliberately skip applyEvent — simulates the rule seeing an edit whose
		// fold left no fileEditLog entry, exercising the `?? 0` fallback.
		const v = rebBlindEditUnreadFile(state, event);
		expect(v?.ruleId).toBe("reb_blind_edit_unread_file");
	});

	it("rebReadRecencyDecayEdit: returns null when the event has no file_path", () => {
		const state = createState("s1");
		const event = ev("PostToolUse", "Edit", { old_string: TWO_LINES, new_string: "a\nb" });
		expect(rebReadRecencyDecayEdit(state, event)).toBeNull();
	});

	it("rebReadRecencyDecayEdit: treats an empty recentEvents window as 0% unrelated (crafted state)", () => {
		const state = createState("s1");
		state.stepCount = 100;
		state.fileReadSteps.set("/repo/src/x.ts", 1);
		state.recentEvents = []; // deliberately empty — hits the `total === 0` branch
		const event = edit("/repo/src/x.ts");
		expect(rebReadRecencyDecayEdit(state, event)).toBeNull();
	});

	it("dirOf: a bare basename with no '/' yields an empty parent directory", () => {
		// All reads share the same (empty) "directory", which is itself a coherent
		// cluster — the read-storm rule should suppress, exercising the idx<0 branch.
		const bareReads: ToolEvent[] = [];
		for (let i = 0; i < 10; i++) bareReads.push(read(`bare${i}.ts`));
		expect(run(rebReadStormNoEdit, bareReads)).toBeNull();
	});

	it("rebReadStormNoEdit: returns null when the Read event has no file_path", () => {
		const state = createState("s1");
		const event = ev("PostToolUse", "Read", {});
		expect(rebReadStormNoEdit(state, event)).toBeNull();
	});

	it("rebReadStormNoEdit: skips a non-PostToolUse event in the recent-events window", () => {
		const preLeg = ev("PreToolUse", "Read", { file_path: "/repo/pkgPre/mod.ts" });
		const v = run(rebReadStormNoEdit, [preLeg, ...scatteredReads(10)]);
		expect(v?.ruleId).toBe("reb_read_storm_no_edit");
	});

	it("rebReadStormNoEdit: skips a non-Read PostToolUse tool call inside the run without breaking it", () => {
		const v = run(rebReadStormNoEdit, [
			...scatteredReads(5),
			bash("echo just looking"),
			...scatteredReads(5).map((_e, i) => read(`/repo/pkgLater${i}/mod.ts`)),
		]);
		expect(v?.ruleId).toBe("reb_read_storm_no_edit");
	});

	it("rebImportAddedWithoutReadingModule: returns null when the event has no file_path", () => {
		const state = createState("s1");
		const event = ev("PostToolUse", "Edit", { old_string: "a", new_string: 'import "./x.js";' });
		expect(rebImportAddedWithoutReadingModule(state, event)).toBeNull();
	});

	it("rebImportAddedWithoutReadingModule: returns null on a non-JS/TS file", () => {
		expect(
			run(rebImportAddedWithoutReadingModule, [
				edit("/repo/docs/notes.md", "old", 'import { x } from "./unseen.js";'),
			]),
		).toBeNull();
	});

	it("rebImportAddedWithoutReadingModule: returns null when new_string/content are both absent (crafted event)", () => {
		const state = createState("s1");
		const event = ev("PostToolUse", "Edit", { file_path: "/repo/src/a.ts", old_string: "x" });
		expect(rebImportAddedWithoutReadingModule(state, event)).toBeNull();
	});

	it("rebImportAddedWithoutReadingModule: returns null when the added text is empty", () => {
		expect(
			run(rebImportAddedWithoutReadingModule, [edit("/repo/src/a.ts", "old text", "")]),
		).toBeNull();
	});

	it("rebImportAddedWithoutReadingModule: resolves a relative (non-absolute) file_path (dir without leading '/')", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("src/a.ts", "// top", 'import { x } from "./unseen.js";'),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
	});
});

// ============================================================
// Mutation-hardening: pinned real-behavior assertions
// ============================================================
// Every case below was verified empirically against a mutated copy of the
// source (scratch/mut-probe/probe.mts): the assertion holds on real code AND
// fails against the specific mutant it targets, so these are not guesses.

describe("isPostSurgicalEdit (shared gate): every clause is load-bearing", () => {
	it("does NOT fire on a PreToolUse Edit even with a multi-line old_string (hook clause required)", () => {
		const v = run(rebBlindEditUnreadFile, [
			ev("PreToolUse", "Edit", { file_path: "/repo/src/x.ts", old_string: TWO_LINES, new_string: "y\nz" }),
		]);
		expect(v).toBeNull();
	});

	it("does NOT fire on a non-Edit/MultiEdit tool even with file_path+old_string set (tool clause required)", () => {
		const v = run(rebBlindEditUnreadFile, [
			ev("PostToolUse", "Bash", { file_path: "/repo/src/x.ts", old_string: TWO_LINES, new_string: "y\nz" }),
		]);
		expect(v).toBeNull();
	});
});

describe("metric() and rebBlindEditUnreadFile: exact severities and reason text", () => {
	it("metric() always sets severity to exactly 'low'", () => {
		const v = run(rebReadRecencyDecayEdit, [read("/repo/src/x.ts"), ...reads(45), edit("/repo/src/x.ts")]);
		expect(v?.severity).toBe("low");
	});

	it("rebBlindEditUnreadFile always sets severity to exactly 'medium'", () => {
		expect(run(rebBlindEditUnreadFile, [edit("/repo/src/x.ts")])?.severity).toBe("medium");
	});

	it("rebBlindEditUnreadFile reason names the basename and the exact trailing sentences", () => {
		const v = run(rebBlindEditUnreadFile, [edit("/repo/src/x.ts")]);
		expect(v?.reason).toContain("Multi-line edit to x.ts, which this session never read or grepped.");
		expect(v?.reason).toContain("Editing unseen content risks clobbering context the file's surroundings depend on — ");
		expect(v?.reason).toContain("read the region first.");
	});

	it("rebColdStartFirstEditZeroReads reason is the exact three-part sentence", () => {
		const v = run(rebColdStartFirstEditZeroReads, [edit("/repo/src/x.ts")]);
		expect(v?.reason).toContain("First edit of the session with zero reads and zero searches beforehand — editing an ");
		expect(v?.reason).toContain("existing file cold. Orient first (read the file or search for its usages) unless the ");
		expect(v?.reason).toContain("change was fully specified upfront.");
	});

	it("rebColdStartFirstEditZeroReads requires isPostSurgicalEdit at its OWN call site (separate from the shared helper)", () => {
		const v = run(rebColdStartFirstEditZeroReads, [
			ev("PreToolUse", "Edit", { file_path: "/repo/src/x.ts", old_string: TWO_LINES, new_string: "y\nz" }),
		]);
		expect(v).toBeNull();
	});
});

describe("lastReadStep: exact/loop precedence and max-step selection", () => {
	it("prefers the EXACT key over a later suffix-matching pseudo-read", () => {
		const events = [
			read("/repo/src/x.ts"),
			...reads(30),
			bash("cat src/x.ts"),
			...reads(14, "src/late"),
			edit("/repo/src/x.ts"),
		];
		expect(run(rebReadRecencyDecayEdit, events)?.ruleId).toBe("reb_read_recency_decay_edit");
	});

	it("recognizes a bare-basename pseudo-read via the endsWith/equals clauses", () => {
		expect(run(rebBlindEditUnreadFile, [bash("cat x.ts"), edit("/repo/src/x.ts")])).toBeNull();
	});

	it("uses endsWith, not startsWith, for the suffix-match clause", () => {
		const state = createState("s1");
		state.fileReadSteps.set("dir", 1);
		const event = edit("/dir/name.ts");
		expect(rebBlindEditUnreadFile(state, event)).not.toBeNull();
	});

	it("a crafted step-0 read still counts as a valid match (best===null must assign unconditionally)", () => {
		const state = createState("s1");
		state.fileReadSteps.set("x.ts", 0);
		expect(rebBlindEditUnreadFile(state, edit("/repo/src/x.ts"))).toBeNull();
	});

	it("among multiple matching keys inserted LOW-step-first, returns the MAX step, not the first", () => {
		const state = createState("s1");
		state.stepCount = 100;
		state.fileReadSteps.set("new/x.ts", 5);
		state.fileReadSteps.set("old/x.ts", 90);
		state.recentEvents = Array.from({ length: 50 }, () => bash("echo unrelated"));
		// real: last=90, gap=10<=40 -> null. A mutant that only keeps the FIRST
		// hit (best never updates again) would compute last=5, gap=95>40 -> fires.
		expect(rebReadRecencyDecayEdit(state, edit("/repo/src/x.ts"))).toBeNull();
	});

	it("among multiple matching keys inserted HIGH-step-first, returns the MAX step, not the last processed", () => {
		const state = createState("s1");
		state.stepCount = 100;
		state.fileReadSteps.set("old/x.ts", 90);
		state.fileReadSteps.set("new/x.ts", 5);
		state.recentEvents = Array.from({ length: 50 }, () => bash("echo unrelated"));
		// real: last=90 (max, correct compare) -> null. A mutant that always
		// overwrites unconditionally would end on the LAST-processed value (5).
		expect(rebReadRecencyDecayEdit(state, edit("/repo/src/x.ts"))).toBeNull();
	});

	it("k===base alone (no directory on either side, so endsWith('/'+k) cannot match) still recognizes the read", () => {
		const state = createState("s1");
		state.fileReadSteps.set("x.ts", 1); // bare basename key, no directory
		const event = edit("x.ts"); // edited file also has no directory
		expect(rebBlindEditUnreadFile(state, event)).toBeNull();
	});
});

describe("(module) IMPORT_SPEC_RE: whitespace after the opening paren / before it", () => {
	it("'require(' matches with a space AFTER the opening paren, before the quote", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("/repo/src/a.ts", "// top", 'const u = require( "./unseen.js");'),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
	});

	it("dynamic 'import(' matches with a space AFTER the opening paren, before the quote", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("/repo/src/a.ts", "// top", 'const u = import( "./unseen.js");'),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
	});

	it("dynamic 'import(' matches with ZERO space between 'import' and the opening paren", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("/repo/src/a.ts", "// top", 'const u = import("./unseen.js");'),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
	});

	it("JS_TS_FILE_RE recognizes an edited .mjs file, not just plain .ts/.js", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("/repo/src/a.mjs", "// top", 'import { x } from "./unseen.js";'),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
	});

	it("moduleKnown matches extension-insensitively even when the import specifier itself uses .mjs", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			read("/repo/src/util.ts"),
			edit("/repo/src/a.ts", "// top", 'import { x } from "./util.mjs";'),
		]);
		expect(v).toBeNull();
	});

	it("MODULE_EXT_RE strips only the TRAILING extension, not an extension-lookalike substring mid-path", () => {
		// "a.jsonify.js" contains ".js" mid-string (inside "jsonify") in addition
		// to the real trailing ".js" — an unanchored strip would remove the WRONG
		// occurrence and break the extension-insensitive comparison.
		const v = run(rebImportAddedWithoutReadingModule, [
			read("/repo/src/a.jsonify.ts"),
			edit("/repo/src/b.ts", "// top", 'import { x } from "./a.jsonify.js";'),
		]);
		expect(v).toBeNull();
	});
});

describe("moduleKnown: index-file resolution and the resolved.endsWith(/kn) suffix clause", () => {
	it("resolves a directory import ('./sub') to a previously-read 'sub/index' file", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			read("/repo/src/sub/index.ts"),
			edit("/repo/src/a.ts", "// top", 'import { x } from "./sub";'),
		]);
		expect(v).toBeNull();
	});

	it("matches via resolved.endsWith('/'+kn) when the read key is a directory-suffix of the resolved path", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			read("nested/helper.ts"),
			edit("/repo/a.ts", "// top", 'import { h } from "./deep/nested/helper.js";'),
		]);
		expect(v).toBeNull();
	});
});

describe("sessionHasOriented: readCount alone is sufficient", () => {
	it("readCount>0 with no searches and no fileReadSteps entries still counts as oriented (crafted state)", () => {
		const state = createState("s1");
		state.readCount = 1;
		expect(rebColdStartFirstEditZeroReads(state, edit("/repo/src/x.ts"))).toBeNull();
	});
});

describe("unrelatedFraction: window exclusion, relatedness clauses, and the ratio itself", () => {
	it("excludes the CURRENT event from its own window", () => {
		const state = createState("s1");
		state.stepCount = 100;
		state.fileReadSteps.set("/repo/src/x.ts", 1);
		const event = edit("/repo/src/x.ts");
		state.recentEvents = [bash("echo a"), bash("echo b"), event];
		// real: excluding the edit itself leaves 2/2 unrelated -> fires. If the
		// edit were NOT excluded it would count as related (same file_path),
		// dropping the ratio to 2/3 <= 0.7 -> suppressed.
		expect(rebReadRecencyDecayEdit(state, event)?.ruleId).toBe("reb_read_recency_decay_edit");
	});

	it("a matching file_path marks an event related independent of its command text", () => {
		const state = createState("s1");
		state.stepCount = 100;
		state.fileReadSteps.set("/repo/src/x.ts", 1);
		const event = edit("/repo/src/x.ts");
		state.recentEvents = [read("/repo/src/x.ts"), bash("echo a"), bash("echo b")];
		// real: the Read of the same file is related (2/3 unrelated <= 0.7) -> null.
		expect(rebReadRecencyDecayEdit(state, event)).toBeNull();
	});

	it("computes unrelated/total, not unrelated*total", () => {
		const state = createState("s1");
		state.stepCount = 100;
		state.fileReadSteps.set("/repo/src/x.ts", 1);
		const event = edit("/repo/src/x.ts");
		const relatedEvents = Array.from({ length: 19 }, () => read("/repo/src/x.ts"));
		state.recentEvents = [...relatedEvents, bash("echo unrelated")];
		// real ratio: 1/20 = 0.05 <= 0.7 -> null. A multiply mutant gives 1*20=20,
		// which also fails the <=0.7 check but for the wrong reason on OTHER
		// inputs — here it would (wrongly) NOT suppress.
		expect(rebReadRecencyDecayEdit(state, event)).toBeNull();
	});

	it("reason text names the exact trailing sentence and the leading gap/basename template", () => {
		const state = createState("s1");
		state.stepCount = 100;
		state.fileReadSteps.set("/repo/src/x.ts", 1);
		state.recentEvents = Array.from({ length: 50 }, () => bash("echo unrelated"));
		const v = rebReadRecencyDecayEdit(state, edit("/repo/src/x.ts"));
		expect(v?.reason).toContain("steps after it was last read, with the intervening");
		expect(v?.reason).toContain("work almost entirely elsewhere — the mental model of this file may be stale.");
	});
});

describe("rebReadRecencyDecayEdit: every guard clause and both thresholds are load-bearing", () => {
	it("requires an EDIT_TOOLS member (non-edit tools never reach the gap/ratio checks)", () => {
		const state = createState("s1");
		state.stepCount = 100;
		state.fileReadSteps.set("/repo/src/x.ts", 1);
		state.recentEvents = Array.from({ length: 50 }, () => bash("echo unrelated"));
		expect(rebReadRecencyDecayEdit(state, ev("PostToolUse", "Grep", { file_path: "/repo/src/x.ts" }))).toBeNull();
	});

	it("requires PostToolUse specifically, independent of the tool clause", () => {
		const state = createState("s1");
		state.stepCount = 100;
		state.fileReadSteps.set("/repo/src/x.ts", 1);
		state.recentEvents = Array.from({ length: 50 }, () => bash("echo unrelated"));
		const event = ev("PreToolUse", "Edit", { file_path: "/repo/src/x.ts", old_string: "a", new_string: "b" });
		expect(rebReadRecencyDecayEdit(state, event)).toBeNull();
	});

	it("requires BOTH a file_path present AND a source-code extension (|| not &&)", () => {
		const state = createState("s1");
		state.stepCount = 100;
		state.fileReadSteps.set("/repo/notes.md", 1);
		state.recentEvents = Array.from({ length: 50 }, () => bash("echo unrelated"));
		expect(rebReadRecencyDecayEdit(state, edit("/repo/notes.md"))).toBeNull();
	});

	it("a gap of exactly 40 steps stays at/under the threshold (boundary, not below)", () => {
		const state = createState("s1");
		state.stepCount = 41;
		state.fileReadSteps.set("/repo/src/x.ts", 1);
		state.recentEvents = Array.from({ length: 50 }, () => bash("echo unrelated"));
		expect(rebReadRecencyDecayEdit(state, edit("/repo/src/x.ts"))).toBeNull();
	});

	it("an unrelated fraction of exactly 0.7 stays at/under the threshold (boundary, not below)", () => {
		const state = createState("s1");
		state.stepCount = 100;
		state.fileReadSteps.set("/repo/src/x.ts", 1);
		const unrelated = Array.from({ length: 7 }, () => bash("echo unrelated"));
		const related = Array.from({ length: 3 }, () => read("/repo/src/x.ts"));
		state.recentEvents = [...unrelated, ...related];
		expect(rebReadRecencyDecayEdit(state, edit("/repo/src/x.ts"))).toBeNull();
	});

	it("requires 'MultiEdit' specifically to be an EDIT_TOOLS member", () => {
		const state = createState("s1");
		state.stepCount = 100;
		state.fileReadSteps.set("/repo/src/x.ts", 1);
		state.recentEvents = Array.from({ length: 50 }, () => bash("echo unrelated"));
		const event = ev("PostToolUse", "MultiEdit", { file_path: "/repo/src/x.ts", old_string: "a\nb", new_string: "c\nd" });
		expect(rebReadRecencyDecayEdit(state, event)?.ruleId).toBe("reb_read_recency_decay_edit");
	});
});

describe("dirOf and maxSameDirCount: directory grouping edge cases", () => {
	it("a leading-slash-only path and a bare filename both resolve to the empty directory (same group)", () => {
		const events: ToolEvent[] = [];
		for (let i = 0; i < 5; i++) events.push(read(`/f${i}.ts`));
		for (let i = 0; i < 5; i++) events.push(read(`b${i}.ts`));
		expect(run(rebReadStormNoEdit, events)).toBeNull();
	});

	it("tracks the running MAX across directories, small group processed AFTER the large one", () => {
		const events: ToolEvent[] = [];
		for (let i = 0; i < 6; i++) events.push(read(`/repo/dirA/f${i}.ts`));
		for (let i = 0; i < 4; i++) events.push(read(`/repo/dirB/f${i}.ts`));
		expect(run(rebReadStormNoEdit, events)).toBeNull();
	});

	it("tracks the running MAX across directories, small group processed BEFORE the large one", () => {
		const events: ToolEvent[] = [];
		for (let i = 0; i < 4; i++) events.push(read(`/repo/dirB/f${i}.ts`));
		for (let i = 0; i < 6; i++) events.push(read(`/repo/dirA/f${i}.ts`));
		expect(run(rebReadStormNoEdit, events)).toBeNull();
	});

	it("an exact half/half split (5-vs-5) is NOT a strict majority — the rule fires", () => {
		const events: ToolEvent[] = [];
		for (let i = 0; i < 5; i++) events.push(read(`/repo/dirA/f${i}.ts`));
		for (let i = 0; i < 5; i++) events.push(read(`/repo/dirB/f${i}.ts`));
		expect(run(rebReadStormNoEdit, events)?.ruleId).toBe("reb_read_storm_no_edit");
	});
});

describe("rebReadStormNoEdit: window-scan admission and re-read handling", () => {
	it("the top guard requires the Read tool (a crafted Bash-with-file_path trigger never fires)", () => {
		const events = [...scatteredReads(10), ev("PostToolUse", "Bash", { file_path: "/repo/pkgTrigger/mod.ts" })];
		expect(run(rebReadStormNoEdit, events)).toBeNull();
	});

	it("the top guard requires PostToolUse specifically (a PreToolUse Read trigger never fires)", () => {
		const events = [...scatteredReads(10), ev("PreToolUse", "Read", { file_path: "/repo/pkgTrigger/mod.ts" })];
		expect(run(rebReadStormNoEdit, events)).toBeNull();
	});

	it("requires the triggering event to carry a file_path", () => {
		expect(run(rebReadStormNoEdit, [...scatteredReads(10), ev("PostToolUse", "Read", {})])).toBeNull();
	});

	it("an edit event breaks the count-back scan entirely, even across directory-dispersed batches", () => {
		const batch1 = Array.from({ length: 4 }, (_, i) => read(`/repo/pkgA${i}/mod.ts`));
		const batch2 = Array.from({ length: 6 }, (_, i) => read(`/repo/pkgB${i}/mod.ts`));
		expect(run(rebReadStormNoEdit, [...batch1, edit("/repo/src/x.ts"), ...batch2])).toBeNull();
	});

	it("a non-Read event carrying a file_path is still excluded from the distinct count", () => {
		const events = [
			...Array.from({ length: 8 }, (_, i) => read(`/repo/pkgA${i}/mod.ts`)),
			ev("PostToolUse", "Bash", { file_path: "/repo/pkgBash/mod.ts" }),
			read("/repo/pkgTrigger/mod.ts"),
		];
		expect(run(rebReadStormNoEdit, events)).toBeNull();
	});

	it("a trigger that RE-reads an already-seen file suppresses the crossing, even at exactly 10 unique paths behind it", () => {
		const originalReads = scatteredReads(10);
		const rereadTrigger = read("/repo/pkg0/mod.ts");
		expect(run(rebReadStormNoEdit, [...originalReads, rereadTrigger])).toBeNull();
	});

	it("reason text is the exact two-sentence message", () => {
		const v = run(rebReadStormNoEdit, scatteredReads(10));
		expect(v?.reason).toContain("A long survey can be ");
		expect(v?.reason).toContain("deliberate — but if the goal was a change, it may be time to converge on one.");
	});
});

describe("resolveRelative and moduleKnown: path-math edge cases", () => {
	it("drops an empty path segment produced by a double slash, rather than pushing it", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			read("/repo/src/sub/mod.js"),
			edit("/repo/src/a.ts", "// top", 'import { x } from "./sub//mod.js";'),
		]);
		expect(v).toBeNull();
	});

	it("prefixes a relative (non-absolute) dir with '', not a sentinel string", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			read("src/helper.ts"),
			edit("src/a.ts", "// top", 'import { h } from "./helper.js";'),
		]);
		expect(v).toBeNull();
	});

	it("drops a literal '.' path segment carried in the importing file's own directory", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			read("/repo/src/helper.ts"),
			edit("/repo/src/./a.ts", "// top", 'import { h } from "./helper.js";'),
		]);
		expect(v).toBeNull();
	});

	it("moduleKnown matches via kn.endsWith(/resolved) when resolved has no directory prefix", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			read("deep/nested/helper.ts"),
			edit("a.ts", "// top", 'import { h } from "./helper.js";'),
		]);
		expect(v).toBeNull();
	});
});

describe("rebImportAddedWithoutReadingModule: guard clauses and reason formatting", () => {
	it("requires an EDIT_TOOLS member at its OWN call site (separate from other rules' identical-looking guard)", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			ev("PostToolUse", "Grep", { file_path: "/repo/src/a.ts", new_string: 'import { x } from "./unseen.js";' }),
		]);
		expect(v).toBeNull();
	});

	it("requires PostToolUse specifically at its OWN call site", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			ev("PreToolUse", "Edit", { file_path: "/repo/src/a.ts", old_string: "// top", new_string: 'import { x } from "./unseen.js";' }),
		]);
		expect(v).toBeNull();
	});

	it("caps the reason list at 3 imports and joins them with ', '", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit(
				"/repo/src/a.ts",
				"// top",
				'import { a } from "./one.js";\nimport { b } from "./two.js";\nimport { c } from "./three.js";\nimport { d } from "./four.js";',
			),
		]);
		expect(v?.reason).toContain("./one.js, ./two.js, ./three.js");
		expect(v?.reason).not.toContain("./four.js");
	});

	it("reason trailing text is the exact two-sentence message", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("/repo/src/a.ts", "// top", 'import { x } from "./unseen.js";'),
		]);
		expect(v?.reason).toContain("the imported surface (names, signatures) is assumed, not seen. A typecheck will confirm ");
		expect(v?.reason).toContain("resolution, but not intent.");
	});
});

describe("(module) IMPORT_SPEC_RE / JS_TS_FILE_RE: exact regex boundaries", () => {
	it("'from' matches with zero trailing whitespace before the quote", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("/repo/src/a.ts", "// top", 'import { x } from"./unseen.js";'),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
	});

	it("'require' matches with a space before the opening paren", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("/repo/src/a.ts", "// top", 'const u = require ("./unseen.js");'),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
	});

	it("dynamic 'import(' matches with a space before the opening paren", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("/repo/src/a.ts", "// top", 'const u = import ("./unseen.js");'),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
	});

	it("JS_TS_FILE_RE requires the extension at the END of the path, not merely present", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("/repo/src/x.ts.backup", "// top", 'import { x } from "./unseen.js";'),
		]);
		expect(v).toBeNull();
	});
});

// ============================================================
// Known gap: daemon-restart state loss reads as "never read" (pinned)
// ============================================================
// `reb_blind_edit_unread_file`'s ONLY source of "was this read?" is the
// TrajectoryState object it is handed. src/harness/server/trajectory-shadow.ts
// holds that state in a plain in-memory `Map<string, TrajectoryState>`
// (`stateBySession`), keyed by session_id, with NO persistence to disk. A
// daemon restart (rebuild, crash, RSS-ceiling auto-restart — see
// project_daemon_lifecycle_ledger) re-creates the map empty; `getState()`
// then calls `createState(session)` fresh for the SAME session_id the agent
// is still using. From the rule's point of view a state-loss is INDISTIN-
// GUISHABLE from a genuine unread — this test pins that the rule cannot see
// the difference, which is the exact mechanism behind the observed false-
// fires (files that WERE read this session, before a mid-session restart).
// This is a state-continuity gap in the daemon's wiring, not a defect in
// this file's pure functions — the fix belongs in trajectory-shadow.ts
// (e.g. rehydrate fileReadSteps from activity.jsonl on a cache miss), which
// this test-only unit must not touch.
describe("reb_blind_edit_unread_file: daemon-restart state loss (documented gap, not a bug in this file)", () => {
	it("fires on a fresh TrajectoryState even when the SAME session_id genuinely read the file earlier — a restart mid-session is indistinguishable from never-read", () => {
		// Simulates the moment right after a daemon restart: a brand-new state for
		// a session_id the agent has been using all along (createState is exactly
		// what trajectory-shadow.ts's getState() calls on a stateBySession miss).
		const stateAfterRestart = createState("continuing-session-id");
		// The agent's NEXT tool call is a multi-line edit to a file it read
		// several turns ago — but that read landed in the OLD (now-discarded)
		// TrajectoryState instance, so this fresh one has no record of it.
		const eventAfterRestart = edit("/repo/src/x.ts");
		const v = rebBlindEditUnreadFile(stateAfterRestart, eventAfterRestart);
		// Current (gap) behavior: fires as if genuinely unread. If trajectory
		// state ever gains restart-survivable persistence, this assertion should
		// flip to `.toBeNull()` — until then it pins the gap, not the fix.
		expect(v?.ruleId).toBe("reb_blind_edit_unread_file");
	});

	it("contrast: within ONE continuous state (no restart), the same read+edit sequence correctly suppresses", () => {
		// Same file, same read-then-edit shape, but folded into a SINGLE state —
		// demonstrating the rule is correct when its state isn't discarded mid-session.
		const v = run(rebBlindEditUnreadFile, [read("/repo/src/x.ts"), edit("/repo/src/x.ts")]);
		expect(v).toBeNull();
	});
});

// ============================================================
// Wiring
// ============================================================

describe("lastReadStep: relative pseudo-read keys use suffix matching", () => {
	it("matches a MULTI-SEGMENT relative pseudo-read key against an absolute edit path", () => {
		// The public contract is loose path matching: a relative pseudo-read
		// should suppress the blind-edit nudge for the corresponding absolute
		// edit, regardless of which equivalent suffix form supplies the match.
		const state = createState("s1");
		state.fileReadSteps.set("src/x.ts", 1); // deliberately NOT "x.ts" alone
		const event = edit("/repo/src/x.ts");
		expect(rebBlindEditUnreadFile(state, event)).toBeNull();
	});
});

describe("resolveRelative: '..' pops a directory segment rather than being pushed literally", () => {
	it("does NOT fire when a ../ import resolves via a proper directory pop, matching a prior read at the popped-up path", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			read("/repo/lib/util.ts"),
			edit("/repo/src/a.ts", "// top", 'import { u } from "../lib/util.js";'),
		]);
		expect(v).toBeNull();
	});
});

describe("Family 9 — wiring", () => {
	it("READ_EDIT_RULES exports all five rules", () => {
		expect(READ_EDIT_RULES).toHaveLength(5);
		expect(READ_EDIT_RULES).toContain(rebBlindEditUnreadFile);
		expect(READ_EDIT_RULES).toContain(rebColdStartFirstEditZeroReads);
		expect(READ_EDIT_RULES).toContain(rebReadRecencyDecayEdit);
		expect(READ_EDIT_RULES).toContain(rebReadStormNoEdit);
		expect(READ_EDIT_RULES).toContain(rebImportAddedWithoutReadingModule);
	});
});
