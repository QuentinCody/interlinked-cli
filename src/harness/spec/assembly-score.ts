// Assembly-theoretic significance scoring (docs/design/
// spec-audit-runtime-checks.md §8.2, spike 14; evaluation in
// docs/external-pulse/assembly-theory.md). The transferable core and
// nothing else: assembly index a = minimal construction steps WITH free
// reuse (approximated by Re-Pair grammar size — exact is NP-hard, and
// ranking needs an order, not a theorem), and significance grows as
// e^a·(n−1) over copy number n. A structure too complex to recur by
// accident, that recurs anyway, is a load-bearing convention; a single
// copy contributes nothing; a trivial structure contributes nothing
// however often it repeats.
//
// BOUNDARIES (§8.3): scores RANK and GATE findings from other detectors —
// a high score is never itself a finding, and the vocabulary never reaches
// agent-facing text. Deterministic, dependency-free.
//
// WIRED CONSUMERS (round-2 #33): assemblyIndexOfTokens ranks recurrence rows
// by structural complexity in recurrence.ts (aggregateRecurrences — the
// within-equal-count tiebreaker). significance()/isTriviallyAssembled remain
// the GATE substrate (bounded score / numeric-triviality); their consumers
// land as the magic-literal and warning-slot gates adopt them — until then
// they are exercised only by this module's own tests. Do not read the RANK/
// GATE line above as "both are live": ranking is, gating is staged.

/** Cap on Re-Pair rounds — safety bound; real inputs converge much sooner. */
const MAX_ROUNDS = 512;
/** Exponent cap in the significance formula (keeps values finite/orderable). */
const MAX_EXPONENT = 12;

/**
 * Re-Pair grammar size over a token sequence: repeatedly replace the most
 * frequent adjacent pair (count ≥ 2) with a fresh nonterminal. Returns the
 * assembly-index approximation: rules created + final sequence length.
 *
 * Cost is O(min(MAX_ROUNDS, n)·n) — bounded (no exponential backtracking), but
 * a very long input still costs tens of ms. Callers feeding untrusted-length
 * input (e.g. a user-supplied signature) should cap it first; the index is a
 * ranking heuristic, so a bounded prefix carries more than enough structure.
 */
/** Adjacent-pair counts over `seq`, keyed left→right, value→count. Nested
 *  Map keying (not a delimited string) is load-bearing — see the identity
 *  note on `runRepairRound`. */
function countAdjacentPairs(
	seq: readonly (string | object)[],
): Map<string | object, Map<string | object, number>> {
	const counts = new Map<string | object, Map<string | object, number>>();
	for (let i = 0; i + 1 < seq.length; i++) {
		const left = seq[i] as string | object;
		const right = seq[i + 1] as string | object;
		let inner = counts.get(left);
		if (!inner) {
			inner = new Map();
			counts.set(left, inner);
		}
		inner.set(right, (inner.get(right) ?? 0) + 1);
	}
	return counts;
}

/** Most frequent adjacent pair in `counts`, or nulls with count 1 if none
 *  recurs (count ≥ 2) — the Re-Pair stopping condition. */
function mostFrequentPair(
	counts: Map<string | object, Map<string | object, number>>,
): { bestA: string | object | null; bestB: string | object | null; bestCount: number } {
	let bestA: string | object | null = null;
	let bestB: string | object | null = null;
	let bestCount = 1;
	for (const [left, inner] of counts) {
		for (const [right, count] of inner) {
			if (count > bestCount) {
				bestA = left;
				bestB = right;
				bestCount = count;
			}
		}
	}
	return { bestA, bestB, bestCount };
}

/** One Re-Pair round: replace every occurrence of the single most frequent
 *  adjacent pair with a fresh nonterminal. `merged` is false when no pair
 *  recurs (count < 2) — the caller's stopping condition — in which case
 *  `seq` is returned unchanged. */
function runRepairRound(
	seq: readonly (string | object)[],
): { seq: (string | object)[]; merged: boolean } {
	const { bestA, bestB, bestCount } = mostFrequentPair(countAdjacentPairs(seq));
	if (bestCount < 2) return { seq: [...seq], merged: false };
	const nonterminal = {}; // fresh identity: collides with nothing
	const next: (string | object)[] = [];
	for (let i = 0; i < seq.length; i++) {
		if (i + 1 < seq.length && seq[i] === bestA && seq[i + 1] === bestB) {
			next.push(nonterminal);
			i++;
		} else {
			next.push(seq[i] as string | object);
		}
	}
	return { seq: next, merged: true };
}

