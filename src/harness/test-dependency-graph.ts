import { dirname, join } from "node:path";
import { analyzeSyntax } from "../lib/metrics/analysis-syntax.js";
import { resolveSourceTarget } from "../lib/metrics/graph-entries.js";
import type { RepositoryInventory } from "../lib/metrics/measurement-types.js";
import { parseTsSource } from "./checks/cyclomatic-ast.js";
import { hasExactSyntax } from "./function-tokens/ast-tokens.js";

export interface TestDependencyGraph {
    dependencies: Map<string, string[]>;
    opaqueFiles: Set<string>;
    incomplete: boolean;
}

function fileDependencies(file: RepositoryInventory["files"][number], known: Set<string>): { targets: string[]; opaque: boolean } {
    const parsed = parseTsSource(file.content, file.path), targets: string[] = [];
    if (!parsed || !hasExactSyntax(parsed)) return { targets, opaque: true };
    let opaque = /\b(eval|Function|fetch|process|global|globalThis|crypto|WebSocket|Date|performance|setTimeout|setInterval|require|importActual|importMock|stubGlobal|stubEnv|doMock|mock)\b|import\.meta|Math\s*\.\s*random|Math\s*\[/.test(file.content);
    for (const reference of analyzeSyntax(parsed).imports) {
        const specifier = reference.specifier;
        if (!specifier?.startsWith(".")) {
            if (specifier !== "vitest" && specifier !== "vitest/config" && specifier !== "node:assert/strict") opaque = true;
            continue;
        }
        const target = resolveSourceTarget(join(dirname(file.path), specifier), known);
        if (target) targets.push(target); else opaque = true;
    }
    return { targets: targets.sort(), opaque };
}

/** Uncertainty belongs to the importing module, not every test in the repository. */
export function buildTestDependencyGraph(inventory: RepositoryInventory): TestDependencyGraph {
    const known = new Set(inventory.files.map(file => file.path));
    const dependencies = new Map<string, string[]>(), opaqueFiles = new Set<string>();
    for (const file of inventory.files) {
        if (file.language !== "typescript" && file.language !== "javascript") continue;
        const result = fileDependencies(file, known);
        dependencies.set(file.path, result.targets);
        if (result.opaque) opaqueFiles.add(file.path);
    }
    return { dependencies, opaqueFiles, incomplete: inventory.gaps.length > 0 || inventory.issues.length > 0 };
}

export function testDependencyClosure(graph: TestDependencyGraph, seeds: Iterable<string>): { paths: Set<string>; opaque: boolean } {
    const paths = new Set(seeds), queue = [...paths];
    let opaque = graph.incomplete;
    for (let index = 0; index < queue.length; index++) {
        const path = queue[index];
        if (path === undefined) continue;
        opaque ||= graph.opaqueFiles.has(path);
        for (const target of graph.dependencies.get(path) ?? []) {
            if (!paths.has(target)) { paths.add(target); queue.push(target); }
        }
    }
    return { paths, opaque };
}
