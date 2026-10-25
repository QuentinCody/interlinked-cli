import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import type { DecisionClient } from "./decision-eval-client.mjs";
import type { JevQuestion } from "../../src/harness/jev/types.js";
import { diffuse, diffusePreservingMass, lexicalScore } from "./graph-lab-core.mjs";
import { distribution } from "./graph-lab-evaluate.mjs";

interface Token { text: string; start: number; end: number; line: number }
export function tokens(source: string): Token[] {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source), result: Token[] = [];
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
        const start = scanner.getTokenPos(), end = scanner.getTextPos();
        result.push({ text: source.slice(start, end), start, end, line: source.slice(0, start).split("\n").length });
    }
    return result;
}
export function changedIndices(before: Token[], after: Token[]): number[] {
    const lengths = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
    for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--)
        lengths[i]![j] = before[i]!.text === after[j]!.text ? 1 + lengths[i + 1]![j + 1]! : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    const changed = new Set<number>(); let i = 0, j = 0;
    while (i < before.length || j < after.length) {
        if (i < before.length && j < after.length && before[i]!.text === after[j]!.text) { i++; j++; }
        else if (i < before.length && (j === after.length || lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) changed.add(i++);
        else { if (before.length) changed.add(Math.max(0, Math.min(before.length - 1, i - 1))); j++; }
    }
    return [...changed].sort((a, b) => a - b);
}
function namedFunctions(source: string): Map<string, string> {
    const file = ts.createSourceFile("sample.ts", source, ts.ScriptTarget.Latest, true), result = new Map<string, string>();
    const walk = (node: ts.Node) => {
        if (ts.isFunctionDeclaration(node) && node.name && node.body) result.set(node.name.text, node.getText(file));
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrowFunction(node.initializer))
            result.set(node.name.text, node.initializer.getText(file));
        ts.forEachChild(node, walk);
    };
    walk(file); return result;
}
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 8_000_000 });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
interface LocalizationCase {
    id: string; commit: string; path: string; name: string; task: string; source: string; next: string;
    tokens: Token[]; changedTokens: number[];
}
function caseFromCommit(commit: string): LocalizationCase | string {
    const stats = git("show", "--format=", "--numstat", commit).trim().split("\n").map(line => line.split("\t"));
    const files = stats.filter(([a, d, path]) => path?.endsWith(".ts") && !path.endsWith(".test.ts") && Number(a) + Number(d) <= 80);
    if (files.length !== 1) return "not_one_small_production_file";
    const path = files[0]![2]!;
    let before: string, after: string;
    try { before = git("show", `${commit}^:${path}`); after = git("show", `${commit}:${path}`); } catch { return "missing_parent_file"; }
    const oldFunctions = namedFunctions(before), newFunctions = namedFunctions(after);
    const changed = [...oldFunctions].filter(([name, source]) => newFunctions.has(name) && newFunctions.get(name) !== source);
    if (changed.length !== 1) return "not_one_named_function_change";
    const [name, source] = changed[0]!, next = newFunctions.get(name)!;
    const oldTokens = tokens(source), newTokens = tokens(next);
    if (oldTokens.length < 8 || oldTokens.length > 254 || newTokens.length > 500) return "token_bounds";
    const changedTokens = changedIndices(oldTokens, newTokens);
    if (!changedTokens.length || changedTokens.length > oldTokens.length / 2) return "not_a_local_lexical_edit";
    const task = git("show", "-s", "--format=%s%n%b", commit).trim();
    return { id: hash(`${commit}:${name}`).slice(0, 12), commit, path, name, task, source, next, tokens: oldTokens, changedTokens };
}

