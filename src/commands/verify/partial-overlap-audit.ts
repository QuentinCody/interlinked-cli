import { createHash } from "node:crypto";
import { relative } from "node:path";
import { analyzeHelperOverlap, collectSiblingOverlapSources, matchPartialHelperOverlaps, type OverlapSource } from "../../harness/checks/helper-overlap.js";
import { isTestFile, JS_TS_EXTS, getExtension } from "../../harness/checks/shared.js";
import type { InlineMatch } from "../../harness/check-registry/types.js";

// Bounded cache of plain analysis records, never TypeScript programs. Content
// hashes invalidate edits; the audit does not rely on timestamps or Git state.
const cache = new Map<string, { hash: string; source: OverlapSource }>();
function analyze(content: string, file: string): OverlapSource {
    const hash = createHash("sha256").update(content).digest("hex");
    const prior = cache.get(file);
    if (prior?.hash === hash) return prior.source;
    const source = analyzeHelperOverlap(content, file);
    cache.delete(file); cache.set(file, { hash, source });
    if (cache.size > 128) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    return source;
}

/** Existing-code inventory, distinct from the edit-time new-function detector. */
export function checkExistingPartialOverlap(content: string, file: string, root: string): InlineMatch[] {
    if (!JS_TS_EXTS.has(getExtension(file)) || isTestFile(file)) return [];
    const source = analyze(content, file);
    if (source.windows.length === 0) return [];
    const siblings = collectSiblingOverlapSources(file, analyze);
    return matchPartialHelperOverlaps(source, siblings, new Set(source.functions.map(fn => fn.name))).map(hit => ({
        line: hit.window.line,
        text: `Existing 5-statement structural overlap with ${relative(root, hit.otherFile)}:${hit.other.line}-${hit.other.endLine} (${hit.name} / ${hit.other.name}); review shared logic. This does not establish safe extraction.`,
    }));
}
