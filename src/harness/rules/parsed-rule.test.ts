import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GuardRule } from "../types.js";
import { loadDistilledRules } from "./distilled-rules.js";
import { loadFindingRules } from "./finding-rules.js";
import { parseRuntimeRule } from "./parsed-rule.js";

const valid: GuardRule = {
	id: "valid", enabled: true, trigger: "PreToolUse", tool_match: ["Bash"],
	action: "warn", patterns: [{ field: "command", regex: "danger" }],
	reason: "Review this command", severity: "medium",
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const invalidFields = [
	{ id: 1 }, { enabled: "false" }, { trigger: "BeforeTool" }, { tool_match: "Bash" },
	{ action: "deny" }, { severity: "warning" }, { reason: [] }, { patterns: false },
	{ patterns: [null] }, { patterns: [{ field: "command", regex: 123 }] },
	{ patterns: [{ field: "command", regex: "ok", negate: "false" }] },
	{ active_when: { phase: { name: "tdd_state", value: 1 } } },
	{ active_when: { after_command: { pattern: "build", window_steps: "10" } } },
	{ requires_prior: { verification_kind: "typo" } }, { forbids_after: [] },
	{ rewrite: { field: "command", match: "foo", replace: null } },
	{ applies_to_roles: ["admin"] }, { tool_externality: ["network"] },
	{ active_when: { agent_source: "cowork-typo" } },
	{ active_when: { agent_source: ["cowork", "cowork-typo"] } },
];

it("retains valid evaluator scope and rewrite fields", () => {
	const rule: GuardRule = {
		...valid, action: "rewrite", rewrite: { field: "command", match: "foo", replace: "bar" },
		active_when: { skill: ["tdd"], phase: { name: "tdd_state", value: "red", scope: "file" },
			after_command: { pattern: "test", window_steps: 10 }, overlay: "gpt", file_scope: "src/",
			agent_source: ["factory-droid", "codex"], predicate: { name: "custom", args: { allowed: true } } },
		requires_prior: { tool: "Read", file_read: "src/**", verification_kind: "test", within_last_n: 5 },
		forbids_after: { bash_match: "deploy" }, applies_to_roles: ["worker"], tool_externality: ["local_write"],
		keywords: ["foo"], file_extensions: ["ts"], expires_after: "1d",
	};
	expect(parseRuntimeRule(rule)).toEqual(rule);
});

for (const [name, load] of [["distilled-rules", loadDistilledRules], ["findings-rules", loadFindingRules]] as const) {
	describe(name, () => {
		function write(rules: unknown[], overrides: unknown = {}): string {
			const root = mkdtempSync(join(tmpdir(), "parsed-rule-"));
			roots.push(root);
			mkdirSync(join(root, ".interlinked"));
			writeFileSync(join(root, ".interlinked", `${name}.json`), JSON.stringify({ rules }));
			writeFileSync(join(root, ".interlinked", `${name}.overrides.json`), JSON.stringify(overrides));
			return root;
		}
		it.each(invalidFields)("skips malformed evaluator fields beside valid rules: %j", (fields) => {
			const root = write([{ ...valid, id: "bad", ...fields }, valid]);
			expect(load(root).map((rule) => rule.id)).toEqual(["valid"]);
		});
		it("ignores malformed overrides while retaining valid partial modifications", () => {
			const root = write([valid], {
				removed_rule_ids: 7, removed_groups: {}, disabled_rule_ids: "valid",
				modifications: { valid: { action: "typo", enabled: "false", severity: "high" } },
			});
			expect(load(root)[0]).toMatchObject({ action: "warn", enabled: true, severity: "high" });
		});
		it.each([{ agent_source: "cowork" }, { agent_source: ["cowork", "claude"] }])("retains Cowork-scoped runtime rules: %j", ({ agent_source }) => {
			const rule = { ...valid, active_when: { agent_source } };
			expect(parseRuntimeRule(rule)).toEqual(rule);
			expect(load(write([rule]))).toEqual([expect.objectContaining(rule)]);
		});
	});
}
