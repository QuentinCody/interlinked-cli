import assert from "node:assert/strict";
import test from "node:test";
import { summarizeLocalization } from "./graph-lab-replays.mjs";

test("localization aggregates per function rather than counting individual token votes", () => {
    const rows = [{ id: "a", metrics: { lexical: { top1: true, reciprocalRank: 1, changedMass: 0.5, uniformMass: 0.25, liftOverUniform: 2 } }, orderResults: [], graphEdges: 0, graphKind: "fixture" },
        { id: "b", metrics: { lexical: { top1: false, reciprocalRank: 0.5, changedMass: 0.1, uniformMass: 0.1, liftOverUniform: 1 } }, orderResults: [], graphEdges: 0, graphKind: "fixture" }];
    assert.equal(summarizeLocalization(rows).lexical!.top1, 0.5);
    assert.equal(summarizeLocalization(rows).lexical!.reciprocalRank, 0.75);
});
