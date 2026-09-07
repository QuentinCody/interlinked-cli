// CLASS: export existence smoke tests verify availability without exercising behavior.
// FIRES WHEN: every expect assertion in an active test checks a static value import
// (or namespace member) with toBeDefined, toBeTypeOf("function"), or typeof/function.
// DOES NOT FIRE: a returned value, local variable, negation, unknown assertion,
// behavioral assertion, shadowed binding, skipped suite, or type-only import.
// CALIBRATION (2026-09-07; no independent precision measurement):
// | pass | hits/files | corpus and correction |
// | prototype | 127/61 | earlier regex scope; over-counted locals |
// | AST | 13/11 | 2145 tracked tests; restricted to imported export references |
// Includes intentional compatibility tests and tracked structure fixtures.
// KNOWN GAPS: dynamic imports, require, aliased expect, and helper assertions are
// unresolved. Export availability may itself be a legitimate compatibility contract.
// HOW TO EXTEND: add a presence matcher in isPresenceAssertion plus P/N cases;
// preserve the import-binding restriction and wildcard ownership split.
import type * as TS from "typescript";
import type { ParsedTsSource, TsModule } from "./cyclomatic-ast.js";
import type { InlineMatch } from "./shared.js";
import { parseTestQuality, qualityBlocks, qualityImportNames, walkTestNodes } from "./test-quality-ast.js";

function isExportReference(ts: TsModule, node: TS.Expression, imports: Set<string>, namespaces: Set<string>): boolean {
    if (ts.isIdentifier(node)) return imports.has(node.text);
    if (!ts.isPropertyAccessExpression(node)) return false;
    let root = node.expression;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    return ts.isIdentifier(root) && namespaces.has(root.text);
}

function isString(ts: TsModule, node: TS.Node | undefined, value: string): boolean {
    return node !== undefined && ts.isStringLiteralLike(node) && node.text === value;
}

function presenceSubject(ts: TsModule, subject: TS.Expression, matcher: string, args: readonly TS.Expression[]): TS.Expression | null {
    if (matcher === "toBeDefined" && args.length === 0) return subject;
    if (matcher === "toBeTypeOf" && isString(ts, args[0], "function")) return subject;
    if (matcher !== "toBe") return null;
    if (ts.isTypeOfExpression(subject) && isString(ts, args[0], "function")) return subject.expression;
    if (!ts.isBinaryExpression(subject) || subject.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return null;
    if (!ts.isTypeOfExpression(subject.left) || !isString(ts, subject.right, "function")) return null;
    return args[0]?.kind === ts.SyntaxKind.TrueKeyword ? subject.left.expression : null;
}

function isPresenceAssertion(parsed: ParsedTsSource, call: TS.CallExpression, imports: Set<string>, namespaces: Set<string>): boolean {
    const { ts } = parsed;
    const subject = call.arguments[0];
    const member = call.parent;
    if (!subject || !ts.isPropertyAccessExpression(member) || member.expression !== call) return false;
    const matcher = member.parent;
    if (!ts.isCallExpression(matcher) || matcher.expression !== member) return false;
    const reference = presenceSubject(ts, subject, member.name.text, matcher.arguments);
    return reference !== null && isExportReference(ts, reference, imports, namespaces);
}

function namespaceImports({ ts, sf }: ParsedTsSource): Set<string> {
    const names = new Set<string>();
    for (const statement of sf.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    }
    return names;
}

function isSmokeBody(parsed: ParsedTsSource, body: TS.Node, imports: Set<string>, namespaces: Set<string>): boolean {
    const { ts } = parsed;
    let assertions = 0;
    let otherEvidence = false;
    walkTestNodes(ts, body, (node) => {
        if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && imports.has(node.name.getText())) otherEvidence = true;
        if (!ts.isCallExpression(node)) return;
        if (ts.isIdentifier(node.expression) && node.expression.text === "expect") {
            assertions++;
            if (!isPresenceAssertion(parsed, node, imports, namespaces)) otherEvidence = true;
        }
        if (node.expression.getText().startsWith("assert")) otherEvidence = true;
    });
    return assertions > 0 && !otherEvidence;
}

/** Report active tests whose assertions only check statically imported export existence. */
export function checkExportExistenceSmokeTest(content: string, filePath: string): InlineMatch[] {
    const parsed = parseTestQuality(content, filePath);
    if (!parsed) return [];
    const imports = qualityImportNames(parsed);
    const namespaces = namespaceImports(parsed);
    return qualityBlocks(parsed).filter((block) => block.kind === "test" && isSmokeBody(parsed, block.body, imports, namespaces))
        .slice(0, 10).map((block) => ({
            line: parsed.sf.getLineAndCharacterOfPosition(block.call.getStart(parsed.sf)).line + 1,
            text: "export_existence_smoke_test: assertions only check imported exports exist or are functions. Exercise a public behavior, or document export availability as the compatibility contract.",
        }));
}
