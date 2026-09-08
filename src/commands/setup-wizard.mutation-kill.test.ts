// Mutation-kill companion for setup-wizard.ts — targets the ~90 mutants that
// survived the per-edit campaign against setup-wizard.test.ts. Each test names
// the exact mutant behavior it discriminates from the original.
//
// SUSPECTED-EQUIVALENT mutants (documented here, no test written — a
// structural argument, not an empirical proof; see the campaign receipt):
//   - sharedStructuralFamilyOn: `!existsSync(path)` -> false, and the "utf-8"
//     encoding literal -> "". Both are backstopped by the enclosing
//     try/catch: readFileSync on a missing/unreadable path throws either way
//     and the catch returns false, so removing the early guard changes
//     nothing observable. The "utf-8" -> "" swap makes Node's readFileSync
//     return a Buffer instead of a string, but JSON.parse coerces a Buffer
//     via its default (also UTF-8) toString(), so the parsed result is
//     byte-identical for any real guard-rules.json content.
//   - sharedStructuralFamilyOn: the `!isJsonObject(parsed) || !isJsonObject(
//     parsed.structural_checks)` guard -> false, and its `||` -> `&&`. Every
//     JSON value for which the guard would have fired (array/null/primitive)
//     yields `.enabled === true` as `undefined === true` (false) or a thrown
//     TypeError (caught, also false) when the guard is skipped — never
//     `true`. So the guard's removal is unobservable through the boolean
//     return value.
//   - deadCodePatch: the `keep` Set (`["enabled","dead_imports","dead_exports"]`)
//     content, including emptying it or dropping any one member. All three
//     protected keys are unconditionally overwritten to `true` right after
//     the scoping loop (`structural.enabled = true; ...`), so whatever the
//     loop did to them during the scoped-down pass is erased before return.
//   - choicesFromNonInteractive: `raw.scope === "diff"` -> false. Every input
//     that would take the removed branch produces "diff" either way, because
//     DEFAULT_WIZARD_CHOICES.scope is itself "diff" — the fallback and the
//     special-cased value coincide.
//   - choicesFromNonInteractive: `raw.adopt === undefined` -> false. When
//     raw.adopt is omitted, the regex path tests the coerced string
//     "undefined" against /^(false|no|0)$/i (no match) and returns true —
//     which is also DEFAULT_WIZARD_CHOICES.adopt. Same coincidence.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyWizardChoices,
	choicesFromNonInteractive,
	DEFAULT_WIZARD_CHOICES,
	describePostureReceipt,
	describeWizardPlan,
	parseWizardYesNo,
	type WizardDeps,
	writeDeadCodeConfig,
} from "./setup-wizard.js";

describe("applyWizardChoices — mutation kill (step labels + enable options)", () => {
	// test-contract: public-api — every step failure is prefixed with its own exact label, not a blanked-out one
	it("MK1: every step failure carries its exact label, in step order", async () => {
		const deps: WizardDeps = {
			enable: async () => {
				throw new Error("E");
			},
			applyMode: async () => {
				throw new Error("M");
			},
			setCap: async () => {
				throw new Error("C");
			},
			adopt: async () => {
				throw new Error("A");
			},
			writeScope: () => {
				throw new Error("S");
			},
			writeDeadCode: () => {
				throw new Error("D");
			},
		};
		const result = await applyWizardChoices(
			"/repo",
			{ ...DEFAULT_WIZARD_CHOICES, caps: { cyclomatic: 15 }, adopt: true },
			deps,
		);
		expect(result.failures).toEqual([
			"enable (hooks): E",
			"mode: M",
			"scope: S",
			"dead code: D",
			"cap cyclomatic: C",
			"adopt (baseline floor): A",
		]);
	});

	// test-contract: public-api — an empty (but non-null) runners array must omit the `clients` key entirely, not send clients=""
	it("MK2: an empty runners array omits the enable 'clients' option rather than sending clients=''", async () => {
		let captured: { clients?: string; syncMode: string } | undefined;
		const deps: WizardDeps = {
			enable: async (opts) => {
				captured = opts;
			},
			applyMode: async () => {},
			setCap: async () => {},
			adopt: async () => {},
			writeScope: () => {},
			writeDeadCode: () => {},
		};
		await applyWizardChoices("/repo", { ...DEFAULT_WIZARD_CHOICES, runners: [] }, deps);
		expect(captured).toEqual({ syncMode: "local" });
	});
});

