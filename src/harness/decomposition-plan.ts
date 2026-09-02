// ===========================================
// Decomposition plan for an over-cap function (JS/TS)
// ===========================================
// The cyclomatic write gate's block message says "decompose"; this module says
// WHERE. Given a function name and a target cap it walks the function's own
// body on the TypeScript AST, prices every branch arm (if / else / loop /
// switch case / try / catch / logical chain) by the decision points it would
// carry away, and greedily picks the fewest arms whose extraction brings the
// remainder to the cap. An arm is only a candidate when the helper it would
// become fits the cap itself (`cc + 1 <= targetCap`); a larger arm is split
// into its own arms instead. Candidates are disjoint by construction.
//
// Pure apart from the cached optional-`typescript` load shared with
// cyclomatic-ast.ts; returns null when that dep is absent (the gate that calls
// this already fails open in that case). Arms are priced with the gate's OWN
// `isDecisionPoint` predicate (imported, never mirrored) — a plan that disagrees
// with the gate's count would send the agent chasing the wrong lines. The one
// pricing subtlety: a `case` label's +1 (and a `catch` keyword's) cannot leave
// the parent with a helper, so a clause arm is priced by its STATEMENTS only.

import type * as TS from "typescript";
import {
	functionName,
	isDecisionPoint,
	isFunctionLike,
	isImplementationFunction,
	parseTsSource,
	type TsModule,
} from "./checks/cyclomatic-ast.js";

type ExtractionKind = "if" | "else" | "loop" | "case" | "try" | "catch" | "finally" | "logical";

/** Public API: one row of `DecompositionPlan.extractions`, consumed by the block-message formatter. */
export interface Extraction {
	/** 1-based inclusive line span of the arm to extract. */
	startLine: number;
	endLine: number;
	/** Decision points the extraction removes from the parent. */
	cc: number;
	/** Control-flow ancestors between the function body and this arm (0 = top level). */
	nesting: number;
	kind: ExtractionKind;
	/** camelCase helper name derived from the arm's condition identifiers. */
	suggestedName: string;
}

export interface DecompositionPlan {
	functionName: string;
	targetCap: number;
	/** The function's cyclomatic complexity before any extraction. */
	totalCc: number;
	/** What the function would measure after the listed extractions. */
	remainingCc: number;
	extractions: Extraction[];
}

/** Same population as the AST cyclomatic gate. */
const JS_TS_RE = /\.[cm]?[jt]sx?$/i;

/** Identifiers that carry no meaning in a helper name. */
const NAME_STOPLIST = new Set(["this", "undefined", "null", "true", "false", "typeof"]);
const MAX_NAME_IDENTS = 2;
const MAX_MESSAGE_LINES = 3;

// ---------- decision counting (the gate's predicate, applied per subtree) ----------

function isLoop(ts: TsModule, node: TS.Node): boolean {
	return (
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node) ||
		ts.isWhileStatement(node) ||
		ts.isDoStatement(node)
	);
}

/** Decision points in `node`'s subtree (itself included), not crossing into nested functions. */
function countDecisions(ts: TsModule, node: TS.Node): number {
	if (isFunctionLike(ts, node)) return 0;
	let count = isDecisionPoint(ts, node) ? 1 : 0;
	ts.forEachChild(node, (child) => {
		count += countDecisions(ts, child);
	});
	return count;
}

function functionCc(ts: TsModule, fn: TS.Node): number {
	let count = 1;
	ts.forEachChild(fn, (child) => {
		count += countDecisions(ts, child);
	});
	return count;
}

// ---------- naming ----------

