import assert from "node:assert/strict";
import test from "node:test";
import { reachable, clauseCandidates, lexicalScore, diffuse, diffusePreservingMass, choose, moduleGraph } from "./graph-lab-core.mjs";

test("reachability respects direction and cycles", () => {
    assert.deepEqual([...reachable(["entry"], [["entry", "a"], ["a", "b"], ["b", "a"], ["orphan", "b"]])].sort(), ["a", "b", "entry"]);
});
test("literal imports produce edges while computed imports preserve opacity", () => {
    const graph = moduleGraph({ "a.ts": 'import "./b.js"; import(name);', "b.ts": "export const x = 1;" });
    assert.deepEqual(graph.edges, [["a.ts", "b.ts"]]);
    assert.deepEqual(graph.opaque, ["a.ts"]);
});
test("clause candidates keep negation and source offsets", () => {
    const source = "Tests passed; I did not run lint.\nOnly unit cases were selected.";
    const rows = clauseCandidates(source);
    assert.equal(rows.length, 3);
    assert.ok(rows.some(r => r.text.includes("not")));
    for (const r of rows) assert.equal(source.slice(...r.spans[0]!), r.text);
});
test("lexical and graph rankings have explicit zero and unmatched behavior", () => {
    assert.equal(lexicalScore("parseWords", "parse words"), 1);
    assert.equal(lexicalScore("unrelated", "parse words"), 0);
    const scores = diffuse([1, 0, 0], [[0, 1], [1, 0]], 0.8);
    assert.ok(scores[1]! > 0 && scores[2] === 0);
    assert.ok(Math.abs(scores.reduce((a, b) => a + b) - 1) < 1e-8);
    assert.equal(choose({ a: 0.2, none: 0.8 }), "none");
});
test("graph expansion preserves the mass reserved for no matching location", () => {
    assert.ok(Math.abs(diffusePreservingMass([0.2, 0.2], [[0, 1], [1, 0]]).reduce((a, b) => a + b, 0) - 0.4) < 1e-8);
    assert.deepEqual(diffusePreservingMass([0, 0], [[0, 1]]), [0, 0]);
});
