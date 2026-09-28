import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    STAGES_LEDGER_ENV,
    STAGE_ENV,
    VERIFICATION_STAGES_FILE,
    VERIFICATION_STAGES_SCHEMA,
    buildVerificationStageRow,
    elapsedMs,
    isVerificationStage,
    platformIdentity,
    recordVerificationStage,
    stageFromEnvironment,
    verificationStagesPath,
    type VerificationStageInput,
    type VerificationStageRow,
} from "./verification-stages.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "verification-stages-"));
    roots.push(root);
    return root;
}
function rows(path: string): VerificationStageRow[] {
    // SAFETY: the file under test is written only by recordVerificationStage in this test, one buildVerificationStageRow per line.
    return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as VerificationStageRow);
}
const input: VerificationStageInput = { stage: "edit", check: "vitest:selected", identity: "abc", status: "passed", reused: false, reuse_denied_reason: "no-receipt", exec_ms: 12, lookup_ms: 1 };

describe("recordVerificationStage — positive (must fire)", () => {
    // test-contract: public-api — a row lands under <root>/.interlinked with the schema, the input and the process identity
    it("P1: appends one schema-tagged row and creates .interlinked when absent", () => {
        const root = fixture();
        expect(existsSync(join(root, ".interlinked"))).toBe(false);
        expect(recordVerificationStage(root, input, { env: {} })).toBe(true);
        const [row] = rows(join(root, ".interlinked", VERIFICATION_STAGES_FILE));
        expect(row).toMatchObject({ ...input, schema: VERIFICATION_STAGES_SCHEMA, dry_run: false, pid: process.pid, node: process.versions.node, platform: platformIdentity() });
        expect(Number.isNaN(Date.parse(row?.ts ?? ""))).toBe(false);
    });

    // test-contract: public-api — INTERLINKED_STAGES_LEDGER redirects rows (the pre-push export writes into the source checkout)
    it("P2: honors the ledger path override and appends across calls", () => {
        const root = fixture(), ledger = join(root, "elsewhere", "stages.jsonl");
        const env = { [STAGES_LEDGER_ENV]: ledger };
        expect(recordVerificationStage(root, input, { env })).toBe(true);
        expect(recordVerificationStage(root, { ...input, check: "npm run build", stage: "push" }, { env })).toBe(true);
        expect(existsSync(join(root, ".interlinked"))).toBe(false);
        expect(rows(ledger).map(row => [row.stage, row.check])).toEqual([["edit", "vitest:selected"], ["push", "npm run build"]]);
    });
});

describe("recordVerificationStage — negative (must not fire)", () => {
    // test-contract: invariant — a dry run must not move any ledger (CLAUDE.md: "A dry run must not move the gate")
    it("N1: writes nothing for a dry run", () => {
        const root = fixture();
        expect(recordVerificationStage(root, input, { dryRun: true, env: {} })).toBe(false);
        expect(existsSync(join(root, ".interlinked", VERIFICATION_STAGES_FILE))).toBe(false);
    });

    // test-contract: invariant — telemetry is fail-open: an unwritable ledger reports false and never throws
    it("N2: returns false instead of throwing when the ledger path is unwritable", () => {
        const root = fixture();
        writeFileSync(join(root, "blocker"), "not a directory\n");
        // The ledger's parent is a regular file, so mkdir fails with ENOTDIR.
        const env = { [STAGES_LEDGER_ENV]: join(root, "blocker", "stages.jsonl") };
        expect(() => recordVerificationStage(root, input, { env })).not.toThrow();
        expect(recordVerificationStage(root, input, { env })).toBe(false);
        expect(readFileSync(join(root, "blocker"), "utf8")).toBe("not a directory\n");
    });
});

describe("stage and path resolution", () => {
    // test-contract: public-api — INTERLINKED_STAGE selects the stage only when it names a known stage
    it("reads a valid INTERLINKED_STAGE and falls back otherwise", () => {
        expect(stageFromEnvironment("cli", { [STAGE_ENV]: "push" })).toBe("push");
        expect(stageFromEnvironment("cli", { [STAGE_ENV]: "deploy" })).toBe("cli");
        expect(stageFromEnvironment("edit", {})).toBe("edit");
        expect(isVerificationStage("ci")).toBe(true);
        expect(isVerificationStage("")).toBe(false);
        expect(isVerificationStage(3)).toBe(false);
    });

    // test-contract: public-api — the default ledger lives under the project's .interlinked; an empty override is ignored
    it("resolves the default path and ignores an empty override", () => {
        expect(verificationStagesPath("/repo", {})).toBe(join("/repo", ".interlinked", VERIFICATION_STAGES_FILE));
        expect(verificationStagesPath("/repo", { [STAGES_LEDGER_ENV]: "" })).toBe(join("/repo", ".interlinked", VERIFICATION_STAGES_FILE));
        expect(verificationStagesPath("/repo", { [STAGES_LEDGER_ENV]: "/x/y.jsonl" })).toBe("/x/y.jsonl");
    });

    // test-contract: public-api — the row builder stamps schema, timestamp and dry-run flag without touching disk
    it("builds a row with the supplied clock and dry-run flag", () => {
        const row = buildVerificationStageRow(input, true, () => new Date("2026-09-28T00:00:00.000Z"));
        expect(row.ts).toBe("2026-09-28T00:00:00.000Z");
        expect(row.dry_run).toBe(true);
        expect(row.schema).toBe(VERIFICATION_STAGES_SCHEMA);
    });

    // test-contract: boundary — elapsed time is whole, non-negative milliseconds
    it("elapsedMs rounds and clamps at zero", () => {
        expect(elapsedMs(1000, () => 1250.6)).toBe(251);
        expect(elapsedMs(2000, () => 1000)).toBe(0);
    });
});
