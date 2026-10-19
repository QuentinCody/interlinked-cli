import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PersistedLedgerState } from "./hook-coverage-ledger.js";

/** Atomic replacement of the current state. Retained receipts are not part of it: they
 * live in the append-only history log, so this write does not grow with history. */
export function writeHookCoverageLedger(path: string, state: PersistedLedgerState): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    let open = true;
    try {
        writeFileSync(descriptor, `${JSON.stringify(state)}\n`, "utf8");
        closeSync(descriptor); open = false;
        renameSync(temporary, path);
    } catch (error) {
        // interlinked-ignore: empty_catch — cleanup failures must not mask the persistence failure rethrown below.
        if (open) { try { closeSync(descriptor); } catch { /* Preserve the original persistence failure. */ } }
        try { unlinkSync(temporary); } catch { /* Best effort cleanup; never replace the previous ledger. */ }
        throw error;
    }
}
