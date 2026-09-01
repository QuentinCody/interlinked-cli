import { extname } from "node:path";
import type * as TS from "typescript";
import {
    functionName,
    isFunctionLike,
    isImplementationFunction,
    parseTsSource,
    type TsModule,
} from "../checks/cyclomatic-ast.js";
import type {
    FunctionDeclarationKind,
    FunctionTokenEntry,
} from "./types.js";

const JSX_EXTENSIONS = new Set([".jsx", ".tsx"]);

function declarationKind(ts: TsModule, node: TS.Node): FunctionDeclarationKind {
    if (ts.isConstructorDeclaration(node)) return "constructor";
    if (ts.isGetAccessorDeclaration(node)) return "getter";
    if (ts.isSetAccessorDeclaration(node)) return "setter";
    if (ts.isMethodDeclaration(node)) return "method";
    if (ts.isArrowFunction(node)) return "lambda";
    if (ts.isFunctionExpression(node)) return "closure";
    return "function";
}

// SAFETY: TS's own `Node.parent` field is typed `Node` (non-optional) for
// convenience, but is actually `undefined` once a walk reaches the root
// SourceFile node. This function's honest return type restores that for
// every caller without needing a per-call-site assertion.
function parentOf(node: TS.Node): TS.Node | undefined {
    return node.parent;
}

function namedContainer(ts: TsModule, node: TS.Node, sf: TS.SourceFile): string | null {
    if (isFunctionLike(ts, node)) return functionName(ts, node, sf);
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        return node.name?.getText(sf) ?? "(anonymous class)";
    }
    if (ts.isModuleDeclaration(node)) return node.name.getText(sf);
    return null;
}

function qualifiedName(ts: TsModule, node: TS.Node, sf: TS.SourceFile): string {
    const segments: string[] = [];
    let current: TS.Node | undefined = node;
    while (current) {
        const name = namedContainer(ts, current, sf);
        if (name) segments.push(name);
        current = parentOf(current);
    }
    return segments.reverse().join(".");
}

function countCanonicalTokens(
    ts: TsModule,
    source: string,
    filePath: string,
    start: number,
    end: number,
): number {
    const variant = JSX_EXTENSIONS.has(extname(filePath).toLowerCase())
        ? ts.LanguageVariant.JSX
        : ts.LanguageVariant.Standard;
    const scanner = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        variant,
        source.slice(start, end),
    );
    let count = 0;
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) count++;
    return count;
}

function finalizeIdentity(entries: FunctionTokenEntry[]): void {
    const counts = new Map<string, number>();
    for (const entry of entries) {
        counts.set(entry.qualifiedName, (counts.get(entry.qualifiedName) ?? 0) + 1);
    }
    for (const entry of entries) {
        if (entry.name === "(callback)") entry.identityKind = "anonymous";
        else if ((counts.get(entry.qualifiedName) ?? 0) > 1) entry.identityKind = "colliding";
    }
}

export function computeTypeScriptFunctionTokens(
    content: string,
    filePath: string,
): FunctionTokenEntry[] | null {
    const parsed = parseTsSource(content, filePath);
    if (!parsed) return null;
    const { ts, sf } = parsed;
    const entries: FunctionTokenEntry[] = [];
    const walk = (node: TS.Node): void => {
        if (isImplementationFunction(ts, node)) {
            const startOffset = node.getStart(sf, false);
            const endOffset = node.getEnd();
            const start = sf.getLineAndCharacterOfPosition(startOffset);
            const end = sf.getLineAndCharacterOfPosition(endOffset);
            entries.push({
                name: functionName(ts, node, sf),
                qualifiedName: qualifiedName(ts, node, sf),
                declarationKind: declarationKind(ts, node),
                language: "typescript",
                startOffset,
                endOffset,
                line: start.line + 1,
                endLine: end.line + 1,
                canonicalTokens: countCanonicalTokens(ts, content, filePath, startOffset, endOffset),
                identityKind: "named",
            });
        }
        ts.forEachChild(node, walk);
    };
    walk(sf);
    entries.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
    finalizeIdentity(entries);
    return entries;
}
