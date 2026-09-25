import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { E2E_RUNS_DIRECTORY, emptyReceipt, readE2eReceipt, readE2eReceiptDetailed, writeE2eReceipt } from "./receipt.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("receipt IO — positive", () => {
    it("P1: writes a version-1 receipt under its run directory and reads it back with its runId", () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-receipt-")); roots.push(root);
        const receipt = emptyReceipt({ runId: "run-1", project: { id: "orders", root: ".", canonicalRoot: root }, scenarioIds: ["order-persists"], policyDigest: "a".repeat(64), generation: "b".repeat(64) });
        const path = writeE2eReceipt(root, receipt);
        expect(path).toBe(`${E2E_RUNS_DIRECTORY}/run-1/receipt.json`);
        expect(readE2eReceipt(root, path)?.runId).toBe("run-1");
        expect(JSON.parse(readFileSync(join(root, path), "utf8")).version).toBe(1);
    });
});
describe("receipt IO — negative", () => {
    it("N1: a second write to the same run directory is refused (no report substitution)", () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-receipt-")); roots.push(root);
        const receipt = emptyReceipt({ runId: "run-1", project: { id: "orders", root: ".", canonicalRoot: root }, scenarioIds: [], policyDigest: "a".repeat(64), generation: "b".repeat(64) });
        writeE2eReceipt(root, receipt);
        expect(() => writeE2eReceipt(root, receipt)).toThrow();
    });
    it("N3: a case state outside the closed set (e.g. skipped) makes the whole receipt unreadable, with the field named (R5)", () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-receipt-")); roots.push(root);
        const receipt = emptyReceipt({ runId: "run-1", project: { id: "orders", root: ".", canonicalRoot: root }, scenarioIds: ["s"], policyDigest: "a".repeat(64), generation: "b".repeat(64) });
        receipt.cases = [{ id: "c", digest: "d".repeat(64), authority: "configured", provenance: "matched", state: "passed", runnerKind: "process", details: [] }];
        const path = writeE2eReceipt(root, receipt);
        const tampered = JSON.parse(readFileSync(join(root, path), "utf8"));
        tampered.cases[0].state = "skipped";
        writeFileSync(join(root, path), JSON.stringify(tampered));
        expect(readE2eReceiptDetailed(root, path)).toMatchObject({ receipt: null, issue: expect.stringMatching(/receipt\.cases\[0\]\.state must be one of .*got "skipped"/) });
        delete tampered.completion.complete;
        tampered.cases[0].state = "passed";
        writeFileSync(join(root, path), JSON.stringify(tampered));
        expect(readE2eReceiptDetailed(root, path).issue).toMatch(/completion\.complete must be a boolean/);
    });
    it("N2: a malformed, foreign-version or escaping receipt reads as null", () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-receipt-")); roots.push(root);
        writeFileSync(join(root, "bad.json"), "{\"version\":2,\"runId\":\"x\"}");
        expect(readE2eReceipt(root, "bad.json")).toBeNull();
        writeFileSync(join(root, "torn.json"), "{\"version\":1");
        expect(readE2eReceipt(root, "torn.json")).toBeNull();
        expect(readE2eReceipt(root, "../outside.json")).toBeNull();
        expect(readE2eReceipt(root, "absent.json")).toBeNull();
    });
});
