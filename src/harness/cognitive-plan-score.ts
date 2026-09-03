// ===========================================
// Subtree cognitive scoring for the flattening planner
// ===========================================
// The planner (cognitive-plan.ts) prices a candidate move by asking "what does
// this subtree cost at nesting N, and what would it cost at nesting 0?". The
// shipped scorer in checks/cognitive-ast.ts answers only the whole-unit
// question (`scoreUnit` is a closure over one function), so this module
// mirrors its ACCUMULATION walk with an explicit starting nesting.
//
// What is NOT mirrored: the increment classification itself. The four
// predicates below are imported from cognitive-ast.ts, so "is this an
// increment, and does it pay nesting" has exactly one definition in the tree.
// cognitive-plan-score.test.ts pins the remaining mirror (the traversal)
// against `computeCognitiveAst` across eight construct shapes.

import type * as TS from "typescript";
import {
	isLabeledJump,
	isNestingConstruct,
	logicalOpKind,
	unwrapParens,
} from "./checks/cognitive-ast.js";
import { isFunctionLike, type TsModule } from "./checks/cyclomatic-ast.js";

export interface SubtreeScore {
	/** Cognitive points the nodes contribute when visited at the given nesting. */
	cost: number;
	/** How many of those increments paid a nesting penalty — what a guard clause lifts. */
	nestingIncrements: number;
}

/**
 * Score `nodes` as if visited at `nesting`, stopping at nested function-likes
 * exactly as `scoreUnit` does (each is its own unit).
 *
 * Recursion's one-off +1 is deliberately not modeled: it is a whole-unit
 * property that none of the planner's four moves relocates, so including it
 * would only skew the per-move savings.
 */
export function scoreNodes(
	ts: TsModule,
	nodes: readonly TS.Node[],
	nesting: number,
): SubtreeScore {
	let cost = 0;
	let nestingIncrements = 0;

	const addNested = (n: number): void => {
		cost += 1 + n;
		nestingIncrements += 1;
	};
	const descend = (node: TS.Node, n: number): void => {
		ts.forEachChild(node, (child) => visit(child, n));
	};
	// An `else if` continuation increments flat and does NOT deepen (Sonar
	// flattens chains); everything else about it scores like a normal `if`.
	const visitIf = (node: TS.IfStatement, n: number, isElseIf: boolean): void => {
		if (isElseIf) cost += 1;
		else addNested(n);
		visit(node.expression, n + 1);
		visit(node.thenStatement, n + 1);
		const els = node.elseStatement;
		if (!els) return;
		if (ts.isIfStatement(els)) {
			visitIf(els, n, true);
			return;
		}
		cost += 1; // plain `else`, flat
		visit(els, n + 1);
	};
	const visit = (node: TS.Node, n: number): void => {
		if (isFunctionLike(ts, node)) return; // its own unit's boundary
		if (ts.isIfStatement(node)) {
			visitIf(node, n, false);
			return;
		}
		if (isNestingConstruct(ts, node)) {
			addNested(n);
			descend(node, n + 1);
			return;
		}
		const op = logicalOpKind(ts, node);
		if (op !== null) {
			// +1 per run transition; parens end a run (Sonar's sequences rule).
			// SAFETY: `logicalOpKind` returns non-null only for a BinaryExpression.
			const left = unwrapParens(ts, (node as TS.BinaryExpression).left);
			if (logicalOpKind(ts, left) !== op) cost += 1;
			descend(node, n);
			return;
		}
		if (isLabeledJump(ts, node)) cost += 1;
		descend(node, n);
	};

	for (const node of nodes) visit(node, nesting);
	return { cost, nestingIncrements };
}

/**
 * Does this statement list transfer control OUT of itself — a `return`, or a
 * `break`/`continue` whose loop or switch sits outside the list?
 *
 * Such a block cannot become a plain `helper()` call: the caller needs a
 * residual guard (`if (r !== null) return r;`, `if (step.stop) break;`) which
 * costs `1 + nesting` and stays behind. Measured 2026-09-02 against two real
 * over-cap functions — ignoring the residual put the estimate 2 and 5 points
 * optimistic, so the planner subtracts it from the move's saving.
 *
 * Nested function-likes are skipped: a `return` inside a callback is local to it.
 */
export function hasEscapingJump(ts: TsModule, stmts: readonly TS.Node[]): boolean {
	let found = false;
	const visit = (node: TS.Node, loopDepth: number): void => {
		if (found || isFunctionLike(ts, node)) return;
		if (ts.isReturnStatement(node)) {
			found = true;
			return;
		}
		if ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) && loopDepth === 0) {
			found = true;
			return;
		}
		const inner = isBreakTarget(ts, node) ? loopDepth + 1 : loopDepth;
		ts.forEachChild(node, (child) => visit(child, inner));
	};
	for (const stmt of stmts) visit(stmt, 0);
	return found;
}

/** A construct an unlabeled `break`/`continue` binds to. */
function isBreakTarget(ts: TsModule, node: TS.Node): boolean {
	return (
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node) ||
		ts.isWhileStatement(node) ||
		ts.isDoStatement(node) ||
		ts.isSwitchStatement(node)
	);
}

/**
 * Operator-run transitions inside a logical expression — the whole cognitive
 * cost of the sequence, and therefore the ceiling on what splitting it saves
 * (one run must remain, so the saving is `count - 1`).
 */
export function logicalRunCount(ts: TsModule, root: TS.Node): number {
	let count = 0;
	const visit = (node: TS.Node): void => {
		if (isFunctionLike(ts, node)) return;
		const op = logicalOpKind(ts, node);
		if (op !== null) {
			// SAFETY: `logicalOpKind` returns non-null only for a BinaryExpression.
			const left = unwrapParens(ts, (node as TS.BinaryExpression).left);
			if (logicalOpKind(ts, left) !== op) count += 1;
		}
		ts.forEachChild(node, visit);
	};
	visit(root);
	return count;
}
