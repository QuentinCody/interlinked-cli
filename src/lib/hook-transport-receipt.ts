import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendFileWithMutationLock } from "./file-mutation-lock.js";

export interface HookTransportReceipt {
    schema: 1;
    event_id: string;
    session_id: string;
    native_event: string;
    hook_pid: number;
    socket_path: string | null;
    protocol: "raw" | "framed";
    outcome: "daemon" | "cold" | "suppressed";
}

/** Diagnostic evidence must never change a hook's decision. */
export function writeHookTransportReceipt(dataDir: string | null, receipt: HookTransportReceipt): void {
    if (!dataDir) return;
    try {
        mkdirSync(dataDir, { recursive: true });
        appendFileWithMutationLock(join(dataDir, "hook-transport.jsonl"), `${JSON.stringify(receipt)}\n`, { waitMs: 0 });
    } catch {
        // An unwritable evidence ledger does not bypass or block evaluation.
    }
}
