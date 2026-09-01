// Discriminated-union exhaustiveness check.
//
// Flags TS `switch` statements on a literal-union or discriminated-union typed
// value when exhaustiveness is NOT asserted in the default branch. Strategy:
//   1. Cheap text gate (no `switch (` token → bail).
//   2. Parse via `ts.createSourceFile` (cheap, no Program build).
//   3. Walk SwitchStatement nodes; resolve discriminant type via AST-only
//      heuristics (inline annotations, parameter/variable type, type-alias
//      lookup in the same file). When the type can't be resolved syntactically
//      we skip — heuristic, false-negative-friendly.
//   4. For unions of ≥2 literal members, check case coverage + default-branch
//      assertion (never-typed assignment, assertNever, UnreachableError throw).
//
// Bias: aim for the "added a union member, forgot a case, no assertNever
// default" bug shape without firing on boolean switches, typeof narrowing,
// runtime parsing of unknown input, or numeric-discriminated fully-covered
// switches.

import { createRequire } from "node:module";
import { parseTsSourceWith } from "./cyclomatic-ast.js";
import { getExtension, type InlineMatch, isTestFile } from "./shared.js";

// `typescript` is a devDep; load lazily so the check is a no-op in
// environments where the package is missing.
type TsModule = typeof import("typescript");
const nodeRequire = createRequire(import.meta.url);
let _tsCache: TsModule | null | undefined;

function loadTs(): TsModule | null {
	if (_tsCache !== undefined) return _tsCache;
	try {
		_tsCache = nodeRequire("typescript") as TsModule;
	} catch {
		_tsCache = null;
	}
	return _tsCache;
}

/** Test-only hook so unit tests can simulate `typescript` being unavailable. */
export function __resetTsCacheForTesting(): void {
	_tsCache = undefined;
}

const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const DISCRIMINANT_KEYS = ["kind", "type", "tag", "variant", "_tag"] as const;
const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;

interface LiteralUnion {
	/** Sorted, deduped literal forms (quoted strings for `string`, digits for `number`). */
	members: string[];
}

interface DiscriminatedUnion {
	/** The shared discriminant property name (kind / type / tag / variant / _tag). */
	discriminant: string;
	/** Sorted, deduped literal tag values for that property across members. */
	tags: string[];
}

interface ResolutionContext {
	localUnions: Map<string, LiteralUnion>;
	localDiscriminated: Map<string, DiscriminatedUnion>;
}

type ResolvedRaw =
	| { kind: "union"; value: LiteralUnion }
	| { kind: "discriminated"; value: DiscriminatedUnion };

interface ResolvedDiscriminant {
	/** Discriminant key name when resolved via discriminated union, else undefined. */
	discriminant?: string;
	tags: string[];
}

/**
 * Detect TS switch statements on discriminated unions that lack an
 * exhaustiveness assertion in the default branch. No-op outside .ts/.tsx/.mts/
 * .cts, in test files, and when the `typescript` package is unavailable.
 */
