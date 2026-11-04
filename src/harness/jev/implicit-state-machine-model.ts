// Implicit state machines: lifecycle-field model (one file, AST).
//
// The first stage of the deterministic candidate SELECTOR behind the Jev
// state-machine check (`implicit-state-machine.ts`). It classifies mutable
// LIFECYCLE FIELDS and decides nothing; `implicit-state-machine-scopes.ts`
// finds the scopes that own them. Design, signature and FP sources:
// scratch/2026-11-03-prompts-eval/A-state-machines.md ("Fold-in").
//
// Lifecycle kinds:
//   union    a string-literal union (declared, also through a same-file alias),
//            or an initializer literal whose every write is a literal
//   boolean  typed `boolean`, or initialized `true` / `false`
//   handle   nullable timer / child process / server / socket / watcher /
//            promise
//   slot     any other nullable object reference. OFF unless the
//            `nullableSlots` option is set: a measured variant, not the design.
// A member of an object-typed field whose name is state-like (`status.state`)
// is a union sub-field; the holder (`status`) is then a "container".

import type * as TS from "typescript";
import { isFunctionLike, type TsModule } from "../checks/cyclomatic-ast.js";

export type LifecycleKind = "union" | "boolean" | "handle" | "slot";
export type ScopeKind = "class" | "factory" | "record";

export interface SelectOptions {
	/** Variant: count a nullable non-primitive, non-handle field as a lifecycle "slot". Default false. */
	nullableSlots?: boolean;
}

interface Classified {
	kind: LifecycleKind;
	type: string;
	/** Declared values (`"ready"`, `true`, `set`, `null`); empty when inferred from writes. */
	domain: string[];
	/** A union inferred from a literal initializer: every write must also be a literal. */
	inferred: boolean;
}

export interface FieldDecl extends Classified {
	name: string;
	/** Normalized initializer value, or null when there is none. */
	initial: string | null;
	line: number;
	decl: TS.Node;
}

export interface ModelContext {
	ts: TsModule;
	sf: TS.SourceFile;
	options: SelectOptions;
	aliases: Map<string, TS.TypeNode>;
	aliasDecls: Map<string, TS.Node>;
	consts: Map<string, string>;
	records: Map<string, readonly TS.TypeElement[]>;
	functions: Map<string, TS.FunctionLikeDeclaration>;
	declCache: WeakMap<TS.Node, Map<string, TS.Node>>;
	typed?: Map<string, Set<TS.Node>>;
}

export interface ScopeModel {
	kind: ScopeKind;
	name: string;
	node: TS.Node;
	/** The node that ends an upward walk from a write (the scope node; the source file for records). */
	boundary: TS.Node;
	line: number;
	fields: Map<string, FieldDecl>;
	/** Fields that are not lifecycle fields but hold one (`status` for `status.state`). */
	containers: Set<string>;
	/** Field or container name that `expr` refers to in this scope, else null. */
	fieldOf(expr: TS.Node): string | null;
	/** Same-scope function a call resolves to (the one-level follow). */
	calleeOf(call: TS.CallExpression): TS.FunctionLikeDeclaration | null;
	/** Name of the same-scope function a callback reference (`this.m`, `m`, `m.bind(…)`) names. */
	functionRefOf(expr: TS.Node): string | null;
}

export type FieldSink = Pick<ScopeModel, "fields" | "containers">;
type FieldSyntax = { type?: TS.TypeNode | undefined; initializer?: TS.Expression | undefined; questionToken?: TS.QuestionToken | undefined };

const STATE_PROPS = new Set(["state", "status", "phase", "stage", "lifecycle", "mode"]);
const HANDLE_TYPES = new Set([
	"Timeout",
	"Timer",
	"Immediate",
	"ChildProcess",
	"ChildProcessWithoutNullStreams",
	"ChildProcessByStdio",
	"Server",
	"Socket",
	"FSWatcher",
	"StatWatcher",
	"Worker",
	"WebSocket",
	"Promise",
]);
/** `ReturnType<typeof X>` is a handle when X is one of these factories. */
const HANDLE_FACTORIES = new Set([
	"setTimeout",
	"setInterval",
	"setImmediate",
	"createServer",
	"createConnection",
	"connect",
	"spawn",
	"fork",
	"watch",
]);

