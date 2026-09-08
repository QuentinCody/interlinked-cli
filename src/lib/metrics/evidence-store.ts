import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseIstanbulEvidence } from "./evidence-coverage.js";
import { evidenceIdentity, identityDifferences } from "./evidence-identity.js";
import { parseMutationEvidence } from "./evidence-mutation.js";
import { parseEvidenceReceipt } from "./evidence-receipt.js";
import type { EvidenceReceipt, StoredEvidence } from "./evidence-types.js";
import { containedFile, hashBytes } from "./inventory.js";
import type { RepositoryInventory } from "./measurement-types.js";
import { localEvidenceFreshness, type EvidenceFreshnessOptions, type LocalEvidenceFreshness } from "./evidence-local-freshness.js";

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export function readEvidenceArtifact(path: string): string {
    if (statSync(path).size > MAX_ARTIFACT_BYTES) throw new Error("Evidence artifact exceeds 64 MiB limit");
    return readFileSync(path, "utf8");
}
export function evidenceDirectory(root: string): string { return join(root, ".interlinked", "metrics", "evidence"); }

function validateStoredEvidence(inventory: RepositoryInventory, receipt: EvidenceReceipt, artifact: string, checkFreshness: (receipt: EvidenceReceipt) => LocalEvidenceFreshness): StoredEvidence {
    if (hashBytes(artifact) !== receipt.artifactHash) throw new Error("Evidence artifact hash mismatch");
    const freshness = checkFreshness(receipt);
    const issues = [...receipt.issues, ...identityDifferences(receipt.identity, evidenceIdentity(inventory)), ...freshness.issues];
    const id = hashBytes(JSON.stringify(parseEvidenceReceipt(receipt)));
    const parsed: unknown = JSON.parse(artifact);
    const coverage = receipt.kind === "coverage" ? parseIstanbulEvidence(parsed, receipt.reportRoot) : [];
    const mutation = receipt.kind === "mutation" ? parseMutationEvidence(parsed, inventory, receipt.reportRoot) : { mutants: [], coveredFiles: coverage.map(row => row.path) };
    const stale = freshness.stale || identityDifferences(receipt.identity, evidenceIdentity(inventory)).length > 0;
    let state: StoredEvidence["observations"]["state"] = "measured";
    if (receipt.outcome !== "passed" || issues.length) state = "inconclusive";
    if (stale) state = "stale";
    return { id, receipt, observations: { kind: receipt.kind, state, evidenceId: id, issues,
        coverage, mutants: mutation.mutants, coveredFiles: mutation.coveredFiles } };
}

export function validateEvidence(inventory: RepositoryInventory, receipt: EvidenceReceipt, artifact: string, options: EvidenceFreshnessOptions = {}): StoredEvidence {
    const parsed = parseEvidenceReceipt(receipt);
    return validateStoredEvidence(inventory, parsed, artifact, localEvidenceFreshness(inventory.root, options));
}

function retainLocalValidationIssues(stored: StoredEvidence): StoredEvidence {
    if (stored.receipt.origin !== "local" || !stored.observations.issues.length) return stored;
    const receipt = { ...stored.receipt, issues: [...new Set(stored.observations.issues)] };
    const id = hashBytes(JSON.stringify(receipt));
    return { ...stored, id, receipt, observations: { ...stored.observations, evidenceId: id } };
}

export function saveEvidence(inventory: RepositoryInventory, receipt: EvidenceReceipt, artifact: string, options: EvidenceFreshnessOptions = {}): StoredEvidence {
    const stored = retainLocalValidationIssues(validateEvidence(inventory, receipt, artifact, options)), directory = evidenceDirectory(inventory.root);
    mkdirSync(directory, { recursive: true });
    for (const [suffix, content] of [["artifact.json", artifact], ["receipt.json", JSON.stringify(stored.receipt)]] as const) {
        const target = join(directory, `${stored.id}.${suffix}`), temporary = `${target}.${randomUUID()}.tmp`;
        writeFileSync(temporary, content, { mode: 0o600 });
        renameSync(temporary, target);
    }
    return stored;
}

export function loadEvidence(inventory: RepositoryInventory, options: EvidenceFreshnessOptions = {}): { entries: StoredEvidence[]; issues: string[] } {
    const directory = evidenceDirectory(inventory.root), entries: StoredEvidence[] = [], issues: string[] = [];
    const freshness = localEvidenceFreshness(inventory.root, options);
    let names: string[];
    try { names = readdirSync(directory).filter(name => /^[a-f0-9]{64}\.receipt\.json$/.test(name)).sort(); }
    catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) issues.push("Evidence store unreadable");
        return { entries, issues };
    }
    for (const name of names.slice(-1000)) {
        try {
            const receipt = parseEvidenceReceipt(JSON.parse(readEvidenceArtifact(containedFile(directory, name))));
            const artifact = readEvidenceArtifact(containedFile(directory, name.replace("receipt.json", "artifact.json")));
            const entry = validateStoredEvidence(inventory, receipt, artifact, freshness);
            if (!name.startsWith(entry.id)) throw new Error("Receipt identity mismatch");
            entries.push(entry);
        } catch (error) { issues.push(`${name}: ${error instanceof Error ? error.message : "Invalid evidence"}`); }
    }
    if (names.length > 1000) issues.push("Evidence history exceeds 1000-receipt read bound");
    return { entries, issues };
}
