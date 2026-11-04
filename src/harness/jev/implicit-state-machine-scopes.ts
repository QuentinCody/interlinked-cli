// Implicit state machines: scope discovery (class, factory closure, record).
//
// Builds a `ScopeModel` for each class body, each factory closure (a function
// that declares `let` bindings and returns an object literal with a function
// member), and each top-level interface / object type alias that a same-file
// declaration is typed with. Field classification lives in
// `implicit-state-machine-model.ts`; this module only decides which nodes are
// scopes and how a reference resolves to one of their fields.

import type * as TS from "typescript";
import { functionName, isFunctionLike, type TsModule } from "../checks/cyclomatic-ast.js";
import {
	addField,
	declaredNames,
	type FieldSink,
	lineOf,
	type ModelContext,
	type ScopeModel,
	typeRefName,
	unwrap,
} from "./implicit-state-machine-model.js";

type FactoryFn = TS.FunctionDeclaration | TS.FunctionExpression | TS.ArrowFunction;

export function collectScopes(ctx: ModelContext): ScopeModel[] {
	const { ts } = ctx;
	const out: ScopeModel[] = [];
	const visit = (node: TS.Node): void => {
		const scope = scopeFor(ctx, node);
		if (scope) out.push(scope);
		ts.forEachChild(node, visit);
	};
	visit(ctx.sf);
	return out;
}

function scopeFor(ctx: ModelContext, node: TS.Node): ScopeModel | null {
	const { ts } = ctx;
	if (ts.isClassLike(node)) return classScope(ctx, node);
	if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return factoryScope(ctx, node);
	if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.parent === ctx.sf) return recordScope(ctx, node);
	return null;
}

function isFunctionValue(ts: TsModule, e: TS.Expression): e is TS.ArrowFunction | TS.FunctionExpression {
	return ts.isArrowFunction(e) || ts.isFunctionExpression(e);
}

function bindTarget(ts: TsModule, e: TS.Node): TS.Node {
	if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return e;
	return e.expression.name.text === "bind" ? e.expression.expression : e;
}

// ---- class ------------------------------------------------------------------

function thisBelongsTo(ts: TsModule, node: TS.Node, cls: TS.Node): boolean {
	for (let n: TS.Node | undefined = node.parent; n; n = n.parent) {
		if (n === cls) return true;
		if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isClassLike(n)) return false;
		if ((ts.isMethodDeclaration(n) || ts.isAccessor(n)) && !ts.isClassLike(n.parent)) return false;
	}
	return false;
}

function thisMemberName(ts: TsModule, cls: TS.Node, e: TS.Node): string | null {
	if (!ts.isPropertyAccessExpression(e) || e.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
	return thisBelongsTo(ts, e.expression, cls) ? e.name.text : null;
}

function isMutableProperty(ts: TsModule, m: TS.PropertyDeclaration): boolean {
	const flags = ts.getCombinedModifierFlags(m);
	return (flags & (ts.ModifierFlags.Readonly | ts.ModifierFlags.Static)) === 0;
}

function addClassMember(ctx: ModelContext, sink: FieldSink, m: TS.ClassElement): void {
	const { ts } = ctx;
	if (ts.isPropertyDeclaration(m) && isMutableProperty(ts, m) && (ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name))) {
		addField(ctx, sink, m.name.text, m, m);
		return;
	}
	if (!ts.isConstructorDeclaration(m)) return;
	for (const p of m.parameters) {
		const readonly = (ts.getCombinedModifierFlags(p) & ts.ModifierFlags.Readonly) !== 0;
		if (ts.isParameterPropertyDeclaration(p, m) && !readonly && ts.isIdentifier(p.name)) addField(ctx, sink, p.name.text, p, p);
	}
}

function classMethods(ctx: ModelContext, cls: TS.ClassLikeDeclaration): Map<string, TS.FunctionLikeDeclaration> {
	const { ts } = ctx;
	const out = new Map<string, TS.FunctionLikeDeclaration>();
	for (const m of cls.members) {
		if (!m.name || !(ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name))) continue;
		if (ts.isMethodDeclaration(m) && m.body) out.set(m.name.text, m);
		const init = ts.isPropertyDeclaration(m) && m.initializer ? unwrap(ts, m.initializer) : undefined;
		if (init && isFunctionValue(ts, init)) out.set(m.name.text, init);
	}
	return out;
}

