// Implicit state machines: the deterministic candidate SELECTOR.
//
// UNMEASURED as a standalone gate: this decides which scopes are worth a Jev
// call, never whether code is wrong. Signature (A-state-machines.md, steps 3–4):
//   FIRE when a scope has ≥ 3 lifecycle fields, ≥ 2 of them (not one-shot
//   latches) have ≥ 2 distinct writer units, and ≥ 1 write is async.
//   EXCLUDE, in order, with a reason code:
//     too-few-fields          < 3 lifecycle fields after dropping debounce
//                             timers and inferred unions with a non-literal write
//     single-writer-function  every direct write sits in one top-level function
//                             (a central reducer without a union)
//     explicit-txn            the module has a discriminated-union reducer
//                             (`switch (txn.kind)`) that the scope calls or holds
//     exhaustive-switch       a `switch` on a lifecycle union ends in a `never` check
//     few-multi-writer-fields < 2 non-latch fields with ≥ 2 writers (a field only
//                             ever set `true` from `false` is a one-shot latch)
//     no-async-writer         no write runs in a callback, `finally` or after `await`
// A status computed by a getter is never stored, so it is never a field.
// Known recall gaps (by construction): a Map of timers / records (one entry per
// key is the machine), and a record whose interface lives in another file.

import type * as TS from "typescript";
import { astComplexityAvailable, isFunctionLike, parseTsSource } from "../checks/cyclomatic-ast.js";
import {
	buildModelContext,
	type FieldDecl,
	leadingDoc,
	type LifecycleKind,
	type ModelContext,
	refOf,
	type ScopeKind,
	type ScopeModel,
	type SelectOptions,
} from "./implicit-state-machine-model.js";
import { collectScopes } from "./implicit-state-machine-scopes.js";
import { calleeName, collectWriterSites, type ScopeWrites, type WriterSite } from "./implicit-state-machine-writes.js";

export const MIN_LIFECYCLE_FIELDS = 3;
export const MIN_MULTI_WRITER_FIELDS = 2;
export const MIN_WRITERS = 2;
export const MAX_COMBINATIONS = 16;

export interface LifecycleField {
	name: string;
	kind: LifecycleKind;
	type: string;
	line: number;
	/** Values used to enumerate combinations. */
	domain: string[];
	writerSites: WriterSite[];
	/** Distinct writer units. */
	writers: number;
	asyncWriter: boolean;
	/** Only ever assigned `true` from a `false` start: a one-shot latch. */
	latch: boolean;
}

export interface Combination {
	id: string;
	values: Record<string, string>;
	/** Writer units that assign ≥ 2 of these fields, all to exactly these values. */
	assignedBy: string[];
}

export interface StateMachineCandidate {
	scope: string;
	scopeKind: ScopeKind;
	file: string;
	line: number;
	fields: LifecycleField[];
	excludedFields: Array<{ name: string; reason: "debounce" | "non-literal-write" }>;
	combinations: Combination[];
	omittedFromCombinations: string[];
	doc: string | null;
	/** Top-level writer units with their line ranges (packet excerpts). */
	units: Array<{ name: string; start: number; end: number }>;
}

export type ScopeReason =
	| "fires"
	| "too-few-fields"
	| "single-writer-function"
	| "explicit-txn"
	| "exhaustive-switch"
	| "few-multi-writer-fields"
	| "no-async-writer";

export interface ScopeVerdict {
	reason: ScopeReason;
	candidate: StateMachineCandidate;
}

interface TxnReducers {
	nodes: TS.Node[];
	names: Set<string>;
}

const DISCRIMINANTS = new Set(["kind", "type", "op", "tag"]);
const NEVER_HELPER_RE = /^(?:assertNever|assertUnreachable|unreachable|exhaustive)/i;

// ---- fields -----------------------------------------------------------------

function domainOf(decl: FieldDecl, sites: WriterSite[]): string[] {
	if (decl.domain.length > 0) return decl.domain;
	const values = [decl.initial, ...sites.map((s) => s.value)].filter((v): v is string => v !== null && v !== "?");
	return [...new Set(values)];
}

