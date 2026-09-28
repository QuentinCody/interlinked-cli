import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type * as TS from "typescript";
import { isJsonObject } from "../../lib/json-types.js";
import { LINT_DETECTORS } from "../../lib/lint-import/catalog.js";
import type { InlineMatch } from "../check-registry/types.js";
import { hasExactSyntax } from "../function-tokens/ast-tokens.js";
import { functionName, isFunctionLike, parseTsSource, type ParsedTsSource } from "./cyclomatic-ast.js";

export const EXPRESSION_COUNTER = "interlinked-expression-v1";
export interface ExpressionLimits {
    expressionTokens: number;
    callbackDepth: number;
    callbackCount: number;
    controlFlowDepth: number;
}
export const DEFAULT_EXPRESSION_LIMITS: Readonly<ExpressionLimits> = Object.freeze({
    expressionTokens: 60, callbackDepth: 2, callbackCount: 3, controlFlowDepth: 3,
});
export interface ExpressionMeasurement {
    owner: string;
    startOffset: number;
    endOffset: number;
    line: number;
    endLine: number;
    label: string;
    boundary: "initializer" | "assignment" | "return" | "condition" | "argument" | "statement";
    syntaxTokens: number;
    inlineCallbacks: number;
    maxCallbackDepth: number;
    classification: "literal-data" | "computation";
    conditionalDepth: number;
}
export interface ExpressionFinding {
    owner: string;
    value: number;
    check: string;
    line: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
    label: string;
    text: string;
}
export interface ExpressionAnalysis {
    counter: typeof EXPRESSION_COUNTER;
    status: "measured" | "unsupported" | "unavailable";
    reason?: string;
    expressions: ExpressionMeasurement[];
    structural: ExpressionFinding[];
}
interface Stats { tokens: number; callbacks: number; depth: number; conditional: number; }
interface AnalysisContext { parsed: ParsedTsSource; stats: WeakMap<TS.Node, Stats>; }
type Boundary = Pick<ExpressionMeasurement, "boundary" | "label">;
const statsBySource = new WeakMap<TS.SourceFile, WeakMap<TS.Node, Stats>>();
const reportsBySource = new WeakMap<TS.SourceFile, Map<string, ExpressionAnalysis>>();

function transparent(node: TS.Node, parsed: ParsedTsSource): TS.Node {
    const { ts } = parsed;
    let current = node;
    while (current.parent && (ts.isParenthesizedExpression(current.parent) ||
        ts.isAsExpression(current.parent) || ts.isNonNullExpression(current.parent) ||
        ts.isSatisfiesExpression(current.parent))) current = current.parent;
    return current;
}

function inlineCallback(node: TS.Node, parsed: ParsedTsSource): boolean {
    const { ts } = parsed;
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
    const wrapped = transparent(node, parsed);
    const parent = wrapped.parent;
    return !!parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
        !!parent.arguments?.some(argument => argument === wrapped);
}

function collectStats(node: TS.Node, context: AnalysisContext): Stats {
    const { ts, sf } = context.parsed;
    const result: Stats = { tokens: 0, callbacks: 0, depth: 0, conditional: 0 };
    if (node.kind === ts.SyntaxKind.JSDocComment) return result;
    const children = node.getChildren(sf);
    if (children.length === 0 && node.kind <= ts.SyntaxKind.LastToken && node.getWidth(sf) > 0) result.tokens = 1;
    for (const child of children) {
        const stats = collectStats(child, context);
        result.tokens += stats.tokens;
        result.callbacks += stats.callbacks;
        result.depth = Math.max(result.depth, stats.depth);
        result.conditional = Math.max(result.conditional, stats.conditional);
    }
    if (ts.isConditionalExpression(node)) result.conditional += 1;
    if (inlineCallback(node, context.parsed)) {
        result.callbacks += 1;
        result.depth += 1;
    } else if (isFunctionLike(ts, node)) {
        result.callbacks = 0;
        result.depth = 0;
    }
    if (isFunctionLike(ts, node)) result.conditional = 0;
    context.stats.set(node, result);
    return result;
}

function literalData(node: TS.Node, parsed: ParsedTsSource): boolean {
    const { ts } = parsed;
    if (ts.isLiteralExpression(node) || node.kind === ts.SyntaxKind.TrueKeyword ||
        node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literalData(node.expression, parsed);
    if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.MinusToken ||
        node.operator === ts.SyntaxKind.PlusToken)) return ts.isNumericLiteral(node.operand);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(item => literalData(item, parsed));
    if (!ts.isObjectLiteralExpression(node)) return false;
    return node.properties.every(property => ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) && literalData(property.initializer, parsed));
}

