import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { GuardRule } from "../types.js";
import type { FindingRule } from "./finding-rules.js";
import { findingRulesPath, getFindingRulesWatchPaths, loadFindingRules } from "./finding-rules.js";

/** Cast helper — loadFindingRules returns GuardRule[], but findings carry extra fields. */
function asFindingRule(rule: GuardRule): FindingRule {
	// SAFETY: loadFindingRules constructs every rule from FindingRule inputs
	// (`{ ...raw }` where raw: FindingRule) — the extra `source`/`user_modified`
	// fields are always present on the runtime object; GuardRule is just the
	// narrower return type of the public API.
	return rule;
}

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "finding-rules-"));
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function writeRules(rules: unknown[]): void {
	writeFileSync(findingRulesPath(cwd), JSON.stringify({ version: 1, rules }), "utf-8");
}

function writeOverrides(overrides: unknown): void {
	writeFileSync(
		join(cwd, ".interlinked", "findings-rules.overrides.json"),
		JSON.stringify(overrides),
		"utf-8",
	);
}

const baseRule = (over: Partial<GuardRule> & { id: string; source?: Record<string, unknown> }): Record<string, unknown> => ({
	enabled: true,
	trigger: "PostToolUse",
	tool_match: ["Write", "Edit"],
	action: "warn",
	patterns: [{ field: "content", regex: "Date\\.parse\\([^)]*\\)\\s*[<>]" }],
	reason: "Date.parse result compared without a finite guard",
	severity: "medium",
	source: { kind: "finding", finding_id: "fnd_x", bug_class: "nan_coercion_guard" },
	...over,
});

