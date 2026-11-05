// Backward member-chain scan over comment/string-stripped JS/TS text.
// Sibling of agent-safety-async.ts (that file sits at the per-file line cap):
// `misused_promises` asks whether the receiver chain of a `.forEach(` is the
// direct operand of `await`, including a chain that spans several lines
// (`await readable\n  .filter(fn)\n  .forEach(async …)`).
//
// A `?` joins a chain only as the optional-chaining token `?.`; a bare `?` is a
// ternary, and walking back across it made `await c ? xs.forEach(async …) : 0`
// read as an awaited forEach (false negative found by the kill-proof census,
// docs/reviews/kill-proof-census-harness.md). Likewise `!` joins only as a
// postfix non-null assertion (`x!.y`, `f()!.y`, `xs[0]!.y`), never as a prefix
// negation (`!a.b`).

// Bound on one backward bracket-matching scan.
const CHAIN_BRACKET_MAX_SCAN = 4000;

function isSpace(c: string | undefined): boolean {
	return c !== undefined && /\s/.test(c);
}

function isIdentChar(c: string | undefined): boolean {
	return c !== undefined && /[\w$]/.test(c);
}

/** True when the last non-space character at or before `k` ends an operand (identifier, `)` or `]`). */
function endsOperand(src: string, k: number): boolean {
	let d = k;
	while (d >= 0 && isSpace(src[d])) d--;
	const c = src[d];
	return c === ")" || c === "]" || isIdentChar(c);
}

/**
 * Whether the character at `k` links the chain token starting at `head` (the
 * next non-space offset to its right) to what precedes it: a member `.`, the
 * `?` of `?.`, or a postfix `!` — one that ends an operand and is not the
 * prefix of the identifier at `head`.
 */
function isChainLink(src: string, k: number, head: number): boolean {
	const c = src[k];
	return c === "." || (c === "?" && src[k + 1] === ".") || (c === "!" && !isIdentChar(src[head]) && endsOperand(src, k - 1));
}

/**
 * Index of the bracket opening the `)`/`]` at `closeIdx` (scanning back at
 * most {@link CHAIN_BRACKET_MAX_SCAN} characters), or -1.
 */
function matchingOpenBefore(src: string, closeIdx: number): number {
	let depth = 0;
	for (let k = closeIdx; k >= 0 && closeIdx - k < CHAIN_BRACKET_MAX_SCAN; k--) {
		const c = src[k];
		if (c === ")" || c === "]") depth++;
		else if (c === "(" || c === "[") depth--;
		if (depth === 0) return k;
	}
	return -1;
}

/**
 * One backward step from the identifier ending at `k`: `next` is the offset of
 * the link (`.`, `?.`, `!`) before it when the chain continues, or the
 * identifier's first character with `done` set when it is the chain head.
 */
function stepOverIdentifier(src: string, k: number): { next: number; done: boolean } {
	let i = k;
	while (i >= 0 && isIdentChar(src[i])) i--;
	let d = i;
	while (d >= 0 && isSpace(src[d])) d--;
	return isChainLink(src, d, i + 1) ? { next: d, done: false } : { next: i + 1, done: true };
}

/**
 * Start offset of the member chain whose `.` sits at `dotIdx`: walks back over
 * identifiers, `.`/`?.`/`!` links, balanced call/index brackets and the
 * whitespace (newlines included) of a multi-line chain.
 */
export function memberChainStart(src: string, dotIdx: number): number {
	let head = dotIdx;
	for (;;) {
		let k = head - 1;
		while (k >= 0 && isSpace(src[k])) k--;
		const c = src[k];
		if (c === ")" || c === "]") {
			const open = matchingOpenBefore(src, k);
			if (open < 0) return head;
			head = open;
		} else if (isIdentChar(c)) {
			const step = stepOverIdentifier(src, k);
			if (step.done) return step.next;
			head = step.next;
		} else if (isChainLink(src, k, head)) {
			head = k;
		} else {
			return head;
		}
	}
}
