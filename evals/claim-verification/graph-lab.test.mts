import assert from "node:assert/strict";
import test from "node:test";
import { modelAccount, summarizeCore } from "./graph-lab.mjs";

test("Cloudflare evaluation needs the caller's explicit account; Jev does not", () => {
    assert.equal(modelAccount("jev-1.13.0", {}), "");
    assert.throws(() => modelAccount("clef-flash", {}), /CLOUDFLARE_ACCOUNT_ID/);
    assert.throws(() => modelAccount("clef-flash", { CLOUDFLARE_ACCOUNT_ID: "../other" }), /CLOUDFLARE_ACCOUNT_ID/);
    assert.equal(modelAccount("clef-flash", { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) }), "a".repeat(32));
});

test("core summaries report held-out results separately from development examples", () => {
    const row = { split: "holdout", expected: true, graphLexical: true, graphOracle: true, rawP: 0.2, graphP: 0.95, graphThenLinkedVerifier: true };
    const result = summarizeCore("provenance", [row, { ...row, split: "development", rawP: 0.95 }]);
    assert.equal(result.holdout.raw!.truePositives, 0);
    assert.equal(result.holdout.graph!.truePositives, 1);
    assert.equal(result.development.raw!.truePositives, 1);
});
