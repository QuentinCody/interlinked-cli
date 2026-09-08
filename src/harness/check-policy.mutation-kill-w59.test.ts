import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	DEFAULT_POLICY,
	loadCheckPolicy,
	resolveAction,
	summarizePolicy,
	type CheckPolicy,
} from "./check-policy.js";
import type { CheckRegistration } from "./check-registry/types.js";

let dirs: string[] = [];

function makeTmpRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "check-policy-w59-"));
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const d of dirs) {
		rmSync(d, { recursive: true, force: true });
	}
	dirs = [];
});

function fakeCheck(overrides: Partial<CheckRegistration> = {}): CheckRegistration {
	return {
		id: "fake_check",
		name: "Fake check",
		description: "Policy resolution fixture",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction: "Fix the finding",
		fn: () => [],
		resultsPropName: "fakeCheck",
		phase: "post",
		...overrides,
	};
}

describe("loadCheckPolicy — no policy files present", () => {
	it("returns coverage_ratchet with real default fields, not an empty object", () => {
		const dir = makeTmpRepo();
		const policy = loadCheckPolicy(dir);
		// Kills: ObjectLiteral mutant replacing `{ ...DEFAULT_POLICY.coverage_ratchet }` with `{}`
		expect(policy.coverage_ratchet.enabled).toBe(false);
		expect(policy.coverage_ratchet.per_file).toBe(true);
		expect(policy.coverage_ratchet.allow_decrease_pct).toBe(0);
	});

	it("returns mutation_gate with real default fields, not an empty object", () => {
		const dir = makeTmpRepo();
		const policy = loadCheckPolicy(dir);
		// Kills: ObjectLiteral mutant replacing `{ ...DEFAULT_POLICY.mutation_gate }` with `{}`
		expect(policy.mutation_gate.enabled).toBe(false);
		expect(policy.mutation_gate.min_score).toBe(0.6);
		expect(policy.mutation_gate.schedule).toBe("weekly");
	});

	it("does not mutate DEFAULT_POLICY objects when applying a team file", () => {
		const dir = makeTmpRepo();
		writeFileSync(
			join(dir, ".interlinked", "check-policy.json"),
			JSON.stringify({ coverage_ratchet: { enabled: true } }),
		);
		const policy = loadCheckPolicy(dir);
		expect(policy.coverage_ratchet.enabled).toBe(true);
		// DEFAULT_POLICY itself must be untouched (spread copy, not empty-object aliasing).
		expect(DEFAULT_POLICY.coverage_ratchet.enabled).toBe(false);
		expect(DEFAULT_POLICY.coverage_ratchet.per_file).toBe(true);
	});
});

describe("readPolicyFile behavior via loadCheckPolicy — existsSync / malformed JSON", () => {
	it("returns defaults (no throw) when no policy files exist at all", () => {
		const dir = makeTmpRepo();
		// Kills: ConditionalExpression mutant `!existsSync(path)` -> `false`
		// (would attempt to read a nonexistent file and throw ENOENT).
		expect(() => loadCheckPolicy(dir)).not.toThrow();
		const policy = loadCheckPolicy(dir);
		expect(policy.defaults.action).toBe("warn_after");
		expect(policy.defaults.scope).toBe("diff");
	});

	it("swallows malformed JSON in a policy file and falls back to defaults", () => {
		const dir = makeTmpRepo();
		writeFileSync(join(dir, ".interlinked", "check-policy.json"), "{ not valid json ,,,");
		// Kills: BlockStatement mutant replacing the catch body `{ return null; }` with `{}`
		// (would fall through with no return -> undefined, not null, breaking applyPolicyFile).
		expect(() => loadCheckPolicy(dir)).not.toThrow();
		const policy = loadCheckPolicy(dir);
		expect(policy.defaults.action).toBe("warn_after");
		expect(policy.coverage_ratchet.enabled).toBe(false);
	});

	it("applies a syntactically valid team file normally", () => {
		const dir = makeTmpRepo();
		writeFileSync(
			join(dir, ".interlinked", "check-policy.json"),
			JSON.stringify({ defaults: { action: "info" } }),
		);
		const policy = loadCheckPolicy(dir);
		expect(policy.defaults.action).toBe("info");
	});
});

