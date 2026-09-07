import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { inventoryPaths } from "./inventory-paths.js";
import { isScoreInput, sourceLanguage, sourceRole } from "./inventory-roles.js";
import type { InventoryFile, RepositoryInventory } from "./measurement-types.js";

export const SOURCE_ROLE_VERSION = "interlinked-source-roles-v1";

export function hashBytes(content: string | Uint8Array): string {
    return createHash("sha256").update(content).digest("hex");
}

export function inventoryHash(files: readonly InventoryFile[]): string {
    return hashBytes(JSON.stringify(files.map(file => [file.path, file.role, file.sha256]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
}

/** Artifact paths must name one regular file inside the selected root. */
export function containedFile(root: string, path: string): string {
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Path escapes repository root");
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Expected a regular, non-symlink file");
    const resolved = relative(root, realpathSync(absolute));
    if (resolved === ".." || resolved.startsWith("../") || isAbsolute(resolved)) throw new Error("Path resolves outside repository root");
    return absolute;
}

function readInput(inventory: RepositoryInventory, path: string): void {
    const role = sourceRole(path);
    if (!isScoreInput(role) || /(^|\/)\.(git|interlinked|claude|codex|agents)(\/|$)/.test(path)) {
        inventory.excluded.push({ path, role, reason: "Excluded by source-role policy" });
        return;
    }
    try {
        const absolute = containedFile(inventory.root, path);
        if (lstatSync(absolute).size > 2 * 1024 * 1024) throw new Error("Input exceeds 2 MiB analysis limit");
        const content = readFileSync(absolute, "utf8");
        inventory.files.push({ path, role, content, language: sourceLanguage(path), sha256: hashBytes(content) });
    } catch (error) {
        inventory.gaps.push({ path, role, reason: error instanceof Error ? error.message : String(error) });
    }
}

export function collectRepositoryInventory(directory: string): RepositoryInventory {
    const root = realpathSync(directory);
    const paths = inventoryPaths(root);
    const inventory: RepositoryInventory = {
        version: SOURCE_ROLE_VERSION, root, discovery: paths.discovery, files: [], gaps: [],
        excluded: [], inputHash: "", sourceHash: "", issues: paths.issues,
    };
    for (const path of paths.paths) readInput(inventory, path.replaceAll("\\", "/"));
    inventory.inputHash = inventoryHash(inventory.files);
    inventory.sourceHash = inventoryHash(inventory.files.filter(file => file.role === "product"));
    return inventory;
}
