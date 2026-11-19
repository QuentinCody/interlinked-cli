// Bounded structural overlap evidence for the edit-time helper advisory.
// Adapted from the statement-window surfacer; binding identity is resolved
// per source file. This establishes shared syntax, never safe extraction.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type * as ts from "typescript";
import { functionName as cyclomaticFunctionName } from "./cyclomatic-ast.js";
import { loadCheckTypescript } from "./check-typescript.js";
import { getExtension, isTestFile, JS_TS_EXTS } from "./shared.js";

export const HELPER_OVERLAP_LIMITS = {
    statements: 5, bytes: 256 * 1024, nodes: 20_000, windows: 256, siblings: 40, findings: 10,
} as const;

export interface OverlapFunction {
    name: string;
    line: number;
    start: number;
    end: number;
}
export interface StatementWindow {
    hash: string;
    name: string;
    functionLine: number;
    line: number;
    endLine: number;
    start: number;
    end: number;
}
export interface OverlapSource {
    file: string;
    imports: string[];
    functions: OverlapFunction[];
    windows: StatementWindow[];
    visited: number;
    truncated: boolean;
    unavailable?: "compiler" | "parse-error";
}
export interface PartialOverlapHit {
    line: number;
    name: string;
    window: StatementWindow;
    otherFile: string;
    other: StatementWindow;
}

type BodyFunction = ts.FunctionLikeDeclaration & { body: ts.Block };
function isBodyFunction(ts: typeof import("typescript"), node: ts.Node): node is BodyFunction {
    return (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
        || ts.isConstructorDeclaration(node)) && node.body !== undefined && ts.isBlock(node.body);
}
function functionName(ts: typeof import("typescript"), node: BodyFunction, source: ts.SourceFile): string | undefined {
    const name = cyclomaticFunctionName(ts, node, source);
    return name === "(callback)" ? undefined : name;
}
function propertyName(ts: typeof import("typescript"), node: ts.Identifier): boolean {
    const p = node.parent;
    return (ts.isPropertyAccessExpression(p) && p.name === node)
        || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)
            || ts.isPropertySignature(p)) && p.name === node)
        || (ts.isBindingElement(p) && p.propertyName === node)
        || (ts.isQualifiedName(p) && p.right === node)
        || (ts.isLabeledStatement(p) && p.label === node)
        || ((ts.isBreakStatement(p) || ts.isContinueStatement(p)) && p.label === node);
}
function importTargets(file: string, specifier: string): string[] {
    if (!specifier.startsWith(".")) return [];
    const base = resolve(dirname(file), specifier);
    return [base, base.replace(/\.[cm]?js$/, ".ts"), base.replace(/\.jsx?$/, ".tsx"),
        `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}/index.ts`, `${base}/index.js`];
}
function jumpTarget(ts: typeof import("typescript"), node: ts.BreakStatement | ts.ContinueStatement): ts.Node | undefined {
    const label = node.label?.text;
    for (let target: ts.Node | undefined = node.parent; target; target = target.parent) {
        if (label !== undefined) {
            if (ts.isLabeledStatement(target) && target.label.text === label) return target;
        } else if (ts.isIterationStatement(target, false) || (ts.isBreakStatement(node) && ts.isSwitchStatement(target))) {
            return target;
        }
    }
    return undefined;
}

function jumpsOutside(ts: typeof import("typescript"), nodes: readonly ts.Statement[], start: number, end: number, spend: () => boolean): boolean {
    let outside = false;
    function walk(node: ts.Node): void {
        if (!spend()) { outside = true; return; }
        if (isBodyFunction(ts, node)) return;
        if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
            const target = jumpTarget(ts, node);
            if (target === undefined || target.getStart() < start || target.end > end) outside = true;
        }
        ts.forEachChild(node, walk);
    }
    nodes.forEach(walk);
    return outside;
}