export function lineOf(ctx: ModelContext, node: TS.Node): number {
	return ctx.sf.getLineAndCharacterOfPosition(node.getStart(ctx.sf)).line + 1;
}

/** Strip parentheses, `as`, `satisfies`, `!` and `<T>` wrappers. */
export function unwrap(ts: TsModule, e: TS.Expression): TS.Expression {
	let cur = e;
	while (
		ts.isParenthesizedExpression(cur) ||
		ts.isAsExpression(cur) ||
		ts.isSatisfiesExpression(cur) ||
		ts.isNonNullExpression(cur) ||
		ts.isTypeAssertionExpression(cur)
	) {
		cur = cur.expression;
	}
	return cur;
}

/** A string literal, or a module `const` initialized with one, as a JSON-quoted value. */
export function literalOf(ctx: ModelContext, e: TS.Expression): string | null {
	const x = unwrap(ctx.ts, e);
	if (ctx.ts.isStringLiteralLike(x)) return JSON.stringify(x.text);
	if (!ctx.ts.isIdentifier(x)) return null;
	const v = ctx.consts.get(x.text);
	return v === undefined ? null : JSON.stringify(v);
}

/** Normalized value of an initializer or a write: a literal, `true`, `false`, `null`, else null. */
export function plainValue(ctx: ModelContext, e: TS.Expression): string | null {
	const { ts } = ctx;
	const x = unwrap(ts, e);
	if (x.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(x)) return "null";
	if (ts.isIdentifier(x) && x.text === "undefined") return "null";
	if (x.kind === ts.SyntaxKind.TrueKeyword) return "true";
	if (x.kind === ts.SyntaxKind.FalseKeyword) return "false";
	return literalOf(ctx, x);
}

export function buildModelContext(ts: TsModule, sf: TS.SourceFile, options: SelectOptions): ModelContext {
	const ctx: ModelContext = {
		ts,
		sf,
		options,
		aliases: new Map(),
		aliasDecls: new Map(),
		consts: new Map(),
		records: new Map(),
		functions: new Map(),
		declCache: new WeakMap(),
	};
	for (const st of sf.statements) indexStatement(ctx, st);
	return ctx;
}

function indexStatement(ctx: ModelContext, st: TS.Statement): void {
	const { ts } = ctx;
	if (ts.isTypeAliasDeclaration(st)) {
		ctx.aliases.set(st.name.text, st.type);
		ctx.aliasDecls.set(st.name.text, st);
		if (ts.isTypeLiteralNode(st.type)) ctx.records.set(st.name.text, st.type.members);
	} else if (ts.isInterfaceDeclaration(st)) {
		ctx.records.set(st.name.text, st.members);
	} else if (ts.isFunctionDeclaration(st) && st.name) {
		ctx.functions.set(st.name.text, st);
	} else if (ts.isVariableStatement(st)) {
		const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
		for (const d of st.declarationList.declarations) indexVariable(ctx, d, isConst);
	}
}

function indexVariable(ctx: ModelContext, d: TS.VariableDeclaration, isConst: boolean): void {
	const { ts } = ctx;
	if (!ts.isIdentifier(d.name) || !d.initializer) return;
	const init = unwrap(ts, d.initializer);
	if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ctx.functions.set(d.name.text, init);
	else if (isConst && ts.isStringLiteralLike(init)) ctx.consts.set(d.name.text, init.text);
}

// ---- type classification ----------------------------------------------------

function unionParts(ts: TsModule, t: TS.TypeNode): TS.TypeNode[] {
	if (ts.isParenthesizedTypeNode(t)) return unionParts(ts, t.type);
	if (ts.isUnionTypeNode(t)) return t.types.flatMap((m) => unionParts(ts, m));
	return [t];
}

function isNullish(ts: TsModule, t: TS.TypeNode): boolean {
	if (t.kind === ts.SyntaxKind.UndefinedKeyword) return true;
	return ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword;
}

function literalMember(ctx: ModelContext, p: TS.TypeNode, depth: number): string[] | null {
	const { ts } = ctx;
	if (ts.isLiteralTypeNode(p) && ts.isStringLiteral(p.literal)) return [JSON.stringify(p.literal.text)];
	if (depth > 3 || !ts.isTypeReferenceNode(p) || !ts.isIdentifier(p.typeName)) return null;
	const alias = ctx.aliases.get(p.typeName.text);
	if (!alias) return null;
	return literalMembers(ctx, unionParts(ts, alias).filter((m) => !isNullish(ts, m)), depth + 1);
}

