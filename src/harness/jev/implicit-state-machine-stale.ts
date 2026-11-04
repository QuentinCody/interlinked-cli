// Implicit state machines: the "stale handle handler" sub-check.
//
// UNMEASURED beyond the design sample (A-state-machines.md: 2/2 after AST
// scoping, n too small). Deterministic, so it ships beside the selector and
// prints without any Jev call.
//
// FIRES WHEN an event handler registered on a handle H held in a local
// (`child.on("exit", …)`) writes the field that owns H, or another lifecycle
// field, directly or through its direct same-scope callee, AND the same
// top-level unit stores H into that field (`this.child = child`), AND the
// field is multi-generation: a new handle is stored outside the constructor
// and the field is also cleared (or stored at two sites). An old handle's late
// event then clobbers the new generation.
// DOES NOT FIRE when the handler, or the direct callee that receives H, compares
// scope state with a captured value (`this.child === child`, `gen !== this.gen`);
// when the handle is stored only in the constructor (one object per handle); when
// the handler is registered on `this.f` rather than a captured local; or when the
// handler writes no lifecycle field.
// KNOWN GAPS: guards in a callee two levels down; handlers passed by reference;
// generation counters held in a factory `let` (only `this.x` and lifecycle fields
// count as scope state on the compared side).

import type * as TS from "typescript";
import { isFunctionLike, parseTsSource, type TsModule } from "../checks/cyclomatic-ast.js";
import { buildModelContext, declaredNames, lineOf, type ModelContext, refOf, type ScopeModel, unwrap } from "./implicit-state-machine-model.js";
import { collectScopes } from "./implicit-state-machine-scopes.js";
import { collectWriterSites } from "./implicit-state-machine-writes.js";

export interface StaleHandleFinding {
	file: string;
	scope: string;
	/** The field that owns the handle. */
	field: string;
	/** The local the handler was registered on. */
	handle: string;
	event: string;
	/** Line of the registration call. */
	line: number;
	/** Lifecycle fields or containers the handler writes (directly or through its direct callee). */
	writes: string[];
	/** Lines where the field receives a new handle. */
	reassignedAt: number[];
}

interface Registration {
	call: TS.CallExpression;
	handle: string;
	event: string;
	cb: TS.ArrowFunction | TS.FunctionExpression;
}

const REGISTER_METHODS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener"]);
const IDENTITY_OPS = new Set(["===", "!==", "==", "!="]);

function forEachNode(ts: TsModule, root: TS.Node, fn: (n: TS.Node) => void, intoFunctions = true): void {
	const visit = (n: TS.Node): void => {
		fn(n);
		if (intoFunctions || !isFunctionLike(ts, n)) ts.forEachChild(n, visit);
	};
	ts.forEachChild(root, visit);
}

/** Handle fields that receive a new handle outside the constructor and are also cleared (or stored twice). */
function multiGenerationFields(ctx: ModelContext, scope: ScopeModel): Map<string, number[]> {
	const out = new Map<string, number[]>();
	const sites = collectWriterSites(ctx, scope).sites;
	for (const f of scope.fields.values()) {
		if (f.kind !== "handle") continue;
		const direct = (sites.get(f.name) ?? []).filter((s) => s.via === undefined);
		const stores = direct.filter((s) => s.value === "set").map((s) => s.line);
		if (stores.length >= 1 && (stores.length >= 2 || direct.some((s) => s.value === "null"))) out.set(f.name, stores);
	}
	return out;
}

