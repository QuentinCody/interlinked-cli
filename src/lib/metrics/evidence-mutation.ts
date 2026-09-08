import type { MutantObservation, MutantOutcome } from "./behavioral-types.js";
import { artifactSourcePath, record, sourceSpan, textField } from "./evidence-json.js";
import { hashBytes } from "./inventory.js";
import type { RepositoryInventory } from "./measurement-types.js";

const OUTCOMES: Readonly<Record<string, MutantOutcome>> = { Killed: "killed", Survived: "survived", NoCoverage: "no-coverage", Timeout: "timeout", RuntimeError: "error", CompileError: "error", Ignored: "ignored", Pending: "error" };

function mutant(value: unknown, path: string): MutantObservation {
    const row = record(value, "mutant"), status = textField(row.status, "mutant status");
    const outcome = Object.hasOwn(OUTCOMES, status) ? OUTCOMES[status] : undefined;
    if (!outcome) throw new Error(`Unsupported mutant status: ${status}`);
    return { id: textField(row.id, "mutant id"), path, ...sourceSpan(row.location), operator: textField(row.mutatorName, "operator"),
        replacement: typeof row.replacement === "string" ? row.replacement : "", outcome };
}

export function parseMutationEvidence(value: unknown, inventory: RepositoryInventory, reportRoot = inventory.root): { mutants: MutantObservation[]; coveredFiles: string[] } {
    const report = record(value, "mutation report"), files = record(report.files, "mutation files");
    const mutants: MutantObservation[] = [], coveredFiles: string[] = [], ids = new Set<string>();
    for (const [rawPath, raw] of Object.entries(files)) {
        const path = artifactSourcePath(reportRoot, rawPath), file = record(raw, "mutation file");
        const input = inventory.files.find(item => item.path === path);
        if (!input || typeof file.source !== "string" || hashBytes(file.source) !== input.sha256) throw new Error(`Mutation source mismatch: ${path}`);
        if (!Array.isArray(file.mutants)) throw new Error("mutants must be an array");
        coveredFiles.push(path);
        for (const value of file.mutants) {
            const row = mutant(value, path), key = `${path}:${row.id}`;
            if (ids.has(key)) throw new Error(`Duplicate mutant identity: ${key}`);
            ids.add(key); mutants.push(row);
        }
    }
    return { mutants, coveredFiles };
}
