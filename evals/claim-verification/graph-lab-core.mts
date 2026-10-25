import type { LocatedCandidate } from "./annotation-metrics.mjs";
import { posix } from "node:path";
import ts from "typescript";

export function moduleGraph(files: Record<string, string>) {
    const edges: Array<[string, string]> = [], opaque: string[] = [];
    for (const [name, source] of Object.entries(files)) {
        const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
        const add = (specifier: string) => {
            const target = posix.normalize(posix.join(posix.dirname(name), specifier)).replace(/\.js$/, ".ts");
            if (target in files) edges.push([name, target]); else opaque.push(name);
        };
        const visit = (node: ts.Node) => {
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const arg = node.arguments[0]; if (arg && ts.isStringLiteral(arg)) add(arg.text); else opaque.push(name);
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
    }
    return { edges, opaque: [...new Set(opaque)] };
}

export function reachable(seeds: string[], edges: Array<[string, string]>): Set<string> {
    const seen = new Set(seeds), queue = [...seeds];
    for (let i = 0; i < queue.length; i++) for (const [from, to] of edges) {
        if (from === queue[i] && !seen.has(to)) { seen.add(to); queue.push(to); }
    }
    return seen;
}
export function clauseCandidates(source: string): LocatedCandidate[] {
    const rows: LocatedCandidate[] = [];
    const pattern = /[^;\n.!?]+[;.!?]?/g;
    for (const match of source.matchAll(pattern)) {
        const text = match[0].trim(); if (!text) continue;
        const start = match.index + match[0].indexOf(text);
        rows.push({ text, spans: [[start, start + text.length]] });
    }
    return rows;
}
export function words(text: string): Set<string> {
    return new Set(text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? []);
}
export function lexicalScore(a: string, b: string): number {
    const left = words(a), right = words(b);
    const n = [...left].filter(w => right.has(w)).length;
    return n / (left.size + right.size - n || 1);
}
export function choose(scores: Record<string, number>): string {
    return Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "none";
}
/** Directed personalized diffusion; this score is not a calibrated edit probability. */
export function diffuse(seed: number[], edges: Array<[number, number]>, damping = 0.7, rounds = 30): number[] {
    if (!seed.length) return [];
    const total = seed.reduce((a, b) => a + b, 0);
    const reset = seed.map(v => total ? v / total : 1 / seed.length);
    const neighbors = seed.map(() => new Set<number>());
    for (const [from, to] of edges) if (neighbors[from] && neighbors[to] && from !== to) neighbors[from]!.add(to);
    let scores = [...reset];
    for (let round = 0; round < rounds; round++) {
        const next = reset.map(v => (1 - damping) * v);
        for (let i = 0; i < scores.length; i++) {
            const targets = neighbors[i]!;
            if (targets.size) for (const j of targets) next[j]! += damping * scores[i]! / targets.size;
            else next[i]! += damping * scores[i]!;
        }
        scores = next;
    }
    return scores;
}
export function diffusePreservingMass(seed: number[], edges: Array<[number, number]>): number[] {
    const mass = seed.reduce((a, b) => a + b, 0);
    return diffuse(seed, edges).map(score => score * mass);
}