function className(ctx: ModelContext, cls: TS.ClassLikeDeclaration): string {
	if (cls.name) return cls.name.text;
	const p = cls.parent;
	return ctx.ts.isVariableDeclaration(p) && ctx.ts.isIdentifier(p.name) ? p.name.text : "(anonymous class)";
}

function classScope(ctx: ModelContext, cls: TS.ClassLikeDeclaration): ScopeModel | null {
	const { ts } = ctx;
	const sink: FieldSink = { fields: new Map(), containers: new Set() };
	for (const m of cls.members) addClassMember(ctx, sink, m);
	if (sink.fields.size === 0) return null;
	const methods = classMethods(ctx, cls);
	return {
		kind: "class",
		name: className(ctx, cls),
		node: cls,
		boundary: cls,
		line: lineOf(ctx, cls),
		...sink,
		fieldOf: (e) => {
			const n = thisMemberName(ts, cls, e);
			return n !== null && (sink.fields.has(n) || sink.containers.has(n)) ? n : null;
		},
		calleeOf: (call) => methods.get(thisMemberName(ts, cls, call.expression) ?? "") ?? null,
		functionRefOf: (e) => {
			const n = thisMemberName(ts, cls, bindTarget(ts, e));
			return n !== null && methods.has(n) ? n : null;
		},
	};
}

// ---- factory closure --------------------------------------------------------

function namedFunctions(ctx: ModelContext, st: TS.Statement): Array<[string, TS.FunctionLikeDeclaration]> {
	const { ts } = ctx;
	if (ts.isFunctionDeclaration(st) && st.name) return [[st.name.text, st]];
	if (!ts.isVariableStatement(st)) return [];
	const out: Array<[string, TS.FunctionLikeDeclaration]> = [];
	for (const d of st.declarationList.declarations) {
		const init = d.initializer ? unwrap(ts, d.initializer) : undefined;
		if (ts.isIdentifier(d.name) && init && isFunctionValue(ts, init)) out.push([d.name.text, init]);
	}
	return out;
}

function innerFunctions(ctx: ModelContext, body: TS.Block): Map<string, TS.FunctionLikeDeclaration> {
	return new Map(body.statements.flatMap((st) => namedFunctions(ctx, st)));
}

function isApiMember(ts: TsModule, p: TS.ObjectLiteralElementLike, inner: Map<string, unknown>): boolean {
	if (ts.isMethodDeclaration(p) || ts.isAccessor(p)) return true;
	if (ts.isShorthandPropertyAssignment(p)) return inner.has(p.name.text);
	if (!ts.isPropertyAssignment(p)) return false;
	const init = unwrap(ts, p.initializer);
	return isFunctionValue(ts, init) || (ts.isIdentifier(init) && inner.has(init.text));
}

function returnsObjectApi(ctx: ModelContext, body: TS.Block, inner: Map<string, unknown>): boolean {
	const { ts } = ctx;
	return body.statements.some((st) => {
		if (!ts.isReturnStatement(st) || !st.expression) return false;
		const obj = unwrap(ts, st.expression);
		return ts.isObjectLiteralExpression(obj) && obj.properties.some((p) => isApiMember(ts, p, inner));
	});
}

function isShadowed(ctx: ModelContext, ident: TS.Identifier, owner: TS.Node): boolean {
	for (let n: TS.Node | undefined = ident.parent; n && n !== owner; n = n.parent) {
		if (isFunctionLike(ctx.ts, n) && declaredNames(ctx, n).has(ident.text)) return true;
	}
	return false;
}

function factoryLets(ctx: ModelContext, body: TS.Block, sink: FieldSink): void {
	const { ts } = ctx;
	for (const st of body.statements) {
		if (!ts.isVariableStatement(st) || (st.declarationList.flags & ts.NodeFlags.Let) === 0) continue;
		for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) addField(ctx, sink, d.name.text, d, d);
	}
}

