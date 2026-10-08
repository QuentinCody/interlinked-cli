import { expect, it } from "vitest";
import { diffRuns, probabilityFor, measurementKey } from "./reports.js";
import type { Measurement, DecisionRun } from "./types.js";

it("reports model drift even when the interpreted answer stays the same", () => {
    const before = {
        id: "x",
        unitId: "x",
        contract: { id: "n", adverse: false },
        record: { repository: "r", revision: "a", provenance: { metricsVersion: "test" } },
        status: "answered",
        value: true,
        raw: { kind: "yes_no", probability: 0.9 },
        provenance: { modelIdentity: "v1", questionHash: "a" },
    } as Measurement; // SAFETY: focused report fixture supplies every field consumed by these report functions.
    const after = { ...before, provenance: { ...before.provenance, modelIdentity: "v2" } };
    expect(probabilityFor(before)).toBeCloseTo(0.1);
    expect(measurementKey(before)).toContain("r");
    const a = { measurements: [before] } as DecisionRun; // SAFETY: diff reads the measurement array only.
    const b = { measurements: [after] } as DecisionRun; // SAFETY: diff reads the measurement array only.
    expect(diffRuns(a, b).changes[0]?.kind).toBe("metric_drift");
});
