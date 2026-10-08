import { dirname, join } from "node:path";
import { resolveSourceTarget } from "../lib/metrics/graph-entries.js";
import { hashBytes } from "../lib/metrics/inventory.js";
import type { RepositoryInventory } from "../lib/metrics/measurement-types.js";
import { parseTsSource } from "./checks/cyclomatic-ast.js";
import { hasExactSyntax } from "./function-tokens/ast-tokens.js";
import { fileEffects } from "./runtime-effects.js";

export interface TestDependencyGraph {
    dependencies: Map<string, string[]>;
    /** Modules that may read inputs the check identity does not hash (see runtime-effects.ts). */
    opaqueFiles: Set<string>;
    /** Modules whose result may differ between two runs of the same bytes (clock, randomness, timers). */
    nondeterministicFiles: Set<string>;
    incomplete: boolean;
}

/** What the closure of some seeds may depend on: its paths, unhashed reads (opaque) and unrepeatable results. */
export interface TestDependencyClosure { paths: Set<string>; opaque: boolean; nondeterministic: boolean; }

/** A module the graph reads besides the inventory (src/ fixtures the score inventory excludes by role). */
export interface GraphFile { path: string; content: string; }

/**
 * The PRE-H1 text rule: the process (environment, cwd, argv), the network, the clock, randomness, dynamic evaluation
 * and test-time mocking, matched as words. The test graph now classifies per operation (runtime-effects.ts); this
 * stricter rule remains the binder for EXTERNAL REPORTER code (`check-identity.ts`) — a reporter writes the run's
 * artifacts, and holding it to a stricter rule than tests can only make a run fresh-only, never reuse wrong bytes.
 */
const RUNTIME_OPACITY = /\b(eval|Function|fetch|process|global|globalThis|Buffer|crypto|WebSocket|Date|performance|setTimeout|setInterval|require|createRequire|importActual|importMock|stubGlobal|stubEnv|doMock|mock)\b|import\.meta|Math\s*\.\s*random|Math\s*\[/;

/** The runtime read that makes `content` opaque under the reporter rule, or null when none is named. */
export function runtimeOpacity(content: string): string | null {
    return RUNTIME_OPACITY.exec(content)?.[0] ?? null;
}

interface ModuleAnalysis { specifiers: string[]; opaque: boolean; nondeterministic: boolean; }
const analysisMemo = new Map<string, { analysis: ModuleAnalysis; bytes: number }>();
const ANALYSIS_MEMO_ENTRIES = 8192;
const ANALYSIS_MEMO_BYTES = 8 * 1024 * 1024;
let analysisMemoBytes = 0;

/** Cache only content-derived summaries, never ASTs, resolved edges or test
 * verdicts. Parser/classifier code is fixed for this process; restart discards
 * the cache. A source-role or inventory change still rebuilds the graph. */
function analyzeModule(file: GraphFile): ModuleAnalysis {
    const key = JSON.stringify([file.path, hashBytes(file.content)]);
    const cached = analysisMemo.get(key);
    if (cached) {
        analysisMemo.delete(key);
        analysisMemo.set(key, cached);
        return cached.analysis;
    }
    const parsed = parseTsSource(file.content, file.path);
    if (!parsed || !hasExactSyntax(parsed)) return { specifiers: [], opaque: true, nondeterministic: false };
    const effects = fileEffects(parsed);
    const analysis = { specifiers: effects.specifiers, opaque: effects.opaque.length > 0, nondeterministic: effects.nondeterministic.length > 0 };
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(analysis));
    if (bytes > ANALYSIS_MEMO_BYTES) return analysis;
    analysisMemo.set(key, { analysis, bytes });
    analysisMemoBytes += bytes;
    while (analysisMemo.size > ANALYSIS_MEMO_ENTRIES || analysisMemoBytes > ANALYSIS_MEMO_BYTES) {
        const oldest = analysisMemo.keys().next();
        if (oldest.done) break;
        analysisMemoBytes -= analysisMemo.get(oldest.value)!.bytes;
        analysisMemo.delete(oldest.value);
    }
    return analysis;
}

function fileDependencies(file: GraphFile, known: Set<string>): { targets: string[]; opaque: boolean; nondeterministic: boolean } {
    const analysis = analyzeModule(file), targets: string[] = [];
    let opaque = analysis.opaque;
    for (const specifier of analysis.specifiers) {
        const target = resolveSourceTarget(join(dirname(file.path), specifier), known);
        if (target) targets.push(target); else opaque = true;
    }
    return { targets: [...new Set(targets)].sort(), opaque, nondeterministic: analysis.nondeterministic };
}

/**
 * Uncertainty belongs to the importing module, not every test in the repository. `extra` files (src/ fixtures the
 * score inventory leaves out) are resolvable import targets with their own dependencies; they are not in the
 * inventory's identity hash, so a closure that reaches one is selectable but never reusable (test-plan.ts).
 */
export function buildTestDependencyGraph(inventory: RepositoryInventory, extra: readonly GraphFile[] = []): TestDependencyGraph {
    const files: GraphFile[] = [...inventory.files.filter(file => file.language === "typescript" || file.language === "javascript"), ...extra];
    const known = new Set([...inventory.files.map(file => file.path), ...extra.map(file => file.path)]);
    const dependencies = new Map<string, string[]>(), opaqueFiles = new Set<string>(), nondeterministicFiles = new Set<string>();
    for (const file of files) {
        const result = fileDependencies(file, known);
        dependencies.set(file.path, result.targets);
        if (result.opaque) opaqueFiles.add(file.path);
        if (result.nondeterministic) nondeterministicFiles.add(file.path);
    }
    return { dependencies, opaqueFiles, nondeterministicFiles, incomplete: inventory.gaps.length > 0 || inventory.issues.length > 0 };
}

export function testDependencyClosure(graph: TestDependencyGraph, seeds: Iterable<string>): TestDependencyClosure {
    const paths = new Set(seeds), queue = [...paths];
    let opaque = graph.incomplete, nondeterministic = false;
    for (let index = 0; index < queue.length; index++) {
        const path = queue[index];
        if (path === undefined) continue;
        opaque ||= graph.opaqueFiles.has(path);
        nondeterministic ||= graph.nondeterministicFiles.has(path);
        for (const target of graph.dependencies.get(path) ?? []) {
            if (!paths.has(target)) { paths.add(target); queue.push(target); }
        }
    }
    return { paths, opaque, nondeterministic };
}
