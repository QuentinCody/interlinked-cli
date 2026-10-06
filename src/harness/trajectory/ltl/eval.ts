// ===========================================
// Trajectory LTL — residual-progression evaluator
// ===========================================
//
// Ported in design from Bombadil's `bombadil-ltl/src/{eval.rs,stop.rs}`
// (Antithesis, MIT License — https://github.com/antithesishq/bombadil); the
// TypeScript is a re-implementation, no code copied. Each event rewrites a
// property's formula into its RESIDUAL: the obligation that remains for the
// rest of the trace. A residual that is `false` is a violation.
//
// Kept from Bombadil: `always` stays alive after a violation (it re-arms and
// can report again); a false outcome travels with a CONTINUATION through
// `and` / `implies` and is absorbed by `or` / `eventually`; identical pending
// obligations are merged so an unbounded `always(eventually(p))` cannot grow
// without limit; violations carry only the evidence the atoms read.
//
// Different from Bombadil (deliberate, see the intake notes):
//   * bounds count EVENTS, not wall-clock time;
//   * an obligation spawned inside a bounded window is kept until it resolves
//     (Bombadil drops the pending list when `end < time`);
//   * `until` / `release` exist; a refuted one does not re-arm;
//   * end of trace is THREE-valued (residual.ts): `always` pending ⇒ true,
//     `eventually` / `until` / `next` pending ⇒ `unknown`, never a silent pass
//     (Bombadil's `stop_default` is unwired, so an unbounded `eventually` that
//     never fired was not reported at all);
//   * reports are de-duplicated per (property, onset) — the trial saw 530
//     reports of one cause without it.

import type { Atom, Binary, Formula } from "./formula.js";
import { recordReads } from "./read-set.js";
import {
	type AtomEvidence,
	asFormula,
	type EndMode,
	type EndVerdict,
	endOfResidual,
	type LtlObligation,
	type RawViolation,
	type Residual,
	residualKey,
	residualSize,
	type StepVerdict,
	type TemporalResidual,
} from "./residual.js";

export type { AtomEvidence, EndMode, EndVerdict, StepVerdict } from "./residual.js";

export interface LtlViolation {
	readonly property: string;
	/** Event index at which the failing obligation became active. */
	readonly onset: number;
	/** Event index at which the failure was confirmed. */
	readonly at: number;
	readonly evidence: readonly AtomEvidence[];
}

export interface Property<S, E> {
	readonly id: string;
	readonly formula: Formula<S, E>;
}

export interface PropertyReport {
    readonly unavailable?: string;
	readonly id: string;
	readonly verdict: StepVerdict;
	/** New, de-duplicated violations confirmed at this event. */
	readonly violations: readonly LtlViolation[];
}

export interface EndReport {
    readonly unavailable?: string;
	readonly id: string;
	/** LTL3 verdict: `unknown` whenever anything is still pending. */
	readonly verdict: EndVerdict;
	/** The same fold with a pending `always` / `release` read as satisfied; `unknown` here
	 *  means a STRONG obligation (`eventually` / `until` / `next`) is still open. */
	readonly leaning: EndVerdict;
}

// ---------------------------------------------------------------------------
// Outcomes (internal)
// ---------------------------------------------------------------------------

type Outcome<S, E> =
	| { readonly kind: "true"; readonly evidence: readonly AtomEvidence[] }
	| { readonly kind: "false"; readonly violations: readonly RawViolation[]; readonly continuation: Residual<S, E> | null }
	| { readonly kind: "pending"; readonly residual: Residual<S, E> };

interface Ctx<S, E> {
	readonly state: S;
	readonly event: E;
	readonly index: number;
}

const ok = <S, E>(evidence: readonly AtomEvidence[]): Outcome<S, E> => ({ kind: "true", evidence });
const pending = <S, E>(residual: Residual<S, E>): Outcome<S, E> => ({ kind: "pending", residual });
const failed = <S, E>(violations: readonly RawViolation[], continuation: Residual<S, E> | null): Outcome<S, E> => ({
	kind: "false",
	violations,
	continuation,
});
const trueResidual = <S, E>(evidence: readonly AtomEvidence[]): Residual<S, E> => ({ kind: "true", evidence });

