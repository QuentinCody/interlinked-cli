import { beforeAll, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import type { GuardRule, GuardRulesConfig, HarnessDecision } from "../types.js";
import { lazyLiteralGate, literalGateFor, literalOnlyWarning } from "./literal-context-gate.js";

let rules: GuardRulesConfig;

beforeAll(() => {
	rules = getDefaultConfig();
	rules.rules = loadRules(process.cwd()).rules;
});

function decide(command: string, toolName = "Bash"): HarnessDecision {
	return evaluatePreToolUse(
		{
			hook_event: "PreToolUse",
			session_id: "literal-gate",
			agent_source: "claude",
			agent_name: "literal-gate",
			tool_name: toolName,
			tool_input: { command },
			timestamp: "2026-10-08T00:00:00.000Z",
		},
		rules,
		undefined,
		new ReservationManager(),
		new CohortManager(),
	);
}

function guardWarnings(d: HarnessDecision): string[] {
	return (d.warnings ?? []).filter((w) => w.startsWith("[interlinked:guard]"));
}

describe("literal-context gate — positive (must fire: block becomes a warning)", () => {
	it("P1: a for-loop feeding `interlinked harness test` is allowed with a literal warning", () => {
		const d = decide(`for c in 'docker system prune -af'; do interlinked harness test "$c"; done`);
		expect(d.decision).toBe("allow");
		expect(guardWarnings(d).some((w) => w.includes("rule builtin-docker-prune matched inside a string literal"))).toBe(true);
		expect(guardWarnings(d)[0]).toContain("not blocked — the text is data, not an executed command");
		// The rule loop and the compound pass report the rule once, not twice.
		expect(guardWarnings(d).filter((w) => w.includes("rule builtin-docker-prune "))).toHaveLength(1);
	});

	it("P2: a grep pattern naming DROP TABLE is allowed with a literal warning", () => {
		const d = decide(`grep -rn "DROP TABLE" src/db | head -5`);
		expect(d.decision).toBe("allow");
		expect(guardWarnings(d).join("\n")).toContain("(grep pattern)");
	});

	it("P3: literalOnlyWarning degrades an ask rule too", () => {
		const rule: GuardRule = {
			id: "test-ask",
			enabled: true,
			trigger: "PreToolUse",
			tool_match: ["Bash"],
			action: "ask",
			patterns: [{ field: "command", regex: "\\bdocker\\s+system\\s+prune\\b" }],
			reason: "r",
			severity: "high",
			category: "containers",
		};
		const cmd = `printf '%s' 'docker system prune' | base64`;
		const warning = literalOnlyWarning(rule, { command: cmd }, lazyLiteralGate("Bash", cmd));
		expect(warning).toContain("rule test-ask matched inside a string literal (printf argument)");
	});
});

describe("literal-context gate — negative (must not fire: the block stands)", () => {
	it("N1: the bare command is still blocked", () => {
		const d = decide("docker system prune -af");
		expect(d.decision).toBe("block");
		expect(d.rule_id).toBe("builtin-docker-prune");
	});

	it("N2: echo piped to sh and bash -c are still blocked", () => {
		expect(decide(`echo 'docker system prune -af' | sh`).decision).toBe("block");
		expect(decide(`bash -c 'docker system prune -af'`).decision).toBe("block");
	});

	it("N3: an eval loop and a loop that also executes the text after the literal are still blocked", () => {
		expect(decide(`for c in 'docker system prune -af'; do eval "$c"; done`).decision).toBe("block");
		expect(decide(`interlinked harness test 'x'; docker system prune -af`).decision).toBe("block");
	});

	it("N4: a non-shell tool and a warn-only rule get no literal gate", () => {
		expect(literalGateFor("Write", `printf '%s' 'docker system prune' | base64`)).toBeNull();
		const warnRule: GuardRule = {
			id: "test-warn",
			enabled: true,
			trigger: "PreToolUse",
			tool_match: ["Bash"],
			action: "warn",
			patterns: [{ field: "command", regex: "prune" }],
			reason: "r",
			severity: "low",
			category: "containers",
		};
		const cmd = `printf '%s' 'docker system prune' | base64`;
		expect(literalOnlyWarning(warnRule, { command: cmd }, lazyLiteralGate("Bash", cmd))).toBeNull();
	});
});
