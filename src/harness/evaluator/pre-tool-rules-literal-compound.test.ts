import { afterEach, expect, it, vi } from "vitest";
import { evaluateCompoundCommand } from "../command-decomposition.js";
import { getDefaultConfig } from "../rules-loader.js";
import { evaluateDestructiveRules } from "./pre-tool-rules.js";

vi.mock("../command-decomposition.js", async original => ({
    ...await original<typeof import("../command-decomposition.js")>(),
    evaluateCompoundCommand: vi.fn(),
}));
afterEach(() => { vi.resetAllMocks(); });

it.each([undefined, "named-rule"])("retains a literal-only compound warning when the decomposition identifies %s", ruleId => {
    // A compound decision may be unnamed; masking must still be verified before
    // downgrading it, and the original diagnostic must remain visible once.
    vi.mocked(evaluateCompoundCommand)
        .mockReturnValueOnce({ decision: "block", warnings: ["compound diagnostic"], ...(ruleId ? { rule_id: ruleId } : {}) })
        .mockReturnValueOnce({ decision: "allow", warnings: [] });
    const warnings: string[] = [];
    const rules = { ...getDefaultConfig(), rules: [] };
    const decision = evaluateDestructiveRules({ hook_event: "PreToolUse", agent_source: "claude", session_id: "literal-compound",
        timestamp: "2026-10-19T00:00:00Z", tool_name: "Bash", tool_input: { command: "printf '%s' 'docker system prune' | cat" } }, rules, undefined, warnings);
    expect(decision).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toBe("compound diagnostic");
    expect(warnings[1]).toContain(`rule ${ruleId ?? "compound-subcommand"} matched inside a string literal`);
    expect(evaluateCompoundCommand).toHaveBeenCalledTimes(2);
});
