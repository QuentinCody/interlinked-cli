// Regression pins for the red-team 2026-10-21 round-2 re-attack on the
// baseline-integrity gate ("Scope-string re-anchor to lower a coverage-edit
// fraction", scratch/2026-10-21-red-team/harden-result.json). Root cause: the
// gate reconstructed Edits with a helper that ignored `replace_all` and gave
// up on a non-unique old_string, and a null reconstruction ALLOWED the call.
// Invariant pinned here: for an existing gated water-line, every write-capable
// call is either judged on every result it can produce or refused.
// Fixtures inject disk text or use OS temp dirs — the real `.interlinked/*.json`
// is never touched.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig } from "../rules-loader.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { evaluateBaselineIntegrityForEvent } from "./baseline-integrity-gate.js";

const COV_EDIT = ".interlinked/coverage-edit-baseline.json";
const CAPS = ".interlinked/metric-caps.json";
const S = "scoped:abc123def456";
const entry = (f: number, scope: string) => `{"f":${f},"scope":"${scope}"}`;
const SCOPED = `{"src/foo.ts":${entry(0.95, S)},"src/bar.ts":${entry(0.95, S)}}`;
const LEGACY = '{\n  "src/foo.ts": 1,\n  "src/bar.ts": 1,\n  "src/z.ts": 0.5\n}\n';
const TIGHT_CAPS = '{\n  "version": 1,\n  "max_cyclomatic": 16\n}\n';

function event(toolName: string, toolInput: Record<string, unknown>): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "red-team",
		agent_source: "claude",
		tool_name: toolName,
		tool_input: toolInput,
		timestamp: "2026-10-21T00:00:00.000Z",
		cwd: "/repo",
	};
}