describe("applyPolicyFile — mode preset gating via loadCheckPolicy", () => {
	it("applies a known mode string ('strict') as a preset", () => {
		const dir = makeTmpRepo();
		writeFileSync(join(dir, ".interlinked", "check-policy.json"), JSON.stringify({ mode: "strict" }));
		const policy = loadCheckPolicy(dir);
		// Kills: ConditionalExpression mutants on `typeof file.mode === "string" && isKnownMode(file.mode)`
		// both -> true and -> false, plus the EqualityOperator/LogicalOperator/StringLiteral variants.
		expect(policy.mode).toBe("strict");
	});

	it("ignores an unknown mode string and keeps the default mode", () => {
		const dir = makeTmpRepo();
		writeFileSync(
			join(dir, ".interlinked", "check-policy.json"),
			JSON.stringify({ mode: "not_a_real_mode" }),
		);
		const policy = loadCheckPolicy(dir);
		// Kills: mutant forcing the condition to `true` (would call applyModePreset with
		// a bogus mode and set policy.mode to "not_a_real_mode").
		expect(policy.mode).toBe("balanced");
	});

	it("ignores a non-string mode value (e.g. a number) without throwing", () => {
		const dir = makeTmpRepo();
		writeFileSync(join(dir, ".interlinked", "check-policy.json"), JSON.stringify({ mode: 42 }));
		// Kills: mutant forcing condition to `true` -> would call isKnownMode/applyModePreset
		// with a non-string and either throw or misbehave; also kills EqualityOperator mutant
		// `!== "string"` for this same branch since typeof 42 === "string" is false either way,
		// but combined with StringLiteral mutant (`"string"` -> `""`) typeof 42 === "" is also
		// false, so we need a case where the value IS a string to fully separate them (see below).
		expect(() => loadCheckPolicy(dir)).not.toThrow();
		const policy = loadCheckPolicy(dir);
		expect(policy.mode).toBe("balanced");
	});

	it("distinguishes typeof-string check from StringLiteral mutant using a string that is not === 'string'", () => {
		const dir = makeTmpRepo();
		// file.mode is a string ("balanced") so typeof file.mode === "string" is true regardless
		// of the StringLiteral mutant only if repl differs; use an explicit known mode to confirm
		// the preset actually applies end-to-end (defaults.action changes for strict mode).
		writeFileSync(join(dir, ".interlinked", "check-policy.json"), JSON.stringify({ mode: "lenient" }));
		const policy = loadCheckPolicy(dir);
		expect(policy.mode).toBe("lenient");
		// lenient mode's default_action (if defined) or check_overrides should differ from balanced;
		// at minimum mode field proves the whole conjunction evaluated true and preset applied.
	});
});

describe("applyPolicyFile — defaults / checks / coverage_ratchet / mutation_gate presence checks", () => {
	it("applies file.defaults only when truthy (defaults object present)", () => {
		const dir = makeTmpRepo();
		writeFileSync(
			join(dir, ".interlinked", "check-policy.json"),
			JSON.stringify({ defaults: { action: "ask", scope: "project" } }),
		);
		const policy = loadCheckPolicy(dir);
		// Kills: ConditionalExpression mutant `file.defaults` -> `false` would skip this entirely.
		expect(policy.defaults.action).toBe("ask");
		expect(policy.defaults.scope).toBe("project");
	});

	it("leaves defaults untouched when file.defaults is absent", () => {
		const dir = makeTmpRepo();
		writeFileSync(join(dir, ".interlinked", "check-policy.json"), JSON.stringify({}));
		const policy = loadCheckPolicy(dir);
		expect(policy.defaults.action).toBe("warn_after");
		expect(policy.defaults.scope).toBe("diff");
	});

	it("applies file.coverage_ratchet only when present", () => {
		const dir = makeTmpRepo();
		writeFileSync(
			join(dir, ".interlinked", "check-policy.json"),
			JSON.stringify({ coverage_ratchet: { allow_decrease_pct: 5 } }),
		);
		const policy = loadCheckPolicy(dir);
		// Kills: ConditionalExpression mutant `file.coverage_ratchet` -> `true` would attempt to
		// spread `undefined` when the key is absent elsewhere, or misapply here.
		expect(policy.coverage_ratchet.allow_decrease_pct).toBe(5);
		expect(policy.coverage_ratchet.per_file).toBe(true);
	});

	it("does not touch coverage_ratchet when file.coverage_ratchet is absent", () => {
		const dir = makeTmpRepo();
		writeFileSync(join(dir, ".interlinked", "check-policy.json"), JSON.stringify({ mode: "strict" }));
		const policy = loadCheckPolicy(dir);
		expect(policy.coverage_ratchet).toEqual(DEFAULT_POLICY.coverage_ratchet);
	});

	it("applies file.mutation_gate only when present", () => {
		const dir = makeTmpRepo();
		writeFileSync(
			join(dir, ".interlinked", "check-policy.json"),
			JSON.stringify({ mutation_gate: { min_score: 0.9 } }),
		);
		const policy = loadCheckPolicy(dir);
		// Kills: ConditionalExpression mutant `file.mutation_gate` -> `true` would spread undefined
		// into policy.mutation_gate when the key is missing in other test cases.
		expect(policy.mutation_gate.min_score).toBe(0.9);
		expect(policy.mutation_gate.schedule).toBe("weekly");
	});

	it("does not touch mutation_gate when file.mutation_gate is absent", () => {
		const dir = makeTmpRepo();
		writeFileSync(join(dir, ".interlinked", "check-policy.json"), JSON.stringify({ mode: "strict" }));
		const policy = loadCheckPolicy(dir);
		expect(policy.mutation_gate).toEqual(DEFAULT_POLICY.mutation_gate);
	});
});

