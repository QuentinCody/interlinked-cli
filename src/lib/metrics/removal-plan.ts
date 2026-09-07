import { isAbsolute } from "node:path";
import { natural, record, stringList, textField } from "./evidence-json.js";

export interface RemovalEdit { path: string; sourceSha256: string; start: number; end: number; }
export interface RemovalCheck { kind: "typecheck" | "test" | "build"; argv: string[]; }
export interface RemovalPlan { schemaVersion: 1; edits: RemovalEdit[]; checks: RemovalCheck[]; }

function edit(value: unknown): RemovalEdit {
    const row = record(value, "removal edit"), path = textField(row.path, "path"), sourceSha256 = textField(row.sourceSha256, "sourceSha256");
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error("Removal path must be relative and contained");
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error("Expected source SHA-256");
    const start = natural(row.start, "start"), end = natural(row.end, "end");
    if (end <= start) throw new Error("Removal span must be nonempty");
    return { path, sourceSha256, start, end };
}
function check(value: unknown): RemovalCheck {
    const row = record(value, "removal check"), argv = stringList(row.argv, "argv");
    if (row.kind !== "typecheck" && row.kind !== "test" && row.kind !== "build") throw new Error("Unknown removal check kind");
    if (!argv.length) throw new Error("Removal check requires a command");
    return { kind: row.kind, argv };
}
export function parseRemovalPlan(value: unknown): RemovalPlan {
    const row = record(value, "removal plan");
    if (row.schemaVersion !== 1 || !Array.isArray(row.edits) || !Array.isArray(row.checks)) throw new Error("Expected version 1 removal plan");
    const edits = row.edits.map(edit), checks = row.checks.map(check);
    if (!edits.length || !checks.some(row => row.kind === "test") || !checks.some(row => row.kind === "typecheck")) throw new Error("Removal validation requires edits, tests and type checking");
    return { schemaVersion: 1, edits, checks };
}
