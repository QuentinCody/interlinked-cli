import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { componentKind, maskComponentScripts } from "../import-resolution/component-scripts.js";
import { importReferences } from "./analysis-syntax.js";
import type { ImportReference } from "./analysis-syntax.js";

/**
 * Imports that a single-file component (`.svelte`, `.vue`, `.astro`) makes from its script blocks.
 * The component is not measured; it only joins the import graph as an importer, with line numbers of the original file.
 */
export function componentImports(path: string, content: string): ImportReference[] {
    const kind = componentKind(path);
    if (kind === null) return [];
    const parsed = parseTsSource(maskComponentScripts(content, kind), "component-script.ts");
    return parsed ? importReferences(parsed) : [];
}
