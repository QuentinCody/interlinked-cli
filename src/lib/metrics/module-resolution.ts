import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import type * as TS from "typescript";
import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { isJsonObject } from "../json-types.js";
import type { InventoryFile, RepositoryInventory } from "./measurement-types.js";
import { resolveSourceTarget } from "./graph-entries.js";
import { measurementCompilerOptions } from "./typed-program.js";

export type ScoringResolution = { kind: "local"; target: string } | { kind: "external" | "unresolved" };
interface Packages { dependencies: Set<string>; workspaces: Set<string>; }
function addPackage(file: InventoryFile, packages: Packages): void {
    try {
        const json: unknown = JSON.parse(file.content);
        if (!isJsonObject(json)) return;
        if (typeof json.name === "string") packages.workspaces.add(json.name);
        for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
            const map = json[field];
            if (isJsonObject(map)) for (const name of Object.keys(map)) packages.dependencies.add(name);
        }
    } catch { /* Invalid metadata never supplies an external-dependency exemption. */ }
}
function packageNames(inventory: RepositoryInventory): Packages {
    const packages = { dependencies: new Set(builtinModules.flatMap(name => [name, `node:${name}`])), workspaces: new Set<string>() };
    for (const file of inventory.files.filter(file => file.path.endsWith("package.json"))) addPackage(file, packages);
    return packages;
}
type CompilerResolver = (from: string, specifier: string) => TS.ResolvedModuleFull | undefined;
function compilerResolver(inventory: RepositoryInventory): CompilerResolver {
    const parsed = parseTsSource("", "resolution.ts");
    if (!parsed) return () => undefined;
    const { options } = measurementCompilerOptions(inventory, parsed.ts);
    const cache = parsed.ts.createModuleResolutionCache(inventory.root, path => path, options);
    return (from, specifier) => parsed.ts.resolveModuleName(specifier, resolve(inventory.root, from), options, parsed.ts.sys, cache).resolvedModule;
}
interface ResolutionContext { root: string; known: ReadonlySet<string>; packages: Packages; resolveWithCompiler: CompilerResolver; }
function resolveImport(context: ResolutionContext, from: string, specifier: string): ScoringResolution {
    const direct = specifier.startsWith(".") ? resolveSourceTarget(join(dirname(from), specifier), context.known) : null;
    if (direct) return { kind: "local", target: direct };
    const resolved = context.resolveWithCompiler(from, specifier);
    if (resolved) {
        const target = relative(context.root, resolved.resolvedFileName).replaceAll("\\", "/");
        if (context.known.has(target)) return { kind: "local", target };
        if (resolved.isExternalLibraryImport || /\.d\.[cm]?ts$/.test(target)) return { kind: "external" };
    }
    const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
    if (context.packages.dependencies.has(name) && !context.packages.workspaces.has(name)) return { kind: "external" };
    return { kind: "unresolved" };
}
export function scoringModuleResolver(inventory: RepositoryInventory, known: ReadonlySet<string>): (from: string, specifier: string) => ScoringResolution {
    const context = { root: inventory.root, known, packages: packageNames(inventory), resolveWithCompiler: compilerResolver(inventory) };
    return (from, specifier) => resolveImport(context, from, specifier);
}
