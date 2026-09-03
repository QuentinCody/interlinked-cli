// ===========================================
// Inspection-wrapper exemption
// ===========================================
// `interlinked harness test "rm -rf /"` is the documented way to test a
// command against the loaded rules — the destructive text is DATA being
// handed to the inspector, not code being run. Without an exemption the
// outer PreToolUse evaluation pattern-matches the quoted argument and
// blocks the inspection itself (observed live 2026-06-12, blocking the
// exact usage CLAUDE.md suggests).
//
// Mechanism adapted from destructive_command_guard's built-in
// inspection-wrapper exemption (#132) and its redirect-tail hardening
// (independently reimplemented; see
// docs/external-pulse/destructive-command-guard.md): the exemption applies
// ONLY when the full command is the wrapper prefix plus one inert
// argument. Any chain metacharacter, redirect, substitution, or extra
// argument in the tail disqualifies it — `interlinked harness test "x" &&
// rm -rf /` falls through to normal evaluation. Fails closed: when in
// doubt, no exemption.

/** Wrapper prefixes whose next argument is inspected, never executed. */
const INSPECTION_PREFIX_RE =
	/^\s*(?:interlinked|npx\s+tsx\s+src\/index\.ts|node\s+(?:\.\/)?dist\/index\.js)\s+harness\s+test\s+/;

/** Leading option tokens permitted between the prefix and the argument. */
const FLAG_TOKEN_RE = /^--?[\w-]+\s+/;

/** Bare-word argument: no whitespace, quotes, or shell metacharacters. */
const INERT_BARE_WORD_RE = /^[^\s;&|<>`$()\\'"]+$/;

/** Drops the leading option tokens, returning the argument tail. */
function stripLeadingFlags(tail: string): string {
	let rest = tail.trim();
	let flagMatch = FLAG_TOKEN_RE.exec(rest);
	while (flagMatch) {
		rest = rest.slice(flagMatch[0].length);
		flagMatch = FLAG_TOKEN_RE.exec(rest);
	}
	return rest;
}

/** True when `rest` is one single-quoted argument and nothing follows it.
 *  Single quotes are literal in shell — content is inert by construction. */
function isLoneSingleQuotedArgument(rest: string): boolean {
	const close = rest.indexOf("'", 1);
	if (close === -1) return false;
	return rest.slice(close + 1).trim() === "";
}

/** Scans the double-quoted argument opening at index 0, resolving backslash
 *  escapes. Returns the unescaped body and the index of the closing quote,
 *  or null when the quote is unterminated. */
function readDoubleQuotedArgument(
	rest: string,
): { body: string; closeIndex: number } | null {
	let i = 1;
	let body = "";
	while (i < rest.length) {
		const ch = rest[i];
		if (ch === "\\" && i + 1 < rest.length) {
			body += rest[i + 1];
			i += 2;
			continue;
		}
		if (ch === '"') break;
		body += ch;
		i++;
	}
	if (i >= rest.length) return null; // unterminated
	return { body, closeIndex: i };
}

/** True when `rest` is one double-quoted argument, free of expansion, and
 *  nothing follows it. Double quotes still expand `$…` and backticks in the
 *  OUTER shell — `interlinked harness test "$(rm -rf /)"` executes. Reject
 *  both. */
function isLoneDoubleQuotedArgument(rest: string): boolean {
	const scanned = readDoubleQuotedArgument(rest);
	if (!scanned) return false;
	if (/[$`]/.test(scanned.body)) return false;
	return rest.slice(scanned.closeIndex + 1).trim() === "";
}

/** True when `tail` is exactly one inert argument (plus optional leading
 *  flags): a single-quoted string, a double-quoted string free of
 *  expansion/substitution characters, or a bare metacharacter-free word.
 *  Anything after the argument — chaining, redirects, a second argument —
 *  disqualifies. */
function isInertArgumentTail(tail: string): boolean {
	const rest = stripLeadingFlags(tail);
	if (!rest) return false;
	if (rest.startsWith("'")) return isLoneSingleQuotedArgument(rest);
	if (rest.startsWith('"')) return isLoneDoubleQuotedArgument(rest);
	return INERT_BARE_WORD_RE.test(rest);
}

/** Public API — true when the whole Bash command is an inspection-wrapper
 *  invocation whose argument is inert data. Callers skip destructive-rule
 *  evaluation for these (the inner text is what's being inspected). */
export function isInspectionWrapperCall(cmd: string): boolean {
	const m = INSPECTION_PREFIX_RE.exec(cmd);
	if (!m) return false;
	return isInertArgumentTail(cmd.slice(m[0].length));
}
