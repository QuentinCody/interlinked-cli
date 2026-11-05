import { expect, it } from "vitest";
import { decisionExitCode } from "./outcome.js";

const row = (status: string) => ({ schemaVersion: 1, contract: { id: "m" }, status });

// test-contract: public-api — insufficient evidence is an uncertainty outcome (exit 3), never a clean 0
it("exits 3 when a measurement has insufficient evidence", () => {
    expect(decisionExitCode({ measurements: [row("insufficient_evidence")] })).toBe(3);
});

// test-contract: invariant — one insufficient-evidence row withholds success even beside answered rows
it("exits 3 for answered plus insufficient-evidence measurements", () => {
    expect(decisionExitCode({ measurements: [row("answered"), row("insufficient_evidence")] })).toBe(3);
});
