// Assertion-strength advice uses complete JS/TS calls, preserving literal
// values and multiline syntax. These counts describe assertion shapes, not
// whether a test protects the right contract or kills a particular mutant.
import type * as TS from "typescript";
import { hasParseErrors, parseTsSource, type ParsedTsSource, type TsModule } from "../checks/cyclomatic-ast.js";
import { qualityTokenKey } from "../checks/test-quality-ast.js";
import type { AssertionStrengthCounts } from "./ratchet-metrics.js";

const WEAK_MATCHER_NAMES = new Set([
    "toContain", "toMatch", "toBeTruthy", "toBeFalsy", "toBeDefined", "toBeTypeOf",
]);
const EXACT_MATCHER_NAMES = new Set(["toBe", "toEqual", "toStrictEqual"]);
type Strength = "weak" | "exact";
interface AssertionCall {
    call: TS.CallExpression;
    subject: TS.Expression;
    matcher: string;
    negated: boolean;
    scope: number;
    subjectKey: string;
    key: string;
}

function readAssertion(ts: TsModule, call: TS.CallExpression, scope: number): AssertionCall | null {
    if (!ts.isPropertyAccessExpression(call.expression)) return null;
    const matcher = call.expression.name.text;
    let expression = call.expression.expression;
    let negated = false;
    while (ts.isPropertyAccessExpression(expression)) {
        if (!["not", "resolves", "rejects"].includes(expression.name.text)) return null;
        if (expression.name.text === "not") negated = !negated;
        expression = expression.expression;
    }
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== "expect") return null;
    const subject = expression.arguments[0];
    if (!subject) return null;
    return { call, subject, matcher, negated, scope, subjectKey: qualityTokenKey(ts, subject.getText()), key: qualityTokenKey(ts, call.getText()) };
}

function assertionCalls({ ts, sf }: ParsedTsSource): AssertionCall[] {
    const calls: AssertionCall[] = [];
    const visit = (node: TS.Node, scope: number): void => {
        const currentScope = ts.isFunctionLike(node) ? node.pos : scope;
        if (ts.isCallExpression(node)) {
            const assertion = readAssertion(ts, node, currentScope);
            if (assertion) calls.push(assertion);
        }
        ts.forEachChild(node, (child) => visit(child, currentScope));
    };
    visit(sf, -1);
    return calls;
}

function hasBroadArgument(ts: TsModule, node: TS.Node): boolean {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "expect" &&
        ["any", "anything"].includes(node.expression.name.text)) return true;
    return ts.forEachChild(node, (child) => hasBroadArgument(ts, child) || undefined) === true;
}

function classifyEquality(ts: TsModule, assertion: AssertionCall): Strength | null {
    const { call, subject, negated } = assertion;
    const arg = call.arguments[0];
    if (!arg) return null;
    if (negated || ts.isTypeOfExpression(subject)) return "weak";
    if (ts.isIdentifier(subject) && ts.isIdentifier(arg) && subject.text === arg.text) return "weak";
    if (hasBroadArgument(ts, arg)) return "weak";
    return "exact";
}

function classifyCallPresence(ts: TsModule, assertion: AssertionCall, calls: AssertionCall[]): Strength | null {
    if (assertion.negated) return "exact"; // Pins the observable call count to zero.
    const pinsArgs = calls.some((other) =>
        other.scope === assertion.scope && other.subjectKey === assertion.subjectKey &&
        other.matcher === "toHaveBeenCalledWith" && !other.negated && !hasBroadArgument(ts, other.call),
    );
    return pinsArgs ? null : "weak";
}

function classifyCall(ts: TsModule, assertion: AssertionCall, calls: AssertionCall[]): Strength | null {
    const { call, matcher, negated } = assertion;
    if (matcher === "toBeUndefined" || matcher === "toBeNull") return negated ? "weak" : "exact";
    if (matcher === "toHaveBeenCalledTimes" && call.arguments.length === 1) return negated ? "weak" : "exact";
    if (matcher === "toHaveBeenCalled") return classifyCallPresence(ts, assertion, calls);
    if (WEAK_MATCHER_NAMES.has(matcher)) return "weak";
    if (EXACT_MATCHER_NAMES.has(matcher)) return classifyEquality(ts, assertion);
    return null;
}

function classifiedAssertions(content: string, filePath: string): { key: string; strength: Strength | null }[] | null {
    const parsed = parseTsSource(content, filePath);
    if (!parsed || hasParseErrors(parsed.sf)) return null;
    const calls = assertionCalls(parsed);
    return calls.map((call) => ({ key: call.key, strength: classifyCall(parsed.ts, call, calls) }));
}

/** Count complete calls in raw source. Unavailable or invalid syntax has no verdict. */
export function classifyJsTsAssertionCalls(content: string, filePath = "assertions.ts"): AssertionStrengthCounts {
    const counts: AssertionStrengthCounts = { weak: 0, exact: 0 };
    for (const { strength } of classifiedAssertions(content, filePath) ?? []) {
        if (strength) counts[strength]++;
    }
    return counts;
}

/** Compare whole-call token multisets, preserving strings and ignoring trivia/moves.
 * Parsing full files keeps comments, templates, and multiline chains in context. */
export function countAddedJsTsAssertions(pre: string, post: string, filePath: string): AssertionStrengthCounts {
    const before = classifiedAssertions(pre, filePath);
    const after = classifiedAssertions(post, filePath);
    const counts: AssertionStrengthCounts = { weak: 0, exact: 0 };
    if (!before || !after) return counts;
    const remaining = new Map<string, number>();
    for (const { key } of before) remaining.set(key, (remaining.get(key) ?? 0) + 1);
    for (const { key, strength } of after) {
        const copies = remaining.get(key) ?? 0;
        if (copies > 0) remaining.set(key, copies - 1);
        else if (strength) counts[strength]++;
    }
    return counts;
}

/** Python fallback: compare already literal-stripped lines as a multiset.
 * Whole-file stripping must precede this comparison to retain comment and
 * string context. Trimmed line moves and indentation changes cancel out. */
export function addedLinesText(strippedPre: string, strippedPost: string): string {
    const remaining = new Map<string, number>();
    for (const raw of strippedPre.split("\n")) {
        const line = raw.trim();
        remaining.set(line, (remaining.get(line) ?? 0) + 1);
    }
    const added: string[] = [];
    for (const raw of strippedPost.split("\n")) {
        const line = raw.trim();
        if (line === "") continue;
        const copies = remaining.get(line) ?? 0;
        if (copies > 0) remaining.set(line, copies - 1);
        else added.push(line);
    }
    return added.join("\n");
}
