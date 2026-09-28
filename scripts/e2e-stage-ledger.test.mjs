// Pins the script-side mirror of src/harness/verification-stages.ts: same row
// shape, same env contract (INTERLINKED_STAGE / INTERLINKED_STAGES_LEDGER), so
// rows from scripts/e2e-run.mjs sit in the same ledger `interlinked query
// stages` reads. The TS module owns the contract; this file must not drift.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STAGES_SCHEMA, recordStage, stageFromEnvironment, stagesLedgerPath } from "./e2e-stage-ledger.mjs";

const temps = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "e2e-stage-ledger-"));
    temps.push(root);
    return root;
}
function rows(path) {
    return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

describe("recordStage — positive (must fire)", () => {
    // test-contract: public-api — one schema-tagged row lands under <root>/.interlinked with the TS module's field names
    it("P1: appends a row shaped like the harness ledger", () => {
        const root = fixture();
        expect(recordStage(root, { check: "e2e-merge", status: "passed", post_ms: 1234 }, { env: {} })).toBe(true);
        const [row] = rows(join(root, ".interlinked", "verification-stages.jsonl"));
        expect(row).toMatchObject({ schema: STAGES_SCHEMA, stage: "cli", check: "e2e-merge", status: "passed", identity: null, reused: false, post_ms: 1234, node: process.versions.node, pid: process.pid, dry_run: false });
        expect(Number.isNaN(Date.parse(row.ts))).toBe(false);
        expect(row.platform).toBe(`${process.platform}-${process.arch}-${release()}`);
    });

    // test-contract: public-api — the env contract is the TS module's: stage from INTERLINKED_STAGE, path from INTERLINKED_STAGES_LEDGER
    it("P2: honors INTERLINKED_STAGE and INTERLINKED_STAGES_LEDGER", () => {
        const root = fixture(), path = join(root, "elsewhere", "stages.jsonl");
        const env = { INTERLINKED_STAGE: "push", INTERLINKED_STAGES_LEDGER: path };
        expect(stagesLedgerPath(root, env)).toBe(path);
        expect(stageFromEnvironment("cli", env)).toBe("push");
        expect(stageFromEnvironment("cli", { INTERLINKED_STAGE: "deploy" })).toBe("cli");
        expect(recordStage(root, { check: "e2e-tests", status: "failed", exec_ms: 5 }, { env })).toBe(true);
        expect(rows(path)).toMatchObject([{ stage: "push", check: "e2e-tests", status: "failed", exec_ms: 5 }]);
        expect(existsSync(join(root, ".interlinked"))).toBe(false);
    });
});

describe("recordStage — negative (must not fire)", () => {
    // test-contract: invariant — telemetry is fail-open: an unwritable ledger reports false and never throws
    it("N1: returns false instead of throwing when the ledger parent is a file", () => {
        const root = fixture();
        const env = { INTERLINKED_STAGES_LEDGER: join(root, "blocker", "stages.jsonl") };
        writeFileSync(join(root, "blocker"), "x");
        expect(() => recordStage(root, { check: "x", status: "passed" }, { env })).not.toThrow();
        expect(recordStage(root, { check: "x", status: "passed" }, { env })).toBe(false);
    });
});
