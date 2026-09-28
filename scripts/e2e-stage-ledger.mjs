// Script-side mirror of src/harness/verification-stages.ts for the .mjs
// runners (scripts/e2e-run.mjs) that cannot import the TypeScript harness.
// Same row shape, same env contract (INTERLINKED_STAGE, INTERLINKED_STAGES_LEDGER),
// same fail-open rule; the TS module owns the contract and
// scripts/e2e-stage-ledger.test.mjs pins this copy against it.
import { appendFileSync, mkdirSync } from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";

export const STAGES_SCHEMA = "verification-stages.v1";
const STAGES = new Set(["edit", "commit", "push", "ci", "cli"]);

export function stageFromEnvironment(fallback, env = process.env) {
    const declared = env.INTERLINKED_STAGE;
    return STAGES.has(declared) ? declared : fallback;
}

export function stagesLedgerPath(root, env = process.env) {
    const override = env.INTERLINKED_STAGES_LEDGER;
    return override && override.length > 0 ? override : join(root, ".interlinked", "verification-stages.jsonl");
}

/** Appends one row `{check, status, exec_ms?, post_ms?, ...}`; returns false on any I/O failure. */
export function recordStage(root, input, { env = process.env } = {}) {
    const row = {
        schema: STAGES_SCHEMA, ts: new Date().toISOString(), stage: stageFromEnvironment("cli", env), identity: null, reused: false, ...input,
        platform: `${process.platform}-${process.arch}-${release()}`, node: process.versions.node, pid: process.pid, dry_run: false,
    };
    try {
        const path = stagesLedgerPath(root, env);
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(row)}\n`);
        return true;
    } catch {
        return false;
    }
}
