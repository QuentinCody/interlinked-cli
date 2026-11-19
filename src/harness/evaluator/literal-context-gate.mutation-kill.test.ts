import { describe, expect, it } from "vitest";
import type { GuardRule } from "../types.js";
import { lazyLiteralGate, literalOnlyWarning } from "./literal-context-gate.js";

describe("literal-context-gate mutation-kill", () => {
	// test-contract: boundary — a soft_block rule that matches only inside a data literal degrades to a warning
	it("degrades a soft_block rule matching only inside a printf literal", () => {
		const rule: GuardRule = {
			id: "test-soft",
			enabled: true,
			trigger: "PreToolUse",
			tool_match: ["Bash"],
			action: "soft_block",
			patterns: [{ field: "command", regex: "\\bdocker\\s+system\\s+prune\\b" }],
			reason: "r",
			severity: "high",
			category: "containers",
		};
		const cmd = `printf '%s' 'docker system prune' | base64`;
		const warning = literalOnlyWarning(rule, { command: cmd }, lazyLiteralGate("Bash", cmd));
		expect(warning).toContain("rule test-soft matched inside a string literal (printf argument)");
	});

	// test-contract: boundary — a non-stopping action (warn) is never routed through the literal gate
	it("returns null for a warn rule", () => {
		const rule: GuardRule = {
			id: "test-warn",
			enabled: true,
			trigger: "PreToolUse",
			tool_match: ["Bash"],
			action: "warn",
			patterns: [{ field: "command", regex: "\\bdocker\\s+system\\s+prune\\b" }],
			reason: "r",
			severity: "high",
			category: "containers",
		};
		const cmd = `printf '%s' 'docker system prune' | base64`;
		expect(literalOnlyWarning(rule, { command: cmd }, lazyLiteralGate("Bash", cmd))).toBeNull();
	});
});