describe("loadFindingRules", () => {
	it("retains valid review metadata and omits malformed source coordinates", () => {
		writeRules([{
			...baseRule({ id: "reviewed", source: { kind: "finding", bug_class: "unsafe-input", lines: ["ten", 20] } }),
			distilled_action_reason: "Validated external input can reach the rule",
			confidence: 0.75,
			user_modified: false,
		}]);
		expect(loadFindingRules(cwd)[0]).toMatchObject({
			id: "reviewed", confidence: 0.75, user_modified: false,
			distilled_action_reason: "Validated external input can reach the rule",
			source: { kind: "finding", bug_class: "unsafe-input" },
		});
		expect(asFindingRule(nonNull(loadFindingRules(cwd)[0])).source?.lines).toBeUndefined();
	});

	it("omits an overflowing JSON confidence without dropping the valid rule", () => {
		const payload = JSON.stringify({ rules: [{ ...baseRule({ id: "overflow" }), confidence: 99 }] });
		writeFileSync(findingRulesPath(cwd), payload.replace('"confidence":99', '"confidence":1e999'));
		const rules = loadFindingRules(cwd);
		expect(rules.map(rule => rule.id)).toEqual(["overflow"]);
		expect(asFindingRule(nonNull(rules[0])).confidence).toBeUndefined();
	});

	// test-contract: boundary — returns [] when the file is missing
	it("returns [] when the file is missing", () => {
		expect(loadFindingRules(cwd)).toEqual([]);
	});

	// test-contract: boundary — returns [] on malformed JSON (fail-open)
	it("returns [] on malformed JSON (fail-open)", () => {
		writeFileSync(findingRulesPath(cwd), "{ not json", "utf-8");
		expect(loadFindingRules(cwd)).toEqual([]);
	});

	// test-contract: public-api — returns [] when the file is valid JSON but not an object with rules
	it("returns [] when the file is valid JSON but not an object with rules", () => {
		writeFileSync(findingRulesPath(cwd), "[]", "utf-8");
		expect(loadFindingRules(cwd)).toEqual([]);
	});

	// test-contract: invariant — loads an enabled finding rule
	it("loads an enabled finding rule", () => {
		writeRules([baseRule({ id: "finding-nan-1" })]);
		const rules = loadFindingRules(cwd);
		expect(rules).toHaveLength(1);
		expect(nonNull(rules[0]).id).toBe("finding-nan-1");
		expect(nonNull(rules[0]).action).toBe("warn");
	});

	// test-contract: invariant — preserves finding source metadata for recurrence and CLI consumers
	it("preserves finding source metadata for recurrence and CLI consumers", () => {
		writeRules([
			baseRule({
				id: "finding-source",
				source: {
					kind: "finding",
					finding_id: "fnd_123",
					bug_class: "nan_coercion_guard",
					found_at: "2026-06-18T12:00:00.000Z",
				},
			}),
		]);

		expect(loadFindingRules(cwd)[0]).toMatchObject({
			source: {
				finding_id: "fnd_123",
				found_at: "2026-06-18T12:00:00.000Z",
			},
		});
	});

	// test-contract: invariant — treats a rule with no patterns array as non-ReDoS (loads it)
	it("treats a rule with no patterns array as non-ReDoS (loads it)", () => {
		const { patterns: _omit, ...noPatterns } = baseRule({ id: "finding-np" });
		writeRules([noPatterns]);
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual(["finding-np"]);
	});

	// test-contract: invariant — drops rules with a ReDoS-prone pattern (same gate as distilled)
	it("drops rules with a ReDoS-prone pattern (same gate as distilled)", () => {
		writeRules([
			baseRule({ id: "finding-ok" }),
			baseRule({ id: "finding-redos", patterns: [{ field: "content", regex: "(a+)+b" }] }),
		]);
		const ids = loadFindingRules(cwd).map((r) => r.id);
		expect(ids).toContain("finding-ok");
		expect(ids).not.toContain("finding-redos");
	});

	// test-contract: invariant — removes rules listed in removed_rule_ids
	it("removes rules listed in removed_rule_ids", () => {
		writeRules([baseRule({ id: "finding-keep" }), baseRule({ id: "finding-drop" })]);
		writeOverrides({ removed_rule_ids: ["finding-drop"] });
		const ids = loadFindingRules(cwd).map((r) => r.id);
		expect(ids).toEqual(["finding-keep"]);
	});

	// test-contract: invariant — omits rules listed in disabled_rule_ids from the active set
	it("omits rules listed in disabled_rule_ids from the active set", () => {
		writeRules([baseRule({ id: "finding-d" })]);
		writeOverrides({ disabled_rule_ids: ["finding-d"] });
		expect(loadFindingRules(cwd)).toEqual([]);
	});

	// test-contract: invariant — applies per-rule modifications (action / severity)
	it("applies per-rule modifications (action / severity)", () => {
		writeRules([baseRule({ id: "finding-m" })]);
		writeOverrides({ modifications: { "finding-m": { action: "block", severity: "high" } } });
		const rule = loadFindingRules(cwd)[0];
		expect(nonNull(rule).action).toBe("block");
		expect(nonNull(rule).severity).toBe("high");
	});

	// test-contract: invariant — skips rows without an id
	it("skips rows without an id", () => {
		writeRules([{ enabled: true, action: "warn" }, baseRule({ id: "finding-valid" })]);
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual(["finding-valid"]);
	});

	// test-contract: boundary — ignores malformed overrides (still loads rules)
	it("ignores malformed overrides (still loads rules)", () => {
		writeRules([baseRule({ id: "finding-r" })]);
		writeFileSync(join(cwd, ".interlinked", "findings-rules.overrides.json"), "{ bad", "utf-8");
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual(["finding-r"]);
	});

	// test-contract: public-api — P1: loads rules when the pristine file parses to a proper JSON object
	it("P1: loads rules when the pristine file parses to a proper JSON object", () => {
		writeRules([baseRule({ id: "finding-shape-ok" })]);
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual(["finding-shape-ok"]);
	});

	// test-contract: boundary — N1: treats a top-level JSON array in the pristine file as invalid shape, not a rules object
	it("N1: treats a top-level JSON array in the pristine file as invalid shape, not a rules object", () => {
		// Hardening regression: `typeof parsed === "object"` is also true for
		// arrays, so a rules array written directly at the top level (instead of
		// wrapped in `{ version, rules: [...] }`) must still yield no rules
		// rather than being read as a keyed record.
		writeFileSync(findingRulesPath(cwd), JSON.stringify([baseRule({ id: "top-level-array" })]), "utf-8");
		expect(loadFindingRules(cwd)).toEqual([]);
	});

	// test-contract: boundary — N2: treats a top-level JSON array in the overrides file as invalid shape, rules load unaffected
	it("N2: treats a top-level JSON array in the overrides file as invalid shape, rules load unaffected", () => {
		writeRules([baseRule({ id: "finding-unaffected" })]);
		writeFileSync(
			join(cwd, ".interlinked", "findings-rules.overrides.json"),
			JSON.stringify(["not", "an", "object"]),
			"utf-8",
		);
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual(["finding-unaffected"]);
	});
});

