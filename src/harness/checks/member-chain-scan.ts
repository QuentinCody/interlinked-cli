// Backward member-chain scan over comment/string-stripped JS/TS text.
// Sibling of agent-safety-async.ts (that file sits at the per-file line cap):
// `misused_promises` asks whether the receiver chain of a `.forEach(` is the
// direct operand of `await`, including a chain that spans several lines
// (`await readable\n  .filter(fn)\n  .forEach(async …)`).

// Bound on one backward bracket-matching scan.
const CHAIN_BRACKET_MAX_SCAN = 4000;

function isSpace(c: string | undefined): boolean {
	return c !== undefined && /\s/.test(c);
}

function isIdentChar(c: string | undefined): boolean {
	return c !== undefined && /[\w$]/.test(c);
}

function isChainLink(c: string | undefined): boolean {
	return c === "." || c === "?" || c === "!";
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
 * the link (`.`, `?`, `!`) before it when the chain continues, or the
 * identifier's first character with `done` set when it is the chain head.
 */
function stepOverIdentifier(src: string, k: number): { next: number; done: boolean } {
	let i = k;
	while (i >= 0 && isIdentChar(src[i])) i--;
	let d = i;
	while (d >= 0 && isSpace(src[d])) d--;
	return isChainLink(src[d]) ? { next: d, done: false } : { next: i + 1, done: true };
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
		} else if (c === "!" || c === "?") {
			head = k;
		} else if (isIdentChar(c)) {
			const step = stepOverIdentifier(src, k);
			if (step.done) return step.next;
			head = step.next;
		} else {
			return head;
		}
	}
}
