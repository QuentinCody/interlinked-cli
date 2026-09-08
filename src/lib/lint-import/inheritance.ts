import { basename } from "node:path";
import { lintJsonc, lintObject } from "./json.js";
import { ruffInheritance } from "./toml-inheritance.js";

function paths(value: unknown): string[] {
    if (value === undefined) return [];
    const values = Array.isArray(value) ? value : [value];
    if (!values.every((entry): entry is string => typeof entry === "string" && entry.length > 0)) {
        throw new Error("Lint inheritance requires literal configuration paths");
    }
    return values;
}

/** Only documented inheritance fields give bare strings path semantics. */
export function lintInheritance(tool: string, file: string, content: string): string[] {
    if (tool === "ruff" && file.endsWith(".toml")) return ruffInheritance(content, basename(file) === "pyproject.toml");
    if ((tool === "biome" || tool === "oxlint") && /\.jsonc?$/.test(file)) {
        const inherited = paths(lintObject(lintJsonc(content)).extends);
        // Biome also accepts package presets. Documented local-path forms
        // start with a dot or end in .json/.jsonc; package context is separate.
        return tool === "biome" ? inherited.filter((path) => path.startsWith(".") || /\.jsonc?$/.test(path)) : inherited;
    }
    return [];
}