function valueBoundary(node: TS.Node, parent: TS.Node, parsed: ParsedTsSource): Boundary | null {
    const { ts, sf } = parsed;
    if ((ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === node) {
        return { boundary: "initializer", label: parent.name.getText(sf) };
    }
    if (ts.isReturnStatement(parent) || ts.isThrowStatement(parent) || ts.isArrowFunction(parent)) {
        return { boundary: "return", label: "returned expression" };
    }
    if (ts.isBinaryExpression(parent) && parent.right === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return { boundary: "assignment", label: parent.left.getText(sf) };
    }
    return null;
}

function executionBoundary(node: TS.Node, parent: TS.Node, parsed: ParsedTsSource): Boundary | null {
    const { ts, sf } = parsed;
    if ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent) ||
        ts.isSwitchStatement(parent)) && parent.expression === node) return { boundary: "condition", label: "condition" };
    if (ts.isForStatement(parent) && parent.condition === node) return { boundary: "condition", label: "loop condition" };
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.some(argument => argument === node)) {
        return { boundary: "argument", label: `${parent.expression.getText(sf).slice(0, 80)} argument` };
    }
    return null;
}

function boundary(node: TS.Node, parsed: ParsedTsSource): Boundary | null {
    if (!parsed.ts.isExpression(node) || isFunctionLike(parsed.ts, node) || !node.parent) return null;
    if (parsed.ts.isExpressionStatement(node.parent)) {
        // Test registration scopes are not a production computation budget. Their bodies
        // are still walked, including expressions with nested collection callbacks.
        const testFile = /(?:^|[/.])(?:__tests__|tests?|spec)(?:[/.]|$)/.test(parsed.sf.fileName);
        const registration = parsed.ts.isCallExpression(node) && /^(?:describe|it|test|beforeEach|afterEach|beforeAll|afterAll)(?:[.(]|$)/.test(node.expression.getText(parsed.sf));
        if (testFile && registration) return null;
        return { boundary: "statement", label: "expression statement" };
    }
    return valueBoundary(node, node.parent, parsed) ?? executionBoundary(node, node.parent, parsed);
}

function measure(node: TS.Node, selected: Boundary, context: AnalysisContext): ExpressionMeasurement {
    const { sf } = context.parsed;
    const stats = context.stats.get(node);
    if (!stats) throw new Error("Expression statistics missing from parsed source");
    const startOffset = node.getStart(sf);
    const endOffset = node.getEnd();
    return {
        ...selected, startOffset, endOffset, owner: expressionOwner(node, context.parsed),
        line: sf.getLineAndCharacterOfPosition(startOffset).line + 1,
        endLine: sf.getLineAndCharacterOfPosition(endOffset).line + 1,
        syntaxTokens: stats.tokens, inlineCallbacks: stats.callbacks, maxCallbackDepth: stats.depth,
        conditionalDepth: stats.conditional,
        classification: literalData(node, context.parsed) ? "literal-data" : "computation",
    };
}

function controlNode(node: TS.Node, parsed: ParsedTsSource): boolean {
    const { ts } = parsed;
    return ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) ||
        ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ||
        ts.isSwitchStatement(node) || ts.isCatchClause(node);
}

function structuralFinding(node: TS.Node, parsed: ParsedTsSource, check: string, text: string): ExpressionFinding {
    const startOffset = node.getStart(parsed.sf);
    const endOffset = node.getEnd();
    return { check, text, label: "control flow", startOffset, endOffset, owner: expressionOwner(node, parsed), value: 1,
        line: parsed.sf.getLineAndCharacterOfPosition(startOffset).line + 1,
        endLine: parsed.sf.getLineAndCharacterOfPosition(endOffset).line + 1 };
}

