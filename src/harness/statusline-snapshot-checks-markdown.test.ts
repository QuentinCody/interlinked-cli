import { describe, expect, it } from "vitest";
import { CHECK_REGISTRY } from "./check-registry/index.js";
import { getDefaultConfig } from "./rules-loader.js";
import {
	buildLoadedChecksMarkdown,
	buildLoadedRulesMarkdown,
	countChecks,
} from "./statusline-snapshot-checks-markdown.js";
import type { GuardRule, GuardRulesConfig, QualityCheckConfig } from "./types.js";

const REGISTRY_AGENT_SAFETY = CHECK_REGISTRY.filter((c) => c.pipeline === "agent_safety").length;

function emptyConfig(): GuardRulesConfig {
	const cfg = getDefaultConfig();
	cfg.rules = [];
	cfg.disabled_rules = [];
	return cfg;
}

function ruleFixture(over: Partial<GuardRule> & { id: string }): GuardRule {
	return {
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["*"],
		action: "block",
		patterns: [],
		reason: "because",
		severity: "high",
		category: "process",
		...over,
	};
}

function toolCheck(over: Partial<QualityCheckConfig> = {}): QualityCheckConfig {
	return {
		enabled: true,
		command: "tsc --noEmit",
		file_types: [".ts"],
		timeout_ms: 5000,
		severity: "error",
		...over,
	};
}

function inlineCheck(over: Partial<QualityCheckConfig> = {}): QualityCheckConfig {
	return {
		enabled: true,
		file_types: [".ts"],
		timeout_ms: 5000,
		severity: "warning",
		...over,
	};
}

describe("countChecks", () => {
	it("counts an enabled command-bearing entry as a tool", () => {
		const cfg = emptyConfig();
		cfg.quality_checks = { tsc: toolCheck() };
		const counts = countChecks(cfg);
		expect(counts.tools).toBe(1);
	});

	it("counts an enabled command-less entry, the agent_safety registry, and structural_checks as inline", () => {
		const cfg = emptyConfig();
		cfg.quality_checks = { secrets_in_source: inlineCheck() };
		(cfg as { structural_checks?: { enabled: boolean } }).structural_checks = { enabled: true };
		const counts = countChecks(cfg);
		expect(counts.inline).toBe(1 + REGISTRY_AGENT_SAFETY + 1);
	});

	it("skips disabled quality_checks entries entirely", () => {
		const cfg = emptyConfig();
		cfg.quality_checks = { tsc: toolCheck({ enabled: false }), lint: inlineCheck({ enabled: false }) };
		const counts = countChecks(cfg);
		expect(counts.tools).toBe(0);
		expect(counts.inline).toBe(REGISTRY_AGENT_SAFETY);
	});

	it("tolerates an undefined quality_checks entry (malformed/partial config)", () => {
		const cfg = emptyConfig();
		// SAFETY: exercising the runtime guard against a malformed config where
		// an entry is absent despite the static type promising it is present.
		cfg.quality_checks = { ghost: undefined as unknown as QualityCheckConfig };
		expect(() => countChecks(cfg)).not.toThrow();
	});
});

describe("buildLoadedRulesMarkdown", () => {
	it("lists active rules grouped by category with built-in vs custom source", () => {
		const cfg = emptyConfig();
		cfg.rules = [
			ruleFixture({ id: "custom-rule", category: "network", reason: "block egress" }),
		];
		const md = buildLoadedRulesMarkdown(cfg);
		expect(md).toContain("# Interlinked harness — loaded rules");
		expect(md).toContain("Total active rules: **1**");
		expect(md).toContain("## Network (1)");
		expect(md).toContain("`custom-rule` — block — high — custom — block egress");
	});

	it("lists disabled rule ids under their own section", () => {
		const cfg = emptyConfig();
		cfg.disabled_rules = ["some-builtin-id"];
		const md = buildLoadedRulesMarkdown(cfg);
		expect(md).toContain("## Disabled rules (1)");
		expect(md).toContain("~~`some-builtin-id`~~");
	});

	it("omits the disabled section when nothing is disabled", () => {
		const md = buildLoadedRulesMarkdown(emptyConfig());
		expect(md).not.toContain("## Disabled rules");
	});
});

describe("buildLoadedChecksMarkdown", () => {
	function mixedConfig(): GuardRulesConfig {
		const cfg = emptyConfig();
		cfg.quality_checks = {
			tsc: toolCheck(),
			secrets_in_source: inlineCheck(),
			unused: inlineCheck({ enabled: false }),
		};
		return cfg;
	}

	it("includes the header", () => {
		expect(buildLoadedChecksMarkdown(mixedConfig())).toContain("# Interlinked harness — loaded checks");
	});

	it("sections enabled tool runners with their command", () => {
		const md = buildLoadedChecksMarkdown(mixedConfig());
		expect(md).toContain("## Tool runners — enabled (1)");
		expect(md).toContain("`tsc` — error — `tsc --noEmit`");
	});

	it("sections enabled config-driven inline checks", () => {
		const md = buildLoadedChecksMarkdown(mixedConfig());
		expect(md).toContain("## Inline detectors — config-driven (1)");
		expect(md).toContain("`secrets_in_source` — warning");
	});

	it("sections the always-loaded registry checks", () => {
		const md = buildLoadedChecksMarkdown(mixedConfig());
		expect(md).toContain(`## Inline detectors — registry (${REGISTRY_AGENT_SAFETY})`);
	});

	it("sections disabled checks", () => {
		const md = buildLoadedChecksMarkdown(mixedConfig());
		expect(md).toContain("## Quality checks — disabled (1)");
		expect(md).toContain("~~`unused`~~");
	});

	it("folds the structural_checks bundle into the config-driven section header count", () => {
		const cfg = emptyConfig();
		cfg.quality_checks = {};
		(cfg as { structural_checks?: { enabled: boolean } }).structural_checks = { enabled: true };
		const md = buildLoadedChecksMarkdown(cfg);
		expect(md).toContain("## Inline detectors — config-driven (1)");
		expect(md).toContain("`structural_checks` — error — bundle");
	});
});
