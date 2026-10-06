import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LedgerState } from "./hook-coverage-ledger.js";

const CHUNK_CHARACTERS = 32 * 1024;

/** Serialize one history entry at a time, never one string for all retained evidence. */
function* ledgerParts(state: LedgerState): Generator<string> {
    const { checks, reviews, ...current } = state;
    yield JSON.stringify(current).slice(0, -1);
    yield ',"reviews":[';
    for (let index = 0; index < reviews.length; index++) {
        if (index) yield ",";
        yield JSON.stringify(reviews[index]);
    }
    yield '],"checks":[';
    for (let index = 0; index < checks.length; index++) {
        if (index) yield ",";
        yield JSON.stringify(checks[index]);
    }
    yield "]}\n";
}

/** Atomic replacement with bounded output buffers; no pruning or schema migration. */
export function writeHookCoverageLedger(path: string, state: LedgerState): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    let open = true;
    try {
        let chunks: string[] = [], length = 0;
        for (const part of ledgerParts(state)) {
            chunks.push(part);
            length += part.length;
            if (length >= CHUNK_CHARACTERS) {
                writeFileSync(descriptor, chunks.join(""), "utf8");
                chunks = []; length = 0;
            }
        }
        if (length) writeFileSync(descriptor, chunks.join(""), "utf8");
        closeSync(descriptor); open = false;
        renameSync(temporary, path);
    } catch (error) {
        if (open) { try { closeSync(descriptor); } catch { /* Preserve the original persistence failure. */ } }
        try { unlinkSync(temporary); } catch { /* Best effort cleanup; never replace the previous ledger. */ }
        throw error;
    }
}
