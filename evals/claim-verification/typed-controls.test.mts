import test from "node:test";
import assert from "node:assert/strict";
import { makeTypedControls, makeTextControls, deterministicOutcome } from "./typed-controls.mjs";

test("constructed positive, changed, removed and summary receipts obey the four explicit predicates", () => {
    const rows = makeTypedControls(17);
    assert.equal(rows.length, 24);
    for (const row of rows) assert.equal(deterministicOutcome(row)?.status === "supported", row.expectedSupport, row.id);
    assert.equal(rows.filter(r => r.expectedSupport).length, 8);
    assert.equal(rows.find(r => r.parentId.endsWith(":file_written") && r.variant === "altered")!.expectedSupport, false);
});
test("document-value controls leave an honest non-verifier path", () => {
    const rows = makeTextControls(41);
    assert.equal(rows.length, 24);
    assert.equal(rows.filter(r => r.expectedSupport).length, 8);
    assert.ok(rows.every(r => deterministicOutcome(r) === null));
    const altered = rows.find(r => r.variant === "altered")!;
    assert.equal(JSON.parse(altered.evidence[0]!.result_tail).retry_limit, 42);
    assert.match(altered.claim, /41/);
});
test("agent summaries cannot carry a trusted typed receipt and missing linkage is not guessed", () => {
    const row = makeTypedControls(19).find(r => r.variant === "summary_only")!;
    assert.equal(deterministicOutcome(row)?.status, "not_assessable");
    const regular = makeTypedControls(19)[0]!;
    const unlinked = structuredClone(regular);
    delete unlinked.interpretation;
    assert.equal(deterministicOutcome(unlinked), null);
});
