import assert from "node:assert/strict";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isJsonObject } from "../lib/json-types.js";

function confinedRelative(root: string, path: string): string {
    const rel = relative(root, path);
    assert(rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`), `E2e output escapes its build stage: ${path}`);
    return rel;
}

function outputPaths(root: string, metafile: unknown): string[] {
    assert(isJsonObject(metafile) && isJsonObject(metafile.outputs), "Missing or malformed e2e build metafile");
    const entries = Object.entries(metafile.outputs);
    const main = entries.find(([, output]) => isJsonObject(output) && output.entryPoint === "src/index.ts");
    assert(main, "E2e build metafile has no CLI entrypoint");
    const stage = dirname(resolve(root, main[0]));
    const stageName = relative(root, stage).replaceAll("\\", "/");
    assert(stageName === "dist" || /^\.dist-build-[^/]+$/.test(stageName), "E2e build output root is not a published build stage");
    return entries.filter(([path]) => path.endsWith(".js")).map(([path]) => join(root, "dist", confinedRelative(stage, resolve(root, path))));
}

function assertRegularArtifact(root: string, path: string): void {
    assert(lstatSync(path).isFile(), `Missing regular E2e build artifact: ${path}`);
    confinedRelative(join(realpathSync(root), "dist"), realpathSync(path));
}

/** Static prerequisites only. The merger must still prove maps were loaded and contain executable models. */
export function assertE2eSourceMaps(root: string, metafile: unknown, inventory: readonly string[]): void {
    const mapped = new Set<string>();
    for (const file of outputPaths(root, metafile)) {
        assertRegularArtifact(root, file);
        const path = `${file}.map`;
        assertRegularArtifact(root, path);
        const map: unknown = JSON.parse(readFileSync(path, "utf8"));
        assert(isJsonObject(map) && map.version === 3 && typeof map.mappings === "string" && Array.isArray(map.sources), `Malformed E2e source map: ${path}`);
        for (const source of map.sources) {
            assert(typeof source === "string", `Malformed E2e source-map source: ${path}`);
            mapped.add(relative(root, resolve(dirname(file), source)).replaceAll("\\", "/"));
        }
    }
    for (const path of inventory) assert(mapped.has(path), `Boundary source is absent from built bundle maps: ${path}`);
}
