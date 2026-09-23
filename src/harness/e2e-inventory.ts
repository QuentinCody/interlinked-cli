import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { isBoundaryFile, isGeneratedHookSource } from "./e2e-boundary.js";

export function sourceFiles(root: string, directory = "src"): string[] {
    return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
        const path = `${directory}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error(`Source inventory cannot follow symbolic links: ${path}`);
        return entry.isDirectory() ? sourceFiles(root, path) : [path];
    }).sort();
}

/** Only the build's own metafile can establish that a barrel was erased. */
function erasedInputs(metafile: unknown): Set<string> {
    if (!isJsonObject(metafile) || !isJsonObject(metafile.inputs) || !isJsonObject(metafile.outputs)) throw new Error("Missing or malformed e2e build metafile");
    const erased = new Set(Object.keys(metafile.inputs));
    for (const output of Object.values(metafile.outputs)) {
        if (!isJsonObject(output) || !isJsonObject(output.inputs)) throw new Error("Malformed metafile output");
        for (const [path, info] of Object.entries(output.inputs)) {
            if (!isJsonObject(info) || typeof info.bytesInOutput !== "number") throw new Error(`Malformed metafile input: ${path}`);
            if (info.bytesInOutput > 0) erased.delete(path);
        }
    }
    return erased;
}

export function boundaryInventory(root: string, metafile: unknown): string[] {
    const erased = erasedInputs(metafile);
    // Resolve the compiler in the project running the e2e lane. It is part of
    // that project's locked build toolchain, not a CLI runtime dependency.
    const compiler: typeof import("esbuild") = createRequire(import.meta.url)("esbuild");
    const inventory: string[] = [];
    for (const path of sourceFiles(root).filter(isBoundaryFile)) {
        if (isGeneratedHookSource(path) || erased.has(path)) continue;
        const compiled = compiler.transformSync(readFileSync(join(root, path), "utf8"), { loader: path.endsWith(".tsx") ? "tsx" : "ts", format: "esm" });
        if (compiled.code.trim() !== "") inventory.push(path);
    }
    return inventory;
}
