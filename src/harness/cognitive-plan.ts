// ===========================================
// Cognitive-flattening plan for an over-cap function (JS/TS)
// ===========================================
// The sibling of decomposition-plan.ts. That module answers the CYCLOMATIC
// gate's "decompose" with WHICH branch arms to extract; this one answers the
// COGNITIVE gate's "flatten" with WHICH nesting to remove — a different
// question, because cognitive complexity charges +1 per structure PLUS +1 per
// enclosing nesting level (checks/cognitive-ast.ts, SonarSource rules). Under
// that metric the cheapest reductions are:
//
//   extract-nested-block / extract-loop-body — a nested block costs `1 + depth`
//     per structure in place and restarts at depth 0 inside a helper, so the
//     parent sheds the whole in-place cost (less any residual guard).
//   guard-clause — inverting an else-less wrapper `if` into an early return
//     lifts what it wrapped one level: every increment inside costs 1 less.
//   split-condition — a `&&`/`||`/`??` sequence pays +1 per operator-run
//     transition; pulling minority runs into named predicates leaves one.
//
// Savings are priced by cognitive-plan-score.ts, which shares the shipped
// increment predicates, so a plan cannot disagree with the gate about what an
// increment is. A candidate is offered only when its helper fits the cap too.
//
// Pure apart from the cached optional-`typescript` load; returns null when that
// dep is absent (the gate calling this already fails open in that case).

import type * as TS from "typescript";
import { cognitiveEntriesFrom, logicalOpKind } from "./checks/cognitive-ast.js";
import {
	functionName,
	isFunctionLike,
	isImplementationFunction,
	parseTsSource,
	type TsModule,
} from "./checks/cyclomatic-ast.js";
import { hasEscapingJump, logicalRunCount, scoreNodes } from "./cognitive-plan-score.js";
import { identifiersOf, joinIdents } from "./decomposition-plan.js";

export type CognitiveMoveKind =
	| "extract-nested-block"
	| "guard-clause"
	| "split-condition"
	| "extract-loop-body";

/** Public API: one ordered row of `CognitivePlan.moves`. */
export interface CognitiveMove {
	kind: CognitiveMoveKind;
	/** 1-based inclusive line span of the code the move touches. */
	startLine: number;
	endLine: number;
	/** Nesting level the affected code is scored at (0 = function top level). */
	depth: number;
	/** Cognitive points the move removes from the ENCLOSING function. */
	estimatedSaving: number;
	/** camelCase helper name, or — for `guard-clause` — the `if (…)` to invert. */
	suggestedName: string;
	/** The function's score after this move and every move before it. */
	remainingAfter: number;
}

export interface CognitivePlan {
	functionName: string;
	targetCap: number;
	/** The function's cognitive complexity before any move. */
	totalCognitive: number;
	/** What it would measure after every listed move. */
	remainingCognitive: number;
	/** Ordered largest-saving-first; empty when already at or under the cap. */
	moves: CognitiveMove[];
}

/** Same population as the AST cognitive pass. */
const JS_TS_RE = /\.[cm]?[jt]sx?$/i;
const MAX_MESSAGE_MOVES = 3;
const MAX_CONDITION_CHARS = 34;

// ---------- containers: the extractable statement lists, with their depth ----------

interface Container {
	stmts: readonly TS.Statement[];
	/** Nesting the statements are visited at. */
	nesting: number;
	kind: "extract-nested-block" | "extract-loop-body";
	/** Position of the owning keyword — the reported startLine and source order. */
	anchor: number;
	name: string;
}

function isLoopNode(ts: TsModule, node: TS.Node): boolean {
	return (
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node) ||
		ts.isWhileStatement(node) ||
		ts.isDoStatement(node)
	);
}

/** A block's statements, or the lone statement of an unbraced body. */
function asList(ts: TsModule, node: TS.Statement | undefined): readonly TS.Statement[] {
	if (!node) return [];
	return ts.isBlock(node) ? node.statements : [node];
}

function loopSubject(ts: TsModule, node: TS.Node): TS.Node | undefined {
	if (ts.isForOfStatement(node) || ts.isForInStatement(node)) return node.expression;
	if (ts.isForStatement(node)) return node.condition;
	if (ts.isWhileStatement(node) || ts.isDoStatement(node)) return node.expression;
	return undefined;
}

/** `else if` does NOT deepen (Sonar flattens the chain), so the chain walks at `n`. */
function ifContainers(ts: TsModule, sf: TS.SourceFile, node: TS.IfStatement, n: number): Container[] {
	const base = `handle${joinIdents(identifiersOf(ts, node.expression), "Branch")}`;
	const out: Container[] = [
		{
			stmts: asList(ts, node.thenStatement),
			nesting: n + 1,
			kind: "extract-nested-block",
			anchor: node.getStart(sf),
			name: base,
		},
	];
	const els = node.elseStatement;
	if (!els) return out;
	if (ts.isIfStatement(els)) {
		out.push(...ifContainers(ts, sf, els, n));
		return out;
	}
	out.push({
		stmts: asList(ts, els),
		nesting: n + 1,
		kind: "extract-nested-block",
		anchor: els.getStart(sf),
		name: `${base}Otherwise`,
	});
	return out;
}