function evidenceOf<S, E>(o: Outcome<S, E>): readonly AtomEvidence[] {
	if (o.kind === "true") return o.evidence;
	if (o.kind === "false") return o.violations.flatMap((v) => v.evidence);
	return [];
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

function evalAtom<S extends object, E extends object>(a: Atom<S, E>, ctx: Ctx<S, E>): Outcome<S, E> {
	const rec = recordReads(ctx.state, ctx.event);
	const raw = a.pred(rec.state, rec.event) === true;
	const value = raw !== a.negated;
	const evidence: AtomEvidence = { name: a.name, negated: a.negated, value, reads: rec.reads() };
	return value ? ok([evidence]) : failed([{ onset: ctx.index, evidence: [evidence] }], null);
}

// ---------------------------------------------------------------------------
// Boolean combinators over outcomes
// ---------------------------------------------------------------------------

function combineAnd<S, E>(l: Outcome<S, E>, r: Outcome<S, E>): Outcome<S, E> {
	if (l.kind === "true" && r.kind === "true") return ok([...l.evidence, ...r.evidence]);
	if (l.kind === "true") return r;
	if (r.kind === "true") return l;
	if (l.kind === "pending" && r.kind === "pending") return pending({ kind: "and", left: l.residual, right: r.residual });
	if (l.kind === "false" && r.kind === "false") {
		return failed([...l.violations, ...r.violations], joinContinuations("and", l.continuation, r.continuation));
	}
	return falseBesidePending(l, r);
}

/** and(false, pending): the violation travels on, the pending side joins its continuation. */
function falseBesidePending<S, E>(l: Outcome<S, E>, r: Outcome<S, E>): Outcome<S, E> {
	const [f, p] = l.kind === "false" ? [l, r] : [r, l];
	if (f.kind !== "false" || p.kind !== "pending") return l; // unreachable by construction
	const continuation: Residual<S, E> = f.continuation
		? { kind: "and", left: f.continuation, right: p.residual }
		: p.residual;
	return failed(f.violations, continuation);
}

function combineOr<S, E>(l: Outcome<S, E>, r: Outcome<S, E>): Outcome<S, E> {
	if (l.kind === "true" || r.kind === "true") return ok([...evidenceOf(l), ...evidenceOf(r)]);
	if (l.kind === "false" && r.kind === "false") {
		return failed([...l.violations, ...r.violations], joinContinuations("or", l.continuation, r.continuation));
	}
	if (l.kind === "pending" && r.kind === "pending") return pending({ kind: "or", left: l.residual, right: r.residual });
	// one false, one pending: the false side is absorbed — only the pending side can still win
	return l.kind === "pending" ? l : r;
}

function combineImplies<S, E>(l: Outcome<S, E>, r: Outcome<S, E>): Outcome<S, E> {
	if (l.kind === "false") return ok(evidenceOf(l));
	if (r.kind === "true") return ok([...evidenceOf(l), ...r.evidence]);
	if (l.kind === "true") return impliesWithTrueAntecedent(l.evidence, r);
	// antecedent pending: a false consequent is stored and fires if the antecedent ever becomes true
	const right: Residual<S, E> = r.kind === "false" ? { kind: "violated", violations: r.violations } : r.residual;
	return pending({ kind: "implies", left: l.residual, right });
}

function impliesWithTrueAntecedent<S, E>(antecedent: readonly AtomEvidence[], r: Outcome<S, E>): Outcome<S, E> {
	if (r.kind === "pending") return pending({ kind: "implies", left: trueResidual(antecedent), right: r.residual });
	if (r.kind === "true") return ok([...antecedent, ...r.evidence]);
	const violations = r.violations.map((v) => ({ onset: v.onset, evidence: [...antecedent, ...v.evidence] }));
	const continuation: Residual<S, E> | null = r.continuation
		? { kind: "implies", left: trueResidual(antecedent), right: r.continuation }
		: null;
	return failed(violations, continuation);
}

function joinContinuations<S, E>(
	kind: "and" | "or",
	l: Residual<S, E> | null,
	r: Residual<S, E> | null,
): Residual<S, E> | null {
	if (l && r) return { kind, left: l, right: r };
	return l ?? r;
}

// ---------------------------------------------------------------------------
// until / release through their expansion laws, so the laws hold by
// construction and the continuation semantics of and/or carry over:
//   φ U ψ  ⇔  ψ ∨ (φ ∧ X(φ U ψ))        φ R ψ  ⇔  ψ ∧ (φ ∨ X(φ R ψ))
// ---------------------------------------------------------------------------

function evalUntil<S extends object, E extends object>(f: Binary<S, E>, ctx: Ctx<S, E>): Outcome<S, E> {
	const r = evalFormula(f.right, ctx);
	return combineOr(r, combineAnd(evalFormula(f.left, ctx), pending(asFormula(f))));
}

function evalRelease<S extends object, E extends object>(f: Binary<S, E>, ctx: Ctx<S, E>): Outcome<S, E> {
	const r = evalFormula(f.right, ctx);
	return combineAnd(r, combineOr(evalFormula(f.left, ctx), pending(asFormula(f))));
}

// ---------------------------------------------------------------------------
// always / eventually with pending obligation lists
// ---------------------------------------------------------------------------

interface SteppedObligations<S, E> {
	readonly kept: LtlObligation<S, E>[];
	readonly violations: RawViolation[];
	witness: readonly AtomEvidence[] | null;
	lastFailure: readonly AtomEvidence[];
}

/**
 * Step every pending obligation plus (inside the window) a fresh instance of
 * `sub`. A false outcome's continuation exists only to report further
 * violations: `always` re-arms it, `eventually` drops it (it can never become
 * a witness — Bombadil's `evaluate_or_eventually` makes the same call).
 */
function stepObligations<S extends object, E extends object>(
	node: TemporalResidual<S, E>,
	ctx: Ctx<S, E>,
): SteppedObligations<S, E> {
	const acc: SteppedObligations<S, E> = { kept: [], violations: [], witness: null, lastFailure: [] };
	const seen = new Set<string>();
	const outcomes: Array<[Outcome<S, E>, number]> = node.pending.map((ob) => [stepResidual(ob.residual, ctx), ob.onset]);
	if (node.remaining !== 0) outcomes.push([evalFormula(node.sub, ctx), ctx.index]);
	for (const [o, onset] of outcomes) {
		if (o.kind === "true") acc.witness = [...(acc.witness ?? []), ...o.evidence];
		else if (o.kind === "pending") keepUnique(acc.kept, seen, { residual: o.residual, onset });
		else {
			acc.violations.push(...o.violations);
			acc.lastFailure = o.violations.flatMap((v) => v.evidence);
			if (o.continuation && node.kind === "always") keepUnique(acc.kept, seen, { residual: o.continuation, onset });
		}
	}
	return acc;
}

/** Merge obligations with the same structural key — same future, earliest onset wins. */
function keepUnique<S, E>(kept: LtlObligation<S, E>[], seen: Set<string>, ob: LtlObligation<S, E>): void {
	const key = residualKey(ob.residual);
	if (seen.has(key)) return;
	seen.add(key);
	kept.push(ob);
}

function decrement(remaining: number | null): number | null {
	return remaining === null ? null : Math.max(0, remaining - 1);
}

function stepAlways<S extends object, E extends object>(node: TemporalResidual<S, E>, ctx: Ctx<S, E>): Outcome<S, E> {
	const stepped = stepObligations(node, ctx);
	const remaining = decrement(node.remaining);
	const closed = remaining === 0 && stepped.kept.length === 0;
	const next: Residual<S, E> | null = closed ? null : { ...node, remaining, pending: stepped.kept };
	if (stepped.violations.length > 0) return failed(stepped.violations, next);
	return next ? pending(next) : ok([]);
}

function stepEventually<S extends object, E extends object>(node: TemporalResidual<S, E>, ctx: Ctx<S, E>): Outcome<S, E> {
	const stepped = stepObligations(node, ctx);
	if (stepped.witness) return ok(stepped.witness);
	const remaining = decrement(node.remaining);
	if (remaining === 0 && stepped.kept.length === 0) {
		return failed([{ onset: node.onset, evidence: stepped.lastFailure }], null);
	}
	return pending({ ...node, remaining, pending: stepped.kept });
}

function freshTemporal<S, E>(f: Formula<S, E> & { kind: "always" | "eventually" }, index: number): TemporalResidual<S, E> {
	return { kind: f.kind, sub: f.sub, remaining: f.bound, pending: [], onset: index };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function evalFormula<S extends object, E extends object>(f: Formula<S, E>, ctx: Ctx<S, E>): Outcome<S, E> {
	switch (f.kind) {
		case "const":
			return f.value ? ok([]) : failed([{ onset: ctx.index, evidence: [] }], null);
		case "atom":
			return evalAtom(f, ctx);
		case "and":
			return combineAnd(evalFormula(f.left, ctx), evalFormula(f.right, ctx));
		case "or":
			return combineOr(evalFormula(f.left, ctx), evalFormula(f.right, ctx));
		case "implies":
			return combineImplies(evalFormula(f.left, ctx), evalFormula(f.right, ctx));
		case "next":
			return pending(asFormula(f.sub));
		case "until":
			return evalUntil(f, ctx);
		case "release":
			return evalRelease(f, ctx);
		case "always":
			return stepAlways(freshTemporal(f, ctx.index), ctx);
		case "eventually":
			return stepEventually(freshTemporal(f, ctx.index), ctx);
	}
}

function stepResidual<S extends object, E extends object>(r: Residual<S, E>, ctx: Ctx<S, E>): Outcome<S, E> {
	switch (r.kind) {
		case "true":
			return ok(r.evidence);
		case "violated":
			return failed(r.violations, null);
		case "formula":
			return evalFormula(r.f, ctx);
		case "and":
			return combineAnd(stepResidual(r.left, ctx), stepResidual(r.right, ctx));
		case "or":
			return combineOr(stepResidual(r.left, ctx), stepResidual(r.right, ctx));
		case "implies":
			return combineImplies(stepResidual(r.left, ctx), stepResidual(r.right, ctx));
		case "always":
			return stepAlways(r, ctx);
		case "eventually":
			return stepEventually(r, ctx);
	}
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

interface Slot<S, E> {
    unavailable?: string;
	readonly id: string;
	residual: Residual<S, E>;
	settled: StepVerdict | null;
	readonly reported: Set<number>;
}

/**
 * Online monitor for a set of properties over one trace. `step` feeds one
 * event (the index advances by one); `end` folds what is still pending into
 * a three-valued end-of-trace verdict without mutating anything, so a session
 * can continue after a Stop event.
 */
export class Monitor<S extends object, E extends object> {
	private index = 0;
	private readonly slots: Slot<S, E>[];

	constructor(properties: readonly Property<S, E>[]) {
		this.slots = properties.map((p) => ({
			id: p.id,
			residual: asFormula(p.formula),
			settled: null,
			reported: new Set<number>(),
		}));
	}

	/** Events consumed so far. */
	get eventsSeen(): number {
		return this.index;
	}

	step(state: S, event: E): PropertyReport[] {
		const ctx: Ctx<S, E> = { state, event, index: this.index };
		const reports = this.slots.map((slot) => stepSlotSafely(slot, ctx));
		this.index += 1;
		return reports;
	}

	/** Three-valued verdict per property for the trace seen so far. Non-destructive. */
	end(): EndReport[] {
		return this.slots.map((slot) => ({
			id: slot.id,
			verdict: endOfSlot(slot, "strict"),
			leaning: endOfSlot(slot, "weak"),
            ...(slot.unavailable ? { unavailable: slot.unavailable } : {}),
		}));
	}

	/** Residual node count of one property (growth telemetry); 0 for an unknown id. */
	size(id: string): number {
		const slot = this.slots.find((s) => s.id === id);
		return slot ? residualSize(slot.residual) : 0;
	}
}

/** A property that ever reported a violation is false over the trace; a settled one keeps its
 *  verdict; an open one folds its residual (`strict`: pending ⇒ unknown; `weak`: a pending
 *  `always` ⇒ true — see residual.ts). */
function endOfSlot<S, E>(slot: Slot<S, E>, mode: EndMode): EndVerdict {
	if (slot.settled === "false" || slot.reported.size > 0) return "false";
    if (slot.unavailable) return "unknown";
	if (slot.settled === "true") return "true";
	return endOfResidual(slot.residual, mode);
}

/**
 * One property, one event. "false" is sticky: once a property has reported a
 * violation it stays false, and its continuation is stepped only to report
 * further violations — a continuation that becomes true has nothing more to
 * say and settles the slot (Bombadil's continuation has the same role).
 */
/** Missing predicate evaluation taints this trace; other properties still execute. */
function stepSlotSafely<S extends object, E extends object>(slot: Slot<S, E>, ctx: Ctx<S, E>): PropertyReport {
    if (!slot.unavailable) {
        try { return stepSlot(slot, ctx); }
        catch (error) { slot.unavailable = String(error); }
    }
    return { id: slot.id, verdict: slot.reported.size > 0 ? "false" : "pending", violations: [], unavailable: slot.unavailable };
}

function stepSlot<S extends object, E extends object>(slot: Slot<S, E>, ctx: Ctx<S, E>): PropertyReport {
	if (slot.settled) return { id: slot.id, verdict: slot.settled, violations: [] };
	const o = stepResidual(slot.residual, ctx);
	const violated = slot.reported.size > 0;
	if (o.kind === "true") {
		slot.settled = violated ? "false" : "true";
		return { id: slot.id, verdict: slot.settled, violations: [] };
	}
	if (o.kind === "pending") {
		slot.residual = o.residual;
		return { id: slot.id, verdict: violated ? "false" : "pending", violations: [] };
	}
	if (o.continuation) slot.residual = o.continuation;
	else slot.settled = "false";
	return { id: slot.id, verdict: "false", violations: dedupeViolations(slot, o.violations, ctx.index) };
}

/** Merge same-onset raw violations into one report each; drop onsets already reported. */
function dedupeViolations<S, E>(slot: Slot<S, E>, raw: readonly RawViolation[], at: number): LtlViolation[] {
	const byOnset = new Map<number, AtomEvidence[]>();
	for (const v of raw) {
		const list = byOnset.get(v.onset);
		if (list) list.push(...v.evidence);
		else byOnset.set(v.onset, [...v.evidence]);
	}
	const out: LtlViolation[] = [];
	for (const [onset, evidence] of byOnset) {
		if (slot.reported.has(onset)) continue;
		slot.reported.add(onset);
		out.push({ property: slot.id, onset, at, evidence });
	}
	return out;
}