function pascal(word: string): string {
	const clean = word.replace(/[^A-Za-z0-9]/g, "");
	return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Up to `max` distinct identifiers from an expression, in source order, outside nested functions. */
function identifiersOf(ts: TsModule, node: TS.Node | undefined, max = MAX_NAME_IDENTS): string[] {
	const found: string[] = [];
	const visit = (n: TS.Node): void => {
		if (found.length >= max || isFunctionLike(ts, n)) return;
		if (ts.isIdentifier(n)) {
			const text = n.text;
			if (text.length > 1 && !NAME_STOPLIST.has(text) && !found.includes(text)) found.push(text);
			return;
		}
		ts.forEachChild(n, visit);
	};
	if (node) visit(node);
	return found;
}

function joinIdents(idents: readonly string[], fallback: string): string {
	const joined = idents.map(pascal).join("");
	return joined.length === 0 ? fallback : joined;
}

/** `!x`, `x === undefined`, `x == null` — the "missing" shape worth naming. */
function isMissingCheck(ts: TsModule, expr: TS.Expression): boolean {
	if (ts.isPrefixUnaryExpression(expr)) {
		return expr.operator === ts.SyntaxKind.ExclamationToken;
	}
	if (!ts.isBinaryExpression(expr)) return false;
	const op = expr.operatorToken.kind;
	const isEquality =
		op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
	const rhs = expr.right;
	const isNullish =
		rhs.kind === ts.SyntaxKind.NullKeyword ||
		(ts.isIdentifier(rhs) && rhs.text === "undefined");
	return isEquality && isNullish;
}

function ifName(ts: TsModule, node: TS.IfStatement): string {
	const missing = isMissingCheck(ts, node.expression) ? "Missing" : "";
	return `handle${missing}${joinIdents(identifiersOf(ts, node.expression), "Branch")}`;
}

function loopSubject(ts: TsModule, node: TS.Node): TS.Node | undefined {
	if (ts.isForOfStatement(node) || ts.isForInStatement(node)) return node.expression;
	if (ts.isForStatement(node)) return node.condition;
	if (ts.isWhileStatement(node) || ts.isDoStatement(node)) return node.expression;
	return undefined;
}

function loopName(ts: TsModule, node: TS.Node): string {
	return `process${joinIdents(identifiersOf(ts, loopSubject(ts, node)), "Loop")}`;
}

function caseLabel(ts: TsModule, clause: TS.CaseOrDefaultClause): string {
	if (ts.isDefaultClause(clause)) return "Default";
	const expr = clause.expression;
	if (ts.isStringLiteral(expr) || ts.isNumericLiteral(expr)) {
		return pascal(expr.text.toLowerCase()) || "Case";
	}
	return joinIdents(identifiersOf(ts, expr, 1), "Case");
}

function caseName(ts: TsModule, sw: TS.SwitchStatement, clause: TS.CaseOrDefaultClause): string {
	return `handle${joinIdents(identifiersOf(ts, sw.expression), "Switch")}${caseLabel(ts, clause)}`;
}

/** First callee inside a try block names the attempt (`client.push` → ClientPush). */
function firstCallee(ts: TsModule, block: TS.Block): string[] {
	let callee: TS.Node | undefined;
	const visit = (n: TS.Node): void => {
		if (callee || isFunctionLike(ts, n)) return;
		if (ts.isCallExpression(n)) {
			callee = n.expression;
			return;
		}
		ts.forEachChild(n, visit);
	};
	visit(block);
	return identifiersOf(ts, callee);
}

function tryNames(ts: TsModule, node: TS.TryStatement): { attempt: string; recover: string; cleanup: string } {
	const subject = joinIdents(firstCallee(ts, node.tryBlock), "Operation");
	return {
		attempt: `attempt${subject}`,
		recover: `handle${subject}Error`,
		cleanup: `cleanup${subject}`,
	};
}

function describeLeaf(ts: TsModule, node: TS.Node): string {
	if (ts.isVariableStatement(node)) {
		const first = node.declarationList.declarations[0];
		return `compute${joinIdents(identifiersOf(ts, first?.name, 1), "Value")}`;
	}
	if (ts.isReturnStatement(node)) return `resolve${joinIdents(identifiersOf(ts, node.expression), "Result")}`;
	return `apply${joinIdents(identifiersOf(ts, node), "Step")}`;
}

// ---------- candidate collection ----------

/** How an arm should be labeled; set by the parent that owns the arm. */
interface ArmLabel {
	kind: ExtractionKind;
	name: string;
}

interface Arm {
	/** The arm's node. A Block / case clause is priced and spanned by its STATEMENTS (see `bodyOf`). */
	node: TS.Node;
	label: ArmLabel;
	/** Does entering this arm deepen control-flow nesting? (Block → statements does not.) */
	deepens: boolean;
	/** Position of the owning keyword (`if` / `else` / `catch` / …) — the reported startLine and source order. Defaults to the node's own start. */
	anchor?: number;
}

/** The extractable statements of a Block or case clause; null for any other node. */
function bodyOf(ts: TsModule, node: TS.Node): readonly TS.Statement[] | null {
	if (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
	return null;
}

/**
 * Decision points a helper made from this arm would carry away. A block's own
 * brace and a clause's `case` label stay with the parent, so only the
 * statements count — for a Block that equals `countDecisions(block)`; for a
 * CaseClause it is one less than the clause's subtree.
 */
function armCc(ts: TsModule, arm: Arm): number {
	const body = bodyOf(ts, arm.node);
	if (body === null) return countDecisions(ts, arm.node);
	return body.reduce((sum, s) => sum + countDecisions(ts, s), 0);
}

/** Start of the first `kind` token among `node`'s direct children (e.g. the `else` keyword); the node's own start if absent. */
function keywordPos(sf: TS.SourceFile, node: TS.Node, kind: TS.SyntaxKind): number {
	return node.getChildren(sf).find((c) => c.kind === kind)?.getStart(sf) ?? node.getStart(sf);
}

/** A statement labels itself; arms of a control-flow parent are labeled by the parent. */
function labelStatement(ts: TsModule, node: TS.Node): ArmLabel {
	if (ts.isIfStatement(node)) return { kind: "if", name: ifName(ts, node) };
	if (isLoop(ts, node)) return { kind: "loop", name: loopName(ts, node) };
	if (ts.isSwitchStatement(node)) {
		return { kind: "case", name: `handle${joinIdents(identifiersOf(ts, node.expression), "Switch")}` };
	}
	if (ts.isTryStatement(node)) return { kind: "try", name: tryNames(ts, node).attempt };
	return { kind: "logical", name: describeLeaf(ts, node) };
}

/** A condition whose `&&`/`||`/`??` chain is the complexity → extract it as a predicate. */
function conditionArm(ts: TsModule, expr: TS.Node | undefined, verb: string): Arm[] {
	if (!expr) return [];
	const name = `${verb}${joinIdents(identifiersOf(ts, expr), "Condition")}`;
	return [{ node: expr, label: { kind: "logical", name }, deepens: false }];
}

/** The else arm is anchored on its `else` keyword, whether it is a block or an `else if`. */
function elseArm(ts: TsModule, sf: TS.SourceFile, node: TS.IfStatement, els: TS.Statement, own: string): Arm {
	const label: ArmLabel = ts.isIfStatement(els)
		? labelStatement(ts, els)
		: { kind: "else", name: `${own}Otherwise` };
	return { node: els, label, deepens: true, anchor: keywordPos(sf, node, ts.SyntaxKind.ElseKeyword) };
}

function ifArms(ts: TsModule, sf: TS.SourceFile, node: TS.IfStatement): Arm[] {
	const own = ifName(ts, node);
	const arms: Arm[] = [
		...conditionArm(ts, node.expression, "is"),
		{ node: node.thenStatement, label: { kind: "if", name: own }, deepens: true, anchor: node.getStart(sf) },
	];
	if (node.elseStatement) arms.push(elseArm(ts, sf, node, node.elseStatement, own));
	return arms;
}

function tryArms(ts: TsModule, sf: TS.SourceFile, node: TS.TryStatement): Arm[] {
	const names = tryNames(ts, node);
	const arms: Arm[] = [
		{ node: node.tryBlock, label: { kind: "try", name: names.attempt }, deepens: true, anchor: node.getStart(sf) },
	];
	if (node.catchClause) {
		arms.push({
			node: node.catchClause.block,
			label: { kind: "catch", name: names.recover },
			deepens: true,
			anchor: node.catchClause.getStart(sf),
		});
	}
	if (node.finallyBlock) {
		arms.push({
			node: node.finallyBlock,
			label: { kind: "finally", name: names.cleanup },
			deepens: true,
			anchor: keywordPos(sf, node, ts.SyntaxKind.FinallyKeyword),
		});
	}
	return arms;
}

function statementArms(ts: TsModule, statements: readonly TS.Statement[]): Arm[] {
	return statements.map((s) => ({ node: s, label: labelStatement(ts, s), deepens: false }));
}

/** The sub-arms to examine when `node` itself is too large to extract whole. */
function armsOf(ts: TsModule, sf: TS.SourceFile, node: TS.Node): Arm[] {
	if (ts.isIfStatement(node)) return ifArms(ts, sf, node);
	if (ts.isTryStatement(node)) return tryArms(ts, sf, node);
	if (ts.isSwitchStatement(node)) {
		// A clause arm is the clause's statements (priced by `armCc`); its label stays with the switch.
		return node.caseBlock.clauses.map((c) => ({
			node: c,
			label: { kind: "case", name: caseName(ts, node, c) },
			deepens: true,
		}));
	}
	if (isLoop(ts, node)) {
		// SAFETY: every kind `isLoop` accepts is an IterationStatement subtype.
		const body = (node as TS.IterationStatement).statement;
		return [
			...conditionArm(ts, loopSubject(ts, node), "shouldProcess"),
			{ node: body, label: { kind: "loop", name: loopName(ts, node) }, deepens: true, anchor: node.getStart(sf) },
		];
	}
	const body = bodyOf(ts, node);
	return body === null ? [] : statementArms(ts, body);
}

interface Candidate extends Extraction {
	/** Source order, for a stable tie-break. */
	pos: number;
}

interface CollectContext {
	ts: TsModule;
	sf: TS.SourceFile;
	targetCap: number;
	out: Candidate[];
}

/**
 * Span = the owning keyword's line through the arm's last STATEMENT; a block's
 * closing brace (or the next `else` / `catch`) stays with the parent, so two
 * adjacent arms never share a line. A whole-statement arm spans itself.
 */
function toCandidate(ctx: CollectContext, arm: Arm, cc: number, nesting: number): Candidate {
	const { ts, sf } = ctx;
	const start = arm.anchor ?? arm.node.getStart(sf);
	const body = bodyOf(ts, arm.node);
	const last = body?.at(-1);
	const end = last === undefined ? arm.node.getEnd() : last.getEnd();
	return {
		startLine: sf.getLineAndCharacterOfPosition(start).line + 1,
		endLine: sf.getLineAndCharacterOfPosition(end).line + 1,
		cc,
		nesting,
		kind: arm.label.kind,
		suggestedName: arm.label.name,
		pos: start,
	};
}

/**
 * Recursive descent: an arm that fits the cap as a helper is a candidate; a
 * larger one is split into its own arms. Decision-free arms are skipped, and a
 * candidate's subtree is never re-entered, so the output set is disjoint.
 */
function collect(ctx: CollectContext, arm: Arm, nesting: number): void {
	const cc = armCc(ctx.ts, arm);
	if (cc === 0) return;
	if (cc + 1 <= ctx.targetCap) {
		ctx.out.push(toCandidate(ctx, arm, cc, nesting));
		return;
	}
	const next = arm.deepens ? nesting + 1 : nesting;
	for (const sub of armsOf(ctx.ts, ctx.sf, arm.node)) collect(ctx, sub, next);
}

function bodyArms(ts: TsModule, fn: TS.Node): Arm[] {
	// SAFETY: `fn` passed `isImplementationFunction`, which narrows to a bodied function-like.
	const body = (fn as TS.FunctionLikeDeclaration).body;
	if (!body) return [];
	if (ts.isBlock(body)) return statementArms(ts, body.statements);
	return [{ node: body, label: { kind: "logical", name: "computeResult" }, deepens: false }];
}

// ---------- selection ----------

function uniqueNames(extractions: Extraction[]): Extraction[] {
	const seen = new Map<string, number>();
	return extractions.map((e) => {
		const n = (seen.get(e.suggestedName) ?? 0) + 1;
		seen.set(e.suggestedName, n);
		return n === 1 ? e : { ...e, suggestedName: `${e.suggestedName}${n}` };
	});
}

/** Greedy by largest CC first (fewest extractions), then by source order; result is in source order. */
function choose(candidates: Candidate[], totalCc: number, targetCap: number): Extraction[] {
	const ranked = [...candidates].sort((a, b) => b.cc - a.cc || a.pos - b.pos);
	const picked: Candidate[] = [];
	let remaining = totalCc;
	for (const c of ranked) {
		if (remaining <= targetCap) break;
		picked.push(c);
		remaining -= c.cc;
	}
	picked.sort((a, b) => a.pos - b.pos);
	return uniqueNames(picked.map(({ pos: _pos, ...rest }) => rest));
}

/** The implementation function named `name` with the highest CC (ties → first in source). */
function findFunction(ts: TsModule, sf: TS.SourceFile, name: string): { fn: TS.Node; cc: number } | null {
	let best: { fn: TS.Node; cc: number } | null = null;
	const walk = (node: TS.Node): void => {
		if (isImplementationFunction(ts, node) && functionName(ts, node, sf) === name) {
			const cc = functionCc(ts, node);
			if (!best || cc > best.cc) best = { fn: node, cc };
		}
		ts.forEachChild(node, walk);
	};
	walk(sf);
	return best;
}

/**
 * Plan the fewest branch extractions that bring `fnName` to `targetCap`.
 * Returns null for a non-JS/TS path, an absent `typescript` dep, or an unknown
 * function. A function already at the cap gets an empty plan; a function no
 * set of arm extractions can rescue gets the best partial plan
 * (`remainingCc > targetCap`) so the message can say so.
 */
export function planDecomposition(
	content: string,
	filePath: string,
	fnName: string,
	targetCap: number,
): DecompositionPlan | null {
	if (!JS_TS_RE.test(filePath)) return null;
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return null;
	const { ts, sf } = parsed;
	const found = findFunction(ts, sf, fnName);
	if (!found) return null;
	const ctx: CollectContext = { ts, sf, targetCap, out: [] };
	if (found.cc > targetCap) {
		for (const arm of bodyArms(ts, found.fn)) collect(ctx, arm, 0);
	}
	const extractions = choose(ctx.out, found.cc, targetCap);
	const removed = extractions.reduce((sum, e) => sum + e.cc, 0);
	return {
		functionName: fnName,
		targetCap,
		totalCc: found.cc,
		remainingCc: found.cc - removed,
		extractions,
	};
}

// ---------- message ----------

function formatExtraction(e: Extraction): string {
	return `lines ${e.startLine}–${e.endLine} (CC ${e.cc}, nesting ${e.nesting}) → ${e.suggestedName}`;
}

function remainderNote(plan: DecompositionPlan): string {
	const base = `remaining CC ${plan.remainingCc}`;
	if (plan.remainingCc <= plan.targetCap) return base;
	return `${base} (still over ${plan.targetCap} — re-plan after extracting)`;
}

/**
 * 1–3 lines for the block message: one extraction per line (first prefixed
 * "extract"), overflow folded into "+N more", the remaining CC on the last line.
 */
export function planToMessage(plan: DecompositionPlan): string {
	if (plan.extractions.length === 0) {
		return (
			`no extractable branch found in ${plan.functionName} (CC ${plan.totalCc}); ` +
			"split its top-level statements by hand"
		);
	}
	const shown = plan.extractions.slice(0, MAX_MESSAGE_LINES);
	const hidden = plan.extractions.length - shown.length;
	const lines = shown.map((e, i) => (i === 0 ? `extract ${formatExtraction(e)}` : formatExtraction(e)));
	const tail = [hidden > 0 ? `+${hidden} more` : "", remainderNote(plan)].filter(Boolean).join("; ");
	lines[lines.length - 1] = `${lines[lines.length - 1]}; ${tail}`;
	return lines.join("\n");
}
