// ===========================================
// Cognitive complexity (SonarSource-aligned), per-function, JS/TS
// ===========================================
// Spec: docs/design/history-relational-metrics.md §5. Where cyclomatic counts
// branches, cognitive scores *readability*: nesting is penalized, a flat
// `switch` is nearly free, boolean-run transitions cost 1 each. The two
// deliberate deviations from the Sonar paper are documented in the spec:
//   1. Attribution — every function-like is its own unit (population parity
//      with cyclomatic-ast.ts), compensated by starting each unit's nesting
//      at its count of enclosing function-like ancestors, so unit scores sum
//      to Sonar's roll-in figure and extracting a callback to top level is
//      rewarded.
//   2. `??` counts as a logical-operator kind (post-dates the paper;
//      consistent with the cyclomatic walker).
// Degrades to null when the optional `typescript` dep is absent — there is no
// regex fallback for this metric (nesting cannot be tracked lexically with
// acceptable accuracy), so callers treat null as "metric unavailable".

import type * as TS from "typescript";
import type { InlineMatch } from "../check-registry/types.js";
import {
	functionName,
	isFunctionLike,
	isImplementationFunction,
	parseTsSource,
	type TsModule,
} from "./cyclomatic-ast.js";

/** Sonar's default threshold; promotion to a ratcheted MetricKey is Phase 2. */
export const DEFAULT_MAX_COGNITIVE = 15;

export interface CognitiveComplexityEntry {
	name: string;
	/** 1-based line of the function's start. */
	line: number;
	endLine: number;
	cognitive: number;
	/** Deepest nesting level actually applied at a nesting-paying increment. */
	maxNesting: number;
	language: "js_ts";
}

/** File population: same extensions the AST cyclomatic pass parses. */
const JS_TS_RE = /\.[cm]?[jt]sx?$/i;

function isLoop(ts: TsModule, node: TS.Node): boolean {
	return (
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node) ||
		ts.isWhileStatement(node) ||
		ts.isDoStatement(node)
	);
}

function logicalOpKind(ts: TsModule, node: TS.Node): TS.SyntaxKind | null {
	if (!ts.isBinaryExpression(node)) return null;
	const op = node.operatorToken.kind;
	if (
		op === ts.SyntaxKind.AmpersandAmpersandToken ||
		op === ts.SyntaxKind.BarBarToken ||
		op === ts.SyntaxKind.QuestionQuestionToken
	) {
		return op;
	}
	return null;
}

function unwrapParens(ts: TsModule, node: TS.Node): TS.Node {
	let cur = node;
	while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
	return cur;
}

interface UnitScore {
	cognitive: number;
	maxNesting: number;
}

/**
 * Score one function-like unit. Nested function-likes are boundaries (their
 * own units); `initialNesting` is the unit's function-ancestor depth per
 * spec deviation 1.
 */
function scoreUnit(ts: TsModule, fn: TS.Node, unitName: string, initialNesting: number): UnitScore {
	let cognitive = 0;
	let maxNesting = 0;
	// Boxed so TS's control-flow narrowing doesn't collapse this to a literal
	// `false` at the read below — `visit` sets it via a `ts.forEachChild`
	// callback, and TS can't see across that call boundary.
	const recursionState = { recursed: false };
	const recursable = unitName !== "(callback)" && unitName !== "constructor";

	const addNested = (nesting: number): void => {
		cognitive += 1 + nesting;
		if (nesting > maxNesting) maxNesting = nesting;
	};

	const descend = (node: TS.Node, nesting: number): void => {
		ts.forEachChild(node, (child) => visit(child, nesting));
	};

	// An `else if` continuation increments flat and does NOT deepen (Sonar
	// flattens chains); everything else about it scores like a normal if.
	const visitIf = (node: TS.IfStatement, nesting: number, isElseIf: boolean): void => {
		if (isElseIf) cognitive += 1;
		else addNested(nesting);
		visit(node.expression, nesting + 1);
		visit(node.thenStatement, nesting + 1);
		const els = node.elseStatement;
		if (!els) return;
		if (ts.isIfStatement(els)) {
			visitIf(els, nesting, true);
			return;
		}
		cognitive += 1; // plain `else`, flat
		visit(els, nesting + 1);
	};

	const visit = (node: TS.Node, nesting: number): void => {
		if (node !== fn && isFunctionLike(ts, node)) return; // own unit's boundary
		if (ts.isIfStatement(node)) {
			visitIf(node, nesting, false);
			return;
		}
		if (
			isLoop(ts, node) ||
			ts.isSwitchStatement(node) ||
			ts.isConditionalExpression(node) ||
			ts.isCatchClause(node)
		) {
			addNested(nesting);
			descend(node, nesting + 1);
			return;
		}
		const op = logicalOpKind(ts, node);
		if (op !== null) {
			// +1 per run transition: increment unless the left operand continues
			// the same operator run. Parens end a run (Sonar's sequences rule).
			const left = unwrapParens(ts, (node as TS.BinaryExpression).left);
			if (logicalOpKind(ts, left) !== op) cognitive += 1;
			descend(node, nesting);
			return;
		}
		if ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) && node.label) {
			cognitive += 1;
		}
		if (
			recursable &&
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === unitName
		) {
			recursionState.recursed = true;
		}
		descend(node, nesting);
	};

	descend(fn, initialNesting); // start from children: the unit itself scores 0
	if (recursionState.recursed) cognitive += 1;
	return { cognitive, maxNesting };
}

/**
 * Per-function cognitive complexity. Returns null when the optional
 * `typescript` dep is unavailable (metric unavailable — no regex fallback).
 */
export function computeCognitiveAst(
	content: string,
	filePath: string,
): CognitiveComplexityEntry[] | null {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return null;
	return cognitiveEntriesFrom(parsed.ts, parsed.sf);
}

/**
 * Walk an ALREADY-PARSED source file. Exported so sibling analyses that hold
 * a tree (ast-delta's profile) get cognitive totals without a second parse.
 */
export function cognitiveEntriesFrom(ts: TsModule, sf: TS.SourceFile): CognitiveComplexityEntry[] {
	const entries: CognitiveComplexityEntry[] = [];
	const walk = (node: TS.Node, fnDepth: number): void => {
		if (isImplementationFunction(ts, node)) {
			const name = functionName(ts, node, sf);
			const { cognitive, maxNesting } = scoreUnit(ts, node, name, fnDepth);
			entries.push({
				name,
				line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
				endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
				cognitive,
				maxNesting,
				language: "js_ts",
			});
		}
		const nextDepth = isFunctionLike(ts, node) ? fnDepth + 1 : fnDepth;
		ts.forEachChild(node, (child) => walk(child, nextDepth));
	};
	walk(sf, 0);
	entries.sort((a, b) => a.line - b.line);
	return entries;
}

/**
 * Registry detector: warn per function over DEFAULT_MAX_COGNITIVE. The match
 * text is the function's source line plus the score so the warning reads in
 * context; remediation lives in the registry entry's fix_instruction.
 */
export function cognitiveComplexityCheck(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_RE.test(filePath)) return [];
	const entries = computeCognitiveAst(content, filePath);
	if (!entries) return [];
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	for (const e of entries) {
		if (e.cognitive <= DEFAULT_MAX_COGNITIVE) continue;
		const snippet = (lines[e.line - 1] ?? "").trim().slice(0, 90);
		matches.push({
			line: e.line,
			text: `${snippet} — cognitive ${e.cognitive} > ${DEFAULT_MAX_COGNITIVE} (max nesting ${e.maxNesting})`,
		});
	}
	return matches;
}
