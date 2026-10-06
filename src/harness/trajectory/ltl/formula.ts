// ===========================================
// Trajectory LTL — formula algebra (negation normal form)
// ===========================================
//
// A declarative rule language over the tool-call stream. Ported in design from
// Bombadil's `bombadil-ltl` crate (`formula.rs`, `syntax.rs`), Antithesis,
// MIT License — https://github.com/antithesishq/bombadil. No code is copied;
// the TypeScript is a re-implementation of the same algebra.
//
// Differences from Bombadil (deliberate):
//   * `within(n)` is measured in EVENTS (tool calls), never wall-clock. The
//     trace is deterministic on replay, so a bound in events is too.
//   * There is no separate `Syntax` tree: `not()` pushes negation to the atoms
//     at construction time, so every formula value is already in NNF. `implies`
//     is preserved (as Bombadil does) for readable violation reports.
//   * `until` / `release` are first-class (Bombadil has neither); they are duals
//     under `not()`.
//
// Atoms are predicates over `(state, event)`. `S` is the folded trajectory
// state, `E` the event. Both are read through a recording Proxy at evaluation
// time (read-set.ts) so a violation names the evidence it used.

/** An atomic predicate. `name` is what the violation report shows. */
export interface Atom<S, E> {
	readonly kind: "atom";
	readonly name: string;
	readonly pred: (state: S, event: E) => boolean;
	/** NNF negation flag — `not(atom)` flips it instead of wrapping. */
	readonly negated: boolean;
}

export interface Const {
	readonly kind: "const";
	readonly value: boolean;
}

export interface Binary<S, E> {
	readonly kind: "and" | "or" | "implies" | "until" | "release";
	readonly left: Formula<S, E>;
	readonly right: Formula<S, E>;
}

export interface Next<S, E> {
	readonly kind: "next";
	readonly sub: Formula<S, E>;
}

/** `always` / `eventually`, optionally bounded to `bound` events (current one included). */
export interface Temporal<S, E> {
	readonly kind: "always" | "eventually";
	readonly sub: Formula<S, E>;
	/** null = unbounded. */
	readonly bound: number | null;
}

export type Formula<S, E> = Atom<S, E> | Const | Binary<S, E> | Next<S, E> | Temporal<S, E>;

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const TRUE: Const = { kind: "const", value: true };
export const FALSE: Const = { kind: "const", value: false };

export function atom<S, E>(name: string, pred: (state: S, event: E) => boolean): Atom<S, E> {
	return { kind: "atom", name, pred, negated: false };
}

export function and<S, E>(left: Formula<S, E>, right: Formula<S, E>): Binary<S, E> {
	return { kind: "and", left, right };
}
export function or<S, E>(left: Formula<S, E>, right: Formula<S, E>): Binary<S, E> {
	return { kind: "or", left, right };
}
export function implies<S, E>(left: Formula<S, E>, right: Formula<S, E>): Binary<S, E> {
	return { kind: "implies", left, right };
}
/** Strong until: `right` must hold at some event, and `left` at every event before it. */
export function until<S, E>(left: Formula<S, E>, right: Formula<S, E>): Binary<S, E> {
	return { kind: "until", left, right };
}
/** Release (dual of until): `right` holds until and including the first event where `left` holds. */
export function release<S, E>(left: Formula<S, E>, right: Formula<S, E>): Binary<S, E> {
	return { kind: "release", left, right };
}
export function next<S, E>(sub: Formula<S, E>): Next<S, E> {
	return { kind: "next", sub };
}

/**
 * `always(f)`: f holds at the current event and every later one. With `bound`
 * n: at the current event and the next n-1 (n events in total).
 */
export function always<S, E>(sub: Formula<S, E>, bound: number | null = null): Temporal<S, E> {
	return { kind: "always", sub, bound: normalizeBound(bound) };
}
/**
 * `eventually(f)`: f holds at the current event or a later one. With `bound`
 * n: at one of the next n events, the current one counted first.
 */
export function eventually<S, E>(sub: Formula<S, E>, bound: number | null = null): Temporal<S, E> {
	return { kind: "eventually", sub, bound: normalizeBound(bound) };
}
/** Set the event bound of an `always` / `eventually` node. */
export function within<S, E>(f: Temporal<S, E>, bound: number): Temporal<S, E> {
	return { ...f, bound: normalizeBound(bound) };
}

/** A bound is a positive integer count of events; anything else is "unbounded". */
function normalizeBound(bound: number | null): number | null {
	if (bound === null || !Number.isFinite(bound)) return null;
	const n = Math.floor(bound);
	return n >= 1 ? n : null;
}

// ---------------------------------------------------------------------------
// Negation (NNF push-down)
// ---------------------------------------------------------------------------

/** `not(f)` in NNF: negation reaches the atoms; every operator flips to its dual. */
export function not<S, E>(f: Formula<S, E>): Formula<S, E> {
	switch (f.kind) {
		case "const":
			return f.value ? FALSE : TRUE;
		case "atom":
			return { ...f, negated: !f.negated };
		case "and":
			return or(not(f.left), not(f.right));
		case "or":
			return and(not(f.left), not(f.right));
		case "implies":
			// ¬(l ⇒ r) ⇔ l ∧ ¬r
			return and(f.left, not(f.right));
		case "until":
			return release(not(f.left), not(f.right));
		case "release":
			return until(not(f.left), not(f.right));
		case "next":
			return next(not(f.sub));
		case "always":
			return eventually(not(f.sub), f.bound);
		case "eventually":
			return always(not(f.sub), f.bound);
	}
}

// ---------------------------------------------------------------------------
// Structural key — identical formulas have identical future behavior, so the
// evaluator de-duplicates pending obligations by this key (Bombadil splices
// its own derived residual for the same reason).
// ---------------------------------------------------------------------------

export function formulaKey<S, E>(f: Formula<S, E>): string {
	switch (f.kind) {
		case "const":
			return f.value ? "T" : "F";
		case "atom":
			return `${f.negated ? "!" : ""}${JSON.stringify(f.name)}`;
		case "next":
			return `X(${formulaKey(f.sub)})`;
		case "always":
		case "eventually":
			return `${f.kind === "always" ? "G" : "F"}${f.bound ?? ""}(${formulaKey(f.sub)})`;
		default:
			return `${f.kind}(${formulaKey(f.left)},${formulaKey(f.right)})`;
	}
}

/** Human-readable rendering for reports (same shape as the key, with names unquoted). */
export function renderFormula<S, E>(f: Formula<S, E>): string {
	switch (f.kind) {
		case "const":
			return f.value ? "true" : "false";
		case "atom":
			return `${f.negated ? "¬" : ""}${f.name}`;
		case "next":
			return `next(${renderFormula(f.sub)})`;
		case "always":
		case "eventually":
			return `${f.kind}(${renderFormula(f.sub)})${f.bound === null ? "" : `.within(${f.bound})`}`;
		default:
			return `${f.kind}(${renderFormula(f.left)}, ${renderFormula(f.right)})`;
	}
}