/** No module resolution, library reads or writes: the checker binds one in-memory file. */
export function analyzeHelperOverlap(content: string, file: string): OverlapSource {
    const out: OverlapSource = { file, imports: [], functions: [], windows: [], visited: 0, truncated: false };
    if (Buffer.byteLength(content) > HELPER_OVERLAP_LIMITS.bytes) { out.truncated = true; return out; }
    const compiler = loadCheckTypescript("extracted_helper_duplicate", "partial statement overlap");
    if (compiler === null) { out.unavailable = "compiler"; return out; }
    const ts = compiler;
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const options: ts.CompilerOptions = { noResolve: true, noLib: true, allowJs: true, target: ts.ScriptTarget.Latest };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = name => name === file ? source : undefined;
    host.fileExists = name => name === file;
    host.readFile = name => name === file ? content : undefined;
    const program = ts.createProgram([file], options, host);
    if (program.getSyntacticDiagnostics(source).length > 0) { out.unavailable = "parse-error"; return out; }
    const checker = program.getTypeChecker();
    function spend(): boolean {
        if (out.visited >= HELPER_OVERLAP_LIMITS.nodes) { out.truncated = true; return false; }
        out.visited++;
        return true;
    }
    const context = { ts, source, checker, out, spend, file };
    const functions = collectOverlapFunctions(context);
    for (const parent of functions) {
        if (out.truncated) break;
        collectOverlapWindows(context, parent);
    }
    return out;
}

function unrelatedSibling(edited: OverlapSource, other: OverlapSource): boolean {
    const file = resolve(edited.file), sibling = resolve(other.file);
    return file !== sibling && dirname(file) === dirname(sibling)
        && !edited.imports.includes(sibling) && !other.imports.includes(file);
}

function* matchingWindows(windows: readonly StatementWindow[], other: OverlapSource, introduced: ReadonlySet<string>) {
    const index = new Map(other.windows.map(window => [window.hash, window]));
    for (const window of windows) {
        if (!introduced.has(window.name)) continue;
        const target = index.get(window.hash);
        if (target) yield { line: window.functionLine, name: window.name, window, otherFile: other.file, other: target };
    }
}

export function matchPartialHelperOverlaps(edited: OverlapSource, siblings: readonly OverlapSource[], introduced: ReadonlySet<string>): PartialOverlapHit[] {
    const matches: PartialOverlapHit[] = [];
    const remaining = new Set(introduced);
    for (const other of siblings.slice(0, HELPER_OVERLAP_LIMITS.siblings)) {
        if (!unrelatedSibling(edited, other)) continue;
        for (const hit of matchingWindows(edited.windows, other, remaining)) {
            matches.push(hit);
            remaining.delete(hit.name);
            if (matches.length >= HELPER_OVERLAP_LIMITS.findings) return matches;
        }
    }
    return matches;
}

/** Sorted, shallow scan; parsing and normalization have independent per-file caps. */
export function collectSiblingOverlapSources(file: string, analyze = analyzeHelperOverlap): OverlapSource[] {
    const sources: OverlapSource[] = [];
    try {
        for (const name of readdirSync(dirname(file)).sort()) {
            if (sources.length >= HELPER_OVERLAP_LIMITS.siblings) break;
            const path = join(dirname(file), name);
            if (path === file || !JS_TS_EXTS.has(getExtension(path)) || isTestFile(path)) continue;
            try {
                if (!statSync(path).isFile() || statSync(path).size > HELPER_OVERLAP_LIMITS.bytes) continue;
                sources.push(analyze(readFileSync(path, "utf8"), path));
            } catch (error) { /* A missing sibling must not interrupt an edit. */ void error; }
        }
    } catch (error) { /* An unreadable directory has no available candidates. */ void error; }
    return sources;
}

interface OverlapContext {
    ts: typeof import("typescript"); file: string; source: ts.SourceFile;
    checker: ts.TypeChecker; out: OverlapSource; spend: () => boolean;
}

function externalIdentity(ts: typeof import("typescript"), file: string, source: ts.SourceFile, symbol: ts.Symbol | undefined, spelling: string): string {
    const declaration = symbol?.declarations?.[0];
    if (declaration === undefined) return `unresolved:${spelling}`;
    let ancestor: ts.Node | undefined = declaration;
    while (ancestor !== undefined && !ts.isImportDeclaration(ancestor)) ancestor = ancestor.parent;
    if (ancestor !== undefined && ts.isImportDeclaration(ancestor) && ts.isStringLiteralLike(ancestor.moduleSpecifier)) {
        const specifier = ancestor.moduleSpecifier.text;
        const module = specifier.startsWith(".") ? resolve(dirname(file), specifier).replace(/\.[cm]?[jt]sx?$/, "") : specifier;
        const imported = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text
            : ts.isNamespaceImport(declaration) ? "*" : "default";
        return `import:${module}:${imported}`;
    }
    return `module:${resolve(file)}:${declaration.getStart(source)}:${spelling}`;
}