describe("sharedStructuralFamilyOn (via writeDeadCodeConfig) — mutation kill", () => {
	// test-contract: invariant — enabled:false must read as family OFF (not "guard passed"), so siblings still get scoped down
	it("MK-ssf1: an existing structural_checks with enabled:false is family-off, siblings scoped down", () => {
		const dir = mkdtempSync(join(tmpdir(), "wiz-ssf-"));
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "guard-rules.json"),
			JSON.stringify({ structural_checks: { enabled: false, smart_tsc: true } }),
		);
		writeDeadCodeConfig(dir, "flag");
		const gr = JSON.parse(readFileSync(join(dir, ".interlinked", "guard-rules.json"), "utf-8"));
		expect(gr.structural_checks.smart_tsc).toBe(false);
		expect(gr.structural_checks.enabled).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("deadCodePatch (via writeDeadCodeConfig) — mutation kill", () => {
	// test-contract: invariant — family-off scoping forces only BOOLEAN sibling checks false; numeric/string config keys are left untouched
	it("MK-dcp1: non-boolean DEFAULT_STRUCTURAL_CHECKS keys are absent from the patch, not forced false", () => {
		const dir = mkdtempSync(join(tmpdir(), "wiz-dcp-"));
		writeDeadCodeConfig(dir, "flag");
		const gr = JSON.parse(readFileSync(join(dir, ".interlinked", "guard-rules.json"), "utf-8"));
		const sc = gr.structural_checks;
		expect(sc.staleness_window_s).toBeUndefined();
		expect(sc.blast_radius_threshold).toBeUndefined();
		expect(sc.completion_reminder_threshold).toBeUndefined();
		expect(sc.impact_high_threshold).toBeUndefined();
		expect(sc.test_first_mode).toBeUndefined();
		expect(sc.characterize_mode).toBeUndefined();
		expect(sc.dead_code_action).toBe("flag");
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("writeDeadCodeConfig — mutation kill", () => {
	// test-contract: bug — a merge failure must throw, not silently no-op past the malformed file
	it("MK-wdc1: a malformed guard-rules.json makes writeDeadCodeConfig throw", () => {
		const dir = mkdtempSync(join(tmpdir(), "wiz-wdc-bad-"));
		const gr = join(dir, ".interlinked", "guard-rules.json");
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(gr, "{ not json");
		expect(() => writeDeadCodeConfig(dir, "flag")).toThrow(/dead-code posture not written/);
		expect(readFileSync(gr, "utf-8")).toBe("{ not json");
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("parseWizardYesNo — mutation kill", () => {
	// test-contract: boundary — trim() must actually strip whitespace before matching
	it("MK-pyn1: surrounding whitespace is trimmed before matching", () => {
		expect(parseWizardYesNo("  y  ", false)).toBe(true);
		expect(parseWizardYesNo("  n  ", true)).toBe(false);
	});

	// test-contract: public-api — each individual yes-token is recognized, not just "yes"
	it("MK-pyn2: each yes-token (y/1/true) parses to true independent of the others", () => {
		expect(parseWizardYesNo("y", false)).toBe(true);
		expect(parseWizardYesNo("1", false)).toBe(true);
		expect(parseWizardYesNo("true", false)).toBe(true);
	});

	// test-contract: public-api — each individual no-token is recognized, not just "0"
	it("MK-pyn3: each no-token (n/no/false) parses to false independent of the others", () => {
		expect(parseWizardYesNo("n", true)).toBe(false);
		expect(parseWizardYesNo("no", true)).toBe(false);
		expect(parseWizardYesNo("false", true)).toBe(false);
	});

	// test-contract: boundary — an unrecognized token falls through to defaultValue, not a hardcoded false
	it("MK-pyn4: an unrecognized token falls through to defaultValue", () => {
		expect(parseWizardYesNo("maybe", true)).toBe(true);
		expect(parseWizardYesNo("banana", false)).toBe(false);
	});
});

describe("choicesFromNonInteractive — mutation kill", () => {
	// test-contract: boundary — an empty-string scope value falls back to the default, not itself
	it("MK-cni-scope: an empty-string scope value falls back to the default", () => {
		expect(choicesFromNonInteractive({ scope: "" }).scope).toBe("diff");
	});

	// test-contract: boundary — adopt=false requires an EXACT match; a value that merely contains a false-keyword must not flip it
	it("MK-cni-adopt-anchors: adopt only turns off on an exact false/no/0, not a substring match", () => {
		expect(choicesFromNonInteractive({ adopt: "xfalse" }).adopt).toBe(true);
		expect(choicesFromNonInteractive({ adopt: "falsey" }).adopt).toBe(true);
	});

	// test-contract: boundary — stray commas produce no empty entries, and each entry is trimmed
	it("MK-cni-runners: stray commas are dropped, entries are trimmed", () => {
		expect(choicesFromNonInteractive({ runners: "claude,,codex," }).runners).toEqual([
			"claude",
			"codex",
		]);
		expect(choicesFromNonInteractive({ runners: "claude, codex " }).runners).toEqual([
			"claude",
			"codex",
		]);
	});

	// test-contract: public-api — realtime/manual pass through exactly; anything else falls to local
	it("MK-cni-syncmode: realtime and manual pass through; unrecognized falls to local", () => {
		expect(choicesFromNonInteractive({ syncMode: "realtime" }).syncMode).toBe("realtime");
		expect(choicesFromNonInteractive({ syncMode: "manual" }).syncMode).toBe("manual");
		expect(choicesFromNonInteractive({ syncMode: "bogus" }).syncMode).toBe("local");
	});

	// test-contract: public-api — delete/off pass through exactly; anything else (including omitted) falls to flag
	it("MK-cni-deadcode: delete/off pass through; omitted falls to flag", () => {
		expect(choicesFromNonInteractive({ deadCode: "delete" }).deadCode).toBe("delete");
		expect(choicesFromNonInteractive({ deadCode: "off" }).deadCode).toBe("off");
		expect(choicesFromNonInteractive({}).deadCode).toBe("flag");
	});
});

describe("describeWizardPlan — mutation kill", () => {
	// test-contract: public-api — exact plan lines for a fully-specified, non-default choice set (join separators, template bodies)
	it("MK-dwp1: exact plan lines for a fully-specified, non-default choice set", () => {
		const lines = describeWizardPlan({
			runners: ["claude", "codex"],
			mode: "balanced",
			scope: "diff",
			caps: { cyclomatic: 15, lines: 400 },
			adopt: true,
			deadCode: "flag",
			syncMode: "local",
		});
		expect(lines).toEqual([
			"  Runners: claude, codex  (change: interlinked enable --clients …)",
			"  Mode: balanced  (change: interlinked mode <name>)",
			"  Scope: diff — judge only what the agent changes",
			"  Caps: cyclomatic=15, lines=400  (change: interlinked caps set)",
			"  Baselines: adopt now — your repo today is the floor; interlinked only stops it getting worse",
			"  Dead code: flag per edit — unused imports/exports reported  (sweep: interlinked deadcode)",
		]);
	});

	// test-contract: public-api — whole-file scope renders its own distinct line, not diff's
	it("MK-dwp2: whole-file scope renders its own distinct line", () => {
		const lines = describeWizardPlan({ ...DEFAULT_WIZARD_CHOICES, scope: "whole-file" });
		expect(lines[2]).toBe("  Scope: whole-file — judge every touched file in full");
	});

	// test-contract: boundary — empty caps render 'shipped defaults', not an empty detail line
	it("MK-dwp3: empty caps render 'shipped defaults', not an empty detail line", () => {
		const lines = describeWizardPlan({ ...DEFAULT_WIZARD_CHOICES, caps: {} });
		expect(lines[3]).toBe("  Caps: shipped defaults  (view: interlinked caps)");
	});
});

describe("describeDeadCodeChoice (via describeWizardPlan) — mutation kill", () => {
	// test-contract: public-api — each of the three dead-code postures renders its own exact, distinct phrase
	it("MK-ddc1: delete/off/flag each render a distinct exact phrase", () => {
		const del = describeWizardPlan({ ...DEFAULT_WIZARD_CHOICES, deadCode: "delete" });
		expect(del[5]).toBe(
			"  Dead code: flag per edit + instruct the agent to delete  (change: rerun the wizard)",
		);
		const off = describeWizardPlan({ ...DEFAULT_WIZARD_CHOICES, deadCode: "off" });
		expect(off[5]).toBe("  Dead code: per-edit checks off  (sweep any time: interlinked deadcode)");
		const flag = describeWizardPlan({ ...DEFAULT_WIZARD_CHOICES, deadCode: "flag" });
		expect(flag[5]).toBe(
			"  Dead code: flag per edit — unused imports/exports reported  (sweep: interlinked deadcode)",
		);
	});
});

describe("capReceiptBits (via describePostureReceipt) — mutation kill", () => {
	// test-contract: boundary — a coverage goal of exactly 0 renders as 'off', not '0 %'
	it("MK-crb1: coverage:0 renders as 'goal off (ratchet only)', not 'goal 0 %'", () => {
		const lines = describePostureReceipt({ ...DEFAULT_WIZARD_CHOICES, caps: { coverage: 0 } });
		const capsLine = lines.find((l) => l.startsWith("  caps:"));
		expect(capsLine).toContain("coverage goal off (ratchet only)");
		expect(capsLine).not.toContain("coverage goal 0 %");
	});
});

describe("describePostureReceipt — mutation kill", () => {
	// test-contract: public-api — exact posture receipt for the shipped defaults, every line in order (join separators, template bodies, ternary branches)
	it("MK-dpr1: exact posture receipt for the shipped defaults", () => {
		const lines = describePostureReceipt(DEFAULT_WIZARD_CHOICES);
		expect(lines).toEqual([
			"  mode strict — Default. Block edits that would introduce type, lint, or test-quality errors before they land.",
			"    · new source file without a companion test → blocked (TDD gate)",
			"    · editing an untested legacy file without a characterization test → blocked",
			"    · per-edit coverage strict: an uncovered added line blocks the edit (no debt)",
			"    · session-end verification + commit-cadence nudges on",
			"    change: interlinked mode strict|balanced|lenient  (preview first: --diff)",
			"  caps: lines ≤ 500 · function-tokens ≤ 500 · cyclomatic ≤ 25 · cognitive ≤ 30 · crap ≤ 30 · coverage goal 100 %",
			"    change: interlinked caps set <metric> <value>  ·  meanings: interlinked caps explain",
			"  scope: diff — only what the agent changes is judged  (rerun the wizard to widen)",
			"  baselines: seeded from today's state; ratchets only tighten  (re-seed: interlinked adopt)",
			"  installs: current deps pre-approved; new packages need interlinked allowlist add <eco> <pkg>",
			"  dead code: flag per edit — unused imports/exports reported  (sweep: interlinked deadcode)",
			"  always on: destructive-command, secrets, and install rails; per-check tuning lives in .interlinked/check-policy.json",
		]);
	});

	// test-contract: public-api — whole-file scope renders its own line in the posture receipt too
	it("MK-dpr2: whole-file scope renders its own line", () => {
		const lines = describePostureReceipt({ ...DEFAULT_WIZARD_CHOICES, scope: "whole-file" });
		expect(lines).toContain(
			"  scope: whole-file — every touched file judged in full  (rerun the wizard to narrow)",
		);
	});

});
