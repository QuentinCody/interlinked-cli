// ===========================================
// Bash write detection — shared parsing primitives
// ===========================================
// Leaf module both `pre-checks-bash-write-detect.ts` and
// `pre-checks-bash-write-verbs.ts` import, so the two scanners cannot form an
// import cycle (they did, briefly, on 2026-08-25 — this split is the fix).

/** File extensions the harness's content-gate checks care about. */
export const CODE_FILE_EXT_RE =
	/\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|pyi|go|rs|java|kt|swift|c|cc|cpp|cxx|h|hpp|hxx|rb|php|cs|scala|clj|sh|bash|zsh)$/i;

/** Length of the separator starting at `i` outside quotes (2 for && and ||,
 *  1 for | and ;, 0 for none). One place decides what counts as a separator. */
function separatorLengthAt(cmd: string, i: number): number {
	const two = cmd.slice(i, i + 2);
	if (two === "&&" || two === "||") return 2;
	const ch = cmd[i];
	return ch === "|" || ch === ";" || ch === "\n" ? 1 : 0;
}

/** Consume from an opening quote through its close, returning the consumed
 *  chunk and the index AFTER it. Double quotes honor backslash escapes;
 *  single quotes are POSIX-literal (no escapes — the quote always closes). */
function consumeQuoted(cmd: string, start: number, quote: "'" | '"'): { chunk: string; next: number } {
	let i = start + 1;
	while (i < cmd.length) {
		const ch = cmd[i];
		if (quote === '"' && ch === "\\" && i + 1 < cmd.length) {
			i += 2;
			continue;
		}
		i++;
		if (ch === quote) break;
	}
	return { chunk: cmd.slice(start, i), next: i };
}

/** The quote-aware scanner behind {@link splitCommandSegments}. Single pass,
 *  no backtracking; quoted chunks and escaped characters pass through intact. */
function scanTopLevelSegments(cmd: string): string[] {
	const segments: string[] = [];
	let current = "";
	let i = 0;
	while (i < cmd.length) {
		// SAFETY: the loop guard holds i < cmd.length, so indexing yields a char.
		const ch = cmd[i] as string;
		if (ch === "'" || ch === '"') {
			const q = consumeQuoted(cmd, i, ch);
			current += q.chunk;
			i = q.next;
			continue;
		}
		if (ch === "\\" && i + 1 < cmd.length) {
			current += ch + cmd[i + 1];
			i += 2;
			continue;
		}
		const sep = separatorLengthAt(cmd, i);
		if (sep > 0) {
			segments.push(current);
			current = "";
			i += sep;
			continue;
		}
		current += ch;
		i++;
	}
	segments.push(current);
	return segments.map((s) => s.trim()).filter(Boolean);
}

/**
 * Split a shell command on its REAL separators (&&, ||, ;, |), honoring
 * single quotes, double quotes, and backslash escapes — a `|` inside a quoted
 * regex is alternation, not a pipe. The naive regex split associated an
 * upstream flag with a downstream command across a quoted `|`
 * (review 2026-08-28: `rg -i 'a|b' … | sed -n '1,200p'` false-blocked as a
 * `sed -i` in-place write — a zero-FP-contract violation for a deterministic
 * block).
 */
// interlinked: defer comment_claims_validation_missing -- the behavior the doc
// above describes is implemented in scanTopLevelSegments/consumeQuoted directly
// above; this export is a thin delegating wrapper kept for the existing import
// surface, and the heuristic cannot see through delegation.
export function splitCommandSegments(cmd: string): string[] {
	return scanTopLevelSegments(cmd);
}

export function splitShellWordsLoose(segment: string): string[] {
	// Flatten nested-quantifier alternation: `(?:[^"\\]|\\[\s\S])*` advances
	// one character per iteration with no backtracking, avoiding the
	// catastrophic-backtracking shape of `[^"\\]*(?:\\.[^"\\]*)*`.
	const words: string[] = [];
	const re = /"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|(\S+)/g;
	for (const match of segment.matchAll(re)) {
		words.push(match[0]);
	}
	return words;
}

export function stripOuterQuotes(value: string): string {
	if (
		(value.startsWith("'") && value.endsWith("'")) ||
		(value.startsWith("\"") && value.endsWith("\""))
	) {
		return value.slice(1, -1);
	}
	return value;
}
