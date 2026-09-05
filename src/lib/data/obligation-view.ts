import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyObligationTxn, openObligations, parseObligationTxn, type ObligationState } from "../../harness/obligations.js";
import { getDataDir } from "../config.js";
import type { JsonObject } from "../json-types.js";
import { dataRecordHash } from "./normalize.js";
import { readDataLines } from "./stream.js";

/** Strict streamed fold using the domain state machine, without fail-open reader ambiguity. */
export async function dataOpenObligations(cwd: string, file: string): Promise<JsonObject> {
    const path = join(getDataDir(cwd), "obligations.jsonl");
    if (!existsSync(path)) return { state: "not-recorded", obligations: [], scope: "obligations ledger only" };
    const state: ObligationState = new Map();
    const locations = new Map<string, { offset: number; raw_hash: string }>();
    try {
        for await (const line of readDataLines(path)) {
            if (!line.complete || line.text === undefined) throw new Error(`incomplete or oversized transaction at ${line.start}`);
            const parsed: unknown = JSON.parse(line.text);
            const txn = parseObligationTxn(parsed);
            if (!txn) throw new Error(`invalid obligation transaction at ${line.start}`);
            applyObligationTxn(state, txn);
            if (txn.op === "open" && txn.file === file) locations.set(txn.file, { offset: line.start, raw_hash: dataRecordHash(line.text) });
        }
        const obligations = openObligations(state).filter((obligation) => obligation.file === file);
        return { state: "available", obligations: JSON.parse(JSON.stringify(obligations)), last_open_evidence: locations.get(file) ?? null,
            source: "obligations.jsonl", scope: "all obligation kinds folded in append order; separate domain ledgers remain separate" };
    } catch (error) {
        return { state: "unavailable", obligations: null, reason: error instanceof Error ? error.message : String(error) };
    }
}
