import { readFileSync, statSync } from "node:fs";
import { object } from "./answers.js";
import { validateEvidence } from "./evidence.js";
import { validateRun } from "./serialization.js";
import { readJson } from "./store.js";
import type { DecisionRun, EvidenceRecord } from "./types.js";

export function readEvidenceRecords(path: string | undefined): EvidenceRecord[] {
    if (!path) throw new Error("an input evidence file is required");
    if (statSync(path).size > 32000000) throw new Error("input exceeds 32MB budget");
    const content = readFileSync(path, "utf8").trim();
    let value: unknown;
    try {
        value = JSON.parse(content);
    } catch {
        value = content
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    }
    const rows = Array.isArray(value) ? value : object(value).records;
    if (!Array.isArray(rows))
        throw new Error("expected evidence array, JSONL, or records envelope");
    return rows.map(validateEvidence);
}

export function readDecisionRun(path: string | undefined): DecisionRun {
    if (!path) throw new Error("run path required");
    return validateRun(readJson(path));
}
