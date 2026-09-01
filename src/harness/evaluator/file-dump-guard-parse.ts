// interlinked-tdd: exempt
// ===========================================
// File-Dump Guard — shell command parsing helpers
// ===========================================
//
// Pure string/number parsing primitives split out of `file-dump-guard.ts`
// (no module-private state, no fs/path imports). These tokenize a Bash
// command into pipeline segments and flag/value tokens for the dump-budget
// verdict logic in the main file.

/**
 * Returns the first shell command group — the text up to the first top-level
 * `;`, `&&`, `||`, or newline (quote-aware). Pipes and single `&`
 * (backgrounding) are intentionally NOT boundaries: a pipeline is the unit a
 * dump is analyzed in, and a trailing `&` is load-bearing for the `tail -f`
 * follow check. This is what makes the guard's "inspect the first segment"
 * contract actually hold — without it, `parseCountFlag` and the verb scan ran
 * over every `;`-joined command at once, so a trailing `sed -n '295,350p'`
 * leaked its `-n 295` onto a leading `head`, reported as "`head` requesting
 * 295 lines" (observed 2026-06-12).
 */
import { nonNull } from "../../lib/non-null.js";

export function firstCommandGroup(command: string): string {
	let q: '"' | "'" | "`" | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (q) {
			if (ch === q) q = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			q = ch;
			continue;
		}
		if (ch === ";" || ch === "\n") return command.slice(0, i);
		if ((ch === "&" || ch === "|") && command[i + 1] === ch) return command.slice(0, i);
	}
	return command;
}

/**
 * Splits on pipeline `|` boundaries while respecting single/double/backtick
 * quoting. Does not split on `||` (boolean OR). Compound separators (`;`,
 * `&&`) are bounded out earlier by `firstCommandGroup`.
 */
export function splitPipeline(command: string): string[] {
	const out: string[] = [];
	let buf = "";
	let q: '"' | "'" | "`" | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (q) {
			buf += ch;
			if (ch === q) q = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			q = ch;
			buf += ch;
			continue;
		}
		if (ch === "|") {
			if (command[i + 1] === "|") {
				buf += "||";
				i++;
				continue;
			}
			out.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf.length > 0) out.push(buf);
	return out;
}

/** Whitespace + quote-aware tokenizer for a single pipeline segment. */
export function tokenize(segment: string): string[] {
	const out: string[] = [];
	let buf = "";
	let q: '"' | "'" | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = nonNull(segment[i]);
		if (q) {
			if (ch === q) {
				q = null;
				continue;
			}
			buf += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			q = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (buf) {
				out.push(buf);
				buf = "";
			}
			continue;
		}
		buf += ch;
	}
	if (buf) out.push(buf);
	return out;
}

/** Drops `sudo|exec|nohup|command`, `env VAR=val`, and bare `VAR=val` prefixes. */
export function stripLeadingWrappers(tokens: string[]): void {
	while (tokens.length > 0) {
		const t = nonNull(tokens[0]);
		if (t === "sudo" || t === "exec" || t === "nohup" || t === "command") {
			tokens.shift();
			continue;
		}
		if (t === "env") {
			tokens.shift();
			while (tokens[0] && /^[A-Za-z_]\w*=/.test(tokens[0])) tokens.shift();
			continue;
		}
		if (/^[A-Za-z_]\w*=/.test(t)) {
			tokens.shift();
			continue;
		}
		break;
	}
}

/**
 * Checks for `-f` / `-F` (follow modes) anywhere in the flag tokens. Handles
 * both `-f` standalone and combined short flags like `-Fn5`.
 */
export function hasFollowFlag(tokens: string[]): boolean {
	for (const t of tokens.slice(1)) {
		if (t.startsWith("--")) continue;
		if (!t.startsWith("-")) break;
		// Combined short flags: -f, -fF, -nf, etc.
		const flagBody = t.slice(1);
		if (/[fF]/.test(flagBody)) return true;
	}
	return false;
}

/**
 * Detects output redirection in the raw command string. Excludes `<<` (heredoc),
 * `>=` and `=>` (operators that may appear in quoted strings — but we accept
 * the imperfection since redirects outside quotes are the common case).
 */
