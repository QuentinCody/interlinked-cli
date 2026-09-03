// ===========================================
// Manual design-debt markers — default exclusions, corpus linkage, scan date
// ===========================================
// Path filtering and the two advisory-only lookups (today's date, known
// common-corpus finding ids) that the marker scanner folds over its results.

import { loadFindings } from "../harness/findings/corpus.js";

export const DEFAULT_EXCLUDED_SEGMENTS = new Set([
    ".cache",
    ".git",
    ".interlinked",
    ".next",
    ".nuxt",
    "__fixtures__",
    "bower_components",
    "build",
    "coverage",
    "dist",
    "docs",
    "examples",
    "fixtures",
    "generated",
    "node_modules",
    "out",
    "target",
    "temp",
    "tmp",
    "vendor",
]);

export function scanDate(clock: (() => number) | undefined): string {
    const date = new Date((clock ?? Date.now)());
    if (!Number.isFinite(date.getTime())) throw new Error("debt marker scan clock is invalid");
    return date.toISOString().slice(0, 10);
}

export function findingIds(projectRoot: string, supplied?: ReadonlySet<string>): ReadonlySet<string> | null {
    if (supplied) return supplied;
    try {
        return new Set(loadFindings(projectRoot).map((finding) => finding.id));
    } catch (corpusError) {
        void corpusError;
        // Finding linkage is advisory. An unreadable corpus must not turn every
        // link into a false "missing" row.
        return null;
    }
}

export function normalizedExclusions(values: readonly string[]): string[] {
    return values
        .map((value) => value.trim().replace(/^\.\//, "").replace(/\/$/, ""))
        .filter(Boolean)
        .sort();
}

export function isExcluded(rel: string, custom: readonly string[]): boolean {
    if (rel.split("/").some((segment) => DEFAULT_EXCLUDED_SEGMENTS.has(segment))) return true;
    return custom.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
}