function buildFields(scope: ScopeModel, writes: ScopeWrites): Pick<StateMachineCandidate, "fields" | "excludedFields"> {
	const fields: LifecycleField[] = [];
	const excludedFields: StateMachineCandidate["excludedFields"] = [];
	for (const decl of scope.fields.values()) {
		const sites = writes.sites.get(decl.name) ?? [];
		if (sites.length === 0) continue;
		if (decl.inferred && sites.some((s) => s.value === "?")) excludedFields.push({ name: decl.name, reason: "non-literal-write" });
		else if (writes.debounce.has(decl.name)) excludedFields.push({ name: decl.name, reason: "debounce" });
		else fields.push(lifecycleField(decl, sites));
	}
	return { fields, excludedFields };
}

function lifecycleField(decl: FieldDecl, sites: WriterSite[]): LifecycleField {
	return {
		name: decl.name,
		kind: decl.kind,
		type: decl.type,
		line: decl.line,
		domain: domainOf(decl, sites),
		writerSites: sites,
		writers: new Set(sites.map((s) => s.unit)).size,
		asyncWriter: sites.some((s) => s.async !== null),
		latch: decl.kind === "boolean" && decl.initial !== "true" && sites.every((s) => s.value === "true"),
	};
}

// ---- combinations -----------------------------------------------------------

function cartesian(fields: LifecycleField[]): Array<Record<string, string>> {
	if (fields.length === 0) return [];
	let acc: Array<Record<string, string>> = [{}];
	for (const f of fields) acc = acc.flatMap((row) => f.domain.map((v) => ({ ...row, [f.name]: v })));
	return acc;
}

function unitWriteSets(fields: LifecycleField[]): Map<string, Map<string, string>> {
	const out = new Map<string, Map<string, string>>();
	for (const f of fields) {
		for (const s of f.writerSites) {
			if (s.value === "?") continue;
			out.set(s.unit, (out.get(s.unit) ?? new Map<string, string>()).set(f.name, s.value));
		}
	}
	return out;
}

function assignedBy(values: Record<string, string>, writeSets: Map<string, Map<string, string>>): string[] {
	const out: string[] = [];
	for (const [unit, writes] of writeSets) {
		if (writes.size >= 2 && [...writes].every(([f, v]) => values[f] === v)) out.push(unit);
	}
	return out;
}

/** Union fields first (their literals are the documented state names), then by writers; ties: smaller domain first. */
function enumerationOrder(a: LifecycleField, b: LifecycleField): number {
	const union = Number(b.kind === "union") - Number(a.kind === "union");
	return union || b.writers - a.writers || a.domain.length - b.domain.length;
}

/** Product of the chosen fields' domains, capped at MAX_COMBINATIONS; fields that do not fit are listed as omitted. */
export function enumerateCombinations(fields: LifecycleField[]): Pick<StateMachineCandidate, "combinations" | "omittedFromCombinations"> {
	const ordered = [...fields].sort(enumerationOrder);
	const chosen: LifecycleField[] = [];
	const omitted: string[] = [];
	let product = 1;
	for (const f of ordered) {
		if (f.domain.length < 2 || product * f.domain.length > MAX_COMBINATIONS) {
			omitted.push(f.name);
			continue;
		}
		chosen.push(f);
		product *= f.domain.length;
	}
	const writeSets = unitWriteSets(chosen);
	const combinations = cartesian(chosen).map((values, i) => ({ id: `c${i + 1}`, values, assignedBy: assignedBy(values, writeSets) }));
	return { combinations, omittedFromCombinations: omitted };
}

// ---- exclusions -------------------------------------------------------------

function someNode(ts: ModelContext["ts"], root: TS.Node, pred: (n: TS.Node) => boolean): boolean {
	if (pred(root)) return true;
	return ts.forEachChild(root, (c) => (someNode(ts, c, pred) ? true : undefined)) === true;
}

