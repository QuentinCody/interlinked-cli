// Discriminant-type resolution for the exhaustiveness check: AST-only
// resolution of a switch discriminant expression's type to a literal-tag
// list, plus the type-alias indexing that backs named-union lookups.

import { findDeclaredTypeForIdentifier } from "./exhaustiveness-scope-lookup.js";

type TsModule = typeof import("typescript");

const DISCRIMINANT_KEYS = ["kind", "type", "tag", "variant", "_tag"] as const;

export interface LiteralUnion {
	/** Sorted, deduped literal forms (quoted strings for `string`, digits for `number`). */
	members: string[];
}

export interface DiscriminatedUnion {
	/** The shared discriminant property name (kind / type / tag / variant / _tag). */
	discriminant: string;
	/** Sorted, deduped literal tag values for that property across members. */
	tags: string[];
}

export interface ResolutionContext {
	localUnions: Map<string, LiteralUnion>;
	localDiscriminated: Map<string, DiscriminatedUnion>;
}

type ResolvedRaw =
	| { kind: "union"; value: LiteralUnion }
	| { kind: "discriminated"; value: DiscriminatedUnion };

export interface ResolvedDiscriminant {
	/** Discriminant key name when resolved via discriminated union, else undefined. */
	discriminant?: string;
	tags: string[];
}

// ---------------------------------------------------------------------------
// Type-alias indexing
// ---------------------------------------------------------------------------

export function indexTypeAliases<T>(
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
export function typeNodeToLiteralUnion(
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
export function typeNodeToDiscriminatedUnion(
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
// Expression-type resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the static type of `expr` to a literal-union tag list. AST-only:
 * inline annotations on the discriminant, type aliases in the same file,
 * parameter/variable declarations in enclosing scope.
 */
export function resolveExpressionType(
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
