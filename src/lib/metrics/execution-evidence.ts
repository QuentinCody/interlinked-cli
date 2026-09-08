import { evidenceIdentity } from "./evidence-identity.js";
import { readMeasurementExecutions } from "./execution-journal.js";
import { hashBytes } from "./inventory.js";
import type { RepositoryInventory } from "./measurement-types.js";

export function executionEvidenceBlockers(inventory: RepositoryInventory): string[] {
    const journal = readMeasurementExecutions(inventory.root);
    if (!journal.entries.some(entry => entry.gate.startsWith("metrics."))) return journal.issues;
    const fingerprint = hashBytes(JSON.stringify(evidenceIdentity(inventory)));
    const latest = new Map(journal.entries.filter(entry => entry.gate.startsWith("metrics.") && entry.inputFingerprint === fingerprint).map(entry => [entry.gate, entry]));
    return [...journal.issues, ...[...latest.values()].filter(entry => entry.outcome !== "measured").map(entry => `${entry.gate}: latest execution ${entry.outcome}; ${entry.reason}`)];
}
