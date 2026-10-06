// ===========================================
// Trajectory LTL — residual shapes, structural key, end-of-trace fold
// ===========================================
//
// The data half of the evaluator (eval.ts holds the stepping half). Ported in
// design from Bombadil's `bombadil-ltl/src/{eval.rs,stop.rs}` (Antithesis,
// MIT License — https://github.com/antithesishq/bombadil); re-implemented,
// no code copied.
//
// A RESIDUAL is what remains of a property after the events seen so far. The
// end-of-trace fold is three-valued (Kleene): `always` / `release` pending
// read as true (nothing refuted them), `eventually` / `until` / `next` / a
// bare atom pending read as `unknown` — never a silent pass.

import type { Formula } from "./formula.js";
import { formulaKey } from "./formula.js";

export type StepVerdict = "true" | "false" | "pending";
export type EndVerdict = "true" | "false" | "unknown";

/** One atom evaluation: what it was asked, what it answered, what it read. */
export interface AtomEvidence {
	readonly name: string;
	readonly negated: boolean;
	/** The atom's value AFTER negation (the truth value that entered the formula). */
	readonly value: boolean;
	readonly reads: readonly string[];
	/** Historical v1 evidence only; current predicate errors produce unavailable reports. */
	readonly error?: string;
}

/** A violation before it is attributed to a property (onset = when the failing obligation started). */
export interface RawViolation {
	readonly onset: number;
	readonly evidence: readonly AtomEvidence[];
}

/** A sub-formula instance an always/eventually node still owes, with the event index it started at. */
export interface LtlObligation<S, E> {
	readonly residual: Residual<S, E>;
	readonly onset: number;
}

export interface TemporalResidual<S, E> {
	readonly kind: "always" | "eventually";
	readonly sub: Formula<S, E>;
	/** Events still inside the window (null = unbounded). */
	readonly remaining: number | null;
	readonly pending: readonly LtlObligation<S, E>[];
	/** Event index at which this node was created. */
	readonly onset: number;
}

export type Residual<S, E> =
	| { readonly kind: "true"; readonly evidence: readonly AtomEvidence[] }
	| { readonly kind: "violated"; readonly violations: readonly RawViolation[] }
	| { readonly kind: "formula"; readonly f: Formula<S, E> }
	| { readonly kind: "and" | "or" | "implies"; readonly left: Residual<S, E>; readonly right: Residual<S, E> }
	| TemporalResidual<S, E>;

export function asFormula<S, E>(f: Formula<S, E>): Residual<S, E> {
	return { kind: "formula", f };
}

// ---------------------------------------------------------------------------
// Structural key + size (obligation dedup, growth telemetry)
// ---------------------------------------------------------------------------

/** Same key ⇒ same future behavior. Onsets are excluded on purpose so merged obligations keep the earliest. */
export function residualKey<S, E>(r: Residual<S, E>): string {
	switch (r.kind) {
		case "true":
			return "T";
		case "violated":
			return `V${r.violations.map((v) => v.onset).join(",")}`;
		case "formula":
			return formulaKey(r.f);
		case "always":
		case "eventually": {
			const pend = r.pending.map((ob) => residualKey(ob.residual)).sort().join("|");
			return `${r.kind}${r.remaining ?? ""}(${formulaKey(r.sub)})[${pend}]`;
		}
		default:
			return `${r.kind}(${residualKey(r.left)},${residualKey(r.right)})`;
	}
}

export function residualSize<S, E>(r: Residual<S, E>): number {
	switch (r.kind) {
		case "and":
		case "or":
		case "implies":
			return 1 + residualSize(r.left) + residualSize(r.right);
		case "always":
		case "eventually":
			return 1 + r.pending.reduce((n, ob) => n + residualSize(ob.residual), 0);
		default:
			return 1;
	}
}

// ---------------------------------------------------------------------------
// End of trace — three-valued fold (Kleene logic)
// ---------------------------------------------------------------------------

function kleeneAnd(values: readonly EndVerdict[]): EndVerdict {
	if (values.includes("false")) return "false";
	return values.includes("unknown") ? "unknown" : "true";
}
function kleeneOr(values: readonly EndVerdict[]): EndVerdict {
	if (values.includes("true")) return "true";
	return values.includes("unknown") ? "unknown" : "false";
}
function kleeneNot(v: EndVerdict): EndVerdict {
	if (v === "unknown") return v;
	return v === "true" ? "false" : "true";
}

/**
 * `strict` is LTL3: anything still pending is `unknown` (the fold commutes with
 * negation, which the law tests rely on). `weak` reads a pending safety
 * obligation — `always` / `release`, nothing refuted it — as true; it is the
 * reporting leaning for a Stop summary, never an input to the laws.
 */
export type EndMode = "strict" | "weak";

/**
 * A formula that no event has evaluated yet (a `next` body, a re-armed
 * `until`). The fold follows each operator's expansion law with the unseen
 * future folded away, so an atom is `unknown`, `G φ` / `F φ` / `X φ` fold to
 * `φ`, and `φ U ψ` / `φ R ψ` fold to `ψ` — negation-consistent by construction.
 */
function endOfFormula<S, E>(f: Formula<S, E>, mode: EndMode): EndVerdict {
	switch (f.kind) {
		case "const":
			return f.value ? "true" : "false";
		case "atom":
			return "unknown";
		case "and":
			return kleeneAnd([endOfFormula(f.left, mode), endOfFormula(f.right, mode)]);
		case "or":
			return kleeneOr([endOfFormula(f.left, mode), endOfFormula(f.right, mode)]);
		case "implies":
			return kleeneOr([kleeneNot(endOfFormula(f.left, mode)), endOfFormula(f.right, mode)]);
		case "next":
		case "eventually":
			return endOfFormula(f.sub, mode);
		case "until":
			return endOfFormula(f.right, mode);
		case "always":
			return leanWeak(endOfFormula(f.sub, mode), mode);
		case "release":
			return leanWeak(endOfFormula(f.right, mode), mode);
	}
}

/** In weak mode a pending safety obligation reads as true unless it is already refuted. */
function leanWeak(v: EndVerdict, mode: EndMode): EndVerdict {
	return mode === "weak" && v === "unknown" ? "true" : v;
}

export function endOfResidual<S, E>(r: Residual<S, E>, mode: EndMode): EndVerdict {
	switch (r.kind) {
		case "true":
			return "true";
		case "violated":
			return "false";
		case "formula":
			return endOfFormula(r.f, mode);
		case "and":
			return kleeneAnd([endOfResidual(r.left, mode), endOfResidual(r.right, mode)]);
		case "or":
			return kleeneOr([endOfResidual(r.left, mode), endOfResidual(r.right, mode)]);
		case "implies":
			return kleeneOr([kleeneNot(endOfResidual(r.left, mode)), endOfResidual(r.right, mode)]);
		case "always":
		case "eventually":
			return endOfTemporal(r, mode);
	}
}

/** Fold the pending obligations plus, while the window is open, the unseen future
 *  (a fresh `sub`, folded as a never-evaluated formula so constants resolve). */
function endOfTemporal<S, E>(r: TemporalResidual<S, E>, mode: EndMode): EndVerdict {
	const parts = r.pending.map((ob) => endOfResidual(ob.residual, mode));
	if (r.remaining !== 0) {
		const future = endOfFormula(r.sub, mode);
		parts.push(r.kind === "always" ? leanWeak(future, mode) : future);
	}
	return r.kind === "always" ? kleeneAnd(parts) : kleeneOr(parts);
}
