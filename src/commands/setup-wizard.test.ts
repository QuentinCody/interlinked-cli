// Companion for setup-wizard.ts — the harness-first onboarding flow.
// The wizard COMPOSES existing machinery (enable/mode/caps/adopt) rather than
// re-implementing any of it, so these tests pin the composition contract:
// which deps run, in what order, with what arguments, under which choices —
// through an injected-deps seam, never by mocking modules.

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
	type WizardDeps,
	WIZARD_COPY,
	writeDeadCodeConfig,
	writeScopeConfig,
} from "./setup-wizard.js";

function recordingDeps(): WizardDeps & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		enable: async (opts) => {
			calls.push(`enable:${(opts.clients ?? "all") || "all"}:${opts.syncMode ?? "?"}`);
		},
		applyMode: async (name) => {
			calls.push(`mode:${name}`);
		},
		setCap: async (metric, value) => {
			calls.push(`cap:${metric}=${value}`);
		},
		adopt: async () => {
			calls.push("adopt");
		},
		writeScope: (cwd, scope) => {
			calls.push(`scope:${scope}`);
			void cwd;
		},
		writeDeadCode: (cwd, action) => {
			calls.push(`deadcode:${action}`);
			void cwd;
		},
	};
}

describe("applyWizardChoices — positive (must compose)", () => {
	// test-contract: public-api — the default path is enable → mode → scope → adopt, with no cap writes when caps are untouched
	it("P1: defaults run enable, strict mode, diff scope, and adopt — and write no caps", async () => {
		const deps = recordingDeps();
		await applyWizardChoices("/repo", DEFAULT_WIZARD_CHOICES, deps);
		expect(deps.calls).toEqual([
			"enable:all:local",
			"mode:strict",
			"scope:diff",
			"deadcode:flag",
			"adopt",
		]);
	});

	// test-contract: public-api — an edited cap writes exactly that cap, before adopt seeds baselines against it
	it("P2: a changed cap is written via setCap, and before adopt runs", async () => {
		const deps = recordingDeps();
		await applyWizardChoices(
			"/repo",
			{ ...DEFAULT_WIZARD_CHOICES, caps: { cyclomatic: 15 } },
			deps,
		);
		expect(deps.calls).toContain("cap:cyclomatic=15");
		expect(deps.calls.indexOf("cap:cyclomatic=15")).toBeLessThan(deps.calls.indexOf("adopt"));
	});

	// test-contract: public-api — declining adopt (greenfield) skips the baseline seeding but nothing else
	it("P3: adopt=false skips only the adopt step", async () => {
		const deps = recordingDeps();
		await applyWizardChoices("/repo", { ...DEFAULT_WIZARD_CHOICES, adopt: false }, deps);
		expect(deps.calls).not.toContain("adopt");
		expect(deps.calls[0]).toMatch(/^enable:/);
	});

	// test-contract: public-api — chosen runners are passed through to enable verbatim as a comma list
	it("P4: selected runners reach enable as its clients option", async () => {
		const deps = recordingDeps();
		await applyWizardChoices(
			"/repo",
			{ ...DEFAULT_WIZARD_CHOICES, runners: ["claude", "codex"] },
			deps,
		);
		expect(deps.calls[0]).toBe("enable:claude,codex:local");
	});
});

describe("applyWizardChoices — negative (must not overreach)", () => {
	// test-contract: invariant — a dep that throws does not abort the remaining steps; the wizard reports and continues
	it("N1: a failing step is reported but later steps still run", async () => {
		const deps = recordingDeps();
		deps.applyMode = async () => {
			throw new Error("mode exploded");
		};
		const result = await applyWizardChoices("/repo", DEFAULT_WIZARD_CHOICES, deps);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toContain("mode");
		expect(deps.calls).toContain("adopt");
	});
});