function loopContainers(ts: TsModule, sf: TS.SourceFile, node: TS.Statement, n: number): Container[] {
	// SAFETY: every kind `isLoopNode` accepts is an IterationStatement subtype.
	const body = (node as TS.IterationStatement).statement;
	return [
		{
			stmts: asList(ts, body),
			nesting: n + 1,
			kind: "extract-loop-body",
			anchor: node.getStart(sf),
			name: `process${joinIdents(identifiersOf(ts, loopSubject(ts, node)), "Item")}`,
		},
	];
}

function switchContainers(ts: TsModule, sf: TS.SourceFile, node: TS.SwitchStatement, n: number): Container[] {
	const subject = joinIdents(identifiersOf(ts, node.expression), "Switch");
	return node.caseBlock.clauses.map((clause, i) => ({
		stmts: clause.statements,
		nesting: n + 1,
		kind: "extract-nested-block" as const,
		anchor: clause.getStart(sf),
		name: `handle${subject}Case${i + 1}`,
	}));
}

/** `try` is NOT a nesting construct (only `catch` is), so its block stays at `n`. */
function tryContainers(sf: TS.SourceFile, node: TS.TryStatement, n: number): Container[] {
	const out: Container[] = [
		{
			stmts: node.tryBlock.statements,
			nesting: n,
			kind: "extract-nested-block",
			anchor: node.getStart(sf),
			name: "attemptOperation",
		},
	];
	if (node.catchClause) {
		out.push({
			stmts: node.catchClause.block.statements,
			nesting: n + 1,
			kind: "extract-nested-block",
			anchor: node.catchClause.getStart(sf),
			name: "handleOperationError",
		});
	}
	if (node.finallyBlock) {
		out.push({
			stmts: node.finallyBlock.statements,
			nesting: n,
			kind: "extract-nested-block",
			anchor: node.finallyBlock.getStart(sf),
			name: "cleanupOperation",
		});
	}
	return out;
}

/** The statement lists `stmt` directly owns, each with the nesting it is scored at. */
function containersOf(ts: TsModule, sf: TS.SourceFile, stmt: TS.Statement, n: number): Container[] {
	if (ts.isIfStatement(stmt)) return ifContainers(ts, sf, stmt, n);
	if (isLoopNode(ts, stmt)) return loopContainers(ts, sf, stmt, n);
	if (ts.isSwitchStatement(stmt)) return switchContainers(ts, sf, stmt, n);
	if (ts.isTryStatement(stmt)) return tryContainers(sf, stmt, n);
	if (ts.isBlock(stmt)) {
		return [
			{
				stmts: stmt.statements,
				nesting: n,
				kind: "extract-nested-block",
				anchor: stmt.getStart(sf),
				name: "runBlock",
			},
		];
	}
	if (ts.isLabeledStatement(stmt)) return containersOf(ts, sf, stmt.statement, n);
	return [];
}

// ---------- candidate collection ----------

interface Candidate {
	kind: CognitiveMoveKind;
	startLine: number;
	endLine: number;
	depth: number;
	estimatedSaving: number;
	suggestedName: string;
	/** Source order, for a stable tie-break. */
	pos: number;
}

interface Ctx {
	ts: TsModule;
	sf: TS.SourceFile;
	targetCap: number;
	out: Candidate[];
}