function literalMembers(ctx: ModelContext, parts: TS.TypeNode[], depth: number): string[] | null {
	const out: string[] = [];
	for (const p of parts) {
		const vals = literalMember(ctx, p, depth);
		if (!vals) return null;
		out.push(...vals);
	}
	return out.length > 0 ? out : null;
}

export function typeRefName(ts: TsModule, t: TS.TypeNode): string | null {
	if (!ts.isTypeReferenceNode(t)) return null;
	return ts.isIdentifier(t.typeName) ? t.typeName.text : t.typeName.right.text;
}

function isHandleFactoryReturn(ts: TsModule, t: TS.TypeReferenceNode): boolean {
	const arg = t.typeArguments?.[0];
	if (!arg || !ts.isTypeQueryNode(arg)) return false;
	const q = arg.exprName;
	return HANDLE_FACTORIES.has(ts.isIdentifier(q) ? q.text : q.right.text);
}

function isHandleType(ctx: ModelContext, t: TS.TypeNode): boolean {
	const { ts } = ctx;
	const name = typeRefName(ts, t);
	if (name === null || !ts.isTypeReferenceNode(t)) return false;
	return HANDLE_TYPES.has(name) || (name === "ReturnType" && isHandleFactoryReturn(ts, t));
}

function isSlotType(ctx: ModelContext, rest: TS.TypeNode[]): boolean {
	const { ts } = ctx;
	return rest.every((p) => ts.isTypeLiteralNode(p) || (ts.isTypeReferenceNode(p) && !isHandleType(ctx, p)));
}

function classifyType(ctx: ModelContext, t: TS.TypeNode, optional: boolean): Classified | null {
	const { ts } = ctx;
	const parts = unionParts(ts, t);
	const rest = parts.filter((p) => !isNullish(ts, p));
	const nullable = optional || rest.length < parts.length;
	const type = t.getText(ctx.sf);
	const first = rest[0];
	if (first === undefined) return null;
	if (rest.length === 1 && first.kind === ts.SyntaxKind.BooleanKeyword) {
		return { kind: "boolean", type, domain: ["true", "false"], inferred: false };
	}
	const lits = literalMembers(ctx, rest, 0);
	const domain = lits && nullable ? [...lits, "null"] : lits;
	if (domain && domain.length >= 2) return { kind: "union", type, domain, inferred: false };
	if (!nullable || lits) return null;
	if (rest.length === 1 && isHandleType(ctx, first)) return { kind: "handle", type, domain: ["set", "null"], inferred: false };
	if (ctx.options.nullableSlots && isSlotType(ctx, rest)) return { kind: "slot", type, domain: ["set", "null"], inferred: false };
	return null;
}

function classifyInit(ctx: ModelContext, init: TS.Expression | undefined): Classified | null {
	if (!init) return null;
	const v = plainValue(ctx, init);
	if (v === "true" || v === "false") return { kind: "boolean", type: "boolean", domain: ["true", "false"], inferred: false };
	if (v !== null && v !== "null") return { kind: "union", type: "(literal)", domain: [], inferred: true };
	return null;
}

function membersOf(ctx: ModelContext, t: TS.TypeNode | undefined): readonly TS.TypeElement[] {
	if (!t) return [];
	if (ctx.ts.isTypeLiteralNode(t)) return t.members;
	const name = typeRefName(ctx.ts, t);
	return name === null ? [] : (ctx.records.get(name) ?? []);
}

function subFieldsFromType(ctx: ModelContext, t: TS.TypeNode | undefined): Array<[string, Classified]> {
	const { ts } = ctx;
	const out: Array<[string, Classified]> = [];
	for (const m of membersOf(ctx, t)) {
		if (!ts.isPropertySignature(m) || !m.type || !ts.isIdentifier(m.name) || !STATE_PROPS.has(m.name.text)) continue;
		const c = classifyType(ctx, m.type, m.questionToken !== undefined);
		if (c?.kind === "union") out.push([m.name.text, c]);
	}
	return out;
}

