import { hashBytes, inventoryHash } from "./inventory.js";
import { isScoreInput, sourceLanguage, sourceRole } from "./inventory-roles.js";
import type { RepositoryInventory } from "./measurement-types.js";

export function inventoryWithOverrides(inventory: RepositoryInventory, changes: ReadonlyMap<string, string | null>): RepositoryInventory {
    const paths = new Set(changes.keys());
    const next = { ...inventory, files: inventory.files.filter(file => !paths.has(file.path)),
        gaps: inventory.gaps.filter(file => !paths.has(file.path)), excluded: inventory.excluded.filter(file => !paths.has(file.path)) };
    for (const [path, content] of changes) {
        if (content === null) continue;
        const role = sourceRole(path);
        if (isScoreInput(role)) next.files.push({ path, content, role, language: sourceLanguage(path), sha256: hashBytes(content) });
        else next.excluded.push({ path, role, reason: "Excluded by source-role policy" });
    }
    next.files.sort((a, b) => a.path.localeCompare(b.path)); next.excluded.sort((a, b) => a.path.localeCompare(b.path));
    next.inputHash = inventoryHash(next.files);
    next.sourceHash = inventoryHash(next.files.filter(file => file.role === "product"));
    return next;
}
