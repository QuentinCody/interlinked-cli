import type * as TS from "typescript";
import { loadCheckTypescript } from "../../harness/checks/check-typescript.js";
import type { CatalogueFinding } from "./catalogue-types.js";

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

export function checkUnreadConfigKeys(declarations: readonly ConfigDeclaration[], sources: readonly ConfigSource[]): {
    findings: CatalogueFinding[]; unavailable: number;
} {
    const compiler = loadCheckTypescript("unread_config_key", "configuration read analysis");
    if (!compiler) return { findings: [], unavailable: declarations.length };
    const ts = compiler;
    const reads = new Set<string>();
    const ambiguous = new Set<string>();
    let dynamic = false;
    for (const source of sources) {
        dynamic = collectConfigurationReads(ts, source, reads, ambiguous) || dynamic;
    }
    let unavailable = 0;
    const findings: CatalogueFinding[] = [];
    for (const declaration of declarations) {
        if (reads.has(declaration.key)) continue;
        if (dynamic || ambiguous.has(declaration.key)) { unavailable++; continue; }
        findings.push({ check: "unread_config_key", file: declaration.file, line: declaration.line,
            message: `No static source read found for configuration key ${declaration.path}.`, evidence: declaration.path });
    }
    return { findings, unavailable };
}

function collectConfigurationReads(ts: typeof TS, source: ConfigSource, reads: Set<string>, ambiguous: Set<string>): boolean {
    let dynamic = false;
    const sf = ts.createSourceFile(source.file, source.content, ts.ScriptTarget.Latest, true);
    function isWriteOnly(node: TS.Node): boolean {
        const parent = node.parent;
        return (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
            || ts.isDeleteExpression(parent);
    }
    function visit(node: TS.Node): void {
        if (ts.isTypeNode(node)) return;
        if (ts.isPropertyAccessExpression(node)) {
            if (!isWriteOnly(node)) reads.add(node.name.text);
        }
        if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
            const key = node.propertyName ?? node.name;
            if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) reads.add(key.text);
            if (node.dotDotDotToken) dynamic = true;
        }
        if (ts.isElementAccessExpression(node)) {
            const argument = node.argumentExpression;
            if (ts.isStringLiteralLike(argument)) {
                if (!isWriteOnly(node)) reads.add(argument.text);
            } else if (!isWriteOnly(node) && /config|rules|settings/i.test(node.expression.getText(sf))) dynamic = true;
        }
        if (ts.isStringLiteralLike(node) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
            && !(ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)) ambiguous.add(node.text);
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return dynamic;
}