function collectStructure(node: TS.Node, depth: number, parsed: ParsedTsSource, limits: ExpressionLimits, out: ExpressionFinding[]): void {
    const { ts } = parsed;
    const base = isFunctionLike(ts, node) ? 0 : depth;
    const elseIf = ts.isIfStatement(node) && node.parent && ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
    const next = base + (controlNode(node, parsed) && !elseIf ? 1 : 0);
    if (next > limits.controlFlowDepth && base <= limits.controlFlowDepth) {
        const finding = structuralFinding(node, parsed, "control_flow_depth", `control-flow depth ${next} > ${limits.controlFlowDepth}`);
        finding.value = next;
        out.push(finding);
    } else if (next > limits.controlFlowDepth) {
        const owner = expressionOwner(node, parsed);
        const containing = out.find(finding => finding.owner === owner && finding.startOffset <= node.getStart(parsed.sf) && finding.endOffset >= node.getEnd());
        if (containing && next > containing.value) {
            containing.value = next;
            containing.text = `control-flow depth ${next} > ${limits.controlFlowDepth}`;
        }
    }
    ts.forEachChild(node, child => collectStructure(child, next, parsed, limits, out));
}

/** Versioned syntax measurements. Recovery trees never certify a clean expression population. */
export function analyzeExpressions(content: string, filePath: string, overrides: Partial<ExpressionLimits> = {}): ExpressionAnalysis {
    const base: Pick<ExpressionAnalysis, "counter" | "expressions" | "structural"> = { counter: EXPRESSION_COUNTER, expressions: [], structural: [] };
    if (!/\.[cm]?[jt]sx?$/i.test(filePath)) return { ...base, status: "unsupported", reason: "Expression adapter supports JavaScript and TypeScript" };
    const parsed = parseTsSource(content, filePath);
    if (!parsed || !hasExactSyntax(parsed)) return { ...base, status: "unavailable", reason: "Exact TypeScript parser result unavailable" };
    const limits = { ...DEFAULT_EXPRESSION_LIMITS, ...overrides };
    const policyKey = JSON.stringify(limits);
    const cachedReports = reportsBySource.get(parsed.sf) ?? new Map<string, ExpressionAnalysis>();
    const cachedReport = cachedReports.get(policyKey);
    if (cachedReport) return cachedReport;
    const cached = statsBySource.get(parsed.sf);
    const context: AnalysisContext = { parsed, stats: cached ?? new WeakMap() };
    if (!cached) {
        collectStats(parsed.sf, context);
        statsBySource.set(parsed.sf, context.stats);
    }
    const expressions: ExpressionMeasurement[] = [];
    const walk = (node: TS.Node): void => {
        const selected = boundary(node, parsed);
        if (selected) expressions.push(measure(node, selected, context));
        parsed.ts.forEachChild(node, walk);
    };
    walk(parsed.sf);
    const structural: ExpressionFinding[] = [];
    collectStructure(parsed.sf, 0, parsed, limits, structural);
    collectPresentation(parsed.sf, parsed, structural);
    const report: ExpressionAnalysis = { counter: EXPRESSION_COUNTER, status: "measured", expressions, structural };
    cachedReports.set(policyKey, report);
    reportsBySource.set(parsed.sf, cachedReports);
    return report;
}

function expressionFindings(item: ExpressionMeasurement, limits: ExpressionLimits): ExpressionFinding[] {
    const findings: ExpressionFinding[] = [];
    const add = (check: string, value: number, detail: string): void => {
        findings.push({ check, value, owner: item.owner, line: item.line, endLine: item.endLine, startOffset: item.startOffset,
            endOffset: item.endOffset, label: item.label, text: `${item.boundary} "${item.label}": ${detail}` });
    };
    if (item.classification !== "literal-data" && item.syntaxTokens > limits.expressionTokens) add("expression_size", item.syntaxTokens, `${item.syntaxTokens} syntax tokens > ${limits.expressionTokens}`);
    if (item.maxCallbackDepth > limits.callbackDepth) add("ubs_deeply_nested_callback", item.maxCallbackDepth, `callback depth ${item.maxCallbackDepth} > ${limits.callbackDepth}; ${item.inlineCallbacks} inline callbacks; ${item.syntaxTokens} syntax tokens`);
    if (item.inlineCallbacks >= limits.callbackCount) add("inline_callback_count", item.inlineCallbacks, `${item.inlineCallbacks} inline callbacks >= ${limits.callbackCount}; depth ${item.maxCallbackDepth}`);
    if (item.conditionalDepth > 1) add("nested_ternaries", item.conditionalDepth, `conditional expression depth ${item.conditionalDepth}`);
    return findings;
}

