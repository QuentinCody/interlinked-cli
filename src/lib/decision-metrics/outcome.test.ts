import { expect, it } from "vitest";
import { decisionExitCode } from "./outcome.js";

it("keeps backend failures, uncertainty and unassessed budgets distinct in shell workflows", () => {
    const row = (status: string) => ({ schemaVersion: 1, contract: { id: "m" }, status });
    expect(decisionExitCode({ measurements: [row("answered")] })).toBe(0);
    expect(decisionExitCode({ measurements: [row("failed")] })).toBe(4);
    expect(decisionExitCode({ measurements: [row("answered"), row("failed")] })).toBe(6);
    expect(decisionExitCode({ measurements: [row("unassessed")] })).toBe(7);
    expect(decisionExitCode({ measurements: [row("abstained")] })).toBe(3);
    expect(decisionExitCode({ mode: "plan", measurements: [row("unassessed")] })).toBe(0);
});
