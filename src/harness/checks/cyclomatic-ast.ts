// ===========================================
// AST-accurate per-function cyclomatic complexity (JS/TS)
// ===========================================
// The regex walker in `cyclomatic.ts` has two systematic errors a published,
// blockable metric can't carry: it rolls inline-closure complexity into the
// enclosing function (syncCommand counted 118 vs the true 52) and it never
// counts `??`. Both are artifacts of not having real function scope. This
// module computes complexity from the TypeScript AST instead — each
// function-like node is its own unit, nested functions counted separately,
// matching the canonical definition (increments for if / loops / catch / case /
// conditional / `&&` `||` `??`).
//
// `typescript` is declared in `optionalDependencies` (alongside the tsgo
// native-preview), so a normal `npm install` pulls it into a PUBLISHED install —
// the strict cyclomatic gate and CRAP scoring are AST-accurate in production,
// not just dev/CI. It is absent only under `--omit=optional` / `--no-optional`
// or a hand-stripped install; there `loadTs` returns null, callers fall back to
// the (less accurate) regex walker, and `astComplexityAvailable()` reports false
// so the degradation is surfaced (e.g. `interlinked harness status`) rather than
// silent. We load it SYNCHRONOUSLY via createRequire (so
// `computeCyclomaticComplexity` stays sync). The self-contained hook script never
// imports this; the type-only `import type` is erased at build.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { extname } from "node:path";
import type * as TS from "typescript";
import type { FunctionComplexityEntry } from "./cyclomatic.js";

export type TsModule = typeof TS;

let tsCache: TsModule | null | undefined;

/**
 * Resolve `typescript` once, synchronously, treating absence as a non-error.
 * Cached (including the null result) so a missing dep costs one failed require.
 */
function loadTs(): TsModule | null {
	if (tsCache !== undefined) return tsCache;
	try {
		tsCache = createRequire(import.meta.url)("typescript") as TsModule;
	} catch {
		tsCache = null;
	}
	return tsCache;
}

/** True when the optional `typescript` dep is resolvable (→ AST path available). */
export function astComplexityAvailable(): boolean {
	return loadTs() !== null;
}

/** Test-only cache reset so a suite can exercise both the present/absent paths. */
export function __resetTsCacheForTesting(): void {
	tsCache = undefined;
	parseMemo.clear();
}

/**
 * Map a file extension onto the ScriptKind the parser needs. Deliberately the
 * ONLY copy of this table: a `.tsx` file parsed as plain TS mis-reads JSX as
 * type assertions, so a per-check reimplementation is a divergence waiting to
 * happen. Reach it through `parseTsSource` / `parseTsSourceWith`.
 */
function scriptKindFor(ts: TsModule, filePath: string): TS.ScriptKind {
	switch (extname(filePath).toLowerCase()) {
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.ScriptKind.JS;
		default:
			return ts.ScriptKind.TS;
	}
}

export interface ParsedTsSource {
	ts: TsModule;
	sf: TS.SourceFile;
}

/**
 * How many parsed SourceFiles the memo keeps. A SourceFile with parent pointers
 * costs roughly an order of magnitude more memory than its text, and the daemon
 * is long-lived, so this stays deliberately tiny: one tool call touches one or
 * two files but runs a dozen-plus AST checks over them, which is exactly the
 * locality a small LRU serves.
 */
const PARSE_MEMO_MAX = 8;

interface MemoEntry extends ParsedTsSource {
	scriptKind: TS.ScriptKind;
}

/** Insertion-ordered = LRU: a hit re-inserts, an overflow evicts the oldest key. */
const parseMemo = new Map<string, MemoEntry>();

/**
 * Content hash + path + ScriptKind. Never the path alone: the whole point of
 * the per-edit gates is that the SAME path holds different content before and
 * after a write, so a path-keyed cache would hand back the pre-edit AST.
 */
function memoKey(content: string, filePath: string, scriptKind: TS.ScriptKind): string {
	const digest = createHash("sha256").update(content).digest("hex");
	return [digest, filePath, String(scriptKind)].join("|");
}

/**
 * Parse with an already-resolved `typescript` module. Use this from call sites
 * that hold their own `ts` (an injected one in tests, or one loaded before a
 * cheap pre-filter); everything else should call `parseTsSource`.
 *
 * The returned SourceFile is SHARED with other callers, so treat it as
 * read-only: never bind it into a `ts.Program` / `TypeChecker`, which mutates
 * the node graph.
 */