function normalizeOverlapStatements(context: OverlapContext, parent: BodyFunction, statements: readonly ts.Statement[]): string | undefined {
    const { ts, source, checker, out, spend, file } = context;
    const parentStart = parent.getStart(source);
    const identities = new Map<ts.Symbol, number>();
    const tokens: string[] = [];
    function recordIdentifier(node: ts.Identifier): void {
        const key = `P${JSON.stringify(node.text)}`;
        if (propertyName(ts, node)) {
            tokens.push(key);
            return;
        }
        const owner = node.parent;
        const shorthand = ts.isShorthandPropertyAssignment(owner);
        const binding = ts.isBindingElement(owner) && owner.name === node
            && owner.propertyName === undefined && ts.isObjectBindingPattern(owner.parent);
        if (shorthand || binding) tokens.push(key);
        const symbol = shorthand ? checker.getShorthandAssignmentValueSymbol(owner) : checker.getSymbolAtLocation(node);
        if (symbol?.declarations?.some(decl => decl.getStart(source) >= parentStart && decl.end <= parent.end)) {
            if (!identities.has(symbol)) identities.set(symbol, identities.size);
            tokens.push(`I${identities.get(symbol)}`);
        } else {
            tokens.push(`G${JSON.stringify(externalIdentity(ts, file, source, symbol, node.text))}`);
        }
    }
    function visit(node: ts.Node): void {
        if (!spend()) return;
        tokens.push(`K${node.kind}`);
        if (ts.isIdentifier(node)) {
            recordIdentifier(node);
        } else if (ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)
            || ts.isBigIntLiteral(node) || ts.isRegularExpressionLiteral(node)
            || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) tokens.push(`L${JSON.stringify(node.text)}`);
        ts.forEachChild(node, visit);
        tokens.push("/");
    }
    statements.forEach(visit);
    return out.truncated ? undefined : tokens.join("|");
}

function collectOverlapFunctions(context: OverlapContext): BodyFunction[] {
    const { ts, source, out, spend, file } = context;
    const functions: BodyFunction[] = [];
    function collect(node: ts.Node): void {
        if (!spend()) return;
        if (isBodyFunction(ts, node)) {
            const name = functionName(ts, node, source);
            if (name !== undefined) {
                functions.push(node);
                out.functions.push({ name, start: node.getStart(source), end: node.end,
                    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
            }
        }
        let specifier: ts.Expression | undefined;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || ts.isIdentifier(node.expression) && node.expression.text === "require")) specifier = node.arguments[0];
        if (specifier !== undefined && ts.isStringLiteralLike(specifier)) out.imports.push(...importTargets(file, specifier.text));
        ts.forEachChild(node, collect);
    }
    collect(source);
    return functions;
}

function collectOverlapWindows(context: OverlapContext, parent: BodyFunction): void {
    const { ts, source, out, spend } = context;
    const selectedName = functionName(ts, parent, source);
    if (selectedName === undefined) return;
    const name = selectedName;
    const functionLine = source.getLineAndCharacterOfPosition(parent.getStart(source)).line + 1;
    function recordWindows(statements: readonly ts.Statement[]): void {
        for (let i = 0; i + HELPER_OVERLAP_LIMITS.statements <= statements.length; i++) {
            if (out.windows.length >= HELPER_OVERLAP_LIMITS.windows) { out.truncated = true; return; }
            const window = statements.slice(i, i + HELPER_OVERLAP_LIMITS.statements);
            const first = window[0];
            const last = window.at(-1);
            if (first === undefined || last === undefined) continue;
            const start = first.getStart(source);
            const end = last.end;
            if (jumpsOutside(ts, window, start, end, spend)) continue;
            const normalized = normalizeOverlapStatements(context, parent, window);
            if (normalized === undefined) return;
            out.windows.push({ hash: createHash("sha256").update(normalized).digest("hex"), name, functionLine,
                line: source.getLineAndCharacterOfPosition(start).line + 1,
                endLine: source.getLineAndCharacterOfPosition(end).line + 1, start, end });
        }
    }
    function lists(node: ts.Node): void {
        if (out.truncated || node !== parent && isBodyFunction(ts, node)) return;
        if (!spend()) return;
        if (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) recordWindows(node.statements);
        ts.forEachChild(node, lists);
    }
    lists(parent);
}
