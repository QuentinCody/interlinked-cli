import { posix } from "node:path";
import type { GlobalNamespace } from "./ledger-drift.js";
import { resolveRelativeTarget } from "./ledger-xref.js";
import type { CountClaim, SpecFacts } from "./types.js";

/** A count or range claim; only its line matters (links within LINK_PROXIMITY_LINES of it name its registry). */
interface CountScope { file: string; facts: SpecFacts; claim: Pick<CountClaim, "line">; global: Map<string, GlobalNamespace>; }
const LINK_PROXIMITY_LINES = 3;

function linkedHomes(input: CountScope): Set<string> {
    const paths = new Set<string>();
    for (const link of input.facts.anchorLinks) {
        if (!link.targetFile || Math.abs(link.line - input.claim.line) > LINK_PROXIMITY_LINES) continue;
        const path = resolveRelativeTarget(input.file, link.targetFile);
        if (path) paths.add(path);
    }
    return paths;
}
function selectNamespace(namespace: GlobalNamespace, files: string[]): GlobalNamespace | null {
    if (!files.length) return null;
    const nums = new Set<number>();
    if (namespace.byFile) {
        for (const file of files) for (const value of namespace.byFile.get(file) ?? []) nums.add(value);
    } else for (const value of namespace.nums) nums.add(value);
    return { ...namespace, nums, max: Math.max(0, ...nums), files,
        definingFiles: namespace.definingFiles.filter((file) => files.includes(file)) };
}

/** README is a directory overview. Other documents need a namespace reference
 * or nearby explicit link; sharing a directory and a noun is insufficient.
 * Range claims use the same scope (2026-10-22): a prefix letter alone does not
 * name a registry — CLAUDE.md's unit items E1–E5 are not docs/harness.md's
 * experiments E18–E28. */
export function scopedClaimCensus(input: CountScope): Map<string, GlobalNamespace> {
    const homes = linkedHomes(input);
    const references = new Set([input.file, ...homes]);
    const overview = /^readme\.md$/i.test(posix.basename(input.file));
    const directory = posix.dirname(input.file);
    const scoped = new Map<string, GlobalNamespace>();
    for (const [key, namespace] of input.global) {
        if (!overview && !namespace.files.some((file) => references.has(file))) continue;
        const files = namespace.files.filter((file) => posix.dirname(file) === directory || homes.has(file));
        const selected = selectNamespace(namespace, files);
        if (selected) scoped.set(key, selected);
    }
    return scoped;
}
