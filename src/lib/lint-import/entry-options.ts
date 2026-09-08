import { validateLintArguments } from "./argv.js";
import { lintObject } from "./json.js";
import { isReportTool, parseReportAdapter } from "./custom-adapters.js";
import type { LintImportEntry, LintOrigin } from "./types.js";

function stringList(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 1000) throw new Error("Invalid lint argument list");
    return value.map((item: unknown) => {
        if (typeof item !== "string" || item.length === 0 || item.length > 16_000 || /[\0\r\n]/.test(item)) throw new Error("Invalid lint argument");
        return item;
    });
}

function origin(value: unknown): LintOrigin {
    const row = lintObject(value);
    const kind = row.kind;
    if (kind !== "package-script" && kind !== "ci" && kind !== "task" && kind !== "shell" && kind !== "registry" && kind !== "config") throw new Error("Invalid lint evidence kind");
    if (typeof row.file !== "string" || typeof row.label !== "string" || typeof row.line !== "number" || !Number.isSafeInteger(row.line) || row.line < 1) throw new Error("Invalid lint evidence location");
    return { file: row.file, line: row.line, kind, label: row.label };
}

export function applyLintEntryOptions(entry: LintImportEntry, value: Record<string, unknown>): LintImportEntry {
    if (isReportTool(entry.tool)) entry.report = parseReportAdapter(value.report);
    else if (value.report !== undefined) throw new Error("Native adapter cannot replace its command");
    if (value.targets !== undefined) entry.targets = stringList(value.targets);
    if (value.flags !== undefined) entry.flags = stringList(value.flags);
    if (value.cadence !== undefined) {
        if (value.cadence !== "hook" && value.cadence !== "audit") throw new Error("Invalid lint cadence");
        entry.cadence = value.cadence;
    }
    if (value.evidence !== undefined) {
        if (!Array.isArray(value.evidence) || value.evidence.length > 1000) throw new Error("Invalid lint evidence");
        entry.evidence = value.evidence.map(origin);
    }
    validateLintArguments(entry);
    return entry;
}