function registrationOf(ctx: ModelContext, n: TS.Node): Registration | null {
	const { ts } = ctx;
	if (!ts.isCallExpression(n)) return null;
	const callee = n.expression;
	if (!ts.isPropertyAccessExpression(callee) || !REGISTER_METHODS.has(callee.name.text)) return null;
	const receiver = unwrap(ts, callee.expression);
	if (!ts.isIdentifier(receiver)) return null;
	const cb = n.arguments.find((a): a is TS.ArrowFunction | TS.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
	if (!cb) return null;
	const first = n.arguments[0];
	const event = first && ts.isStringLiteralLike(first) ? first.text : "?";
	return { call: n, handle: receiver.text, event, cb };
}

function topUnit(ctx: ModelContext, scope: ScopeModel, node: TS.Node): TS.Node | null {
	let top: TS.Node | null = null;
	for (let n: TS.Node | undefined = node.parent; n && n !== scope.boundary; n = n.parent) if (isFunctionLike(ctx.ts, n)) top = n;
	return top;
}

/** The multi-generation field the registering unit stores the handle into (`this.f = H`). */
function storedField(ctx: ModelContext, scope: ScopeModel, reg: Registration, multi: Map<string, number[]>): string | null {
	const { ts } = ctx;
	const top = topUnit(ctx, scope, reg.call);
	if (!top) return null;
	let found: string | null = null;
	forEachNode(ts, top, (n) => {
		if (found !== null || !ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
		const rhs = unwrap(ts, n.right);
		const field = refOf(ctx, scope, n.left);
		if (field !== null && multi.has(field) && ts.isIdentifier(rhs) && rhs.text === reg.handle) found = field;
	});
	return found;
}

function writesIn(ctx: ModelContext, scope: ScopeModel, root: TS.Node, intoFunctions: boolean, out: Set<string>): void {
	const { ts } = ctx;
	forEachNode(
		ts,
		root,
		(n) => {
			if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
			const ref = refOf(ctx, scope, n.left);
			if (ref !== null) out.add(ref);
		},
		intoFunctions,
	);
}

function handlerWrites(ctx: ModelContext, scope: ScopeModel, cb: TS.Node): string[] {
	const out = new Set<string>();
	writesIn(ctx, scope, cb, true, out);
	forEachNode(ctx.ts, cb, (n) => {
		const callee = ctx.ts.isCallExpression(n) ? scope.calleeOf(n) : null;
		if (callee) writesIn(ctx, scope, callee, false, out);
	});
	return [...out];
}

function isScopeState(ctx: ModelContext, scope: ScopeModel, e: TS.Expression): boolean {
	const { ts } = ctx;
	if (refOf(ctx, scope, e) !== null) return true;
	return ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword;
}

/** Does `root` compare scope state with an identifier that `accept` approves? */
function comparesIdentity(ctx: ModelContext, scope: ScopeModel, root: TS.Node, accept: (id: TS.Identifier) => boolean): boolean {
	const { ts } = ctx;
	let found = false;
	forEachNode(ts, root, (n) => {
		if (found || !ts.isBinaryExpression(n) || !IDENTITY_OPS.has(n.operatorToken.getText(ctx.sf))) return;
		const [l, r] = [unwrap(ts, n.left), unwrap(ts, n.right)];
		const matches = (a: TS.Expression, b: TS.Expression): boolean => isScopeState(ctx, scope, a) && ts.isIdentifier(b) && accept(b);
		found = matches(l, r) || matches(r, l);
	});
	return found;
}

function isGuarded(ctx: ModelContext, scope: ScopeModel, reg: Registration): boolean {
	const { ts } = ctx;
	const local = declaredNames(ctx, reg.cb);
	if (comparesIdentity(ctx, scope, reg.cb, (id) => !local.has(id.text))) return true;
	let guarded = false;
	forEachNode(ts, reg.cb, (n) => {
		const callee = !guarded && ts.isCallExpression(n) ? scope.calleeOf(n) : null;
		if (!callee || !ts.isCallExpression(n)) return;
		const idx = n.arguments.findIndex((a) => ts.isIdentifier(a) && a.text === reg.handle);
		const param = idx >= 0 ? callee.parameters[idx]?.name : undefined;
		if (param && ts.isIdentifier(param)) guarded = comparesIdentity(ctx, scope, callee, (id) => id.text === param.text);
	});
	return guarded;
}

function staleInScope(ctx: ModelContext, scope: ScopeModel, file: string): StaleHandleFinding[] {
	const multi = multiGenerationFields(ctx, scope);
	if (multi.size === 0) return [];
	const out: StaleHandleFinding[] = [];
	forEachNode(ctx.ts, scope.boundary, (n) => {
		const reg = registrationOf(ctx, n);
		const field = reg ? storedField(ctx, scope, reg, multi) : null;
		if (!reg || field === null) return;
		const writes = handlerWrites(ctx, scope, reg.cb);
		if (writes.length === 0 || isGuarded(ctx, scope, reg)) return;
		out.push({ file, scope: scope.name, field, handle: reg.handle, event: reg.event, line: lineOf(ctx, reg.call), writes, reassignedAt: multi.get(field) ?? [] });
	});
	return out;
}

/** Stale-handle handlers in every class and factory scope of the file; [] when `typescript` is unavailable. */
export function detectStaleHandleHandlers(content: string, filePath: string): StaleHandleFinding[] {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return [];
	const ctx = buildModelContext(parsed.ts, parsed.sf, {});
	return collectScopes(ctx)
		.filter((scope) => scope.kind !== "record")
		.flatMap((scope) => staleInScope(ctx, scope, filePath));
}
