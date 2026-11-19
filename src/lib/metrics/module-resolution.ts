import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import type * as TS from "typescript";
import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { createImportResolver, type AliasResolution, type ImportResolver } from "../import-resolution/import-resolver.js";
import { mapRepoView } from "../import-resolution/repo-view.js";
import { isJsonObject } from "../json-types.js";
import type { InventoryFile, RepositoryInventory } from "./measurement-types.js";
import { resolveSourceTarget } from "./graph-entries.js";
import { measurementCompilerOptions } from "./typed-program.js";

/** `unresolved` carries a short reason; the report counts imports per reason. */
export type ScoringResolution = { kind: "local"; target: string } | { kind: "external" } | { kind: "unresolved"; reason: string };
const ASSET_RE = /\.(?:json|css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|md|mdx|txt|html|ya?ml|csv|wasm|graphql|gql)$/;
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
interface ResolutionContext { root: string; nodes: ReadonlySet<string>; packages: Packages; resolveWithCompiler: CompilerResolver; alias: ImportResolver; }

/** A path the alias layer found: a graph node, a non-code asset, or a real file the measurement does not read. */
function fromAlias(context: ResolutionContext, found: AliasResolution): ScoringResolution {
    if (found.kind === "virtual") return { kind: "external" };
    if (found.kind === "unresolved") return { kind: "unresolved", reason: found.reason };
    if (context.nodes.has(found.target)) return { kind: "local", target: found.target };
    return ASSET_RE.test(found.target) ? { kind: "external" } : { kind: "unresolved", reason: "target-not-measured" };
}

function viaCompiler(context: ResolutionContext, from: string, specifier: string): ScoringResolution | null {
    const resolved = context.resolveWithCompiler(from, specifier);
    if (!resolved) return null;
    const target = relative(context.root, resolved.resolvedFileName).replaceAll("\\", "/");
    if (context.nodes.has(target)) return { kind: "local", target };
    return resolved.isExternalLibraryImport || /\.d\.[cm]?ts$/.test(target) ? { kind: "external" } : null;
}

/**
 * No code edge in the repository: a Node or Bun built-in, a stylesheet, image or data file, the `./$types` module that
 * `svelte-kit sync` generates outside the tree, or a relative path into `node_modules` (install output, not in the tree).
 */
function carriesNoCode(specifier: string): boolean {
    if (/^(?:node|bun):/.test(specifier) || /^\.\/\$types(?:\.js)?$/.test(specifier)) return true;
    return ASSET_RE.test(specifier.replace(/[?#].*$/, "")) || (specifier.startsWith(".") && /(?:^|\/)node_modules\//.test(specifier));
}

function resolveImport(context: ResolutionContext, from: string, specifier: string): ScoringResolution {
    if (carriesNoCode(specifier)) return { kind: "external" };
    const isRelative = specifier.startsWith(".");
    const direct = isRelative ? resolveSourceTarget(join(dirname(from), specifier), context.nodes) : null;
    if (direct) return { kind: "local", target: direct };
    const alias = isRelative ? null : context.alias.resolve(from, specifier);
    if (alias) return fromAlias(context, alias);
    const compiled = viaCompiler(context, from, specifier);
    if (compiled) return compiled;
    const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
    if (context.packages.dependencies.has(name) && !context.packages.workspaces.has(name)) return { kind: "external" };
    return { kind: "unresolved", reason: isRelative ? "relative-target-missing" : "package-not-declared" };
}

/**
 * `nodes` are the importable modules: measured source files plus single-file components.
 * Relative imports resolve first, then the alias layer (tsconfig paths, workspace packages, framework aliases),
 * then the TypeScript compiler, then the declared-dependency exemption.
 */
export function scoringModuleResolver(inventory: RepositoryInventory, nodes: ReadonlySet<string>): (from: string, specifier: string) => ScoringResolution {
    const view = mapRepoView(new Map(inventory.files.map(file => [file.path, file.content])));
    const context = { root: inventory.root, nodes, packages: packageNames(inventory), resolveWithCompiler: compilerResolver(inventory), alias: createImportResolver(view) };
    return (from, specifier) => resolveImport(context, from, specifier);
}
