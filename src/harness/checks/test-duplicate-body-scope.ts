// Scope comparison for duplicate_test_body: all direct setup statements, including
// hooks after tests. Token normalization preserves whitespace inside literals.
import type * as TS from "typescript";
import { parseTsSource, type TsModule } from "./cyclomatic-ast.js";
import { qualityBlocks, qualityTokenKey, testCallKind } from "./test-quality-ast.js";

/** Describe callback extent in original source offsets. */
export interface DescribeRange { bodyStart: number; bodyEnd: number; }

/** Resolve actual suite callbacks, excluding string/comment lookalikes. */
export function findDescribeRanges(content: string): DescribeRange[] {
    const parsed = parseTsSource(content, "scope.test.ts");
    if (!parsed) return [];
    return qualityBlocks(parsed).filter((block) => block.kind === "suite").map((block) => ({
        bodyStart: block.body.getStart(parsed.sf), bodyEnd: block.body.end - 1,
    }));
}

/** Enclosing suites ordered from outermost to innermost. */
export function describeChainAt(offset: number, ranges: readonly DescribeRange[]): DescribeRange[] {
    return ranges.filter((range) => offset > range.bodyStart && offset < range.bodyEnd)
        .sort((a, b) => a.bodyStart - b.bodyStart);
}

function isTestDeclaration(ts: TsModule, statement: TS.Statement): boolean {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const kind = testCallKind(ts, statement.expression.expression);
    return kind !== null && ["it", "test", "specify", "describe", "suite"].includes(kind.root);
}

function setupText(ts: TsModule, statements: readonly TS.Statement[], sf: TS.SourceFile): string {
    return qualityTokenKey(ts, statements.filter((statement) => !isTestDeclaration(ts, statement))
        .map((statement) => statement.getText(sf)).join("\n"));
}

/** Scope offset to normalized setup text; -1 represents file scope. */
export type SetupMap = Map<number, string>;

/** Collect direct setup throughout each scope, excluding child test/suite bodies. */
export function collectSetupTexts(content: string): SetupMap {
    const parsed = parseTsSource(content, "scope.test.ts");
    if (!parsed) return new Map();
    const { ts, sf } = parsed;
    const result: SetupMap = new Map([[-1, setupText(ts, sf.statements, sf)]]);
    for (const block of qualityBlocks(parsed).filter((candidate) => candidate.kind === "suite")) {
        if (!ts.isBlock(block.body)) continue;
        result.set(block.body.getStart(sf), setupText(ts, block.body.statements, sf));
    }
    return result;
}

/** Compare setup at every lexical level; literal whitespace is significant. */
export function setupKeyAt(offset: number, ranges: readonly DescribeRange[], setupMap: SetupMap): string {
    const parts = [setupMap.get(-1) ?? ""];
    for (const scope of describeChainAt(offset, ranges)) parts.push(setupMap.get(scope.bodyStart) ?? "");
    return JSON.stringify(parts);
}
