import { frameworkEntryFiles } from "../import-resolution/framework-entries.js";
import { mapRepoView } from "../import-resolution/repo-view.js";
import type { RepositoryInventory } from "./measurement-types.js";

/** Files that a declared framework (SvelteKit, Next.js, Nuxt, Astro) loads by path: roots of the scoring graph. */
export function frameworkScoringEntries(inventory: RepositoryInventory, nodes: ReadonlySet<string>): string[] {
    const view = mapRepoView(new Map(inventory.files.map(file => [file.path, file.content])));
    return [...frameworkEntryFiles(view, nodes)];
}