export function assemblyIndexOfTokens(tokens: readonly string[]): number {
	if (tokens.length === 0) return 0;
	// Tokens are strings from the caller plus fresh nonterminal OBJECTS
	// created per rule (round-9 sol #1). Two robustness properties depend on
	// NOT serializing pairs to a delimited string: (a) the pair map is a
	// nested Map keyed by value/identity, so a token that equals any
	// delimiter can't collide; (b) each nonterminal is a fresh object,
	// comparing by identity, so it can never be mistaken for an input token
	// that looks like "0"/"1"/….
	let seq: (string | object)[] = [...tokens];
	let rules = 0;
	for (let round = 0; round < MAX_ROUNDS; round++) {
		const result = runRepairRound(seq);
		if (!result.merged) break;
		seq = result.seq;
		rules++;
	}
	return rules + seq.length;
}

/** Assembly index of a text block, tokenized by words/symbols. */
export function assemblyIndexOfText(text: string): number {
	const tokens = text.split(/\s+/).filter(Boolean);
	return assemblyIndexOfTokens(tokens);
}

/** Whether a numeric literal is trivially assembled — round numbers, powers
 *  of two/ten, tiny values: the shapes the hand-tuned exclusion lists in
 *  policy-constant-drift/magic-literal encode today. The formula replaces
 *  the list: a trivial value has assembly ≈ 1 and contributes nothing. */
export function isTriviallyAssembled(raw: string): boolean {
	// The literal must be a well-formed decimal, optionally grouped by a SINGLE
	// separator type in 3-digit groups with no separator in the fractional part
	// (round-12 sol #4, round-13 sol #3, round-14 sol #2). Rejects empty / hex /
	// binary / exponent forms Number() accepts, and malformed grouping such as
	// "1__000", "1,00,0", "10_00", "1,2_3", "1.0_0".
	const ungrouped = /^-?\d+(?:\.\d+)?$/;
	const grouped = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^-?\d{1,3}(?:_\d{3})+(?:\.\d+)?$/;
	if (!ungrouped.test(raw) && !grouped.test(raw)) return false;
	// Precision guard (round-13 #4, round-14 #3, round-15 #2, round-16 sol #1):
	// count SIGNIFICANT digits — the span from the first to the last nonzero
	// digit. Leading zeros and trailing (padding) zeros are representation-only,
	// so "0.1000000000000000" is 1 sig digit (a trivial 10^-1), while
	// "999999999999999.9" is 16 and rounds under coercion. >15 is not exactly
	// representable — treat as non-trivial.
	const sigDigits = raw.replace(/[-,_.]/g, "").replace(/^0+/, "").replace(/0+$/, "");
	if (sigDigits.length > 15) return false;
	const value = Math.abs(Number(raw.replace(/[,_]/g, "")));
	if (!Number.isFinite(value)) return false;
	if (value <= 2) return true;
	if (Number.isInteger(Math.log2(value))) return true; // powers of two
	if (Number.isInteger(Math.log10(value))) return true; // powers of ten
	// k·10^m with small k (100, 500, 3000, 24? no — 24 isn't k·10^m): the
	// classic round-number shapes.
	const digits = String(Math.trunc(value));
	const trailingZeros = digits.length - digits.replace(/0+$/, "").length;
	if (trailingZeros >= digits.length - 1 && digits.length > 1) return true;
	// Clock/space bases the old lists carried explicitly.
	return value === 24 || value === 60 || value === 12;
}

/** Assembly index of one numeric literal: digit-sequence complexity. */
export function literalAssemblyIndex(raw: string): number {
	if (isTriviallyAssembled(raw)) return 1;
	const digits = raw.replace(/[^0-9]/g, "");
	return assemblyIndexOfTokens([...digits]) + new Set(digits).size;
}

/**
 * The significance prior: e^min(a,cap) · (n − 1). Zero for single copies
 * and near-zero for trivial structures — the FP control that decides which
 * recurrences are worth a finding, a warning slot, or an LLM call.
 *
 * The output is contractually nonnegative and finite/orderable. A malformed
 * caller must not be able to violate that (round-10 sol): a non-finite copy
 * number is treated as "no recurrence" (0), and the assembly index — a
 * conceptually nonnegative count — is clamped to [0, cap], so NaN/negative
 * inputs can't yield NaN or a spuriously-ordered score.
 */
export function significance(assemblyIndex: number, copyNumber: number): number {
	if (!Number.isFinite(copyNumber) || copyNumber <= 1) return 0;
	const a = Number.isFinite(assemblyIndex) ? Math.max(0, assemblyIndex) : 0;
	// Clamp the PRODUCT, not just the exponent: a huge finite copyNumber can
	// overflow the multiplication to Infinity, breaking the finite/orderable
	// contract (round-11 sol). MAX_VALUE is a finite saturation sentinel — two
	// overflowing scores tie, which is the correct "both maximal" ordering.
	return Math.min(Math.exp(Math.min(a, MAX_EXPONENT)) * (copyNumber - 1), Number.MAX_VALUE);
}