function factoryScope(ctx: ModelContext, fn: FactoryFn): ScopeModel | null {
	const { ts } = ctx;
	if (!fn.body || !ts.isBlock(fn.body)) return null;
	const inner = innerFunctions(ctx, fn.body);
	if (!returnsObjectApi(ctx, fn.body, inner)) return null;
	const sink: FieldSink = { fields: new Map(), containers: new Set() };
	factoryLets(ctx, fn.body, sink);
	if (sink.fields.size === 0) return null;
	const ident = (e: TS.Node): string | null => (ts.isIdentifier(e) && !isShadowed(ctx, e, fn) ? e.text : null);
	const name = functionName(ts, fn, ctx.sf);
	return {
		kind: "factory",
		name: name === "(callback)" ? "(anonymous factory)" : name,
		node: fn,
		boundary: fn,
		line: lineOf(ctx, fn),
		...sink,
		fieldOf: (e) => {
			const n = ident(e);
			return n !== null && (sink.fields.has(n) || sink.containers.has(n)) ? n : null;
		},
		calleeOf: (call) => inner.get(ident(call.expression) ?? "") ?? null,
		functionRefOf: (e) => {
			const n = ident(bindTarget(ts, e));
			return n !== null && inner.has(n) ? n : null;
		},
	};
}

// ---- record -----------------------------------------------------------------

function declTypeName(ctx: ModelContext, n: TS.ParameterDeclaration | TS.VariableDeclaration): string | null {
	const { ts } = ctx;
	if (n.type) return typeRefName(ts, n.type);
	const init = ts.isVariableDeclaration(n) && n.initializer ? unwrap(ts, n.initializer) : undefined;
	if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return null;
	const f = ctx.functions.get(init.expression.text);
	return f?.type ? typeRefName(ts, f.type) : null;
}

/** Every parameter / variable declaration in the file keyed by its declared (or returned) type name. */
function typedDecls(ctx: ModelContext): Map<string, Set<TS.Node>> {
	if (ctx.typed) return ctx.typed;
	const { ts } = ctx;
	const out = new Map<string, Set<TS.Node>>();
	const visit = (n: TS.Node): void => {
		const t = ts.isParameter(n) || ts.isVariableDeclaration(n) ? declTypeName(ctx, n) : null;
		if (t !== null) out.set(t, (out.get(t) ?? new Set()).add(n));
		ts.forEachChild(n, visit);
	};
	visit(ctx.sf);
	ctx.typed = out;
	return out;
}

/** The declaration an identifier resolves to, searching enclosing functions then the module. */
function resolveDecl(ctx: ModelContext, ident: TS.Identifier): TS.Node | null {
	for (let n: TS.Node | undefined = ident.parent; n; n = n.parent) {
		if (!isFunctionLike(ctx.ts, n) && n !== ctx.sf) continue;
		const d = declaredNames(ctx, n).get(ident.text);
		if (d) return d;
	}
	return null;
}

function isReadonlySignature(ts: TsModule, m: TS.PropertySignature): boolean {
	return (m.modifiers ?? []).some((k) => k.kind === ts.SyntaxKind.ReadonlyKeyword);
}

function recordScope(ctx: ModelContext, decl: TS.InterfaceDeclaration | TS.TypeAliasDeclaration): ScopeModel | null {
	const { ts } = ctx;
	const members = ctx.records.get(decl.name.text);
	const typed = typedDecls(ctx).get(decl.name.text);
	if (!members || !typed) return null;
	const sink: FieldSink = { fields: new Map(), containers: new Set() };
	for (const m of members) {
		if (ts.isPropertySignature(m) && m.type && ts.isIdentifier(m.name) && !isReadonlySignature(ts, m)) addField(ctx, sink, m.name.text, m, m);
	}
	if (sink.fields.size === 0) return null;
	const own = (e: TS.Node): string | null => {
		if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression)) return null;
		const n = e.name.text;
		if (!sink.fields.has(n) && !sink.containers.has(n)) return null;
		const d = resolveDecl(ctx, e.expression);
		return d !== null && typed.has(d) ? n : null;
	};
	return {
		kind: "record",
		name: decl.name.text,
		node: decl,
		boundary: ctx.sf,
		line: lineOf(ctx, decl),
		...sink,
		fieldOf: own,
		calleeOf: (call) => (ts.isIdentifier(call.expression) ? (ctx.functions.get(call.expression.text) ?? null) : null),
		functionRefOf: (e) => (ts.isIdentifier(e) && ctx.functions.has(e.text) ? e.text : null),
	};
}
