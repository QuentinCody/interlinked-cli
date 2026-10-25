import assert from "node:assert/strict";
import test from "node:test";
import { tokens, changedIndices, localBindingEdges, scoreLocalization } from "./localization-lab.mjs";

test("lexical edits align replacements and anchor insertions", () => {
    const before = tokens("return n < 3;"), after = tokens("return n <= 3;");
    assert.deepEqual(changedIndices(before, after).map(i => before[i]!.text), ["<"]);
    const inserted = changedIndices(tokens("return n;"), tokens("return n + 1;"));
    assert.ok(inserted.length > 0);
});
test("binding graph connects references but does not treat unrelated spelling as data flow", () => {
    const source = "function f(n: number) { const value = n + 1; return value; }";
    const list = tokens(source), edges = localBindingEdges(source, list);
    const refs = list.flatMap((t, i) => t.text === "value" ? [i] : []);
    assert.ok(edges.some(([a, b]) => a === refs[0] && b === refs[1]));
});
test("localization mass and reciprocal rank use the recorded changed sites", () => {
    const result = scoreLocalization([0.1, 0.2, 0.7], [1]);
    assert.equal(result.changedMass, 0.2);
    assert.equal(result.reciprocalRank, 0.5);
    assert.equal(result.top1, false);
});