function lineOf(sf: TS.SourceFile, pos: number): number {
	return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function containerCandidate(ctx: Ctx, c: Container, saving: number): Candidate {
	const last = c.stmts.at(-1);
	return {
		kind: c.kind,
		startLine: lineOf(ctx.sf, c.anchor),
		endLine: lineOf(ctx.sf, last === undefined ? c.anchor : last.getEnd()),
		depth: c.nesting,
		estimatedSaving: saving,
		suggestedName: c.name,
		pos: c.anchor,
	};
}

/**
 * A container is a candidate when the helper it would become fits the cap; a
 * bigger one is descended into instead, so emitted containers are disjoint. A
 * container with no increments has nothing deeper to offer. The saving is the
 * in-place cost LESS the residual guard an escaping jump forces on the caller
 * (`hasEscapingJump`) — a correction measured against the tree, not assumed.
 */
function considerContainer(ctx: Ctx, c: Container): void {
	const inPlace = scoreNodes(ctx.ts, c.stmts, c.nesting);
	if (inPlace.cost === 0) return;
	if (scoreNodes(ctx.ts, c.stmts, 0).cost <= ctx.targetCap) {
		const residual = hasEscapingJump(ctx.ts, c.stmts) ? 1 + c.nesting : 0;
		const saving = inPlace.cost - residual;
		if (saving > 0) ctx.out.push(containerCandidate(ctx, c, saving));
		return;
	}
	walkList(ctx, c.stmts, c.nesting);
}

/**
 * A guard clause preserves semantics only when nothing but a single `return`
 * follows the `if` in its block — otherwise the early return would skip live
 * statements. `else`-carrying `if`s are excluded for the same reason.
 */
function isTailPosition(ts: TsModule, stmts: readonly TS.Statement[], i: number): boolean {
	if (i === stmts.length - 1) return true;
	const next = stmts[i + 1];
	return stmts.length === i + 2 && next !== undefined && ts.isReturnStatement(next);
}

function conditionSnippet(sf: TS.SourceFile, node: TS.IfStatement): string {
	const text = node.expression.getText(sf).replace(/\s+/g, " ");
	const clipped =
		text.length > MAX_CONDITION_CHARS ? `${text.slice(0, MAX_CONDITION_CHARS)}…` : text;
	return `if (${clipped})`;
}

function collectGuardClauses(ctx: Ctx, stmts: readonly TS.Statement[], nesting: number): void {
	const { ts, sf } = ctx;
	for (let i = 0; i < stmts.length; i++) {
		const stmt = stmts[i];
		if (stmt === undefined || !ts.isIfStatement(stmt) || stmt.elseStatement) continue;
		if (!isTailPosition(ts, stmts, i)) continue;
		// Inverting the wrapper lifts every nesting-paying increment it holds by one.
		const saving = scoreNodes(ts, [stmt.thenStatement], nesting + 1).nestingIncrements;
		if (saving <= 0) continue;
		ctx.out.push({
			kind: "guard-clause",
			startLine: lineOf(sf, stmt.getStart(sf)),
			endLine: lineOf(sf, stmt.getEnd()),
			depth: nesting,
			estimatedSaving: saving,
			suggestedName: conditionSnippet(sf, stmt),
			pos: stmt.getStart(sf),
		});
	}
}

/** Top-most logical expressions only — a nested run is part of its parent's cost. */
function collectSplits(ctx: Ctx, root: TS.Node, nesting: number): void {
	const { ts, sf } = ctx;
	const visit = (node: TS.Node): void => {
		if (isFunctionLike(ts, node)) return;
		if (logicalOpKind(ts, node) === null) {
			ts.forEachChild(node, visit);
			return;
		}
		const saving = logicalRunCount(ts, node) - 1; // one run must remain
		// Helper-fits-the-cap check: each extracted predicate holds ONE uniform
		// operator run, which costs exactly 1, so any cap of 1 or more admits it.
		if (saving < 1 || ctx.targetCap < 1) return;
		ctx.out.push({
			kind: "split-condition",
			startLine: lineOf(sf, node.getStart(sf)),
			endLine: lineOf(sf, node.getEnd()),
			depth: nesting,
			estimatedSaving: saving,
			suggestedName: `is${joinIdents(identifiersOf(ts, node), "Condition")}`,
			pos: node.getStart(sf),
		});
	};
	visit(root);
}

function walkList(ctx: Ctx, stmts: readonly TS.Statement[], nesting: number): void {
	collectGuardClauses(ctx, stmts, nesting);
	for (const stmt of stmts) {
		collectSplits(ctx, stmt, nesting);
		for (const c of containersOf(ctx.ts, ctx.sf, stmt, nesting)) considerContainer(ctx, c);
	}
}

// ---------- selection ----------

function overlaps(a: Candidate, b: Candidate): boolean {
	return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/** Greedy: largest saving first, source order as the tie-break, overlaps skipped. */
function choose(candidates: readonly Candidate[], total: number, targetCap: number): Candidate[] {
	const ranked = [...candidates].sort(
		(a, b) => b.estimatedSaving - a.estimatedSaving || a.pos - b.pos,
	);
	const picked: Candidate[] = [];
	let remaining = total;
	for (const c of ranked) {
		if (remaining <= targetCap) break;
		if (picked.some((p) => overlaps(p, c))) continue;
		picked.push(c);
		remaining -= c.estimatedSaving;
	}
	return picked;
}

function toMoves(picked: readonly Candidate[], total: number): CognitiveMove[] {
	const seen = new Map<string, number>();
	let remaining = total;
	return picked.map((c) => {
		remaining -= c.estimatedSaving;
		const n = (seen.get(c.suggestedName) ?? 0) + 1;
		seen.set(c.suggestedName, n);
		const unique = c.kind === "guard-clause" || n === 1 ? c.suggestedName : `${c.suggestedName}${n}`;
		return {
			kind: c.kind,
			startLine: c.startLine,
			endLine: c.endLine,
			depth: c.depth,
			estimatedSaving: c.estimatedSaving,
			suggestedName: unique,
			remainingAfter: remaining,
		};
	});
}

// ---------- function lookup ----------

interface Located {
	fn: TS.Node;
	/** Function-ancestor depth — the unit's starting nesting (spec deviation 1). */
	depth: number;
	total: number;
}

/** The implementation function named `name` with the highest cognitive score. */
function locate(ts: TsModule, sf: TS.SourceFile, name: string): Located | null {
	const entries = cognitiveEntriesFrom(ts, sf).filter((e) => e.name === name);
	if (entries.length === 0) return null;
	const target = entries.reduce((a, b) => (b.cognitive > a.cognitive ? b : a));
	let found: Located | null = null;
	const walk = (node: TS.Node, depth: number): void => {
		if (
			found === null &&
			isImplementationFunction(ts, node) &&
			functionName(ts, node, sf) === name &&
			lineOf(sf, node.getStart(sf)) === target.line
		) {
			found = { fn: node, depth, total: target.cognitive };
		}
		const next = isFunctionLike(ts, node) ? depth + 1 : depth;
		ts.forEachChild(node, (child) => walk(child, next));
	};
	walk(sf, 0);
	return found;
}

function collectFrom(ctx: Ctx, found: Located): void {
	// SAFETY: `locate` only returns nodes that passed `isImplementationFunction`,
	// which narrows to a bodied function-like.
	const body = (found.fn as TS.FunctionLikeDeclaration).body;
	if (!body) return;
	if (ctx.ts.isBlock(body)) walkList(ctx, body.statements, found.depth);
	else collectSplits(ctx, body, found.depth); // concise arrow body — no blocks to extract
}

// ---------- public API ----------

/**
 * Plan the fewest flattening moves that bring `fnName` to `targetCap`.
 * Returns null for a non-JS/TS path, an absent `typescript` dep, or an unknown
 * function. A function already at the cap gets an empty plan; a function no set
 * of moves can rescue gets the best partial plan (`remainingCognitive >
 * targetCap`) so the message can say so.
 */
export function planCognitiveFlattening(
	content: string,
	filePath: string,
	fnName: string,
	targetCap: number,
): CognitivePlan | null {
	if (!JS_TS_RE.test(filePath)) return null;
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return null;
	const { ts, sf } = parsed;
	const found = locate(ts, sf, fnName);
	if (!found) return null;
	const ctx: Ctx = { ts, sf, targetCap, out: [] };
	if (found.total > targetCap) collectFrom(ctx, found);
	const moves = toMoves(choose(ctx.out, found.total, targetCap), found.total);
	return {
		functionName: fnName,
		targetCap,
		totalCognitive: found.total,
		remainingCognitive: moves.at(-1)?.remainingAfter ?? found.total,
		moves,
	};
}

// ---------- message ----------

function describeMove(m: CognitiveMove): string {
	const span = m.startLine === m.endLine ? `L${m.startLine}` : `L${m.startLine}–${m.endLine}`;
	const cost = ` (−${m.estimatedSaving})`;
	if (m.kind === "guard-clause") return `guard-clause the \`${m.suggestedName}\` at ${span}${cost}`;
	if (m.kind === "split-condition") {
		return `split the mixed condition at ${span} into ${m.suggestedName}${cost}`;
	}
	const what = m.kind === "extract-loop-body" ? "loop body" : "block";
	return `extract the depth-${m.depth} ${what} at ${span} as ${m.suggestedName}${cost}`;
}

/**
 * One newline-free sentence for the block message's `↳ plan:` sub-line: the
 * chosen moves largest-saving-first, then the score they land on.
 */
export function cognitivePlanToMessage(plan: CognitivePlan): string {
	if (plan.moves.length === 0) {
		if (plan.remainingCognitive <= plan.targetCap) {
			return (
				`${plan.functionName} is already at cognitive ${plan.totalCognitive} ` +
				`≤ cap ${plan.targetCap} — nothing to flatten`
			);
		}
		return (
			`no flattenable structure found in ${plan.functionName} ` +
			`(cognitive ${plan.totalCognitive}); split it by hand`
		);
	}
	const shown = plan.moves.slice(0, MAX_MESSAGE_MOVES).map(describeMove).join(", then ");
	const hidden = Math.max(0, plan.moves.length - MAX_MESSAGE_MOVES);
	const more = hidden > 0 ? `, +${hidden} more` : "";
	const over =
		plan.remainingCognitive > plan.targetCap
			? ` (still over ${plan.targetCap} — re-plan after flattening)`
			: "";
	return `flatten: ${shown}${more} → ${plan.remainingCognitive}${over}`;
}