export function parseTsSourceWith(ts: TsModule, content: string, filePath: string): TS.SourceFile {
	const scriptKind = scriptKindFor(ts, filePath);
	const key = memoKey(content, filePath, scriptKind);
	const hit = parseMemo.get(key);
	if (hit && hit.ts === ts) {
		parseMemo.delete(key);
		parseMemo.set(key, hit);
		return hit.sf;
	}
	const sf = ts.createSourceFile(
		filePath,
		content,
		ts.ScriptTarget.Latest,
		/* setParentNodes */ true,
		scriptKind,
	);
	parseMemo.set(key, { ts, sf, scriptKind });
	if (parseMemo.size > PARSE_MEMO_MAX) {
		const oldest = parseMemo.keys().next();
		if (!oldest.done) parseMemo.delete(oldest.value);
	}
	return sf;
}

/**
 * Parse once, sharing the cached optional-`typescript` load. Sibling AST
 * metrics (cognitive complexity) build on this so the degrade-to-null
 * behavior stays defined in exactly one place.
 */
export function parseTsSource(content: string, filePath: string): ParsedTsSource | null {
	const ts = loadTs();
	if (!ts) return null;
	return { ts, sf: parseTsSourceWith(ts, content, filePath) };
}

export function isFunctionLike(ts: TsModule, node: TS.Node): boolean {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

/**
 * A function-like node with an actual body — i.e. an *implementation*. Excludes
 * overload signatures and ambient/interface declarations (bodiless), matching
 * the canonical "per implementation function" definition. Arrow and function
 * expressions always have a body; only declaration kinds can be bodiless.
 */
export function isImplementationFunction(ts: TsModule, node: TS.Node): boolean {
	return isFunctionLike(ts, node) && (node as TS.FunctionLikeDeclaration).body !== undefined;
}

/** Does this node add one to cyclomatic complexity? (Canonical decision set.) */
function isDecisionPoint(ts: TsModule, node: TS.Node): boolean {
	if (
		ts.isIfStatement(node) ||
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node) ||
		ts.isWhileStatement(node) ||
		ts.isDoStatement(node) ||
		ts.isCaseClause(node) || // `default:` (DefaultClause) deliberately excluded
		ts.isCatchClause(node) ||
		ts.isConditionalExpression(node)
	) {
		return true;
	}
	if (ts.isBinaryExpression(node)) {
		const op = node.operatorToken.kind;
		return (
			op === ts.SyntaxKind.AmpersandAmpersandToken ||
			op === ts.SyntaxKind.BarBarToken ||
			op === ts.SyntaxKind.QuestionQuestionToken
		);
	}
	return false;
}

/**
 * Cyclomatic = 1 + decision points inside `fn`'s own body, NOT descending into
 * nested function-likes (they are counted as their own entries).
 */
function complexityOf(ts: TsModule, fn: TS.Node): number {
	let count = 1;
	const visit = (node: TS.Node): void => {
		// A nested function starts its own scope — stop here.
		if (node !== fn && isFunctionLike(ts, node)) return;
		if (isDecisionPoint(ts, node)) count++;
		ts.forEachChild(node, visit);
	};
	// Start from the children so the function node itself isn't miscounted.
	ts.forEachChild(fn, visit);
	return count;
}

/** Best-effort human name; matches the golden dataset's `(callback)` fallback. */
export function functionName(ts: TsModule, node: TS.Node, sf: TS.SourceFile): string {
	if (ts.isConstructorDeclaration(node)) return "constructor";
	const named = node as { name?: TS.Node };
	if (named.name && (ts.isIdentifier(named.name) || ts.isPrivateIdentifier(named.name))) {
		return named.name.getText(sf);
	}
	const parent = node.parent;
	if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
		return parent.name.getText(sf);
	}
	if (ts.isPropertyAssignment(parent)) {
		return parent.name.getText(sf);
	}
	if (ts.isPropertyDeclaration(parent)) {
		return parent.name.getText(sf);
	}
	return "(callback)";
}

/**
 * Per-function cyclomatic complexity via the TS AST. Returns `null` when the
 * optional `typescript` dep is unavailable (caller falls back to the regex
 * walker). Pure apart from the cached module load; never throws on parse errors
 * (TS produces a best-effort tree for malformed input).
 */
export function computeCyclomaticAst(
	content: string,
	filePath: string,
): FunctionComplexityEntry[] | null {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return null;
	const { ts, sf } = parsed;
	const entries: FunctionComplexityEntry[] = [];
	const walk = (node: TS.Node): void => {
		if (isImplementationFunction(ts, node)) {
			entries.push({
				name: functionName(ts, node, sf),
				line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
				endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
				cyclomatic: complexityOf(ts, node),
				language: "js_ts",
			});
		}
		ts.forEachChild(node, walk);
	};
	walk(sf);
	entries.sort((a, b) => a.line - b.line);
	return entries;
}