export function checkDiscriminatedUnionExhaustiveness(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!SUPPORTED_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	if (!/\bswitch\s*\(/.test(content)) return [];

	const maybeTs = loadTs();
	if (!maybeTs) return [];
	const ts: TsModule = maybeTs;

	const sourceFile = parseTsSourceWith(ts, content, filePath);

	const lines = sourceLineTexts(sourceFile, content);
	const matches: InlineMatch[] = [];
	const ctx: ResolutionContext = {
		localUnions: indexTypeAliases(ts, sourceFile, typeNodeToLiteralUnion),
		localDiscriminated: indexTypeAliases(ts, sourceFile, typeNodeToDiscriminatedUnion),
	};

	const visit = (node: import("typescript").Node): void => {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		if (ts.isSwitchStatement(node)) {
			const finding = analyzeSwitch(ts, node, sourceFile, lines, ctx);
			if (finding) matches.push(finding);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	return matches;
}

/**
 * Split `content` on TypeScript's OWN line terminators, not `split("\n")`.
 *
 * The reported line index comes from `getLineAndCharacterOfPosition`, and TS's
 * scanner breaks lines on a lone CR and on U+2028 / U+2029 as well as LF. An
 * LF-only split therefore desynchronizes from that index on such files: the
 * index runs past the end of the split view, so the source snippet silently
 * degrades to the empty string. Deriving both from the same line table keeps
 * `lines[line]` in range for every position the parser can hand back.
 */
function sourceLineTexts(
	sourceFile: import("typescript").SourceFile,
	content: string,
): string[] {
	const starts = sourceFile.getLineStarts();
	return starts.map((start, i) => content.slice(start, starts[i + 1] ?? content.length));
}

// ---------------------------------------------------------------------------
// Type-alias indexing
// ---------------------------------------------------------------------------

function indexTypeAliases<T>(
	ts: TsModule,
	sourceFile: import("typescript").SourceFile,
	convert: (ts: TsModule, node: import("typescript").TypeNode) => T | null,
): Map<string, T> {
	const out = new Map<string, T>();
	const walk = (node: import("typescript").Node): void => {
		if (ts.isTypeAliasDeclaration(node)) {
			const v = convert(ts, node.type);
			if (v) out.set(node.name.text, v);
		}
		ts.forEachChild(node, walk);
	};
	walk(sourceFile);
	return out;
}

/** `A | B | C` where every constituent is a string/number literal type. */
function typeNodeToLiteralUnion(
	ts: TsModule,
	node: import("typescript").TypeNode,
): LiteralUnion | null {
	if (!ts.isUnionTypeNode(node) || node.types.length < 2) return null;
	const members: string[] = [];
	for (const t of node.types) {
		const m = literalTypeMemberText(ts, t);
		if (m === null) return null;
		members.push(m);
	}
	return { members: Array.from(new Set(members)).sort() };
}

/** Read a string/number literal type as its case-tag text; null otherwise. */
function literalTypeMemberText(
	ts: TsModule,
	node: import("typescript").TypeNode,
): string | null {
	if (!ts.isLiteralTypeNode(node)) return null;
	const lit = node.literal;
	if (ts.isStringLiteral(lit)) return JSON.stringify(lit.text);
	if (ts.isNumericLiteral(lit)) return lit.text;
	// Boolean literal members make the union `boolean`; skip via null.
	return null;
}

/**
 * `{ kind: 'a', ... } | { kind: 'b', ... }` where every constituent has the
 * same literal-typed discriminant property at a recognized key.
 */
function typeNodeToDiscriminatedUnion(
	ts: TsModule,
	node: import("typescript").TypeNode,
): DiscriminatedUnion | null {
	if (!ts.isUnionTypeNode(node) || node.types.length < 2) return null;
	const perKey = new Map<string, string[]>();
	for (const t of node.types) {
		const lit = unwrapTypeLiteral(ts, t);
		if (!lit) return null;
		for (const key of DISCRIMINANT_KEYS) {
			const tag = readLiteralPropTag(ts, lit, key);
			if (tag === null) continue;
			let acc = perKey.get(key);
			if (!acc) {
				acc = [];
				perKey.set(key, acc);
			}
			acc.push(tag);
		}
	}
	for (const key of DISCRIMINANT_KEYS) {
		const tags = perKey.get(key);
		if (!tags || tags.length !== node.types.length) continue;
		const deduped = Array.from(new Set(tags)).sort();
		if (deduped.length >= 2) return { discriminant: key, tags: deduped };
	}
	return null;
}

function unwrapTypeLiteral(
	ts: TsModule,
	node: import("typescript").TypeNode,
): import("typescript").TypeLiteralNode | null {
	if (ts.isTypeLiteralNode(node)) return node;
	if (ts.isParenthesizedTypeNode(node)) return unwrapTypeLiteral(ts, node.type);
	return null;
}

/** Read the literal type of `<key>` on a TypeLiteralNode, or null. */
function readLiteralPropTag(
	ts: TsModule,
	lit: import("typescript").TypeLiteralNode,
	key: string,
): string | null {
	for (const member of lit.members) {
		if (!ts.isPropertySignature(member)) continue;
		const n = member.name;
		const propName = ts.isIdentifier(n) ? n.text : ts.isStringLiteral(n) ? n.text : null;
		if (propName !== key) continue;
		if (!member.type) return null;
		return literalTypeMemberText(ts, member.type);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Switch analysis
// ---------------------------------------------------------------------------

function analyzeSwitch(
	ts: TsModule,
	node: import("typescript").SwitchStatement,
	sourceFile: import("typescript").SourceFile,
	lines: string[],
	ctx: ResolutionContext,
): InlineMatch | null {
	const expr = node.expression;
	// `switch (typeof x)` — type-narrow style; not the bug shape we target.
	if (ts.isTypeOfExpression(expr)) return null;

	const resolved = resolveExpressionType(ts, expr, ctx);
	if (!resolved || resolved.tags.length < 2) return null;

	const caseTags = new Set<string>();
	let defaultClause: import("typescript").DefaultClause | null = null;
	for (const clause of node.caseBlock.clauses) {
		if (ts.isDefaultClause(clause)) {
			defaultClause = clause;
			continue;
		}
		const tag = caseExpressionToLiteralTag(ts, clause.expression);
		if (tag !== null) caseTags.add(tag);
	}

	const missing = resolved.tags.filter((t) => !caseTags.has(t));
	if (missing.length === 0) return null; // Fully covered by cases.
	if (defaultClause && defaultBranchAssertsNever(ts, defaultClause, sourceFile)) {
		return null;
	}

	const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	const lineNo = line + 1;
	const raw = (lines[line] ?? "").trim();
	const missingDisplay = missing.slice(0, 3).join(", ") + (missing.length > 3 ? ", …" : "");
	const detail = resolved.discriminant
		? `discriminated union on \`${resolved.discriminant}\` missing case(s): ${missingDisplay}`
		: `union missing case(s): ${missingDisplay}`;
	return {
		line: lineNo,
		text: `${raw.slice(0, REPORT_LINE_TRUNC)} — ${detail}`.slice(0, 200),
	};
}

/**
 * Resolve the static type of `expr` to a literal-union tag list. AST-only:
 * inline annotations on the discriminant, type aliases in the same file,
 * parameter/variable declarations in enclosing scope.
 */
function resolveExpressionType(
	ts: TsModule,
	expr: import("typescript").Expression,
	ctx: ResolutionContext,
): ResolvedDiscriminant | null {
	if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) {
		return resolveTypeNode(ts, expr.type, ctx);
	}
	if (ts.isIdentifier(expr)) {
		const declType = findDeclaredTypeForIdentifier(ts, expr);
		return declType ? resolveTypeNode(ts, declType, ctx) : null;
	}
	// `x.kind` — when x's declared type is a discriminated union keyed on
	// `kind`, the case tags are the discriminant's literal values.
	if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
		const propName = expr.name.text;
		const baseDeclType = findDeclaredTypeForIdentifier(ts, expr.expression);
		if (!baseDeclType) return null;
		const base = resolveTypeNodeRaw(ts, baseDeclType, ctx);
		if (base?.kind === "discriminated" && base.value.discriminant === propName) {
			return { discriminant: propName, tags: base.value.tags };
		}
	}
	return null;
}

function resolveTypeNode(
	ts: TsModule,
	typeNode: import("typescript").TypeNode,
	ctx: ResolutionContext,
): ResolvedDiscriminant | null {
	const raw = resolveTypeNodeRaw(ts, typeNode, ctx);
	if (!raw) return null;
	if (raw.kind === "union") return { tags: raw.value.members };
	// Switch directly on a discriminated-union-typed expression: agent
	// would have to switch on `.kind`, not the whole value. Skip.
	return null;
}

function resolveTypeNodeRaw(
	ts: TsModule,
	typeNode: import("typescript").TypeNode,
	ctx: ResolutionContext,
): ResolvedRaw | null {
	const inline = typeNodeToLiteralUnion(ts, typeNode);
	if (inline) return { kind: "union", value: inline };
	const inlineDU = typeNodeToDiscriminatedUnion(ts, typeNode);
	if (inlineDU) return { kind: "discriminated", value: inlineDU };
	if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
		const name = typeNode.typeName.text;
		const u = ctx.localUnions.get(name);
		if (u) return { kind: "union", value: u };
		const du = ctx.localDiscriminated.get(name);
		if (du) return { kind: "discriminated", value: du };
	}
	return null;
}

/**
 * Walk up from `ident` to find a parameter/variable declaration with a type.
 * Each enclosing scope is checked for a matching parameter first, then a
 * matching variable declaration — the two searches are extracted below
 * because the node kinds they match are mutually exclusive (a node is never
 * both a function-like and a block/source-file/module-block), so trying both
 * per scope and taking whichever hits reproduces the original nested-if
 * behavior exactly.
 */
function findDeclaredTypeForIdentifier(
	ts: TsModule,
	ident: import("typescript").Identifier,
): import("typescript").TypeNode | null {
	const name = ident.text;
	// TS's own `.d.ts` declares `Node.parent` as non-optional (`Node`), but at
	// runtime the root `SourceFile` node (and any unbound synthetic node) has
	// `parent === undefined` — the declared type lies. Widen it back to
	// `Node | undefined` here so the loop guard below stays real.
	let current = ident.parent as import("typescript").Node | undefined;
	while (current) {
		const paramType = findParamType(ts, current, name);
		if (paramType) return paramType;
		const varType = findVarType(ts, current, name);
		if (varType) return varType;
		current = current.parent;
	}
	return null;
}

/**
 * Node kinds `findDeclaredTypeForIdentifier` treats as a parameter scope: any
 * function-like declaration whose parameter list may declare `name`.
 */
type ParamScopeNode =
	| import("typescript").FunctionDeclaration
	| import("typescript").FunctionExpression
	| import("typescript").ArrowFunction
	| import("typescript").MethodDeclaration
	| import("typescript").ConstructorDeclaration
	| import("typescript").GetAccessorDeclaration
	| import("typescript").SetAccessorDeclaration;

function isParamScopeNode(
	ts: TsModule,
	node: import("typescript").Node,
): node is ParamScopeNode {
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

/** Search a function-like node's own parameter list for `name`'s declared type. */
function findParamType(
	ts: TsModule,
	node: import("typescript").Node,
	name: string,
): import("typescript").TypeNode | null {
	if (!isParamScopeNode(ts, node)) return null;
	for (const param of node.parameters) {
		if (ts.isIdentifier(param.name) && param.name.text === name && param.type) {
			return param.type;
		}
	}
	return null;
}

/**
 * Node kinds `findDeclaredTypeForIdentifier` treats as a variable-statement
 * scope: block bodies, module (namespace) bodies, and the source file itself.
 */
type StatementScopeNode =
	| import("typescript").Block
	| import("typescript").SourceFile
	| import("typescript").ModuleBlock;

function isStatementScopeNode(
	ts: TsModule,
	node: import("typescript").Node,
): node is StatementScopeNode {
	return ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node);
}

/** Search a block/module/source-file's own statement list for `name`'s declared type. */
function findVarType(
	ts: TsModule,
	node: import("typescript").Node,
	name: string,
): import("typescript").TypeNode | null {
	if (!isStatementScopeNode(ts, node)) return null;
	for (const stmt of node.statements) {
		if (!ts.isVariableStatement(stmt)) continue;
		for (const decl of stmt.declarationList.declarations) {
			if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.type) {
				return decl.type;
			}
		}
	}
	return null;
}

/** Convert a `case <expr>:` expression to its tag form, or null. */
function caseExpressionToLiteralTag(
	ts: TsModule,
	expr: import("typescript").Expression,
): string | null {
	if (ts.isStringLiteralLike(expr)) return JSON.stringify(expr.text);
	if (ts.isNumericLiteral(expr)) return expr.text;
	if (ts.isNoSubstitutionTemplateLiteral(expr)) return JSON.stringify(expr.text);
	// `case -1:` / `case +2:`. Both are PrefixUnaryExpressions, never numeric
	// literals — treating only the minus form as a tag made `case +2:` invisible
	// and reported an exhaustive switch as missing that member.
	if (ts.isPrefixUnaryExpression(expr) && ts.isNumericLiteral(expr.operand)) {
		if (expr.operator === ts.SyntaxKind.MinusToken) return `-${expr.operand.text}`;
		if (expr.operator === ts.SyntaxKind.PlusToken) return expr.operand.text;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Default-branch assertion detection
// ---------------------------------------------------------------------------

const ASSERT_NEVER_RE = /\b(?:assertNever|exhaustiveCheck|absurd|unreachable)\b/;
const UNREACHABLE_THROW_RE = /\bthrow\s+new\s+\w*(?:Unreachable|Exhaustive|Impossible|Assertion)\w*/i;

/**
 * Recognized shapes:
 *   - `const _: never = <expr>;`
 *   - `assertNever(<expr>)` (or aliases above)
 *   - `throw new UnreachableError(...)` / `Exhaustive…Error` / etc.
 *   - any `return assertNever(...)` / `throw assertNever(...)` variant
 *   - any of the above inside a braced clause body (`default: { … }`)
 */
function defaultBranchAssertsNever(
	ts: TsModule,
	clause: import("typescript").DefaultClause,
	sourceFile: import("typescript").SourceFile,
): boolean {
	return statementsAssertNever(ts, clause.statements, sourceFile);
}

/**
 * Scan a statement list for one of the recognized idioms, descending into a
 * bare `{ … }` block. `default: { const _x: never = c; throw … }` is the FIRST
 * idiom this check's own `fix_instruction` recommends, and the clause then
 * holds a single Block — scanning only the top level reported the recommended
 * fix as a finding. Descent is limited to plain blocks: an assertion buried in
 * an `if`/`try` body is conditional, so it still does not count. Per-statement
 * idiom matching (everything except block descent) lives in
 * `matchesAssertNeverIdiom` — a `Block` statement can never itself satisfy any
 * of those idioms (mutually exclusive `SyntaxKind`s), so recursing and moving
 * on via `continue` is equivalent to falling through the old combined checks.
 */
function statementsAssertNever(
	ts: TsModule,
	statements: readonly import("typescript").Statement[],
	sourceFile: import("typescript").SourceFile,
): boolean {
	for (const stmt of statements) {
		if (ts.isBlock(stmt)) {
			if (statementsAssertNever(ts, stmt.statements, sourceFile)) return true;
			continue;
		}
		if (matchesAssertNeverIdiom(ts, stmt, sourceFile)) return true;
	}
	return false;
}

/**
 * Does a single (non-block) statement match one of the recognized
 * exhaustiveness-assertion idioms on its own?
 *   - `const _: never = <expr>;`
 *   - `assertNever(<expr>)` (or aliases above), as an expression statement or
 *     as `return assertNever(<expr>)`
 *   - `throw new UnreachableError(...)` / `Exhaustive…Error` / etc.
 *   - `throw assertNever(...)` / `throw exhaustiveCheck(...)` variants
 */
function matchesAssertNeverIdiom(
	ts: TsModule,
	stmt: import("typescript").Statement,
	sourceFile: import("typescript").SourceFile,
): boolean {
	if (ts.isVariableStatement(stmt)) {
		for (const decl of stmt.declarationList.declarations) {
			if (decl.type && decl.type.kind === ts.SyntaxKind.NeverKeyword) return true;
		}
	}
	if (ts.isThrowStatement(stmt)) {
		if (ts.isNewExpression(stmt.expression)) {
			const exprText = stmt.expression.expression.getText(sourceFile);
			if (UNREACHABLE_THROW_RE.test(`throw new ${exprText}`)) return true;
		}
		if (ts.isCallExpression(stmt.expression)) {
			if (ASSERT_NEVER_RE.test(stmt.expression.expression.getText(sourceFile))) return true;
		}
	}
	if (
		(ts.isExpressionStatement(stmt) || ts.isReturnStatement(stmt)) &&
		stmt.expression &&
		ts.isCallExpression(stmt.expression)
	) {
		if (ASSERT_NEVER_RE.test(stmt.expression.expression.getText(sourceFile))) return true;
	}
	return false;
}
