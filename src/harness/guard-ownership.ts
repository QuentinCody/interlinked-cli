import type * as TS from "typescript";
import { functionName, isFunctionLike, parseTsSource, type ParsedTsSource } from "./checks/cyclomatic-ast.js";
import { hasExactSyntax } from "./function-tokens/ast-tokens.js";

export interface GuardCondition { condition: string; branch: "then" | "else"; }
export interface GuardChange {
    owner: string;
    statement: string;
    before: GuardCondition[];
    after: GuardCondition[];
}
export interface GuardComparison {
    status: "measured" | "partial" | "unsupported" | "unavailable";
    matched: number;
    unmatched: number;
    changes: GuardChange[];
}
interface GuardedStatement { owner: string; statement: string; guards: GuardCondition[]; ambiguous: boolean; scopeSyntax: string; }
interface Inventory { statements: GuardedStatement[]; owners: Map<string, number>; }

/** Parser-resolved leaves preserve literal spelling; whitespace and comments carry no identity. */
function syntaxText(node: TS.Node, parsed: ParsedTsSource): string {
    if (node.kind === parsed.ts.SyntaxKind.JSDocComment) return "";
    const children = node.getChildren(parsed.sf);
    if (!children.length) return node.kind <= parsed.ts.SyntaxKind.LastToken ? node.getText(parsed.sf) : "";
    return children.map(child => syntaxText(child, parsed)).filter(Boolean).join(" ");
}

function inventory(parsed: ParsedTsSource): Inventory {
    const result: Inventory = { statements: [], owners: new Map() };
    const { ts, sf } = parsed;
    function walk(node: TS.Node, owner: string, guards: GuardCondition[], ambiguous: boolean, scopeSyntax: string): void {
        if (isFunctionLike(ts, node)) {
            const name = functionName(ts, node, sf);
            owner = owner ? `${owner}/${name}` : name;
            result.owners.set(owner, (result.owners.get(owner) ?? 0) + 1);
            ambiguous ||= name === "(callback)";
            guards = [];
            scopeSyntax = syntaxText(node, parsed);
        }
        if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
            result.statements.push({ owner, statement: syntaxText(node, parsed), guards, ambiguous, scopeSyntax });
        }
        if (ts.isIfStatement(node)) {
            const condition = syntaxText(node.expression, parsed);
            walk(node.expression, owner, guards, ambiguous, scopeSyntax);
            walk(node.thenStatement, owner, [...guards, { condition, branch: "then" }], ambiguous, scopeSyntax);
            if (node.elseStatement) walk(node.elseStatement, owner, [...guards, { condition, branch: "else" }], ambiguous, scopeSyntax);
            return;
        }
        ts.forEachChild(node, child => walk(child, owner, guards, ambiguous, scopeSyntax));
    }
    walk(sf, "", [], false, syntaxText(sf, parsed));
    return result;
}

/** Unedited function bodies need no new ambiguity warning. Consume multiplicities,
 * so adding/deleting duplicate callbacks cannot hide a changed existing body. */
function changedUnmatched(group: GuardedStatement[], candidates: GuardedStatement[] = []): number {
    const remaining = candidates.map(item => JSON.stringify([item.scopeSyntax, item.guards]));
    let changed = 0;
    for (const item of group) {
        const index = remaining.indexOf(JSON.stringify([item.scopeSyntax, item.guards]));
        if (index < 0) changed += 1;
        else remaining.splice(index, 1);
    }
    return changed;
}

function groupStatements(source: Inventory): Map<string, GuardedStatement[]> {
    const grouped = new Map<string, GuardedStatement[]>();
    for (const statement of source.statements) {
        const key = JSON.stringify([statement.owner, statement.statement]);
        const group = grouped.get(key) ?? [];
        group.push(statement);
        grouped.set(key, group);
    }
    return grouped;
}

function uniqueStatement(group: GuardedStatement[] | undefined, source: Inventory): GuardedStatement | undefined {
    if (group?.length !== 1) return undefined;
    const item = group[0];
    if (!item || item.ambiguous || (source.owners.get(item.owner) ?? 1) !== 1) return undefined;
    // A nested function in a duplicated outer scope is ambiguous too.
    const parts = item.owner.split("/");
    while (parts.length > 1) {
        parts.pop();
        if ((source.owners.get(parts.join("/")) ?? 1) !== 1) return undefined;
    }
    return item;
}

/** Lexical if ownership only: not a dominance analysis or proof of behavioral correctness. */
export function compareGuardOwnership(before: string, after: string, file: string): GuardComparison {
    const result: GuardComparison = { status: "measured", matched: 0, unmatched: 0, changes: [] };
    if (!/\.[cm]?[jt]sx?$/i.test(file)) return { ...result, status: "unsupported" };
    const oldTree = parseTsSource(before, file);
    const newTree = parseTsSource(after, file);
    if (!oldTree || !newTree || !hasExactSyntax(oldTree) || !hasExactSyntax(newTree)) return { ...result, status: "unavailable" };
    const oldSource = inventory(oldTree);
    const newSource = inventory(newTree);
    const oldGroups = groupStatements(oldSource);
    const newGroups = groupStatements(newSource);
    for (const [key, group] of oldGroups) {
        const oldItem = uniqueStatement(group, oldSource);
        const newItem = uniqueStatement(newGroups.get(key), newSource);
        if (!oldItem || !newItem) {
            result.unmatched += changedUnmatched(group, newGroups.get(key));
            continue;
        }
        result.matched += 1;
        if (JSON.stringify(oldItem.guards) !== JSON.stringify(newItem.guards)) {
            result.changes.push({ owner: oldItem.owner, statement: oldItem.statement, before: oldItem.guards, after: newItem.guards });
        }
    }
    if (result.unmatched) result.status = "partial";
    return result;
}
