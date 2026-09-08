import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { record, natural, textField } from "../../lib/metrics/evidence-json.js";
import { hashBytes } from "../../lib/metrics/inventory.js";
import { storeDirFor } from "./store.js";

interface StabilityState { fingerprint: string; signature: string; stableRuns: number; quarantined: boolean; }
function statePath(root: string): string { return join(storeDirFor(root, "vitest-exact-v1"), "stability.json"); }
function readState(root: string): StabilityState | null {
    const path = statePath(root);
    if (!existsSync(path)) return null;
    if (statSync(path).size > 4096) throw new Error("Coverage stability record exceeds bound");
    const value = record(JSON.parse(readFileSync(path, "utf8")), "coverage stability");
    if (typeof value.quarantined !== "boolean") throw new Error("Invalid coverage quarantine state");
    return { fingerprint: textField(value.fingerprint, "fingerprint"), signature: textField(value.signature, "signature"),
        stableRuns: natural(value.stableRuns, "stable runs"), quarantined: value.quarantined };
}
export function indexQuarantined(root: string, fingerprint: string): boolean {
    const state = readState(root);
    return state?.fingerprint === fingerprint && state.quarantined;
}
/** A changed covered-element set under identical inputs requires three agreeing full runs before reuse. */
export function checkIndexStability(root: string, input: { fingerprint: string; signature: string; priorSignature: string | null }): void {
    const previous = readState(root), signature = hashBytes(input.signature);
    const pending = previous?.fingerprint === input.fingerprint && previous.quarantined;
    const changed = input.priorSignature !== null && hashBytes(input.priorSignature) !== signature;
    const stableRuns = pending && previous.signature === signature ? previous.stableRuns + 1 : 1;
    const quarantined = pending ? stableRuns < 3 : changed;
    const state: StabilityState = { fingerprint: input.fingerprint, signature, stableRuns, quarantined };
    const directory = storeDirFor(root, "vitest-exact-v1"), temporary = join(directory, `${process.pid}.stability.tmp`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, statePath(root));
    if (quarantined) throw new Error("Coverage changed under identical inputs; index quarantined until three full warm runs agree");
}