export function hasOutputRedirect(command: string): boolean {
	// `>>`, `>`, `&>`, `\d+>` outside of pure quoted regions.
	// Simple sweep with a quote-respecting state machine.
	let q: '"' | "'" | "`" | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (q) {
			if (ch === q) q = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			q = ch;
			continue;
		}
		if (ch === ">") {
			const prev = command[i - 1];
			const next = command[i + 1];
			// Skip `>=` and `=>` (arithmetic/comparison contexts inside test commands)
			if (next === "=" || prev === "=") continue;
			return true;
		}
	}
	return false;
}

/** Parses an optional `+`-prefixed leading integer from `s`, else `null`. */
function parseLeadingInt(s: string): number | null {
	const m = s.match(/^\+?(\d+)\b/);
	return m ? parseInt(nonNull(m[1]), 10) : null;
}

/**
 * Reads the numeric value a flag carries at token index `i`, in any of the
 * supported shapes for `flag` (the short `-n`/`-c` or long `--lines`/`--bytes`):
 * `flag N` (separate token), `flag=N`, and — for the short form only — the
 * combined `flagN` (`-n50`). Returns the parsed count, or `null` if this token
 * doesn't carry `flag`'s value (signalled by the caller continuing the scan).
 */
function flagCountAt(tokens: string[], i: number, flag: string, allowCombined: boolean): number | null {
	const t = tokens[i];
	if (t === flag) {
		const next = tokens[i + 1];
		return next === undefined ? null : parseLeadingInt(next);
	}
	if (nonNull(t).startsWith(`${flag}=`)) return parseLeadingInt(nonNull(t).slice(flag.length + 1));
	if (allowCombined && nonNull(t).length > flag.length && nonNull(t).startsWith(flag) && /^\+?\d/.test(nonNull(nonNull(t)[flag.length]))) {
		return parseLeadingInt(nonNull(t).slice(flag.length));
	}
	return null;
}

/** True when `t` carries a value for `flag` in any supported shape. */
function tokenMatchesFlag(t: string, flag: string, allowCombined: boolean): boolean {
	if (t === flag || t.startsWith(`${flag}=`)) return true;
	return allowCombined && t.length > flag.length && t.startsWith(flag) && /^\+?\d/.test(nonNull(t[flag.length]));
}

/**
 * Parses a numeric flag (`-n N`, `-n+N`, `-nN`, `--lines=N`) out of the token
 * stream. Returns the integer count or `null` if not present / not parseable.
 */
export function parseCountFlag(tokens: string[], shortFlag: "-n" | "-c"): number | null {
	const longFlag = shortFlag === "-n" ? "--lines" : "--bytes";
	for (let i = 1; i < tokens.length; i++) {
		const t = nonNull(tokens[i]);
		if (tokenMatchesFlag(t, shortFlag, /* allowCombined */ true)) {
			return flagCountAt(tokens, i, shortFlag, true);
		}
		if (tokenMatchesFlag(t, longFlag, /* allowCombined */ false)) {
			return flagCountAt(tokens, i, longFlag, false);
		}
	}
	return null;
}

/**
 * Extracts positional file path arguments from the token stream. Returns
 * empty array when the args contain a glob, command substitution, or other
 * shape we can't safely stat — so the guard fails open on uncertain inputs.
 */
export function extractFilePaths(tokens: string[], verb: string): string[] {
	const out: string[] = [];
	// Flags that take a separate value argument.
	const flagsWithValue = new Set(["-n", "-c", "--lines", "--bytes"]);
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t) continue;
		// End-of-flags marker
		if (t === "--") {
			for (const f of tokens.slice(i + 1)) if (f) out.push(f);
			break;
		}
		if (t.startsWith("-")) {
			// `-n 50` form: skip next token.
			if (flagsWithValue.has(t)) i++;
			continue;
		}
		// Bail on shapes we can't stat reliably.
		if (/[*?[\]]/.test(t)) return [];
		if (t.includes("$(") || t.startsWith("`") || t.startsWith("$")) return [];
		out.push(t);
	}
	// `cat` reading stdin (no positional arg) is fine — return empty.
	if (out.length === 0) return [];
	// `tail` / `head` numeric-only obsolete syntax (`tail -50 file`) — unusual,
	// not bothering to parse; if we picked up a number as a "file" we'd stat
	// fail and silently allow. Acceptable.
	void verb;
	return out;
}

/** Best-effort strip of a leading path on a command name, e.g. `/usr/bin/jq` → `jq`. */
export function stripPathPrefix(token: string): string {
	const idx = token.lastIndexOf("/");
	return idx >= 0 ? token.slice(idx + 1) : token;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