describe("getFindingRulesWatchPaths", () => {
	// test-contract: invariant — returns the pristine + overrides paths
	it("returns the pristine + overrides paths", () => {
		expect(getFindingRulesWatchPaths(cwd)).toEqual([
			join(cwd, ".interlinked", "findings-rules.json"),
			join(cwd, ".interlinked", "findings-rules.overrides.json"),
		]);
	});
});

// ---------------------------------------------------------------------------
// Mutation-kill sweep (survivor manifest, pass1_w30) — src/harness/rules/finding-rules.ts
// ---------------------------------------------------------------------------
describe("normalizeFindingRuleSource — kind gate and optional field copy", () => {
	// test-contract: invariant — drops the whole source when source.kind is not "finding" (mismatched kind, non-nullish source)
	it("drops the whole source when source.kind is not \"finding\" (mismatched kind, non-nullish source)", () => {
		writeRules([
			baseRule({
				id: "finding-badkind",
				source: { kind: "other", bug_class: "x", finding_id: "y" },
			}),
		]);
		const rule = asFindingRule(nonNull(loadFindingRules(cwd)[0]));
		expect(rule.source).toBeUndefined();
	});

	// test-contract: invariant — drops the source entirely (no own property) when raw.source is absent
	it("drops the source entirely (no own property) when raw.source is absent", () => {
		writeRules([{ ...baseRule({ id: "finding-nosource" }), source: undefined }]);
		const rule = nonNull(loadFindingRules(cwd)[0]);
		expect(Object.prototype.hasOwnProperty.call(rule, "source")).toBe(false);
	});

	// test-contract: invariant — copies every optional field (repo/commit/file/lines/reviewer/quote/found_at) when present
	it("copies every optional field (repo/commit/file/lines/reviewer/quote/found_at) when present", () => {
		writeRules([
			baseRule({
				id: "finding-full",
				source: {
					kind: "finding",
					bug_class: "nan_coercion_guard",
					finding_id: "fnd_full",
					found_at: "2026-01-01T00:00:00.000Z",
					repo: "acme/widget",
					commit: "abc123",
					file: "src/x.ts",
					lines: [10, 20],
					reviewer: "qcody",
					quote: "the bug is here",
				},
			}),
		]);
		const rule = asFindingRule(nonNull(loadFindingRules(cwd)[0]));
		expect(rule.source).toStrictEqual({
			kind: "finding",
			bug_class: "nan_coercion_guard",
			finding_id: "fnd_full",
			found_at: "2026-01-01T00:00:00.000Z",
			repo: "acme/widget",
			commit: "abc123",
			file: "src/x.ts",
			lines: [10, 20],
			reviewer: "qcody",
			quote: "the bug is here",
		});
	});

	// test-contract: invariant — omits every optional field (no key at all, not even undefined) when absent
	it("omits every optional field (no key at all, not even undefined) when absent", () => {
		writeRules([baseRule({ id: "finding-minimal-source" })]);
		const rule = asFindingRule(nonNull(loadFindingRules(cwd)[0]));
		expect(rule.source).toStrictEqual({
			kind: "finding",
			finding_id: "fnd_x",
			bug_class: "nan_coercion_guard",
		});
	});

	// test-contract: invariant — only copies finding_id/found_at when they are strings (copyStringSourceField type guard)
	it("only copies finding_id/found_at when they are strings (copyStringSourceField type guard)", () => {
		writeRules([
			{
				...baseRule({ id: "finding-badtype" }),
				source: { kind: "finding", bug_class: "x", finding_id: 42, found_at: true },
			},
		]);
		const rule = asFindingRule(nonNull(loadFindingRules(cwd)[0]));
		expect(rule.source).toStrictEqual({ kind: "finding", bug_class: "x" });
	});
});