/** One finding per containing expression and check; detailed inventory retains every boundary. */
export function expressionReadabilityChecks(content: string, filePath: string, overrides: Partial<ExpressionLimits> = {}): ExpressionFinding[] {
    const limits = { ...DEFAULT_EXPRESSION_LIMITS, ...overrides };
    const report = analyzeExpressions(content, filePath, limits);
    const findings: ExpressionFinding[] = [];
    for (const expression of report.expressions) {
        for (const finding of expressionFindings(expression, limits)) {
            if (!findings.some(existing => existing.check === finding.check &&
                existing.startOffset <= finding.startOffset && existing.endOffset >= finding.endOffset)) findings.push(finding);
        }
    }
    return [...findings, ...report.structural];
}

function controlledBodies(node: TS.Node, parsed: ParsedTsSource): TS.Statement[] {
    const { ts } = parsed;
    if (ts.isIfStatement(node)) {
        const bodies = [node.thenStatement];
        if (node.elseStatement && !ts.isIfStatement(node.elseStatement)) bodies.push(node.elseStatement);
        return bodies;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) ||
        ts.isWhileStatement(node) || ts.isDoStatement(node)) return [node.statement];
    return [];
}

function collectPresentation(node: TS.Node, parsed: ParsedTsSource, out: ExpressionFinding[]): void {
    const { ts, sf } = parsed;
    for (const body of controlledBodies(node, parsed)) {
        if (ts.isBlock(body)) continue;
        const preceding = node.getChildren(sf).filter(child => child.getEnd() <= body.getStart(sf)).at(-1);
        const headerEnd = (preceding?.getEnd() ?? node.getStart(sf) + 1) - 1;
        const headerLine = sf.getLineAndCharacterOfPosition(Math.max(0, headerEnd)).line;
        const bodyEndLine = sf.getLineAndCharacterOfPosition(body.getEnd() - 1).line;
        if (headerLine !== bodyEndLine) out.push(structuralFinding(body, parsed, "required_braces", "multiline control-flow body has no braces; verify intended scope before adding them"));
    }
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
        const seen = new Set<number>();
        for (const statement of node.statements) {
            const line = sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line;
            if (seen.has(line)) out.push(structuralFinding(statement, parsed, "statements_per_line", "multiple sibling statements begin on this line"));
            seen.add(line);
        }
    }
    ts.forEachChild(node, child => collectPresentation(child, parsed, out));
}

/** Manifest-embedded style configuration is as authoritative as a separate config file. */
function hasManifestStyleConfig(directory: string): boolean {
    const manifest = join(directory, "package.json");
    if (!existsSync(manifest)) return false;
    const value: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    return isJsonObject(value) && ("eslintConfig" in value || "prettier" in value);
}

/** A configured style tool owns brace policy. Its actual rule is run through lint import. */
function hasTargetStyleConfig(filePath: string): boolean {
    const detectors = LINT_DETECTORS.filter(detector => ["biome", "eslint", "oxlint", "prettier"].includes(detector.tool));
    let directory = dirname(resolve(filePath));
    for (;;) {
        const names = existsSync(directory) ? readdirSync(directory) : [];
        if (names.some(name => detectors.some(detector => detector.files.test(name)))) return true;
        if (hasManifestStyleConfig(directory)) return true;
        if (existsSync(join(directory, ".interlinked", "lint-import.json"))) return true;
        const parent = dirname(directory);
        if (parent === directory || existsSync(join(directory, ".git"))) return false;
        directory = parent;
    }
}

/** Nearest project policy; numeric budgets are preferences, never implicit hard caps. */
export function expressionLimitsFor(filePath: string): ExpressionLimits {
    let directory = dirname(resolve(filePath));
    for (;;) {
        const policy = join(directory, ".interlinked", "readability.json");
        if (existsSync(policy)) return parseExpressionLimits(readFileSync(policy, "utf8"));
        const parent = dirname(directory);
        if (parent === directory || existsSync(join(directory, ".git"))) return { ...DEFAULT_EXPRESSION_LIMITS };
        directory = parent;
    }
}

export function parseExpressionLimits(content: string): ExpressionLimits {
    const policy: unknown = JSON.parse(content);
    if (!isJsonObject(policy) || policy.version !== 1 || !isJsonObject(policy.limits)) throw new Error("readability.json requires version 1 and limits");
    for (const key of Object.keys(policy)) if (key !== "version" && key !== "limits") throw new Error(`Unknown readability policy field: ${key}`);
    const limits = { ...DEFAULT_EXPRESSION_LIMITS };
    for (const [key, value] of Object.entries(policy.limits)) {
        if (!Object.hasOwn(limits, key)) throw new Error(`Unknown readability limit: ${key}`);
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error(`Invalid readability limit: ${key}`);
        // SAFETY: key membership in the complete limits object was checked above.
        limits[key as keyof ExpressionLimits] = value;
    }
    return limits;
}

