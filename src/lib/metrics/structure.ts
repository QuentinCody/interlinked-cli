import type * as TS from "typescript";
import { computeCyclomaticAst, parseTsSource, type ParsedTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { computeCognitiveAst } from "../../harness/checks/cognitive-ast.js";
import { computeMaintainability } from "../../harness/checks/maintainability.js";
import { countAstImplementations, hasExactSyntax, type AstImplementation, type DocumentationSpan } from "../../harness/function-tokens/ast-tokens.js";

export interface StructureFunction extends AstImplementation {
    cyclomatic: number;
    cognitive: number;
    difficulty: number;
    volume: number;
    maintainability: number;
}
export interface TypeDiagnostics { explicitAny: number; unknown: number; assertions: number; nonNullAssertions: number; }
export interface MeasuredStructure {
    state: "measured";
    typescriptVersion: string;
    astTokens: number;
    physicalLines: number;
    types: TypeDiagnostics;
    functions: StructureFunction[];
}
export type StructureMeasurement = MeasuredStructure | { state: "unavailable"; reason: string };

interface Span { line: number; endLine?: number; loc?: number; }
function spanKey(span: Span): string {
    return `${span.line}:${span.endLine ?? (span.line + (span.loc ?? 1) - 1)}`;
}

function spanReader<T extends Span>(rows: T[]): (span: Span) => T {
    const groups = new Map<string, T[]>();
    for (const row of rows) {
        const key = spanKey(row);
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
    }
    return (span) => {
        const row = groups.get(spanKey(span))?.shift();
        if (!row) throw new Error("Function populations disagree between AST collectors");
        return row;
    };
}

function typeDiagnostics(parsed: ParsedTsSource): TypeDiagnostics {
    const result = { explicitAny: 0, unknown: 0, assertions: 0, nonNullAssertions: 0 };
    const { ts, sf } = parsed;
    function visit(node: TS.Node): void {
        if (node.kind === ts.SyntaxKind.AnyKeyword) result.explicitAny++;
        if (node.kind === ts.SyntaxKind.UnknownKeyword) result.unknown++;
        if (ts.isNonNullExpression(node)) result.nonNullAssertions++;
        if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && node.type.getText(sf) !== "const") result.assertions++;
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return result;
}

function joinMeasurements(content: string, file: string, implementations: readonly AstImplementation[]): StructureFunction[] {
    const cc = computeCyclomaticAst(content, file);
    const cognitive = computeCognitiveAst(content, file);
    const maintainability = computeMaintainability(content, file, 0);
    if (!cc || !cognitive || !maintainability) throw new Error("A required AST collector is unavailable");
    if ([cc.length, cognitive.length, maintainability.length].some(count => count !== implementations.length)) {
        throw new Error("Function populations disagree between AST collectors");
    }
    const readCc = spanReader(cc), readCognitive = spanReader(cognitive), readMaintainability = spanReader(maintainability);
    return implementations.map(fn => {
        const halstead = readMaintainability(fn);
        return { ...fn, cyclomatic: readCc(fn).cyclomatic, cognitive: readCognitive(fn).cognitive,
            difficulty: halstead.halstead.difficulty, volume: halstead.halstead.volume, maintainability: halstead.maintainability };
    });
}

function withoutDocumentation(content: string, documentation: readonly DocumentationSpan[]): string {
    let cursor = 0;
    const parts: string[] = [];
    for (const span of documentation) {
        parts.push(content.slice(cursor, span.startOffset), content.slice(span.startOffset, span.endOffset).replace(/[^\r\n]/g, " "));
        cursor = span.endOffset;
    }
    return parts.join("") + content.slice(cursor);
}

/** No repository code is executed. Recovery trees are never certified as parsed source. */
export function measureStructure(content: string, file: string): StructureMeasurement {
    try {
        const parsed = parseTsSource(content, file);
        if (!parsed) return { state: "unavailable", reason: "TypeScript AST parser is unavailable" };
        if (!hasExactSyntax(parsed)) return { state: "unavailable", reason: "Source did not parse without recovery" };
        const tokens = countAstImplementations(parsed);
        const code = withoutDocumentation(content, tokens.documentation);
        return {
            state: "measured", typescriptVersion: parsed.ts.version, astTokens: tokens.astTokens,
            physicalLines: content.split(/\r?\n/).length - Number(content.endsWith("\n")),
            types: typeDiagnostics(parsed), functions: joinMeasurements(code, file, tokens.functions),
        };
    } catch (error) {
        return { state: "unavailable", reason: error instanceof Error ? error.message : "AST measurement failed" };
    }
}