function discriminantsOf(ctx: ModelContext, t: TS.TypeNode): Set<string> {
	const { ts } = ctx;
	const members = ts.isTypeLiteralNode(t) ? t.members : ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) ? ctx.records.get(t.typeName.text) : undefined;
	const out = new Set<string>();
	for (const m of members ?? []) {
		if (!ts.isPropertySignature(m) || !m.type || !ts.isIdentifier(m.name) || !DISCRIMINANTS.has(m.name.text)) continue;
		if (ts.isLiteralTypeNode(m.type) && ts.isStringLiteral(m.type.literal)) out.add(m.name.text);
	}
	return out;
}

function isDiscriminatedUnion(ctx: ModelContext, t: TS.TypeNode): boolean {
	if (!ctx.ts.isUnionTypeNode(t) || t.types.length < 2) return false;
	const sets = t.types.map((m) => discriminantsOf(ctx, m));
	return [...(sets[0] ?? [])].some((d) => sets.every((s) => s.has(d)));
}

function reducerOf(ctx: ModelContext, sw: TS.SwitchStatement, unions: Set<string>): TS.Node | null {
	const { ts } = ctx;
	const e = sw.expression;
	if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression) || !DISCRIMINANTS.has(e.name.text)) return null;
	const target = e.expression.text;
	let fn: TS.Node | undefined = sw.parent;
	while (fn && !isFunctionLike(ts, fn)) fn = fn.parent;
	if (!fn || !isFunctionLike(ts, fn)) return null;
	const param = fn.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === target);
	const typeName = param?.type && ts.isTypeReferenceNode(param.type) && ts.isIdentifier(param.type.typeName) ? param.type.typeName.text : null;
	return typeName !== null && unions.has(typeName) ? fn : null;
}

/** The names a reducer is called by: its own name and the variable that holds it. */
function reducerNames(ts: ModelContext["ts"], fn: TS.Node): string[] {
	const out: string[] = [];
	if (isFunctionLike(ts, fn) && fn.name && ts.isIdentifier(fn.name)) out.push(fn.name.text);
	if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) out.push(fn.parent.name.text);
	return out;
}

/** Functions that `switch` on the discriminant of a same-file discriminated-union parameter. */
function txnReducers(ctx: ModelContext): TxnReducers {
	const { ts } = ctx;
	const unions = new Set([...ctx.aliases].filter(([, t]) => isDiscriminatedUnion(ctx, t)).map(([name]) => name));
	const out: TxnReducers = { nodes: [], names: new Set() };
	if (unions.size === 0) return out;
	const visit = (n: TS.Node): void => {
		const fn = ts.isSwitchStatement(n) ? reducerOf(ctx, n, unions) : null;
		if (fn) {
			out.nodes.push(fn);
			for (const name of reducerNames(ts, fn)) out.names.add(name);
		}
		ts.forEachChild(n, visit);
	};
	visit(ctx.sf);
	return out;
}

function usesExplicitTxn(ctx: ModelContext, scope: ScopeModel, txn: TxnReducers): boolean {
	const { ts } = ctx;
	if (txn.nodes.length === 0) return false;
	if (scope.kind === "record") return true;
	const holds = txn.nodes.some((fn) => someNode(ts, scope.node, (n) => n === fn));
	return holds || someNode(ts, scope.node, (n) => ts.isCallExpression(n) && txn.names.has(calleeName(ts, n.expression) ?? ""));
}

function isNeverCheck(ctx: ModelContext, n: TS.Node): boolean {
	const { ts } = ctx;
	const neverType = (t: TS.TypeNode | undefined): boolean => t?.kind === ts.SyntaxKind.NeverKeyword;
	if (ts.isVariableDeclaration(n) || ts.isSatisfiesExpression(n) || ts.isAsExpression(n)) return neverType(n.type);
	return ts.isCallExpression(n) && ts.isIdentifier(n.expression) && NEVER_HELPER_RE.test(n.expression.text);
}

