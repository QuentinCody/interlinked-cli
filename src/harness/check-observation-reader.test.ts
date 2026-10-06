import { expect, it } from "vitest";
import { isCheckObservation } from "./check-observation-reader.js";

it("rejects legacy and incomplete records rather than deriving clean rechecks", () => {
    expect(isCheckObservation({ schema: "check-results.v2", execution: [] })).toBe(false);
    expect(isCheckObservation({ schema: "check-observations.v1", executions: [] })).toBe(false);
    expect(isCheckObservation({ schema: "check-observations.v1", ts: "now", session: "s", call: "c", file: "a",
        input: "x", detector: "v", configuration: "p", scope: "full",
        executions: [{ check: "x", status: "completed", findings: [{ text: "missing line" }], emitted: null, duration_ms: 1 }],
    })).toBe(false);
});
it("rejects malformed timestamps, duplicate executions and nonfinite costs", () => {
    const execution = { check: "x", status: "completed", findings: [], emitted: null, duration_ms: 1 };
    const row = { schema: "check-observations.v1", ts: "2026-10-04T00:00:00Z", session: "s", call: "c", file: "a",
        input: "x", detector: "v", configuration: "p", scope: "full", executions: [execution] };
    expect(isCheckObservation(row)).toBe(true);
    expect(isCheckObservation({ ...row, ts: "now" })).toBe(false);
    expect(isCheckObservation({ ...row, executions: [execution, execution] })).toBe(false);
    expect(isCheckObservation({ ...row, executions: [{ ...execution, duration_ms: Infinity }] })).toBe(false);
});