describe("defaultActionFor / actionToPhase constants embedded in resolveAction defaults", () => {
	it("f6a4ee7e36e2a436 target: DEFAULT_POLICY.defaults action/scope literal values", () => {
		// Kills mutants on `{ action: "warn_after", scope: "diff" }` -> `{}`,
		// StringLiteral "diff"->"" , "warn_after"->"", "balanced"->"".
		expect(DEFAULT_POLICY.defaults).toEqual({ action: "warn_after", scope: "diff" });
		expect(DEFAULT_POLICY.mode).toBe("balanced");
	});

	it("DEFAULT_POLICY.coverage_ratchet literal booleans/number are exact", () => {
		// Kills BooleanLiteral mutants false->true / true->false on enabled / per_file,
		// and the whole-object ObjectLiteral mutant `{ enabled: false, per_file: true, allow_decrease_pct: 0 }` -> `{}`.
		expect(DEFAULT_POLICY.coverage_ratchet).toEqual({
			enabled: false,
			per_file: true,
			allow_decrease_pct: 0,
		});
	});

	it("DEFAULT_POLICY.mutation_gate literal values are exact", () => {
		// Kills ObjectLiteral mutant `{ enabled: false, min_score: 0.6, schedule: "weekly" }` -> `{}`,
		// BooleanLiteral false->true on enabled, StringLiteral "weekly"->"".
		expect(DEFAULT_POLICY.mutation_gate).toEqual({
			enabled: false,
			min_score: 0.6,
			schedule: "weekly",
		});
	});
});

describe("resolveAction / summarizePolicy sanity using DEFAULT_POLICY fields", () => {
	it("resolves default action from a fresh policy copy matching DEFAULT_POLICY.defaults", () => {
		const policy: CheckPolicy = {
			...DEFAULT_POLICY,
			defaults: { ...DEFAULT_POLICY.defaults },
			checks: {},
			coverage_ratchet: { ...DEFAULT_POLICY.coverage_ratchet },
			mutation_gate: { ...DEFAULT_POLICY.mutation_gate },
		};
		const resolved = resolveAction(fakeCheck({ phase: "post" }), policy);
		expect(resolved.action).toBe("warn_after");
		expect(resolved.scope).toBe("diff");
	});

	it("summarizePolicy counts a single post-phase check under warn_after", () => {
		const policy: CheckPolicy = {
			...DEFAULT_POLICY,
			defaults: { ...DEFAULT_POLICY.defaults },
			checks: {},
			coverage_ratchet: { ...DEFAULT_POLICY.coverage_ratchet },
			mutation_gate: { ...DEFAULT_POLICY.mutation_gate },
		};
		const counts = summarizePolicy(policy, [fakeCheck({ id: "x", phase: "post" })]);
		expect(counts.warn_after).toBe(1);
		expect(counts.ask).toBe(0);
	});
});
