// Implicit state machines: writer sites per lifecycle field.
//
// For one scope, every assignment to a lifecycle field becomes a WriterSite:
// the writer unit (method, inner function, callback, `finally` block), the
// normalized value written, and whether the write runs asynchronously:
//   event    inside a callback passed to `.on/.once/.addListener/…`
//   timer    inside a callback passed to `setTimeout/setInterval/…`
//   promise  inside a callback passed to `.then/.catch/.finally`
//   finally  inside a `finally` block of an async function
//   await    after an `await` in the same async function
// A same-scope function passed by reference (`this.m`, `this.m.bind(this)`,
// `m`) to one of those calls makes its own writes async of that kind.
// Constructor, factory-body and module-level writes are initialization and
// produce no site. One level of same-scope calls is followed: a caller of
// `this.m()` is also a writer of every field `m` writes directly (`via`).

import type * as TS from "typescript";
import { functionName, isFunctionLike, type TsModule } from "../checks/cyclomatic-ast.js";
import { lineOf, type ModelContext, plainValue, refOf, type ScopeModel, stateProps, unwrap } from "./implicit-state-machine-model.js";

export type AsyncKind = "event" | "timer" | "promise" | "finally" | "await";

export interface WriterSite {
	/** Writer unit, outermost first: `ensureSpawned › on(exit)`. */
	unit: string;
	/** Outermost unit below the scope (class member, inner function, module function). */
	top: string;
	line: number;
	/** Normalized value: `"ready"`, `true`, `false`, `null`, `set`, or `?` (not a literal). */
	value: string;
	async: AsyncKind | null;
	/** Callee name when the write is attributed through a one-level call. */
	via?: string;
}

export interface ScopeWrites {
	sites: Map<string, WriterSite[]>;
	/** Handle fields armed only as a cleared/guarded timer: debounce slots, not lifecycle state. */
	debounce: Set<string>;
	/** Line range of each top-level writer unit, for packet excerpts. */
	units: Map<string, { start: number; end: number }>;
}

interface Unit {
	label: string;
	top: string;
	topNode: TS.Node | null;
	fn: TS.Node | null;
	async: AsyncKind | null;
	init: boolean;
}

interface UnitWalk {
	labels: string[];
	fn: TS.Node | null;
	topNode: TS.Node | null;
	async: AsyncKind | null;
	sawFinally: boolean;
}

interface ArmStats {
	arms: number;
	guarded: number;
	other: number;
}

const EVENT_METHODS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener", "addEventListener"]);
const TIMER_FNS = new Set(["setTimeout", "setInterval", "setImmediate", "queueMicrotask", "nextTick"]);
const PROMISE_METHODS = new Set(["then", "catch", "finally"]);
const ARM_FNS = new Set(["setTimeout", "setInterval", "setImmediate"]);
const CLEAR_FNS = new Set(["clearTimeout", "clearInterval", "clearImmediate"]);

export function calleeName(ts: TsModule, e: TS.Expression): string | null {
	if (ts.isIdentifier(e)) return e.text;
	if (ts.isPropertyAccessExpression(e)) return e.name.text;
	return null;
}

/** The async kind of a call's callbacks: event registration, timer, or promise continuation. */
export function callKind(ts: TsModule, call: TS.CallExpression): AsyncKind | null {
	const name = calleeName(ts, call.expression);
	if (name === null) return null;
	if (EVENT_METHODS.has(name)) return "event";
	if (TIMER_FNS.has(name)) return "timer";
	return PROMISE_METHODS.has(name) ? "promise" : null;
}

function callbackKind(ts: TsModule, fn: TS.Node): AsyncKind | null {
	if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !ts.isCallExpression(fn.parent)) return null;
	return fn.parent.arguments.some((a) => a === fn) ? callKind(ts, fn.parent) : null;
}

