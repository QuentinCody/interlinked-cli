import type { LintImportEntry } from "./types.js";

/** Keep existing scope keys stable; configured profiles have a separate namespace. */
export function lintEntryKey(entry: LintImportEntry): string {
    if (entry.targets || entry.flags) return `invocation:${JSON.stringify([entry.tool, entry.scope, entry.config, entry.targets, entry.flags])}`;
    return entry.config === undefined ? `${entry.tool}:${entry.scope}` : `profile:${JSON.stringify([entry.tool, entry.scope, entry.config])}`;
}

function lintEntryDetails(entry: LintImportEntry): string[] {
    const details = [entry.scope];
    if (entry.config !== undefined) details.push(`config: ${entry.config}`);
    if (entry.targets) details.push(`targets: ${entry.targets.join(", ")}`);
    if (entry.flags) details.push(`options: ${entry.flags.join(" ")}`);
    return details;
}

export function lintEntryLabel(entry: LintImportEntry): string {
    return `${entry.tool} (${lintEntryDetails(entry).join("; ")}) [${entry.cadence ?? "hook"}]`;
}
