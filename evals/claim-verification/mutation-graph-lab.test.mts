import assert from "node:assert/strict";
import test from "node:test";
import { observedSubsumption, diversify, meanRank } from "./mutation-graph-lab.mjs";

test("observed subsumption excludes empty survivor kill sets and has the correct direction", () => {
    const graph = observedSubsumption({ a: ["t1", "t2"], b: ["t1"], c: [], d: [] });
    assert.ok(graph.edges.some(([a, b]) => graph.groups[a]!.mutants.includes("b") && graph.groups[b]!.mutants.includes("a")));
    assert.deepEqual(graph.unresolvedSurvivors, ["c", "d"]);
    assert.equal(graph.groups.length, 2);
});
test("structural diversity delays duplicate neighborhoods without dropping candidates", () => {
    assert.deepEqual(diversify(["a", "b", "c"], { a: "same", b: "same", c: "other" }), ["a", "c", "b"]);
    assert.deepEqual(new Set(meanRank(["a", "b"], ["b", "a"])), new Set(["a", "b"]));
});