/** Run the gate against injected disk text keyed by repo-relative path. */
function gate(toolName: string, toolInput: Record<string, unknown>, disk: Record<string, string>): HarnessDecision | null {
	const getDisk = (file: string) => disk[posix.normalize(file.replace(/^\/repo\//, ""))] ?? null;
	return evaluateBaselineIntegrityForEvent(event(toolName, toolInput), { getDisk });
}

function expectBlock(d: HarnessDecision | null, text: string): void {
	expect(d).toMatchObject({ decision: "block", rule_id: "baseline_integrity_gate" });
	expect(d?.reason).toContain(text);
}

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

describe("red-team 2026-10-21 — edit reconstruction — positive (must fire)", () => {
	it("P1: replace_all lowering a scoped coverage-edit fraction blocks", () => {
		const d = gate("Edit", { file_path: COV_EDIT, old_string: '"f":0.95', new_string: '"f":0.1', replace_all: true }, { [COV_EDIT]: SCOPED });
		expectBlock(d, "lowered 0.95→0.1");
	});
	it("P2: the recorded scope re-anchor, re-issued with replace_all, blocks", () => {
		const d = gate("Edit", { file_path: COV_EDIT, old_string: entry(0.95, S), new_string: entry(0.1, `${S} `), replace_all: true }, { [COV_EDIT]: SCOPED });
		expectBlock(d, "coverage-edit");
	});
	it("P3: replace_all on the legacy bare-number ledger (\": 1,\" → \": 0.1,\") blocks", () => {
		const d = gate("Edit", { file_path: COV_EDIT, old_string: ": 1,", new_string: ": 0.1,", replace_all: true }, { [COV_EDIT]: LEGACY });
		expectBlock(d, "lowered 1→0.1");
	});
	it("P4: MultiEdit with a replace_all entry blocks", () => {
		const edits = [{ old_string: '"src/z.ts": 0.5', new_string: '"src/z.ts": 0.6' }, { old_string: ": 1,", new_string: ": 0.1,", replace_all: true }];
		expectBlock(gate("MultiEdit", { file_path: COV_EDIT, edits }, { [COV_EDIT]: LEGACY }), "lowered 1→0.1");
	});
	it("P5: an ambiguous old_string without replace_all blocks as undecidable", () => {
		const d = gate("Edit", { file_path: COV_EDIT, old_string: ": 1,", new_string: ": 0.1," }, { [COV_EDIT]: LEGACY });
		expectBlock(d, "occurs 2 times");
		expect(d?.reason).toContain("Write of the full file content");
	});
	it("P6: apply_patch with a loosening hunk on metric-caps.json blocks", () => {
		const raw = patch(`*** Update File: ${CAPS}`, "@@", '   "version": 1,', '-  "max_cyclomatic": 16', '+  "max_cyclomatic": 99', " }");
		expectBlock(gate("apply_patch", { command: raw }, { [CAPS]: TIGHT_CAPS }), "max_cyclomatic raised 16→99");
	});
	it("P7: apply_patch whose hunk cannot be applied to metric-caps.json blocks as undecidable", () => {
		const raw = patch(`*** Update File: ${CAPS}`, "@@", '-  "max_cyclomatic": 17', '+  "max_cyclomatic": 99');
		expectBlock(gate("apply_patch", { patch: raw }, { [CAPS]: TIGHT_CAPS }), "cannot be applied with certainty");
	});
	it("P8: the full PreToolUse pipeline blocks a replace_all lowering on a real temp baseline", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "rt-edit-recon-")));
		try {
			mkdirSync(join(root, ".interlinked"), { recursive: true });
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "package.json"), '{"name":"x"}');
			for (const f of ["foo", "bar", "z"]) writeFileSync(join(root, `src/${f}.ts`), "export const x = 1;\n");
			const file = join(root, COV_EDIT);
			writeFileSync(file, LEGACY);
			const e: HarnessEvent = { ...event("Edit", { file_path: file, old_string: ": 1,", new_string: ": 0.1,", replace_all: true }), cwd: root, dry_run: true };
			const d = evaluatePreToolUse(e, getDefaultConfig(), undefined, new ReservationManager(), new CohortManager());
			expect(d).toMatchObject({ decision: "block", rule_id: "baseline_integrity_gate" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("red-team 2026-10-21 — edit reconstruction — further variants (must fire)", () => {
	it("V1: an Edit that also carries harmless `content` is judged on the edit too", () => {
		const d = gate("Edit", { file_path: CAPS, content: TIGHT_CAPS, old_string: '"max_cyclomatic": 16', new_string: '"max_cyclomatic": 99' }, { [CAPS]: TIGHT_CAPS });
		expectBlock(d, "max_cyclomatic raised 16→99");
	});
	it("V2: a NotebookEdit blocks as undecidable; a Copilot str_replace loosening is judged and blocks", () => {
		expectBlock(gate("NotebookEdit", { notebook_path: CAPS, new_source: "{}" }, { [CAPS]: TIGHT_CAPS }), "cannot determine");
		// Round 3 models Copilot's old_str / new_str spelling, so the shape is
		// reconstructed and the loosening itself is reported.
		expectBlock(gate("str_replace", { path: CAPS, old_str: "16", new_str: "99" }, { [CAPS]: TIGHT_CAPS }), "max_cyclomatic raised 16→99");
	});
	it("V3: a dot-segment alias of the water-line path is still gated", () => {
		const loose = TIGHT_CAPS.replace("16", "99");
		expectBlock(gate("Write", { file_path: ".interlinked/./metric-caps.json", content: loose }, { [CAPS]: TIGHT_CAPS }), "max_cyclomatic raised 16→99");
	});
	it("V4: a MultiEdit whose first entry makes the second ambiguous blocks", () => {
		const edits = [{ old_string: '"version": 1', new_string: '"version": 16' }, { old_string: "16", new_string: "99" }];
		expectBlock(gate("MultiEdit", { file_path: CAPS, edits }, { [CAPS]: TIGHT_CAPS }), "edit 2: old_string occurs 2 times");
	});
	it("V5: apply_patch moving a loose file onto metric-caps.json blocks", () => {
		const raw = patch("*** Update File: scratch/caps.json", `*** Move to: ${CAPS}`, "@@", '-  "max_cyclomatic": 40', '+  "max_cyclomatic": 41');
		const disk = { [CAPS]: TIGHT_CAPS, "scratch/caps.json": TIGHT_CAPS.replace("16", "40") };
		expectBlock(gate("apply_patch", { command: raw }, disk), "max_cyclomatic raised 16→41");
	});
	it("V6: a patch directive the section parser does not recognize still gates the water-line it names", () => {
		const raw = patch(`***  update file: ${CAPS}`, '-  "max_cyclomatic": 16', '+  "max_cyclomatic": 99');
		expectBlock(gate("apply_patch", { command: raw }, { [CAPS]: TIGHT_CAPS }), "outside any section");
	});
});

describe("red-team 2026-10-21 — edit reconstruction — negative (must not fire)", () => {
	it("N1: a replace_all that only tightens is allowed", () => {
		expect(gate("Edit", { file_path: COV_EDIT, old_string: ": 1,", new_string: ": 1.0,", replace_all: true }, { [COV_EDIT]: LEGACY })).toBeNull();
		expect(gate("Edit", { file_path: COV_EDIT, old_string: '"f":0.95', new_string: '"f":0.99', replace_all: true }, { [COV_EDIT]: SCOPED })).toBeNull();
	});
	it("N2: a Write that tightens is allowed", () => {
		expect(gate("Write", { file_path: CAPS, content: TIGHT_CAPS.replace("16", "12") }, { [CAPS]: TIGHT_CAPS })).toBeNull();
	});
	it("N3: an ambiguous old_string on an unrelated file is left untouched (no disk read)", () => {
		let reads = 0;
		const d = evaluateBaselineIntegrityForEvent(event("Edit", { file_path: "src/a.ts", old_string: "x", new_string: "y" }), {
			getDisk: () => {
				reads += 1;
				return "x x";
			},
		});
		expect(d).toBeNull();
		expect(reads).toBe(0);
	});
	it("N4: an apply_patch touching only source files, or tightening a cap, is allowed", () => {
		const src = patch("*** Update File: src/a.ts", "@@", "-x", "+y");
		expect(gate("apply_patch", { command: src }, { "src/a.ts": "x\n" })).toBeNull();
		const tighten = patch(`*** Update File: ${CAPS}`, "@@", '-  "max_cyclomatic": 16', '+  "max_cyclomatic": 14');
		expect(gate("apply_patch", { command: tighten }, { [CAPS]: TIGHT_CAPS })).toBeNull();
	});
	it("N5: creating a new water-line is still not a loosening, whatever the tool", () => {
		expect(gate("Edit", { file_path: CAPS, old_string: "a", new_string: "b" }, {})).toBeNull();
	});
});