describe("writeScopeConfig — positive/negative", () => {
	// test-contract: invariant — the scope writer merges into guard-rules.json without clobbering unrelated keys
	it("P5: diff scope enables diff_aware while preserving existing keys", () => {
		const dir = mkdtempSync(join(tmpdir(), "wiz-scope-"));
		const gr = join(dir, ".interlinked", "guard-rules.json");
		writeScopeConfig(dir, "diff");
		const first = JSON.parse(readFileSync(gr, "utf-8"));
		expect(first.diff_aware.enabled).toBe(true);
		writeFileSync(gr, JSON.stringify({ ...first, custom_rules: [{ id: "keep-me" }] }, null, 2));
		writeScopeConfig(dir, "whole-file");
		const second = JSON.parse(readFileSync(gr, "utf-8"));
		expect(second.diff_aware.enabled).toBe(false);
		expect(second.custom_rules).toEqual([{ id: "keep-me" }]);
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: bug-class — a malformed team-shared config must be preserved
	// as evidence and reported, never silently rebuilt from {} (delegation to
	// mergeIntoGuardRules, 2026-08-17)
	it("N7: a malformed guard-rules.json refuses with the file left byte-identical", () => {
		const dir = mkdtempSync(join(tmpdir(), "wiz-scope-bad-"));
		const gr = join(dir, ".interlinked", "guard-rules.json");
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(gr, "{ not json");
		expect(() => writeScopeConfig(dir, "diff")).toThrow(/scope not written/);
		expect(readFileSync(gr, "utf-8")).toBe("{ not json");
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("writeDeadCodeConfig — positive/negative", () => {
	// test-contract: behavior — the flag/delete write scopes the structural
	// family to the dead-code checks when the family is off (enabling dead-code
	// detection must not drag in the other structural checks)
	it("P8: 'delete' on a family-off repo enables only the dead-code checks, action recorded", () => {
		const dir = mkdtempSync(join(tmpdir(), "wiz-deadcode-"));
		writeDeadCodeConfig(dir, "delete");
		const gr = JSON.parse(readFileSync(join(dir, ".interlinked", "guard-rules.json"), "utf-8"));
		expect(gr.structural_checks.enabled).toBe(true);
		expect(gr.structural_checks.dead_imports).toBe(true);
		expect(gr.structural_checks.dead_exports).toBe(true);
		expect(gr.structural_checks.dead_code_action).toBe("delete");
		expect(gr.structural_checks.smart_tsc).toBe(false);
		expect(gr.structural_checks.blast_radius).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: invariant — a repo already running the full family keeps
	// its sibling checks; the write touches only the dead-code keys
	it("N8: family-on repos get a minimal patch, sibling checks untouched", () => {
		const dir = mkdtempSync(join(tmpdir(), "wiz-deadcode-on-"));
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "guard-rules.json"),
			JSON.stringify({ structural_checks: { enabled: true, smart_tsc: true } }),
		);
		writeDeadCodeConfig(dir, "flag");
		const gr = JSON.parse(readFileSync(join(dir, ".interlinked", "guard-rules.json"), "utf-8"));
		expect(gr.structural_checks.smart_tsc).toBe(true);
		expect(gr.structural_checks.dead_code_action).toBe("flag");
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: behavior — "off" disables only the two dead-code checks
	it("N9: 'off' writes dead_imports/dead_exports false and nothing else", () => {
		const dir = mkdtempSync(join(tmpdir(), "wiz-deadcode-off-"));
		writeDeadCodeConfig(dir, "off");
		const gr = JSON.parse(readFileSync(join(dir, ".interlinked", "guard-rules.json"), "utf-8"));
		expect(gr.structural_checks).toEqual({ dead_imports: false, dead_exports: false });
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("choicesFromNonInteractive — positive/negative", () => {
	// test-contract: public-api — flags map onto choices; unknown values fall back to defaults rather than failing bootstrap
	it("P6: mode/scope/adopt flags parse; runners split on commas", () => {
		const c = choicesFromNonInteractive({
			mode: "strict",
			scope: "whole-file",
			adopt: "false",
			runners: "claude,gemini",
		});
		expect(c.mode).toBe("strict");
		expect(c.scope).toBe("whole-file");
		expect(c.adopt).toBe(false);
		expect(c.runners).toEqual(["claude", "gemini"]);
	});

	// test-contract: boundary — garbage values degrade to the recommended defaults, never throw during a non-TTY bootstrap
	it("N2: unknown mode/scope values fall back to defaults", () => {
		const c = choicesFromNonInteractive({ mode: "yolo", scope: "everything" });
		expect(c.mode).toBe(DEFAULT_WIZARD_CHOICES.mode);
		expect(c.scope).toBe(DEFAULT_WIZARD_CHOICES.scope);
	});
});

describe("moveSelection — positive/negative (shared arrow-key semantics)", () => {
	// test-contract: invariant — both surfaces (TUI select + browser demo) wrap top↔bottom through this one function
	it("P8: wraps past the last item to the first, and from the first back to the last", async () => {
		const { moveSelection } = await import("./setup-wizard.js");
		expect(moveSelection(2, 1, 3)).toBe(0);
		expect(moveSelection(0, -1, 3)).toBe(2);
		expect(moveSelection(1, 1, 3)).toBe(2);
	});

	// test-contract: boundary — an empty list can never produce an out-of-range index
	it("N3: zero-length lists pin to 0 and a zero delta holds position", async () => {
		const { moveSelection } = await import("./setup-wizard.js");
		expect(moveSelection(5, 1, 0)).toBe(0);
		expect(moveSelection(1, 0, 3)).toBe(1);
	});
});

describe("parseWizardYesNo / parseWizardCapOverrides — positive/negative (shared parser rules)", () => {
	// test-contract: public-api — both surfaces accept y/yes/1/true and n/no/0/false; empty takes the default
	it("P9: yes/no forms parse and empty input takes the default", async () => {
		const { parseWizardYesNo } = await import("./setup-wizard.js");
		expect(parseWizardYesNo("YES", false)).toBe(true);
		expect(parseWizardYesNo("0", true)).toBe(false);
		expect(parseWizardYesNo("", true)).toBe(true);
		expect(parseWizardYesNo("", false)).toBe(false);
	});

	// test-contract: boundary — cap overrides keep valid pairs and drop garbage without throwing
	it("N4: cap-override parsing drops invalid pairs and keeps valid ones", async () => {
		const { parseWizardCapOverrides } = await import("./setup-wizard.js");
		expect(parseWizardCapOverrides("cyclomatic=15, lines = 400")).toEqual({
			cyclomatic: 15,
			lines: 400,
		});
		expect(parseWizardCapOverrides("nonsense, crap=abc, =5")).toEqual({});
	});
});

describe("describeWizardPlan", () => {
	// test-contract: public-api — the plan summary names every decision so the user sees what will happen before it does
	it("P7: the rendered plan names mode, scope, runners, and adopt intent", () => {
		const text = describeWizardPlan({
			...DEFAULT_WIZARD_CHOICES,
			runners: ["claude"],
			caps: { lines: 400 },
		}).join("\n");
		expect(text).toContain("strict");
		expect(text).toContain("diff");
		expect(text).toContain("claude");
		expect(text).toContain("lines");
		expect(text).toMatch(/baseline|floor|adopt/i);
	});
});

describe("describePostureReceipt", () => {
	// test-contract: public-api — the receipt is the discoverability surface: every
	// enforced thing names the command that changes it (operator decision 2026-08-17)
	it("P10: a strict receipt names the TDD block, strict coverage, and owner commands", () => {
		const text = describePostureReceipt({ ...DEFAULT_WIZARD_CHOICES, mode: "strict" }).join("\n");
		expect(text).toContain("mode strict");
		expect(text).toContain("blocked (TDD gate)");
		expect(text).toContain("no debt");
		expect(text).toContain("interlinked mode strict|balanced|lenient");
		expect(text).toContain("interlinked caps set");
		expect(text).toContain("interlinked adopt");
	});

	it("P11: cap overrides win over shipped defaults in the caps line", () => {
		const text = describePostureReceipt({
			...DEFAULT_WIZARD_CHOICES,
			caps: { cyclomatic: 15, coverage: 95 },
		}).join("\n");
		expect(text).toContain("cyclomatic ≤ 15");
		expect(text).toContain("coverage goal 95 %");
	});

	// test-contract: boundary — coverage is a GOAL (default 100), never a bound:
	// no "≥"/"≤" phrasing, and the default renders the ambition, not a zero
	it("N5: default coverage renders as the 100 % goal, never as a bound", () => {
		const text = describePostureReceipt({ ...DEFAULT_WIZARD_CHOICES, caps: {} }).join("\n");
		expect(text).toContain("coverage goal 100 %");
		expect(text).not.toContain("coverage ≥");
		expect(text).not.toContain("coverage ≤");
	});

	it("N6: skipping adopt flips the baseline and install lines to the warning forms", () => {
		const text = describePostureReceipt({ ...DEFAULT_WIZARD_CHOICES, adopt: false }).join("\n");
		expect(text).toContain("NOT seeded");
		expect(text).toContain("allowlist snapshot");
	});
});

describe("WIZARD_COPY — the two prompts that interpolate runtime state", () => {
	// test-contract: public-api — the single-source copy contract only holds if
	// the parameterised prompts render the SAME text for the TUI reader
	// (setup-wizard-run.ts:178,198) and the browser demo generator. Both are
	// pinned verbatim here, so a copy change shows up as a failing assertion
	// rather than as silent drift between the two surfaces.
	it("the runners prompt lists the detected ids as a bare comma-separated set", () => {
		expect(WIZARD_COPY.steps.runners.prompt(["claude", "codex", "gemini"])).toBe(
			"   Hook all detected? [Y] or list ids (claude,codex,gemini): ",
		);
	});

	it("the mode prompt shows the recommended mode as the bracketed Enter default", () => {
		expect(WIZARD_COPY.steps.mode.prompt("balanced")).toBe("   Mode [balanced]: ");
	});
});
