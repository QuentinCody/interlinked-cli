import { resolve } from "node:path";
import type * as TS from "typescript";
import { emptyReading, qualityFinding, ratioReading } from "./adapter-values.js";
import type { AdapterResult, InventoryFile, QualityFinding, RepositoryInventory } from "./measurement-types.js";
import { createTypedMeasurementProgram, type TypedMeasurementProgram } from "./typed-program.js";
import { uncheckedTypeAssertion, unsafeTypedBoundary } from "./typed-boundaries.js";

// Missing bindings can become compiler error-types that behave like any. They
// cannot establish a measured unsafe-operation rate for the intended program.
const UNRESOLVED_BINDINGS = new Set([2304, 2307, 2311, 2503, 2552, 2580, 2581, 2582, 2583, 2584, 2591, 2592, 2593, 2688, 6053, 7016]);

function receiver(node: TS.Node, ts: typeof TS): TS.Node | null {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return node.expression;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) return node.expression;
    return null;
}

function unsafeOperation(node: TS.Node, context: TypedMeasurementProgram, checker: TS.TypeChecker): string | null {
    const { ts } = context;
    if (uncheckedTypeAssertion(node, ts, checker)) return "Unchecked type assertion";
    if (ts.isNonNullExpression(node)) return "Unchecked non-null assertion";
    const value = receiver(node, ts);
    if (!value) return null;
    const flags = checker.getTypeAtLocation(value).flags;
    if (flags & ts.TypeFlags.Any) return "Operation on an any-typed receiver";
    if (flags & ts.TypeFlags.Unknown) return "Operation on unknown without successful narrowing";
    return null;
}

function measuredOperation(node: TS.Node, context: TypedMeasurementProgram, checker: TS.TypeChecker): { opportunity: boolean; reason: string | null } {
    const boundary = unsafeTypedBoundary(node, context.ts, checker);
    const reason = unsafeOperation(node, context, checker) ?? (boundary.unsafe ? "Unvalidated any/unknown crosses a typed argument, assignment or return boundary" : null);
    return { opportunity: !!reason || !!receiver(node, context.ts) || boundary.opportunity, reason };
}

interface TypedFileReading { operations: number; findings: QualityFinding[]; explicitAnyTypes: number; explicitUnknownTypes: number; }
function inspectTypedFile(file: InventoryFile, source: TS.SourceFile, context: TypedMeasurementProgram): TypedFileReading {
    const checker = context.program.getTypeChecker();
    let operations = 0, explicitAnyTypes = 0, explicitUnknownTypes = 0;
    const findings: QualityFinding[] = [];
    function visit(node: TS.Node): void {
        if (node.kind === context.ts.SyntaxKind.AnyKeyword) explicitAnyTypes++;
        if (node.kind === context.ts.SyntaxKind.UnknownKeyword) explicitUnknownTypes++;
        const { opportunity, reason } = measuredOperation(node, context, checker);
        if (opportunity) operations++;
        if (reason) findings.push(qualityFinding({ metric: "types.unsafe", file,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, message: reason }));
        context.ts.forEachChild(node, visit);
    }
    visit(source);
    return { operations, findings, explicitAnyTypes, explicitUnknownTypes };
}

export function measureTypeSoundness(inventory: RepositoryInventory): AdapterResult {
    const files = inventory.files.filter(file => file.role === "product" && file.language === "typescript");
    if (!files.length) return { metrics: [emptyReading("types.unsafe", "not-applicable", 0, "No TypeScript product files")], findings: [] };
    const context = createTypedMeasurementProgram(inventory);
    if (!context) return { metrics: [emptyReading("types.unsafe", "unsupported", files.length, "TypeScript compiler unavailable")], findings: [] };
    const findings: QualityFinding[] = [], issues = [...context.issues];
    let operations = 0, explicitAnyTypes = 0, explicitUnknownTypes = 0;
    for (const file of files) {
        const source = context.program.getSourceFile(resolve(inventory.root, file.path));
        if (!source) { issues.push(`No typed source for ${file.path}`); continue; }
        const result = inspectTypedFile(file, source, context);
        findings.push(...result.findings); operations += result.operations;
        explicitAnyTypes += result.explicitAnyTypes; explicitUnknownTypes += result.explicitUnknownTypes;
    }
    const unresolved = context.program.getSemanticDiagnostics().filter(diagnostic => UNRESOLVED_BINDINGS.has(diagnostic.code));
    if (unresolved.length) issues.push(`${unresolved.length} unresolved type dependencies or bindings`);
    const metric = ratioReading("types.unsafe", findings.length, operations);
    metric.details = { explicitAnyTypes, explicitUnknownTypes, unsafeOperations: findings.length };
    if (issues.length) { metric.state = "inconclusive"; metric.limitations.push(...issues); }
    metric.limitations.push("unknown declarations are diagnostic only; this metric counts unsafe operations and unchecked assertions.");
    return { metrics: [metric], findings };
}
