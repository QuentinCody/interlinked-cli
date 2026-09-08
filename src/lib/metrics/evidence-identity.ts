import { readFileSync, statSync } from "node:fs";
import { containedFile, hashBytes, inventoryHash } from "./inventory.js";
import type { RepositoryInventory } from "./measurement-types.js";
import type { EvidenceIdentity, EvidenceRunner } from "./evidence-types.js";
import { IDENTITY_KEYS } from "./evidence-receipt.js";

function controlPath(path: string): boolean {
    return /(^|\/)\.(git|interlinked|claude|codex|agents)(\/|$)/.test(path);
}

function supportHash(inventory: RepositoryInventory, overrides: ReadonlyMap<string, string | null>): string {
    const rows: string[][] = [];
    let bytes = 0;
    for (const file of inventory.excluded) {
        if (!["fixture", "asset", "generated"].includes(file.role)) continue;
        if (controlPath(file.path)) continue;
        const override = overrides.get(file.path);
        if (override === null) continue;
        if (override !== undefined) { rows.push([file.path, hashBytes(override)]); continue; }
        const path = containedFile(inventory.root, file.path);
        bytes += statSync(path).size;
        if (bytes > 256 * 1024 * 1024) throw new Error("Behavioral support inputs exceed 256 MiB hash bound");
        rows.push([file.path, hashBytes(readFileSync(path))]);
    }
    return hashBytes(JSON.stringify(rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
}

export function evidenceIdentity(inventory: RepositoryInventory, overrides: ReadonlyMap<string, string | null> = new Map()): EvidenceIdentity {
    return { sourceHash: inventory.sourceHash, inputHash: inventory.inputHash,
        testHash: inventoryHash(inventory.files.filter(file => file.role === "test")),
        configurationHash: inventoryHash(inventory.files.filter(file => file.role === "configuration")),
        dependencyHash: inventoryHash(inventory.files.filter(file => /(^|\/)(package(-lock)?\.json|[^/]*lock[^/]*)$/.test(file.path))),
        scopeHash: hashBytes(JSON.stringify([inventory.version, inventory.excluded.filter(file => !controlPath(file.path)).sort((a, b) => a.path.localeCompare(b.path)), inventory.gaps, inventory.issues])), supportHash: supportHash(inventory, overrides) };
}

export function evidenceCacheKey(identity: EvidenceIdentity, runner: EvidenceRunner, kind: string): string {
    return hashBytes(JSON.stringify([IDENTITY_KEYS.map(key => identity[key]), runner.argv, runner.version, runner.operatorPolicy, runner.environmentHash, kind]));
}

export function identityDifferences(before: EvidenceIdentity, after: EvidenceIdentity): string[] {
    return IDENTITY_KEYS.filter(key => before[key] !== after[key]).map(key => `${key} changed`);
}