export function collectLocalizationCases(limit = 24) {
    const commits = git("log", "--no-merges", "-300", "--format=%H", "--", "src").trim().split("\n");
    const cases: LocalizationCase[] = [], excluded: Record<string, number> = {};
    for (const commit of commits) {
        if (cases.length >= limit) break;
        const candidate = caseFromCommit(commit);
        if (typeof candidate === "string") excluded[candidate] = (excluded[candidate] ?? 0) + 1;
        else cases.push(candidate);
    }
    return { cases, excluded, scannedCommitLimit: 300, requestedCases: limit,
        limitation: "Recorded edit locations only; commit messages were authored after edits. Candidate function is supplied, not retrieved. Insertions use the preceding old token." };
}
export function localBindingEdges(source: string, list: Token[]): Array<[number, number]> {
    const name = "local.ts", options = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
    const host = ts.createCompilerHost(options), file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    host.getSourceFile = path => path === name ? file : undefined;
    const program = ts.createProgram([name], options, host), checker = program.getTypeChecker();
    const groups = new Map<ts.Symbol, number[]>();
    const walk = (node: ts.Node) => {
        if (ts.isIdentifier(node)) {
            const symbol = checker.getSymbolAtLocation(node), index = list.findIndex(t => t.start === node.getStart(file));
            if (symbol && index >= 0) groups.set(symbol, [...(groups.get(symbol) ?? []), index]);
        }
        ts.forEachChild(node, walk);
    };
    walk(file);
    const edges: Array<[number, number]> = [];
    for (let i = 1; i < list.length; i++) edges.push([i - 1, i], [i, i - 1]);
    for (const group of groups.values()) for (const a of group) for (const b of group) if (a !== b) edges.push([a, b]);
    return edges;
}
export function scoreLocalization(scores: number[], changed: number[]) {
    const order = scores.map((score, i) => ({ score, i })).sort((a, b) => b.score - a.score || a.i - b.i);
    const rank = order.findIndex(x => changed.includes(x.i)) + 1;
    const mass = changed.reduce((sum, i) => sum + scores[i]!, 0);
    return { top1: changed.includes(order[0]!.i), reciprocalRank: rank ? 1 / rank : 0, changedMass: mass,
        uniformMass: changed.length / scores.length, liftOverUniform: mass / (changed.length / scores.length) };
}
function optionsFor(source: string, list: Token[]) {
    const lineGroups = [...new Set(list.map(t => t.line))].map(line => list.flatMap((t, i) => t.line === line ? [i] : []));
    const file = ts.createSourceFile("local.ts", source, ts.ScriptTarget.Latest, true);
    const fn = file.statements.find(ts.isFunctionDeclaration), body = fn?.body;
    const statements = body ? [...body.statements] : [...file.statements];
    const astGroups = statements.map(s => list.flatMap((t, i) => t.start >= s.getStart(file) && t.end <= s.end ? [i] : [])).filter(g => g.length);
    const remaining = list.map((_, i) => i).filter(i => !astGroups.some(g => g.includes(i))); if (remaining.length) astGroups.push(remaining);
    const groups = { tokens: list.map((_, i) => [i]), lines: lineGroups, ast: astGroups };
    return Object.fromEntries(Object.entries(groups).map(([kind, rows]) => [kind, Object.fromEntries(rows.map((indices, i) =>
        [`${kind}_${i}`, { indices, text: indices.map(index => list[index]!.text).join(" ") }]))]));
}
function localizationQuestions(options: ReturnType<typeof optionsFor>, id: string, replica: number): Record<string, JevQuestion> {
    return Object.fromEntries(Object.entries(options).map(([kind, values]) => {
        const entries = [...Object.entries(values), ["none", { indices: [], text: "No relevant edit location in this function" }] as const]
            .sort(([a], [b]) => hash(`${id}:${replica}:${a}`).localeCompare(hash(`${id}:${replica}:${b}`)));
        return [kind, { type: "choice", instructions: "Given the change request, which option is the primary edit location? An insertion may be adjacent to an existing token. Select none only if no relevant location exists.",
            criteria: Object.fromEntries(entries.map(([key, value]) => [key, value.text])) }];
    }));
}

function accumulateReplica(options: ReturnType<typeof optionsFor>, c: LocalizationCase,
    answer: Awaited<ReturnType<DecisionClient["ask"]>>, accumulated: Record<string, number[]>) {
    const replicaScores: Record<string, ReturnType<typeof scoreLocalization>> = {};
    for (const [kind, values] of Object.entries(options)) {
        const probabilities = distribution(answer, kind), scores = c.tokens.map(() => 0);
        for (const [id, option] of Object.entries(values)) for (const index of option.indices) scores[index]! += probabilities[id]! / option.indices.length;
        scores.forEach((v, i) => { accumulated[kind]![i]! += v / 2; }); replicaScores[kind] = scoreLocalization(scores, c.changedTokens);
    }
    return replicaScores;
}

export async function evaluateLocalization(client: DecisionClient, cases: LocalizationCase[]) {
    const rows = [];
    for (const c of cases) {
        const options = optionsFor(c.source, c.tokens), accumulated: Record<string, number[]> = Object.fromEntries(Object.keys(options).map(k => [k, c.tokens.map(() => 0)]));
        const orderResults = [];
        for (let replica = 0; replica < 2; replica++) {
            const questions = localizationQuestions(options, c.id, replica);
            const marked = c.tokens.map((t, i) => `⟦tokens_${i}⟧${t.text}`).join(" ");
            const answer = await client.ask(`localization-${c.id}-${replica}`, { request: c.task, functionBefore: c.source, tokenMarkers: marked }, questions);
            orderResults.push(accumulateReplica(options, c, answer, accumulated));
        }
        const rawLexical = c.tokens.map(t => lexicalScore(c.task, t.text)), total = rawLexical.reduce((a, b) => a + b, 0);
        const lexical = rawLexical.map(v => total ? v / total : 1 / rawLexical.length), edges = localBindingEdges(c.source, c.tokens);
        const scores = { uniform: c.tokens.map(() => 1 / c.tokens.length), lexical, lexicalGraph: diffuse(lexical, edges),
            ...accumulated, tokenGraph: diffusePreservingMass(accumulated.tokens!, edges) };
        rows.push({ id: c.id, metrics: Object.fromEntries(Object.entries(scores).map(([arm, values]) => [arm, scoreLocalization(values, c.changedTokens)])),
            orderResults, graphEdges: edges.length, graphKind: "Token adjacency plus resolved local-symbol references; not a control/data-flow graph" });
    }
    return rows;
}