/** Registry bridge retains complete expression locations in addition to legacy line/text. */
export function readabilityMatches(content: string, filePath: string, check: string): InlineMatch[] {
    if (!/\.[cm]?[jt]sx?$/i.test(filePath)) return [];
    try {
        if (check === "required_braces" && hasTargetStyleConfig(filePath)) return [];
        const limits = expressionLimitsFor(filePath);
        const report = analyzeExpressions(content, filePath, limits);
        if (check === "expression_measurement") {
            return report.status === "unavailable" ? [{ line: 1, text: `Expression readability NOT CHECKED: ${report.reason}` }] : [];
        }
        return expressionReadabilityChecks(content, filePath, limits).filter(finding => finding.check === check);
    } catch (error) {
        if (check !== "expression_measurement") return [];
        const reason = error instanceof Error ? error.message : String(error);
        return [{ line: 1, text: `Expression readability NOT CHECKED: ${reason}` }];
    }
}

export function checkExpressionSize(content: string, filePath: string): InlineMatch[] { return readabilityMatches(content, filePath, "expression_size"); }
export function checkInlineCallbackCount(content: string, filePath: string): InlineMatch[] { return readabilityMatches(content, filePath, "inline_callback_count"); }
export function checkControlFlowDepth(content: string, filePath: string): InlineMatch[] { return readabilityMatches(content, filePath, "control_flow_depth"); }
export function checkExpressionMeasurement(content: string, filePath: string): InlineMatch[] { return readabilityMatches(content, filePath, "expression_measurement"); }
export function checkRequiredBraces(content: string, filePath: string): InlineMatch[] { return readabilityMatches(content, filePath, "required_braces"); }
export function checkStatementsPerLine(content: string, filePath: string): InlineMatch[] { return readabilityMatches(content, filePath, "statements_per_line"); }

function expressionOwner(node: TS.Node, parsed: ParsedTsSource): string {
    const names: string[] = [];
    let current: TS.Node | undefined = node.parent;
    while (current) {
        if (isFunctionLike(parsed.ts, current)) names.push(functionName(parsed.ts, current, parsed.sf));
        current = current.parent;
    }
    return names.reverse().join(".") || "<module>";
}

export const READABILITY_CHECK_IDS: ReadonlySet<string> = new Set([
    "expression_size", "inline_callback_count", "control_flow_depth", "expression_measurement",
    "required_braces", "statements_per_line", "nested_ternaries", "ubs_deeply_nested_callback",
]);

/** Compare whole expressions, including edits below an unchanged initializer line. */
export function introducedReadability(before: string, after: string, filePath: string): ExpressionFinding[] {
    let limits: ExpressionLimits;
    let configuredStyle: boolean;
    try {
        limits = expressionLimitsFor(filePath);
        configuredStyle = hasTargetStyleConfig(filePath);
    }
    catch { return []; } // expression_measurement reports the unavailable policy separately.
    const oldFindings = expressionReadabilityChecks(before, filePath, limits);
    const available = new Map<string, number[]>();
    const key = (finding: ExpressionFinding): string => JSON.stringify([finding.check, finding.owner, finding.label]);
    for (const finding of oldFindings) {
        const values = available.get(key(finding)) ?? [];
        values.push(finding.value);
        available.set(key(finding), values);
    }
    for (const values of available.values()) values.sort((a, b) => a - b);
    // Match the largest current values first so a growing small expression cannot
    // consume the allowance needed by an independently shrinking large expression.
    const current = expressionReadabilityChecks(after, filePath, limits).sort((a, b) => b.value - a.value);
    const introduced: ExpressionFinding[] = [];
    for (const finding of current) {
        if (finding.check === "required_braces" && configuredStyle) continue;
        const values = available.get(key(finding)) ?? [];
        const index = values.findIndex(value => value >= finding.value);
        if (index < 0) {
            introduced.push(finding);
            continue;
        }
        values.splice(index, 1);
    }
    return introduced.sort((a, b) => a.startOffset - b.startOffset);
}