/** `{ state: "ready", … }` → [["state", "\"ready\""]] for every state-like property with a literal value. */
export function stateProps(ctx: ModelContext, e: TS.Expression | undefined): Array<[string, string]> {
	const { ts } = ctx;
	const obj = e ? unwrap(ts, e) : undefined;
	if (!obj || !ts.isObjectLiteralExpression(obj)) return [];
	const out: Array<[string, string]> = [];
	for (const p of obj.properties) {
		if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) || !STATE_PROPS.has(p.name.text)) continue;
		const lit = literalOf(ctx, p.initializer);
		if (lit !== null) out.push([p.name.text, lit]);
	}
	return out;
}

function subFields(ctx: ModelContext, decl: FieldSyntax): Array<[string, Classified]> {
	const typed = subFieldsFromType(ctx, decl.type);
	if (typed.length > 0) return typed;
	return stateProps(ctx, decl.initializer).map(([prop]) => [prop, { kind: "union", type: "(literal)", domain: [], inferred: true }]);
}

/** Classify one declared field (and its state-like sub-fields) into the scope's field table. */
export function addField(ctx: ModelContext, sink: FieldSink, name: string, decl: FieldSyntax, node: TS.Node): void {
	const c = decl.type ? classifyType(ctx, decl.type, decl.questionToken !== undefined) : classifyInit(ctx, decl.initializer);
	const line = lineOf(ctx, node);
	if (c) {
		const initial = decl.initializer ? plainValue(ctx, decl.initializer) : null;
		sink.fields.set(name, { ...c, name, initial, line, decl: node });
	}
	const initSubs = new Map(stateProps(ctx, decl.initializer));
	for (const [prop, sc] of subFields(ctx, decl)) {
		sink.fields.set(`${name}.${prop}`, { ...sc, name: `${name}.${prop}`, initial: initSubs.get(prop) ?? null, line, decl: node });
		sink.containers.add(name);
	}
}

/** A field or container reference, including `x.f.state` for a sub-field of container `f`. */
export function refOf(ctx: ModelContext, scope: ScopeModel, e: TS.Node): string | null {
	const direct = scope.fieldOf(e);
	if (direct !== null) return direct;
	if (!ctx.ts.isPropertyAccessExpression(e)) return null;
	const holder = scope.fieldOf(e.expression);
	if (holder === null) return null;
	const sub = `${holder}.${e.name.text}`;
	return scope.fields.has(sub) ? sub : null;
}

// ---- declarations -----------------------------------------------------------

function addBindingNames(ts: TsModule, name: TS.BindingName, decl: TS.Node, out: Map<string, TS.Node>): void {
	if (ts.isIdentifier(name)) {
		out.set(name.text, decl);
		return;
	}
	for (const el of name.elements) if (ts.isBindingElement(el)) addBindingNames(ts, el.name, decl, out);
}

/** Names declared directly in `fn` (parameters and declarations not inside a nested function). Cached. */
export function declaredNames(ctx: ModelContext, fn: TS.Node): Map<string, TS.Node> {
	const hit = ctx.declCache.get(fn);
	if (hit) return hit;
	const { ts } = ctx;
	const out = new Map<string, TS.Node>();
	const visit = (n: TS.Node): void => {
		if (ts.isVariableDeclaration(n)) addBindingNames(ts, n.name, n, out);
		else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) out.set(n.name.text, n);
		if (!isFunctionLike(ts, n)) ts.forEachChild(n, visit);
	};
	if (isFunctionLike(ts, fn)) {
		for (const p of fn.parameters) addBindingNames(ts, p.name, p, out);
		if (fn.body) ts.forEachChild(fn.body, visit);
	} else {
		ts.forEachChild(fn, visit);
	}
	ctx.declCache.set(fn, out);
	return out;
}

/** The JSDoc block(s) directly above `node`, or above the statement that holds a variable-held function. */
export function leadingDoc(ctx: ModelContext, node: TS.Node): string | null {
	const { ts } = ctx;
	let target: TS.Node = node;
	while (target.parent && (ts.isVariableDeclaration(target.parent) || ts.isVariableDeclarationList(target.parent) || ts.isVariableStatement(target.parent))) {
		target = target.parent;
	}
	const text = ctx.sf.text;
	const docs = (ts.getLeadingCommentRanges(text, target.getFullStart()) ?? [])
		.map((r) => text.slice(r.pos, r.end))
		.filter((t) => t.startsWith("/**"));
	return docs.length > 0 ? docs.join("\n") : null;
}
