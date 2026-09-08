import type { LintImportEntry, LintInventory, LintSource } from "./types.js";

export function lintSourceNeedsReview(source: LintSource, inventory: LintInventory, entries: LintImportEntry[]): boolean {
    if (!entries.some((entry) => entry.sources.includes(source.file))) return true;
    if (source.kind !== "script") return false;
    let candidates = (inventory.invocations ?? []).filter((candidate) => candidate.origin.file === source.file);
    if (source.tool === "custom-script") {
        const label = source.declarations[0]?.split(": ")[0];
        candidates = candidates.filter((candidate) => candidate.origin.label === label);
    }
    return candidates.length === 0 || candidates.some((candidate) => !candidate.entry);
}
