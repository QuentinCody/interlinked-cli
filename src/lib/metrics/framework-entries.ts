import { dirname } from "node:path";
import { isJsonObject } from "../json-types.js";
import type { InventoryFile, RepositoryInventory } from "./measurement-types.js";

function declaresNext(file: InventoryFile): boolean {
    try {
        const json: unknown = JSON.parse(file.content);
        return isJsonObject(json) && [json.dependencies, json.devDependencies, json.peerDependencies].some(value => isJsonObject(value) && "next" in value);
    } catch { return false; }
}
export function frameworkScoringEntries(inventory: RepositoryInventory, known: ReadonlySet<string>): string[] {
    const entries = new Set<string>();
    for (const file of inventory.files.filter(file => file.path.endsWith("package.json") && declaresNext(file))) {
        const directory = dirname(file.path), prefix = directory === "." ? "" : `${directory}/`;
        for (const path of known) {
            if (!path.startsWith(prefix)) continue;
            const local = path.slice(prefix.length);
            if (/^(src\/)?pages\/.+\.[jt]sx?$/.test(local) || /^(src\/)?app\/(.*\/)?(page|layout|route|loading|error|not-found|default|template)\.[jt]sx?$/.test(local)
                || /^(src\/)?(middleware|instrumentation)\.[jt]s$/.test(local)) entries.add(path);
        }
    }
    return [...entries];
}
