import { expect, it } from "vitest";
import { clusterGoals, obligationStatus, decisionGraph, reconcilePreference } from "./relations.js";

it("surfaces contradictory pair judgments instead of averaging them", () => {
    const graph = clusterGoals(
        ["a", "b", "c"],
        [
            { left: "a", right: "b", relation: "same_goal" },
            { left: "b", right: "c", relation: "supporting" },
            { left: "a", right: "c", relation: "independent" },
        ],
    );
    expect(graph.groups).toEqual([["a", "b", "c"]]);
    expect(graph.contradictions).toEqual([{ left: "a", right: "c", relation: "independent" }]);
});

it("never rewards edits when verification alone or no work is required", () => {
    expect(obligationStatus({ status: "answered", value: "no_work" }, null)).toBe(
        "no_work_required",
    );
    expect(obligationStatus({ status: "answered", value: "verify_only" }, null)).toBe(
        "verify_only",
    );
    expect(
        obligationStatus(
            { status: "abstained", value: null },
            { status: "answered", value: "satisfied" },
        ),
    ).toBe("abstained");
    expect(
        obligationStatus(
            { status: "answered", value: "update" },
            { status: "failed", value: null },
        ),
    ).toBe("failed");
    expect(reconcilePreference("left", "right")).toBe("left");
    expect(reconcilePreference("left", "left")).toBe("order_sensitive");
});

it("validates the DAG before inference and stops dependencies on insufficient evidence", async () => {
    let calls = 0;
    const results = await decisionGraph([
        {
            id: "first",
            dependencies: [],
            run: async () => ({ status: "insufficient_evidence", value: null }),
        },
        {
            id: "second",
            dependencies: ["first"],
            run: async () => {
                calls++;
                return { status: "answered", value: true };
            },
        },
    ]);
    expect(results.second?.status).toBe("unassessed");
    expect(calls).toBe(0);
    await expect(
        decisionGraph([
            {
                id: "cycle",
                dependencies: ["cycle"],
                run: async () => ({ status: "answered", value: true }),
            },
        ]),
    ).rejects.toThrow(/cycle/);
});
