import test from "node:test";
import assert from "node:assert/strict";
import { locateQuotes, codePointCandidate } from "./external-extractors.mjs";

test("generated quotes must occur exactly once; repeated text cannot be assigned invented offsets", () => {
    const out = locateQuotes("Tests pass. Tests pass. Build failed.", ["Tests pass.", "Build failed.", "invented"]);
    assert.equal(out.candidates.length, 1);
    assert.equal(out.rejected, 2);
    assert.deepEqual(out.candidates[0]!.spans, [[24, 37]]);
});
test("Clairic code-point coordinates are converted to exact UTF-16 source spans", () => {
    assert.deepEqual(codePointCandidate("🧬 result", "result", [2, 8])?.spans, [[3, 9]]);
    assert.equal(codePointCandidate("🧬 result", "wrong", [2, 8]), null);
});
