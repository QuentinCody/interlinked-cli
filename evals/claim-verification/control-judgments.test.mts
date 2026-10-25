import test from "node:test";
import assert from "node:assert/strict";
import { JevClient } from "../../src/harness/jev/client.js";
import { runControl, routeControl } from "./control-judgments.mjs";
import { historicalControls } from "./controls.mjs";
import { makeTypedControls } from "./typed-controls.mjs";

test("summary-only controls cannot enter any model window when provenance enforcement is on", async () => {
    let requests = 0;
    const client = new JevClient({ apiKey: "fixture", fetchImpl: async () => { requests++; throw new Error("unexpected request"); } });
    const c = historicalControls("id", "All tests passed.", [])[1]!;
    const result = await runControl(c, client, true);
    assert.equal(requests, 0);
    assert.equal(result.row.route, "no_eligible_evidence");
    assert.deepEqual([result.row.baseline, result.row.choice, result.row.citations, result.row.rescue], [false, false, false, false]);
    assert.equal(c.evidence.length, 1);
});
test("covered predicates bypass Jev, including receipts that contradict the claim", async () => {
    let requests = 0;
    const client = new JevClient({ apiKey: "fixture", fetchImpl: async () => { requests++; throw new Error("unexpected request"); } });
    const c = makeTypedControls(11).find(r => r.variant === "altered")!;
    const result = await routeControl(c, client);
    assert.equal(result.route, "deterministic");
    assert.equal(result.status, "contradicted");
    assert.equal(requests, 0);
});
