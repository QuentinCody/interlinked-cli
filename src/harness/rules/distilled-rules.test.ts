// Tests for the distilled-from-markdown rules loader (companion to
// `distilled-rules.ts`). Verifies:
//   1. Pristine load returns rules unchanged when no overrides exist.
//   2. `removed_groups[]` filters out matching rules entirely.
//   3. `removed_rule_ids[]` filters out matching rules entirely.
//   4. `disabled_rule_ids[]` flips `enabled: false` (rule still present).
//   5. `modifications{}` overrides action/severity and stamps `user_modified`.
//   6. Malformed distilled-rules.json returns [] (fail-open).
//   7. Watch-paths returns the canonical pair.
//   8. Legacy `compiled-rules.*` files auto-migrate to the new names on load.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { getDistilledRulesWatchPaths, loadDistilledRules } from "./distilled-rules.js";

interface SamplePayload {
	rules?: unknown[];
	[k: string]: unknown;
}

let tmpRoot: string;

function writeDistilled(payload: SamplePayload): void {
	mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
	writeFileSync(
		join(tmpRoot, ".interlinked", "distilled-rules.json"),
		JSON.stringify(payload),
	);
}

function writeOverrides(payload: Record<string, unknown>): void {
	mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
	writeFileSync(
		join(tmpRoot, ".interlinked", "distilled-rules.overrides.json"),
		JSON.stringify(payload),
	);
}

const SAMPLE_RULE = {
	id: "enforce-local-agents-md-no-push-main",
	enabled: true,
	trigger: "PreToolUse",
	tool_match: ["Bash"],
	action: "block",
	patterns: [{ field: "command", regex: "^git\\s+push\\b.*\\bmain\\b" }],
	reason: "BLOCKED by AGENTS.md:42",
	severity: "critical",
	category: "distilled-from-md",
	source: {
		group_id: "local:AGENTS.md",
		file: "AGENTS.md",
		lines: [42, 42],
		quote: "Never push to main without code review.",
		lexical_marker: "Never",
	},
};

