import type * as TS from "typescript";
import { loadCheckTypescript } from "../../harness/checks/check-typescript.js";
import type { CatalogueFinding, CatalogueInputGap } from "./catalogue-types.js";

export interface ConfigDeclaration { key: string; path: string; file: string; line: number; }
export interface ConfigSource { file: string; content: string; }

/** Leaf keys from named default configuration objects; values are never emitted. */
export function configDefaults(source: ConfigSource, ts: typeof TS): ConfigDeclaration[] {
    const sf = ts.createSourceFile(source.file, source.content, ts.ScriptTarget.Latest, true);
    const declarations: ConfigDeclaration[] = [];
    function object(node: TS.ObjectLiteralExpression, prefix: string): void {
        for (const property of node.properties) {
            if (!ts.isPropertyAssignment(property) || !property.name || ts.isComputedPropertyName(property.name)) continue;
            const key = property.name.getText(sf).replace(/^['"]|['"]$/g, "");
            const path = prefix ? `${prefix}.${key}` : key;
            if (ts.isObjectLiteralExpression(property.initializer)) object(property.initializer, path);
            else declarations.push({ key, path, file: source.file, line: sf.getLineAndCharacterOfPosition(property.getStart(sf)).line + 1 });
        }
    }
    function visit(node: TS.Node): void {
        if (ts.isVariableDeclaration(node) && /^(?:DEFAULT_.*CONFIG|DEFAULT_CONFIG)$/.test(node.name.getText(sf))) {
            let value = node.initializer;
            while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value))) value = value.expression;
            if (value && ts.isObjectLiteralExpression(value)) object(value, "");
        }
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return declarations;
}

/** JSON configuration examples require an explicit config-file context. */
export function documentedConfigKeys(source: ConfigSource): ConfigDeclaration[] {
    const out: ConfigDeclaration[] = [];
    const pattern = /```json\s*\n([\s\S]*?)\n```/g;
    for (const match of source.content.matchAll(pattern)) {
        const context = source.content.slice(Math.max(0, match.index - 500), match.index);
        if (!/(?:guard-rules|semantic|config)(?:\.local)?\.json/.test(context)) continue;
        let value: unknown;
        try { value = JSON.parse(match[1] ?? ""); } catch { continue; }
        const base = source.content.slice(0, match.index).split("\n").length;
        function walk(item: unknown, prefix: string): void {
            if (!item || typeof item !== "object" || Array.isArray(item)) return;
            for (const [key, child] of Object.entries(item)) {
                const path = prefix ? `${prefix}.${key}` : key;
                if (child && typeof child === "object" && !Array.isArray(child)) walk(child, path);
                else {
                    const row = (match[1] ?? "").split("\n").findIndex(line => line.includes(JSON.stringify(key) + ":"));
                    out.push({ key, path, file: source.file, line: base + 1 + Math.max(0, row) });
                }
            }
        }
        walk(value, "");
    }
    return out;
}

function declarationGap(declaration: ConfigDeclaration, reason: string): CatalogueInputGap {
    return { file: declaration.file, line: declaration.line, key: declaration.path, reason };
}

export function checkUnreadConfigKeys(declarations: readonly ConfigDeclaration[], sources: readonly ConfigSource[], incompleteSource?: string): {
    findings: CatalogueFinding[]; unavailable: number; unavailable_inputs: CatalogueInputGap[];
} {
    const compiler = loadCheckTypescript("unread_config_key", "configuration read analysis");
    if (!compiler) return { findings: [], unavailable: declarations.length, unavailable_inputs: declarations.map(declaration => declarationGap(declaration, "TypeScript parser unavailable for configuration reads.")) };
    const ts = compiler;
    const reads = new Set<string>();
    const ambiguous = new Map<string, string>();
    const declaredKeys = new Set(declarations.map(declaration => declaration.key));
    let dynamicSource: string | undefined;
    for (const source of sources) {
        const dynamic = collectConfigurationReads(ts, source, reads, ambiguous, declaredKeys);
        dynamicSource ??= dynamic;
    }
    const gaps: CatalogueInputGap[] = [];
    const findings: CatalogueFinding[] = [];
    for (const declaration of declarations) {
        if (reads.has(declaration.key)) continue;
        const literal = ambiguous.get(declaration.key);
        const reason = literal ? `Matching string literal at ${literal} could be a runtime key.`
            : dynamicSource ? `Dynamic access at ${dynamicSource} prevents a complete static inventory of configuration reads.`
            : incompleteSource ? `Configuration reads could not be examined in ${incompleteSource}.` : undefined;
        if (reason) { gaps.push(declarationGap(declaration, reason)); continue; }
        findings.push({ check: "unread_config_key", file: declaration.file, line: declaration.line,
            message: `No static source read found for configuration key ${declaration.path}.`, evidence: declaration.path });
    }
    return { findings, unavailable: gaps.length, unavailable_inputs: gaps };
}

function writeOnlyAccess(ts: typeof TS, node: TS.Node): boolean {
    const parent = node.parent;
    return (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        || ts.isDeleteExpression(parent);
}

function literalUsedAsValue(ts: typeof TS, literal: TS.StringLiteralLike): boolean {
    const parent = literal.parent;
    if (ts.isPropertyAssignment(parent)) return parent.name !== literal;
    if (ts.isElementAccessExpression(parent)) return parent.argumentExpression !== literal;
    return true;
}

function collectConfigurationReads(ts: typeof TS, source: ConfigSource, reads: Set<string>, ambiguous: Map<string, string>, declaredKeys: ReadonlySet<string>): string | undefined {
    let dynamic: string | undefined;
    const sf = ts.createSourceFile(source.file, source.content, ts.ScriptTarget.Latest, true);
    const location = (node: TS.Node) => `${source.file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
    function recordBinding(node: TS.BindingElement): void {
        if (!ts.isObjectBindingPattern(node.parent)) return;
        const key = node.propertyName ?? node.name;
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) reads.add(key.text);
        if (node.dotDotDotToken) dynamic ??= location(node);
    }
    function recordAccess(node: TS.ElementAccessExpression | TS.PropertyAccessExpression): void {
        if (writeOnlyAccess(ts, node)) return;
        if (ts.isPropertyAccessExpression(node)) reads.add(node.name.text);
        else if (ts.isStringLiteralLike(node.argumentExpression)) reads.add(node.argumentExpression.text);
        else if (/config|rules|settings/i.test(node.expression.getText(sf))) dynamic ??= location(node);
    }
    function visit(node: TS.Node): void {
        if (ts.isTypeNode(node)) return;
        if (ts.isBindingElement(node)) recordBinding(node);
        else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) recordAccess(node);
        else if (ts.isStringLiteralLike(node) && declaredKeys.has(node.text) && !ambiguous.has(node.text) && literalUsedAsValue(ts, node)) ambiguous.set(node.text, location(node));
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return dynamic;
}