function hasExhaustiveSwitch(ctx: ModelContext, scope: ScopeModel, fields: LifecycleField[]): boolean {
	const { ts } = ctx;
	const unions = new Set(fields.filter((f) => f.kind === "union").map((f) => f.name));
	if (unions.size === 0) return false;
	return someNode(ts, scope.boundary, (n) => {
		if (!ts.isSwitchStatement(n) || !unions.has(refOf(ctx, scope, n.expression) ?? "")) return false;
		const dflt = n.caseBlock.clauses.find((c) => ts.isDefaultClause(c));
		return dflt !== undefined && someNode(ts, dflt, (x) => isNeverCheck(ctx, x));
	});
}

function reasonFor(ctx: ModelContext, scope: ScopeModel, fields: LifecycleField[], txn: TxnReducers): ScopeReason {
	if (fields.length < MIN_LIFECYCLE_FIELDS) return "too-few-fields";
	const tops = new Set(fields.flatMap((f) => f.writerSites.filter((s) => s.via === undefined).map((s) => s.top)));
	if (tops.size <= 1) return "single-writer-function";
	if (usesExplicitTxn(ctx, scope, txn)) return "explicit-txn";
	if (hasExhaustiveSwitch(ctx, scope, fields)) return "exhaustive-switch";
	const multi = fields.filter((f) => !f.latch && f.writers >= MIN_WRITERS).length;
	if (multi < MIN_MULTI_WRITER_FIELDS) return "few-multi-writer-fields";
	return fields.some((f) => f.asyncWriter) ? "fires" : "no-async-writer";
}

// ---- assembly ---------------------------------------------------------------

function scopeDoc(ctx: ModelContext, scope: ScopeModel, fields: LifecycleField[]): string | null {
	const docs = [leadingDoc(ctx, scope.node)];
	for (const f of fields) {
		const decl = scope.fields.get(f.name)?.decl;
		if (decl) docs.push(leadingDoc(ctx, decl));
		for (const word of f.type.split(/[^\w$]+/)) {
			const alias = ctx.aliasDecls.get(word);
			if (alias) docs.push(leadingDoc(ctx, alias));
		}
	}
	const unique = [...new Set(docs.filter((d): d is string => d !== null))];
	return unique.length > 0 ? unique.join("\n") : null;
}

function verdictFor(ctx: ModelContext, scope: ScopeModel, file: string, txn: TxnReducers): ScopeVerdict {
	const writes = collectWriterSites(ctx, scope);
	const { fields, excludedFields } = buildFields(scope, writes);
	const candidate: StateMachineCandidate = {
		scope: scope.name,
		scopeKind: scope.kind,
		file,
		line: scope.line,
		fields,
		excludedFields,
		...enumerateCombinations(fields),
		doc: scopeDoc(ctx, scope, fields),
		units: [...writes.units].map(([name, r]) => ({ name, ...r })),
	};
	return { reason: reasonFor(ctx, scope, fields, txn), candidate };
}

/** True when the optional `typescript` package is present; otherwise every result is NOT MEASURED. */
export function stateMachineSelectorAvailable(): boolean {
	return astComplexityAvailable();
}

/** Every scope in the file with its reason code; `null` = NOT MEASURED (no `typescript`). */
export function explainStateMachineScopes(content: string, filePath: string, options: SelectOptions = {}): ScopeVerdict[] | null {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return null;
	const ctx = buildModelContext(parsed.ts, parsed.sf, options);
	const txn = txnReducers(ctx);
	return collectScopes(ctx).map((scope) => verdictFor(ctx, scope, filePath, txn));
}

/** The scopes that fire. Empty both when nothing fires and when NOT MEASURED — check `stateMachineSelectorAvailable()`. */
export function selectStateMachineCandidates(content: string, filePath: string, options: SelectOptions = {}): StateMachineCandidate[] {
	return (explainStateMachineScopes(content, filePath, options) ?? []).filter((v) => v.reason === "fires").map((v) => v.candidate);
}