const SECOND_RULE = {
	id: "enforce-skill-tdd-no-bulk-tests",
	enabled: true,
	trigger: "PreToolUse",
	tool_match: ["Edit", "Write"],
	action: "ask",
	patterns: [{ field: "file_path", regex: "src/" }],
	reason: "tdd skill",
	severity: "medium",
	category: "distilled-from-md",
	source: {
		group_id: "skill:tdd",
		file: ".claude/skills/tdd/SKILL.md",
		lines: [23, 25],
		quote: "explicitly bans the horizontal anti-pattern",
	},
};

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "distilled-rules-test-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadDistilledRules", () => {
	it("returns [] when distilled-rules.json is absent", () => {
		expect(loadDistilledRules(tmpRoot)).toEqual([]);
	});

	it("returns rules unchanged when no overrides file exists", () => {
		writeDistilled({ rules: [SAMPLE_RULE, SECOND_RULE] });
		const rules = loadDistilledRules(tmpRoot);
		expect(rules).toHaveLength(2);
		expect(nonNull(rules[0]).id).toBe(SAMPLE_RULE.id);
		expect(nonNull(rules[0]).action).toBe("block");
		expect(nonNull(rules[1]).action).toBe("ask");
	});

	it("filters out rules whose source.group_id is in removed_groups[]", () => {
		writeDistilled({ rules: [SAMPLE_RULE, SECOND_RULE] });
		writeOverrides({ removed_groups: ["skill:tdd"] });
		const rules = loadDistilledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(nonNull(rules[0]).id).toBe(SAMPLE_RULE.id);
	});

	it("filters out rules whose id is in removed_rule_ids[]", () => {
		writeDistilled({ rules: [SAMPLE_RULE, SECOND_RULE] });
		writeOverrides({ removed_rule_ids: [SAMPLE_RULE.id] });
		const rules = loadDistilledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(nonNull(rules[0]).id).toBe(SECOND_RULE.id);
	});

	it("flips enabled:false on rules in disabled_rule_ids[] but keeps them", () => {
		writeDistilled({ rules: [SAMPLE_RULE, SECOND_RULE] });
		writeOverrides({ disabled_rule_ids: [SAMPLE_RULE.id] });
		const rules = loadDistilledRules(tmpRoot);
		expect(rules).toHaveLength(2);
		const disabled = rules.find((r) => r.id === SAMPLE_RULE.id);
		expect(disabled?.enabled).toBe(false);
		const stillEnabled = rules.find((r) => r.id === SECOND_RULE.id);
		expect(stillEnabled?.enabled).toBe(true);
	});

	it("applies modifications.action and stamps user_modified", () => {
		writeDistilled({ rules: [SAMPLE_RULE] });
		writeOverrides({
			modifications: {
				[SAMPLE_RULE.id]: { action: "ask", severity: "medium" },
			},
		});
		const rules = loadDistilledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(nonNull(rules[0]).action).toBe("ask");
		expect(nonNull(rules[0]).severity).toBe("medium");
		// The override also retains its review metadata.
		expect(rules[0]).toMatchObject({ user_modified: true });
	});

	it("returns [] when distilled-rules.json is malformed (fail-open)", () => {
		mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmpRoot, ".interlinked", "distilled-rules.json"),
			"{ not valid json",
		);
		expect(loadDistilledRules(tmpRoot)).toEqual([]);
	});

	it("ignores malformed overrides and still loads pristine rules", () => {
		writeDistilled({ rules: [SAMPLE_RULE] });
		mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmpRoot, ".interlinked", "distilled-rules.overrides.json"),
			"not json at all",
		);
		const rules = loadDistilledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(nonNull(rules[0]).action).toBe("block");
	});

	it("skips entries with missing id rather than throwing", () => {
		writeDistilled({ rules: [{ ...SAMPLE_RULE, id: undefined }, SECOND_RULE] });
		const rules = loadDistilledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(nonNull(rules[0]).id).toBe(SECOND_RULE.id);
	});

	it("returns [] when distilled-rules.json parses to a non-object value (e.g. a bare number)", () => {
		mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
		writeFileSync(join(tmpRoot, ".interlinked", "distilled-rules.json"), "42");
		expect(loadDistilledRules(tmpRoot)).toEqual([]);
	});

	it("ignores overrides that parse to a non-object value and still loads pristine rules", () => {
		writeDistilled({ rules: [SAMPLE_RULE] });
		mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
		writeFileSync(join(tmpRoot, ".interlinked", "distilled-rules.overrides.json"), "null");
		const rules = loadDistilledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(nonNull(rules[0]).id).toBe(SAMPLE_RULE.id);
	});

	it("skips a rule with a ReDoS-prone pattern and logs a warning to stderr", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const unsafeRule = {
				...SAMPLE_RULE,
				id: "enforce-redos-prone",
				patterns: [{ field: "command", regex: "(a+)+" }],
			};
			writeDistilled({ rules: [unsafeRule, SECOND_RULE] });
			const rules = loadDistilledRules(tmpRoot);
			expect(rules).toHaveLength(1);
			expect(nonNull(rules[0]).id).toBe(SECOND_RULE.id);
			expect(stderrSpy).toHaveBeenCalledTimes(1);
			expect(stderrSpy.mock.calls[0]?.[0]).toContain("enforce-redos-prone");
			expect(stderrSpy.mock.calls[0]?.[0]).toContain("ReDoS-prone pattern");
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it("keeps a rule with no patterns array at all (ReDoS check short-circuits)", () => {
		const { patterns: _drop, ...noPatterns } = SAMPLE_RULE;
		writeDistilled({ rules: [noPatterns] });
		const rules = loadDistilledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(nonNull(rules[0]).id).toBe(SAMPLE_RULE.id);
	});

	it("skips non-object entries in rules[] without throwing", () => {
		writeDistilled({ rules: [null, 42, SAMPLE_RULE] });
		const rules = loadDistilledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(nonNull(rules[0]).id).toBe(SAMPLE_RULE.id);
	});

	it("applies modifications.enabled alone (no action/severity in the modification)", () => {
		writeDistilled({ rules: [SAMPLE_RULE] });
		writeOverrides({
			modifications: {
				[SAMPLE_RULE.id]: { enabled: false },
			},
		});
		const rules = loadDistilledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(nonNull(rules[0]).action).toBe(SAMPLE_RULE.action);
		expect(nonNull(rules[0]).severity).toBe(SAMPLE_RULE.severity);
		expect(nonNull(rules[0]).enabled).toBe(false);
	});

	it("defaults enabled to true when the source rule omits it and no override touches it", () => {
		const { enabled: _drop, ...noEnabled } = SAMPLE_RULE;
		writeDistilled({ rules: [noEnabled] });
		const rules = loadDistilledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(nonNull(rules[0]).enabled).toBe(true);
	});

	it("removed_rule_ids takes precedence over modifications", () => {
		writeDistilled({ rules: [SAMPLE_RULE] });
		writeOverrides({
			removed_rule_ids: [SAMPLE_RULE.id],
			modifications: {
				[SAMPLE_RULE.id]: { action: "ask" },
			},
		});
		const rules = loadDistilledRules(tmpRoot);
		expect(rules).toHaveLength(0);
	});

	describe("legacy migration", () => {
		it("renames compiled-rules.json to distilled-rules.json on load", () => {
			mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
			writeFileSync(
				join(tmpRoot, ".interlinked", "compiled-rules.json"),
				JSON.stringify({ rules: [SAMPLE_RULE] }),
			);
			const rules = loadDistilledRules(tmpRoot);
			expect(rules).toHaveLength(1);
			expect(nonNull(rules[0]).id).toBe(SAMPLE_RULE.id);
			expect(existsSync(join(tmpRoot, ".interlinked", "distilled-rules.json"))).toBe(true);
			expect(existsSync(join(tmpRoot, ".interlinked", "compiled-rules.json"))).toBe(false);
		});

		it("renames compiled-rules.overrides.json on load", () => {
			mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
			writeFileSync(
				join(tmpRoot, ".interlinked", "distilled-rules.json"),
				JSON.stringify({ rules: [SAMPLE_RULE] }),
			);
			writeFileSync(
				join(tmpRoot, ".interlinked", "compiled-rules.overrides.json"),
				JSON.stringify({ disabled_rule_ids: [SAMPLE_RULE.id] }),
			);
			const rules = loadDistilledRules(tmpRoot);
			expect(nonNull(rules[0]).enabled).toBe(false);
			expect(
				existsSync(join(tmpRoot, ".interlinked", "distilled-rules.overrides.json")),
			).toBe(true);
			expect(
				existsSync(join(tmpRoot, ".interlinked", "compiled-rules.overrides.json")),
			).toBe(false);
		});

		it("does not clobber an existing distilled-rules.json", () => {
			mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
			writeFileSync(
				join(tmpRoot, ".interlinked", "distilled-rules.json"),
				JSON.stringify({ rules: [SAMPLE_RULE] }),
			);
			writeFileSync(
				join(tmpRoot, ".interlinked", "compiled-rules.json"),
				JSON.stringify({ rules: [SECOND_RULE] }),
			);
			const rules = loadDistilledRules(tmpRoot);
			expect(rules).toHaveLength(1);
			expect(nonNull(rules[0]).id).toBe(SAMPLE_RULE.id);
			// Legacy file is left in place when migration would clobber.
			expect(existsSync(join(tmpRoot, ".interlinked", "compiled-rules.json"))).toBe(true);
		});
	});
});

describe("getDistilledRulesWatchPaths", () => {
	it("returns the two canonical paths under .interlinked/", () => {
		const paths = getDistilledRulesWatchPaths(tmpRoot);
		expect(paths).toHaveLength(2);
		expect(paths[0]).toBe(join(tmpRoot, ".interlinked", "distilled-rules.json"));
		expect(paths[1]).toBe(
			join(tmpRoot, ".interlinked", "distilled-rules.overrides.json"),
		);
	});
});


it("treats a legacy rules envelope without a rules array as empty", () => {
    writeDistilled({ version: 1 });
    expect(loadDistilledRules(tmpRoot)).toEqual([]);
});


it("retains otherwise valid legacy rules without source metadata", () => {
    const { source: _source, ...rule } = SAMPLE_RULE;
    writeDistilled({ rules: [rule] });
    writeOverrides({ removed_groups: ["local:AGENTS.md"] });
    expect(loadDistilledRules(tmpRoot)).toEqual([rule]);
});