describe("applyRuleModification — partial overrides don't clobber the untouched field", () => {
	// test-contract: invariant — applies severity-only override, leaving action untouched
	it("applies severity-only override, leaving action untouched", () => {
		writeRules([baseRule({ id: "finding-sev-only", action: "warn" })]);
		writeOverrides({ modifications: { "finding-sev-only": { severity: "high" } } });
		const rule = nonNull(loadFindingRules(cwd)[0]);
		expect(rule.action).toBe("warn");
		expect(rule.severity).toBe("high");
	});

	// test-contract: invariant — applies action-only override, leaving severity untouched
	it("applies action-only override, leaving severity untouched", () => {
		writeRules([baseRule({ id: "finding-act-only", severity: "medium" })]);
		writeOverrides({ modifications: { "finding-act-only": { action: "block" } } });
		const rule = nonNull(loadFindingRules(cwd)[0]);
		expect(rule.action).toBe("block");
		expect(rule.severity).toBe("medium");
	});

	// test-contract: invariant — marks a modified rule user_modified: true
	it("marks a modified rule user_modified: true", () => {
		writeRules([baseRule({ id: "finding-usermod" })]);
		writeOverrides({ modifications: { "finding-usermod": { action: "block" } } });
		const rule = asFindingRule(nonNull(loadFindingRules(cwd)[0]));
		expect(rule.user_modified).toBe(true);
	});
});

describe("loadFindingRules — array defaults, malformed entries, enabled gate", () => {
	// test-contract: boundary — defaults removed/disabled ids to an empty set when overrides has no ids at all (no overrides file)
	it("defaults removed/disabled ids to an empty set when overrides has no ids at all (no overrides file)", () => {
		// A rule id equal to the mutant's injected sentinel string would be
		// spuriously filtered if either `?? []` default became a non-empty
		// array — this is only observable when there IS no overrides file.
		writeRules([baseRule({ id: "Stryker was here" })]);
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual(["Stryker was here"]);
	});

	// test-contract: boundary — skips a null entry in rules[] without throwing, and still loads the next valid rule
	it("skips a null entry in rules[] without throwing, and still loads the next valid rule", () => {
		writeRules([null, baseRule({ id: "finding-after-null" })]);
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual(["finding-after-null"]);
	});

	// test-contract: invariant — truncates the ReDoS-pattern stderr message to 120 chars and preserves the matched text
	it("truncates the ReDoS-pattern stderr message to 120 chars and preserves the matched text", () => {
		const marker = "ZZMARKERZZ";
		const longRegex = `(a+)+b${"x".repeat(200)}${marker}`;
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		writeRules([
			{ ...baseRule({ id: "finding-redos-long" }), patterns: [{ field: "content", regex: longRegex }] },
		]);
		const ids = loadFindingRules(cwd).map((r) => r.id);
		expect(ids).toEqual([]);
		expect(stderrSpy).toHaveBeenCalledTimes(1);
		const msg = String(stderrSpy.mock.calls[0]?.[0]);
		stderrSpy.mockRestore();
		expect(msg).toContain("(a+)+b");
		expect(msg).not.toContain(marker);
	});

	// test-contract: invariant — does not resurrect a dropped rule's source (if(source) guard is a real conditional)
	it("does not resurrect a dropped rule's source (if(source) guard is a real conditional)", () => {
		// Covered by the "drops the source entirely" case above via the same
		// fixture; asserted again here against the write path specifically.
		writeRules([{ ...baseRule({ id: "finding-nosource-2" }), source: undefined }]);
		const rule = nonNull(loadFindingRules(cwd)[0]);
		expect("source" in rule).toBe(false);
	});

	// test-contract: invariant — drops a rule whose raw.enabled is explicitly false (not just via disabled_rule_ids)
	it("drops a rule whose raw.enabled is explicitly false (not just via disabled_rule_ids)", () => {
		writeRules([baseRule({ id: "finding-hard-disabled", enabled: false })]);
		expect(loadFindingRules(cwd)).toEqual([]);
	});
});

describe("loadFindingRules — per-pattern ReDoS predicate (null/non-string entries)", () => {
	// test-contract: invariant — skips a null pattern entry (short-circuits before reading .regex) and still catches a real ReDoS sibling
	it("skips a null pattern entry (short-circuits before reading .regex) and still catches a real ReDoS sibling", () => {
		writeRules([
			{
				...baseRule({ id: "finding-nullpattern" }),
				patterns: [null, { field: "content", regex: "(a+)+b" }],
			},
		]);
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual([]);
	});

	it("skips a rule with a non-string regex before it reaches the evaluator", () => {
		writeRules([
			{ ...baseRule({ id: "finding-numregex" }), patterns: [{ field: "content", regex: 123 }] },
		]);
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual([]);
	});
});
