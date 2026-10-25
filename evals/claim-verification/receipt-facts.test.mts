import assert from "node:assert/strict";
import test from "node:test";
import { interpretTestClaim, verifyTestClaim, type TestReceipt } from "./receipt-facts.mjs";

const receipt: TestReceipt = {
    id: "run-1", completion: "completed", sourceIdentity: "source-A", selection: ["parser.test.ts"],
    runner: { success: true, numTotalTests: 14, numPassedTests: 14, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 },
};

test("the narrow grammar retains exact provenance and declines broader interpretations", () => {
    const claim = interpretTestClaim("All 14 executed tests passed.", { receiptId: "run-1", sourceIdentity: "source-A", selection: ["parser.test.ts"] });
    assert(claim);
    assert.deepEqual(claim.passage.span, [0, 29]);
    assert.equal(claim.expectedPassed, 14);
    assert.equal(interpretTestClaim("Tests look good.", { receiptId: "run-1", sourceIdentity: "source-A", selection: [] }), null);
});

test("runner failure contradicts success regardless of an outer shell exit code", () => {
    const claim = interpretTestClaim("All 14 executed tests passed.", { receiptId: "run-1", sourceIdentity: "source-A", selection: ["parser.test.ts"] })!;
    assert.equal(verifyTestClaim(claim, receipt).status, "supported");
    assert.equal(verifyTestClaim(claim, { ...receipt, runner: { ...receipt.runner, success: false, numPassedTests: 13, numFailedTests: 1 } }).status, "contradicted");
});

test("missing completion, stale source, partial selection and wrong receipt identity remain distinct", () => {
    const claim = interpretTestClaim("All 14 executed tests passed.", { receiptId: "run-1", sourceIdentity: "source-A", selection: ["parser.test.ts"] })!;
    assert.equal(verifyTestClaim(claim, { ...receipt, completion: "running" }).status, "not_assessable");
    assert.equal(verifyTestClaim(claim, { ...receipt, sourceIdentity: "source-B" }).status, "unsupported");
    assert.equal(verifyTestClaim({ ...claim, selection: ["all"] }, receipt).status, "unsupported");
    assert.equal(verifyTestClaim(claim, { ...receipt, id: "run-2" }).status, "not_assessable");
});

test("malformed counts, missing runner reports and unmeasured source identity cannot pass", () => {
    const claim = interpretTestClaim("All 14 executed tests passed.", { receiptId: "run-1", sourceIdentity: "source-A", selection: ["parser.test.ts"] })!;
    assert.equal(verifyTestClaim(claim, { ...receipt, runner: null }).status, "not_assessable");
    assert.equal(verifyTestClaim(claim, { ...receipt, sourceIdentity: null }).status, "not_assessable");
    assert.equal(verifyTestClaim(claim, { ...receipt, runner: { ...receipt.runner, numPassedTests: -14 } }).status, "not_assessable");
    assert.equal(verifyTestClaim(claim, { ...receipt, runner: { ...receipt.runner, numTotalTests: 13 } }).status, "not_assessable");
});
