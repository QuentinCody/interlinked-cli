// Shared syntax-only traversal for advisory test-quality checks. No type checker
// or code execution; optional TypeScript availability follows cyclomatic-ast.
import type * as TS from "typescript";
import { hasParseErrors, parseTsSource, type ParsedTsSource, type TsModule } from "./cyclomatic-ast.js";
import { getExtension, isTestFile, JS_TS_EXTS } from "./shared.js";

/** Parse supported test source; incomplete source and missing TypeScript have no verdict. */
export function parseTestQuality(content: string, filePath: string): ParsedTsSource | null {
    if (!isTestFile(filePath) || !JS_TS_EXTS.has(getExtension(filePath))) return null;
    const parsed = parseTsSource(content, filePath);
    return parsed && !hasParseErrors(parsed.sf) ? parsed : null;
}

/** Visit nodes in source order, pruning descendants when the callback returns false. */
export function walkTestNodes(ts: TsModule, node: TS.Node, visit: (node: TS.Node) => boolean | void): void {
    if (visit(node) === false) return;
    ts.forEachChild(node, (child) => walkTestNodes(ts, child, visit));
}

/** Root and modifiers of a call, including curried/tagged test.each declarations. */
export function testCallKind(ts: TsModule, expression: TS.Expression): { root: string; modifiers: string[] } | null {
    let current = expression;
    const modifiers: string[] = [];
    for (;;) {
        if (ts.isPropertyAccessExpression(current)) {
            modifiers.push(current.name.text);
            current = current.expression;
        } else if (ts.isCallExpression(current)) current = current.expression;
        else if (ts.isTaggedTemplateExpression(current)) current = current.tag;
        else break;
    }
    return ts.isIdentifier(current) ? { root: current.text, modifiers } : null;
}

/** A statically recognizable test or suite callback. */
export interface QualityBlock {
    call: TS.CallExpression;
    body: TS.ConciseBody;
    kind: "test" | "suite";
    modifiers: string[];
}

/** Gather callbacks, excluding skipped/conditional suites and all their descendants. */
export function qualityBlocks({ ts, sf }: ParsedTsSource): QualityBlock[] {
    const blocks: QualityBlock[] = [];
    walkTestNodes(ts, sf, (node): boolean | void => {
        if (!ts.isCallExpression(node)) return;
        const info = testCallKind(ts, node.expression);
        if (!info || !["it", "test", "specify", "describe", "suite"].includes(info.root)) return;
        if (info.modifiers.some((name) => ["skip", "todo", "skipIf", "runIf", "failing"].includes(name))) return false;
        const callback = node.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
        if (callback?.body) blocks.push({ call: node, body: callback.body, kind: ["describe", "suite"].includes(info.root) ? "suite" : "test", modifiers: info.modifiers });
    });
    return blocks;
}

function importClauseNames(ts: TsModule, clause: TS.ImportClause): string[] {
    const names = clause.name ? [clause.name.text] : [];
    const bindings = clause.namedBindings;
    if (!bindings) return names;
    if (ts.isNamespaceImport(bindings)) return [...names, bindings.name.text];
    return [...names, ...bindings.elements.filter((binding) => !binding.isTypeOnly).map((binding) => binding.name.text)];
}

/** Static local bindings of value imports (including namespace and default imports). */
export function qualityImportNames({ ts, sf }: ParsedTsSource): Set<string> {
    const names = new Set<string>();
    for (const statement of sf.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const clause = statement.importClause;
        if (!clause || clause.isTypeOnly) continue;
        for (const name of importClauseNames(ts, clause)) names.add(name);
    }
    return names;
}

/** Normalize only code trivia, preserving literal bytes and token boundaries. */
export function qualityTokenKey(ts: TsModule, text: string): string {
    const sf = ts.createSourceFile("key.ts", text, ts.ScriptTarget.Latest, true);
    const tokens: string[] = [];
    const visit = (node: TS.Node): void => {
        const children = node.getChildren(sf);
        if (children.length === 0) tokens.push(node.getText(sf));
        else for (const child of children) visit(child);
    };
    visit(sf);
    return JSON.stringify(tokens);
}
