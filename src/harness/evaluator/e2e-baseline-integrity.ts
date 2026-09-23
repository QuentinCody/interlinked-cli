import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertE2eBuild } from "../../../scripts/e2e-evidence.mjs";
import { boundaryInventory } from "../e2e-inventory.js";
import { assertE2eTransition, parseE2eBaseline } from "../e2e-ratchet.js";
import { baseE2eFiles } from "../e2e-store.js";
import type { BaselineGamingFinding } from "./baseline-integrity-gate.js";

export { assertE2eTransition } from "../e2e-ratchet.js";
export interface E2eGuardContext { root: string; base: string }

export function detectE2eBaselineGaming(file: string, beforeText: string, afterText: string, context: E2eGuardContext | undefined): BaselineGamingFinding[] {
    try {
        if (!context) throw new Error("E2e baseline comparison requires the repository root and one resolved base");
        const before = parseE2eBaseline(JSON.parse(beforeText));
        const after = parseE2eBaseline(JSON.parse(afterText));
        const base = baseE2eFiles(context.root, context.base);
        assertE2eBuild(context.root);
        const inventory = boundaryInventory(context.root, JSON.parse(readFileSync(join(context.root, "dist/metafile-esm.json"), "utf8")));
        assertE2eTransition(before.files, after.files, inventory, base);
        return [];
    } catch (error) {
        return [{ file, rule: "coverage-e2e-loosening", before: beforeText, after: afterText,
            message: error instanceof Error ? error.message : String(error) }];
    }
}
