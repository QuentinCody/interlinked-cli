import type * as TS from "typescript";

function expressions(node: TS.Node, ts: typeof TS): readonly TS.Expression[] {
    if (ts.isVariableDeclaration(node) && node.initializer) return [node.initializer];
    if (ts.isReturnStatement(node) && node.expression) return [node.expression];
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return [node.right];
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) return node.arguments ?? [];
    return [];
}
export function unsafeTypedBoundary(node: TS.Node, ts: typeof TS, checker: TS.TypeChecker): { opportunity: boolean; unsafe: boolean } {
    const sites = expressions(node, ts).filter(expression => checker.getContextualType(expression) !== undefined);
    const unsafe = sites.some(expression => {
        const target = checker.getContextualType(expression);
        if (!target || target.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return false;
        return (checker.getTypeAtLocation(expression).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    });
    return { opportunity: sites.length > 0, unsafe };
}
export function uncheckedTypeAssertion(node: TS.Node, ts: typeof TS, checker: TS.TypeChecker): boolean {
    if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) return false;
    if (node.type.getText(node.getSourceFile()) === "const") return false;
    const source = checker.getTypeAtLocation(node.expression), target = checker.getTypeAtLocation(node.type);
    if (target.flags & ts.TypeFlags.Unknown) return false;
    return !!(target.flags & ts.TypeFlags.Any) || !checker.isTypeAssignableTo(source, target) || !!(source.flags & ts.TypeFlags.Any);
}