function isAsyncFunction(ts: TsModule, fn: TS.Node): boolean {
	return ts.canHaveModifiers(fn) && (ts.getModifiers(fn) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

function isAssignment(ts: TsModule, n: TS.Node): n is TS.BinaryExpression {
	if (!ts.isBinaryExpression(n)) return false;
	const k = n.operatorToken.kind;
	return (
		k === ts.SyntaxKind.EqualsToken ||
		k === ts.SyntaxKind.BarBarEqualsToken ||
		k === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
		k === ts.SyntaxKind.QuestionQuestionEqualsToken
	);
}

function isReturnLike(ts: TsModule, st: TS.Statement): boolean {
	if (ts.isReturnStatement(st)) return true;
	return ts.isBlock(st) && st.statements[0] !== undefined && ts.isReturnStatement(st.statements[0]);
}

class SiteCollector {
	readonly out: ScopeWrites = { sites: new Map(), debounce: new Set(), units: new Map() };
	private readonly raw: Array<{ at: TS.BinaryExpression; name: string }> = [];
	private readonly calls: TS.CallExpression[] = [];
	private readonly cbRefs = new Map<string, AsyncKind>();
	private readonly direct = new Map<TS.Node, Map<string, Set<string>>>();
	private readonly containerWrites = new Map<TS.Node, Set<string>>();
	private readonly awaits = new Map<TS.Node, number[]>();
	private readonly arms = new Map<string, ArmStats>();

	constructor(
		private readonly ctx: ModelContext,
		private readonly scope: ScopeModel,
	) {}

	run(): ScopeWrites {
		const { ts } = this.ctx;
		const visit = (n: TS.Node): void => {
			if (isAssignment(ts, n)) this.noteAssignment(n);
			else if (ts.isCallExpression(n)) this.noteCall(n);
			ts.forEachChild(n, visit);
		};
		ts.forEachChild(this.scope.boundary, visit);
		for (const r of this.raw) this.addDirect(r.at, r.name);
		for (const call of this.calls) this.follow(call);
		for (const [name, s] of this.arms) if (s.arms > 0 && s.other === 0 && s.guarded === s.arms) this.out.debounce.add(name);
		return this.out;
	}

	private noteAssignment(n: TS.BinaryExpression): void {
		const name = refOf(this.ctx, this.scope, n.left);
		if (name !== null) this.raw.push({ at: n, name });
	}

	private noteCall(call: TS.CallExpression): void {
		this.calls.push(call);
		const kind = callKind(this.ctx.ts, call);
		if (!kind) return;
		for (const arg of call.arguments) {
			const ref = this.scope.functionRefOf(arg);
			if (ref !== null && !this.cbRefs.has(ref)) this.cbRefs.set(ref, kind);
		}
	}

	private push(name: string, site: WriterSite): void {
		const list = this.out.sites.get(name);
		if (list) list.push(site);
		else this.out.sites.set(name, [site]);
	}

	private noteDirect(fn: TS.Node, name: string, value: string): void {
		const byField = this.direct.get(fn) ?? new Map<string, Set<string>>();
		byField.set(name, (byField.get(name) ?? new Set()).add(value));
		this.direct.set(fn, byField);
	}

	private recordUnit(unit: Unit): void {
		const node = unit.topNode;
		if (!node || this.out.units.has(unit.top)) return;
		const end = this.ctx.sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
		this.out.units.set(unit.top, { start: lineOf(this.ctx, node), end });
	}

	private addDirect(at: TS.BinaryExpression, name: string): void {
		const unit = this.unitOf(at);
		if (unit.init || unit.fn === null) return;
		this.recordUnit(unit);
		const line = lineOf(this.ctx, at);
		const base = { unit: unit.label, top: unit.top, line, async: unit.async };
		const field = this.scope.fields.get(name);
		if (field) {
			const value = plainValue(this.ctx, at.right) ?? (field.kind === "handle" || field.kind === "slot" ? "set" : "?");
			this.push(name, { ...base, value });
			this.noteDirect(unit.fn, name, value);
			if (field.kind === "handle" && value !== "null") this.noteArm(at, unit.fn, name);
		}
		if (!this.scope.containers.has(name)) return;
		this.containerWrites.set(unit.fn, (this.containerWrites.get(unit.fn) ?? new Set()).add(name));
		for (const [prop, lit] of stateProps(this.ctx, at.right)) {
			const sub = `${name}.${prop}`;
			if (!this.scope.fields.has(sub)) continue;
			this.push(sub, { ...base, value: lit });
			this.noteDirect(unit.fn, sub, lit);
		}
	}

	private follow(call: TS.CallExpression): void {
		const callee = this.scope.calleeOf(call);
		if (!callee) return;
		const unit = this.unitOf(call);
		if (unit.init || unit.fn === callee) return;
		this.recordUnit(unit);
		const via = functionName(this.ctx.ts, callee, this.ctx.sf);
		const base = { unit: unit.label, top: unit.top, line: lineOf(this.ctx, call), async: unit.async, via };
		for (const [name, values] of this.direct.get(callee) ?? []) {
			const only = values.size === 1 ? [...values][0] : undefined;
			this.push(name, { ...base, value: only ?? "?" });
		}
		for (const container of this.containerWrites.get(callee) ?? []) {
			for (const [prop, lit] of stateProps(this.ctx, call.arguments[0])) {
				const sub = `${container}.${prop}`;
				if (this.scope.fields.has(sub)) this.push(sub, { ...base, value: lit });
			}
		}
	}

	// ---- debounce timers ----------------------------------------------------

	private noteArm(at: TS.BinaryExpression, fn: TS.Node, name: string): void {
		const { ts } = this.ctx;
		const stats = this.arms.get(name) ?? { arms: 0, guarded: 0, other: 0 };
		const rhs = unwrap(ts, at.right);
		const armed = ts.isCallExpression(rhs) && ARM_FNS.has(calleeName(ts, rhs.expression) ?? "");
		if (!armed) stats.other++;
		else if (this.armGuarded(fn, name, at)) {
			stats.arms++;
			stats.guarded++;
		} else stats.arms++;
		this.arms.set(name, stats);
	}

	private containsRef(node: TS.Node, field: string): boolean {
		if (refOf(this.ctx, this.scope, node) === field) return true;
		return this.ctx.ts.forEachChild(node, (c) => (this.containsRef(c, field) ? true : undefined)) === true;
	}

	private isClearOrGuard(n: TS.Node, field: string): boolean {
		const { ts } = this.ctx;
		if (ts.isCallExpression(n) && CLEAR_FNS.has(calleeName(ts, n.expression) ?? "")) {
			const arg = n.arguments[0];
			return arg !== undefined && refOf(this.ctx, this.scope, arg) === field;
		}
		return ts.isIfStatement(n) && isReturnLike(ts, n.thenStatement) && this.containsRef(n.expression, field);
	}

	/** Does `fn` clear the timer, or return early while one is pending, before arming it at `at`? */
	private armGuarded(fn: TS.Node, field: string, at: TS.Node): boolean {
		const { ts, sf } = this.ctx;
		const limit = at.getStart(sf);
		let found = false;
		const visit = (n: TS.Node): void => {
			if (found || n.getStart(sf) >= limit) return;
			if (this.isClearOrGuard(n, field)) found = true;
			else if (!isFunctionLike(ts, n)) ts.forEachChild(n, visit);
		};
		ts.forEachChild(fn, visit);
		return found;
	}

	// ---- writer units -------------------------------------------------------

	private unitOf(site: TS.Node): Unit {
		const walk: UnitWalk = { labels: [], fn: null, topNode: null, async: null, sawFinally: false };
		let child: TS.Node = site;
		for (let n: TS.Node | undefined = site.parent; n && n !== this.scope.boundary; n = n.parent) {
			this.step(walk, n, child, site);
			child = n;
		}
		const { ts } = this.ctx;
		const top = walk.topNode ? this.fnLabel(walk.topNode) : "(body)";
		const init = walk.topNode === null || ts.isConstructorDeclaration(walk.topNode);
		const async = walk.async ?? this.cbRefs.get(top) ?? null;
		return { label: walk.labels.join(" › "), top, topNode: walk.topNode, fn: walk.fn, async, init };
	}

	private step(walk: UnitWalk, n: TS.Node, child: TS.Node, site: TS.Node): void {
		const { ts } = this.ctx;
		if (ts.isTryStatement(n) && n.finallyBlock === child) {
			walk.labels.unshift("finally");
			walk.sawFinally = true;
			return;
		}
		if (!isFunctionLike(ts, n)) return;
		walk.labels.unshift(this.fnLabel(n));
		walk.fn ??= n;
		walk.topNode = n;
		walk.async ??= this.asyncAt(n, site, walk.sawFinally);
		walk.sawFinally = false;
	}

	private fnLabel(n: TS.Node): string {
		const { ts, sf } = this.ctx;
		const name = functionName(ts, n, sf);
		if (name !== "(callback)" || !ts.isCallExpression(n.parent)) return name;
		const call = n.parent;
		const callee = calleeName(ts, call.expression) ?? "call";
		const first = call.arguments[0];
		return first && ts.isStringLiteralLike(first) ? `${callee}(${first.text})` : `${callee}(cb)`;
	}

	private asyncAt(fn: TS.Node, site: TS.Node, sawFinally: boolean): AsyncKind | null {
		const { ts } = this.ctx;
		const cb = callbackKind(ts, fn);
		if (cb) return cb;
		if (!isAsyncFunction(ts, fn)) return null;
		if (sawFinally) return "finally";
		const end = site.getEnd();
		return this.awaitEnds(fn).some((e) => e <= end) ? "await" : null;
	}

	private awaitEnds(fn: TS.Node): number[] {
		const hit = this.awaits.get(fn);
		if (hit) return hit;
		const { ts } = this.ctx;
		const out: number[] = [];
		const visit = (n: TS.Node): void => {
			if (ts.isAwaitExpression(n)) out.push(n.getEnd());
			else if (ts.isForOfStatement(n) && n.awaitModifier) out.push(n.expression.getEnd());
			if (!isFunctionLike(ts, n)) ts.forEachChild(n, visit);
		};
		ts.forEachChild(fn, visit);
		this.awaits.set(fn, out);
		return out;
	}
}

/** Every post-initialization write to a lifecycle field of `scope`, plus its debounce timers and unit ranges. */
export function collectWriterSites(ctx: ModelContext, scope: ScopeModel): ScopeWrites {
	return new SiteCollector(ctx, scope).run();
}
