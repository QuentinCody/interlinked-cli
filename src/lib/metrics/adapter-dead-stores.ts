import type * as TS from "typescript";
import { parseTsSource, type ParsedTsSource } from "../../harness/checks/cyclomatic-ast.js";
import type { RepositoryAnalysis } from "./analysis.js";
import { qualityFinding, ratioReading } from "./adapter-values.js";
import type { AdapterResult, InventoryFile, QualityFinding } from "./measurement-types.js";

function literal(node: TS.Expression, { ts }: ParsedTsSource): boolean {
    return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword
        || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword;
}

function referencesName(node: TS.Node, name: string, parsed: ParsedTsSource): boolean {
    if (parsed.ts.isIdentifier(node) && node.text === name) return true;
    let found = false;
    parsed.ts.forEachChild(node, child => { if (referencesName(child, name, parsed)) found = true; });
    return found;
}

function overwrittenPair(first: TS.Statement, next: TS.Statement, parsed: ParsedTsSource): TS.VariableDeclaration | null {
    const { ts } = parsed;
    if (!ts.isVariableStatement(first) || first.declarationList.declarations.length !== 1 || !ts.isExpressionStatement(next)) return null;
    const declaration = first.declarationList.declarations[0];
    if (!declaration || !ts.isIdentifier(declaration.name) || !declaration.initializer || !literal(declaration.initializer, parsed)) return null;
    const expression = next.expression;
    if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
    if (!ts.isIdentifier(expression.left) || expression.left.text !== declaration.name.text) return null;
    if (referencesName(expression.right, declaration.name.text, parsed)) return null;
    return declaration;
}

function fileDeadStores(file: InventoryFile): { initializers: number; findings: QualityFinding[] } {
    const parsed = parseTsSource(file.content, file.path);
    const result: { initializers: number; findings: QualityFinding[] } = { initializers: 0, findings: [] };
    if (!parsed) return result;
    function visit(node: TS.Node): void {
        if (parsed?.ts.isVariableDeclaration(node) && node.initializer) result.initializers++;
        if (parsed?.ts.isBlock(node)) scanBlock(node, file, parsed, result.findings);
        parsed?.ts.forEachChild(node, visit);
    }
    visit(parsed.sf);
    return result;
}

function scanBlock(block: TS.Block, file: InventoryFile, parsed: ParsedTsSource, findings: QualityFinding[]): void {
    for (let index = 0; index + 1 < block.statements.length; index++) {
        const first = block.statements[index], next = block.statements[index + 1];
        if (!first || !next) continue;
        const declaration = overwrittenPair(first, next, parsed);
        if (declaration) findings.push(qualityFinding({ metric: "redundancy.dead_stores", file,
            line: parsed.sf.getLineAndCharacterOfPosition(declaration.getStart(parsed.sf)).line + 1,
            message: "Literal initializer is immediately overwritten before a direct read; review callbacks and exception paths before removal" }));
    }
}

export function measureDeadStores(analysis: RepositoryAnalysis): AdapterResult {
    const results = analysis.files.filter(file => file.input.role === "product").map(file => fileDeadStores(file.input));
    const findings = results.flatMap(result => result.findings);
    return { findings, metrics: [ratioReading("redundancy.dead_stores", findings.length, results.reduce((sum, result) => sum + result.initializers, 0))] };
}
