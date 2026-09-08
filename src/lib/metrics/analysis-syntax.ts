import type * as TS from "typescript";
import type { ParsedTsSource } from "../../harness/checks/cyclomatic-ast.js";

export interface SyntaxSpan { line: number; endLine: number; start: number; end: number; }
export interface ImportReference { specifier: string | null; line: number; names: string[]; typeOnly: boolean; }
export interface Declaration { name: string; line: number; exported: boolean; }
export interface SyntaxFacts {
    statements: SyntaxSpan[]; tests: SyntaxSpan[]; imports: ImportReference[];
    declarations: Declaration[]; identifiers: Map<string, number>; topLevelTokens: number;
}

export function syntaxSpan(node: TS.Node, parsed: ParsedTsSource): SyntaxSpan {
    const start = node.getStart(parsed.sf), end = node.getEnd();
    return { start, end, line: parsed.sf.getLineAndCharacterOfPosition(start).line + 1,
        endLine: parsed.sf.getLineAndCharacterOfPosition(end).line + 1 };
}

function testCall(node: TS.Node, { ts, sf }: ParsedTsSource): boolean {
    if (!ts.isCallExpression(node) || !node.arguments.some(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) return false;
    return /^(it|test)(\.(only|skip|todo|concurrent|each|fails|skipIf|runIf))*(\([\s\S]*\))?$/.test(node.expression.getText(sf));
}

function typeOnlyImport(node: TS.ImportDeclaration | TS.ExportDeclaration, ts: typeof TS): boolean {
    if (ts.isExportDeclaration(node) && node.isTypeOnly) return true;
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return true;
    if (ts.isImportDeclaration(node) && node.importClause?.name) return false;
    const clause = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
    if (!clause || !(ts.isNamedImports(clause) || ts.isNamedExports(clause))) return false;
    return clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly);
}

function staticImport(node: TS.ImportDeclaration | TS.ExportDeclaration, parsed: ParsedTsSource): ImportReference | null {
    const { ts } = parsed;
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return null;
    const clause = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
    const names = clause && (ts.isNamedImports(clause) || ts.isNamedExports(clause))
        ? clause.elements.map(element => (element.propertyName ?? element.name).text) : ["*"];
    if (ts.isImportDeclaration(node) && node.importClause?.name) names.push("*");
    const typeOnly = typeOnlyImport(node, ts);
    return { specifier: node.moduleSpecifier.text, line: syntaxSpan(node, parsed).line, names, typeOnly };
}

function importReference(node: TS.Node, parsed: ParsedTsSource): ImportReference | null {
    const { ts } = parsed;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return staticImport(node, parsed);
    if (!ts.isCallExpression(node)) return null;
    if (node.expression.kind !== ts.SyntaxKind.ImportKeyword && !(ts.isIdentifier(node.expression) && node.expression.text === "require")) return null;
    const argument = node.arguments[0];
    return { specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : null,
        line: syntaxSpan(node, parsed).line, names: ["*"], typeOnly: false };
}

function topDeclarations(parsed: ParsedTsSource): Declaration[] {
    const { ts, sf } = parsed;
    const out: Declaration[] = [];
    for (const node of sf.statements) {
        const exported = ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
        if (ts.isVariableStatement(node)) {
            for (const declaration of node.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) out.push({ name: declaration.name.text, exported, line: syntaxSpan(declaration, parsed).line });
            }
        } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
            out.push({ name: node.name.text, exported, line: syntaxSpan(node, parsed).line });
        }
    }
    return out;
}

function executableStatement(node: TS.Node, { ts }: ParsedTsSource): boolean {
    return ts.isStatement(node) && !ts.isBlock(node) && !ts.isEmptyStatement(node)
        && !ts.isFunctionDeclaration(node) && !ts.isClassDeclaration(node)
        && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)
        && !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node);
}

function writtenTokens(node: TS.Node, parsed: ParsedTsSource): number {
    if (parsed.ts.isFunctionLike(node) || parsed.ts.isTypeNode(node) || node.kind === parsed.ts.SyntaxKind.JSDocComment) return 0;
    const children = node.getChildren(parsed.sf);
    if (children.length === 0) return Number(node.kind <= parsed.ts.SyntaxKind.LastToken && node.getWidth(parsed.sf) > 0);
    return children.reduce((sum, child) => sum + writtenTokens(child, parsed), 0);
}

export function analyzeSyntax(parsed: ParsedTsSource): SyntaxFacts {
    const facts: SyntaxFacts = { statements: [], tests: [], imports: [], declarations: topDeclarations(parsed), identifiers: new Map(), topLevelTokens: 0 };
    function visit(node: TS.Node): void {
        if (executableStatement(node, parsed)) facts.statements.push(syntaxSpan(node, parsed));
        if (testCall(node, parsed)) facts.tests.push(syntaxSpan(node, parsed));
        const reference = importReference(node, parsed);
        if (reference) facts.imports.push(reference);
        if (parsed.ts.isIdentifier(node)) facts.identifiers.set(node.text, (facts.identifiers.get(node.text) ?? 0) + 1);
        parsed.ts.forEachChild(node, visit);
    }
    visit(parsed.sf);
    for (const node of parsed.sf.statements) {
        if (executableStatement(node, parsed) || parsed.ts.isClassDeclaration(node)) facts.topLevelTokens += writtenTokens(node, parsed);
    }
    return facts;
}
