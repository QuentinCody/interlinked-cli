// interlinked-tdd: exempt
// ===========================================
// git-commit detection — shell tokenization, cwd, and flag-cluster primitives
// ===========================================
// Pure shell-parsing leaf helpers extracted from `commit-parse.ts` to keep the
// parser entry point under the per-file line cap. No fs, no env, no module-scope
// mutable state. `commit-parse.ts` imports these; nothing here imports back (a
// true leaf — no circular import).
//
// `node:path` posix helpers are pure string ops (no fs / env), so they keep this
// module's "no I/O" discipline while giving correct `..`/absolute handling when
// combining `cd` segments and `-C` flags into one effective directory.
import { posix } from "node:path";
import { nonNull } from "../../lib/non-null.js";

/**
 * Minimal shell-aware splitter: handles single + double quotes and backslash
 * escapes so a quoted commit message stays one token. NOT a general bash parser.
 * Exported as part of the blessed shell-structure contract (re-exported via
 * `harness/shell-structure.ts`): every command CLASSIFIER must tokenize with
 * these instead of regex-matching raw command strings, where quoted/echoed
 * text matches as if it were a command (finding 2026-06, round 6).
 */
/** Mutable scan state for {@link shellSplit}'s per-character helper. */
interface ShellSplitScan {
	cur: string;
	inSingle: boolean;
	inDouble: boolean;
}

/**
 * Handle a backslash-escape or a quote toggle at character `c` for
 * {@link shellSplit}. Unlike {@link consumeQuoteOrEscape} (which keeps the
 * quote characters themselves, for segment splitting) this drops them — a
 * shell token never contains its own delimiting quotes. Returns the number of
 * EXTRA characters consumed (1 for an escape that swallowed the next char, 0
 * for a quote toggle), or `null` when `c` is neither. Mutates `scan` in place.
 */
function consumeShellQuoteOrEscape(scan: ShellSplitScan, c: string, next: string | undefined): number | null {
	if (c === "\\" && next !== undefined && !scan.inSingle) {
		scan.cur += next;
		return 1;
	}
	if (c === "'" && !scan.inDouble) {
		scan.inSingle = !scan.inSingle;
		return 0;
	}
	if (c === '"' && !scan.inSingle) {
		scan.inDouble = !scan.inDouble;
		return 0;
	}
	return null;
}

export function shellSplit(input: string): string[] {
	const out: string[] = [];
	const scan: ShellSplitScan = { cur: "", inSingle: false, inDouble: false };
	for (let i = 0; i < input.length; i++) {
		const c = nonNull(input[i]);
		const next = input[i + 1];
		const consumed = consumeShellQuoteOrEscape(scan, c, next);
		if (consumed !== null) {
			i += consumed;
			continue;
		}
		if (/\s/.test(c) && !scan.inSingle && !scan.inDouble) {
			scan.cur = pushSegment(out, scan.cur);
			continue;
		}
		scan.cur += c;
	}
	pushSegment(out, scan.cur);
	return out;
}

/** Append the current buffer as a segment and reset it. */
function pushSegment(segments: string[], cur: string): string {
	if (cur.length > 0) segments.push(cur);
	return "";
}

/** Mutable scan state shared by the segment splitter's per-character helpers. */
interface SegmentScan {
	cur: string;
	inSingle: boolean;
	inDouble: boolean;
}

/**
 * Handle a backslash-escape or a quote toggle at character `c`. Returns the
 * number of EXTRA characters consumed (1 for an escape that swallowed the next
 * char, 0 for a quote toggle), or `null` when `c` is neither — so the caller
 * falls through to separator / literal handling. Mutates `scan` in place.
 */
function consumeQuoteOrEscape(scan: SegmentScan, c: string, next: string | undefined): number | null {
	if (c === "\\" && next !== undefined && !scan.inSingle) {
		scan.cur += c + next;
		return 1;
	}
	if (c === "'" && !scan.inDouble) {
		scan.inSingle = !scan.inSingle;
		scan.cur += c;
		return 0;
	}
	if (c === '"' && !scan.inSingle) {
		scan.inDouble = !scan.inDouble;
		scan.cur += c;
		return 0;
	}
	return null;
}

/** True when `c` is a top-level (unquoted) shell separator: `;`, `|`, `&`. */
function isTopLevelSeparator(scan: SegmentScan, c: string): boolean {
	return !scan.inSingle && !scan.inDouble && (c === ";" || c === "|" || c === "&");
}

/**
 * Split a compound shell line into top-level segments on `;`, `&&`, `||`, and
 * pipes — quote-aware so a separator inside a commit message is ignored. Each
 * segment is parsed for a `git commit` independently (so `cd x && git commit -m y`
 * is detected). The per-character quote / escape / separator logic lives in
 * {@link consumeQuoteOrEscape} and {@link isTopLevelSeparator} to keep this loop
 * low-complexity.
 */
export function splitSegments(command: string): string[] {
	const segments: string[] = [];
	const scan: SegmentScan = { cur: "", inSingle: false, inDouble: false };
	for (let i = 0; i < command.length; i++) {
		const c = nonNull(command[i]);
		const next = command[i + 1];
		const consumed = consumeQuoteOrEscape(scan, c, next);
		if (consumed !== null) {
			i += consumed;
			continue;
		}
		if (isTopLevelSeparator(scan, c)) {
			// Consume a paired `&&` / `||` as one separator.
			if ((c === "&" && next === "&") || (c === "|" && next === "|")) i++;
			scan.cur = pushSegment(segments, scan.cur);
			continue;
		}
		scan.cur += c;
	}
	pushSegment(segments, scan.cur);
	return segments;
}

/** Drop a leading `sudo` / `env VAR=…` / `VAR=…` prefix so `git` is the head token. */
export function stripLeadingPrefix(tokens: string[]): string[] {
	const out = tokens.slice();
	while (out.length > 0) {
		const head = nonNull(out[0]);
		if (head === "sudo" || head === "command" || head === "nohup" || head === "time") {
			out.shift();
			continue;
		}
		if (head === "env") {
			out.shift();
			while (out[0] && /^[A-Za-z_]\w*=/.test(out[0])) out.shift();
			continue;
		}
		if (/^[A-Za-z_]\w*=/.test(head)) {
			out.shift();
			continue;
		}
		break;
	}
	return out;
}

/**
 * Combine a base directory with a `next` one the way a shell does: `next` absolute
 * → `next` wins; otherwise join (posix, so `..` and trailing slashes normalize).
 * `null` base/next are the "no override yet" identity. Used to fold a chain of
 * `cd` segments and compounding `-C` flags into a single effective directory.
 */
export function combineCwd(base: string | null, next: string | null): string | null {
	if (next === null) return base;
	// Absolute (posix or Windows-drive) → it replaces whatever came before.
	if (posix.isAbsolute(next) || /^[A-Za-z]:[\\/]/.test(next)) return next;
	return base ? posix.join(base, next) : next;
}

/**
 * The literal target of a `cd <dir>` segment, or null when the segment is not a
 * plain `cd` or its target cannot be resolved statically (`cd` with no arg, `cd
 * -`, `cd ~...`, or only flags like `cd -P`). A non-literal `cd` deliberately
 * yields null so the caller leaves the effective cwd undefined rather than guess.
 */
export function parseCdTarget(segment: string): string | null {
	const tokens = stripLeadingPrefix(shellSplit(segment));
	if (tokens.length < 2 || tokens[0] !== "cd") return null;
	const dir = tokens.slice(1).find((t) => !t.startsWith("-"));
	if (dir === undefined || dir === "-" || dir.startsWith("~")) return null;
	return literalDir(dir);
}

/**
 * A directory token that can be resolved STATICALLY, or null. A target carrying a
 * shell variable, command substitution, or glob metachar ($, *, ?) cannot be
 * known at parse time, so it yields null and the caller leaves the effective cwd
 * undefined (falling back to the shell cwd) rather than treating it as a literal
 * directory name. Shared by the cd and -C paths so both degrade identically.
 */
export function literalDir(dir: string): string | null {
	return /[$*?]/.test(dir) ? null : dir;
}

/** True for a `-a` / `--all` flag, including a short cluster like `-am` / `-aq` —
 *  but NOT a letter inside an attached option value (`-mfair` is `-m fair`):
 *  only {@link clusterBooleanLetters} count. */
export function isAllFlag(token: string): boolean {
	if (token === "--all") return true;
	return clusterBooleanLetters(token).includes("a");
}

/** True for `--include` / `-i`, including a short cluster like `-im`. Only the
 *  cluster's BOOLEAN letters count — `-mfix` is `-m` with the attached value
 *  `fix`, not a cluster containing `i` (finding 2026-06: it set includesIndex
 *  and false-blocked pathspec commits). In `git commit`'s short-flag set a
 *  boolean `i` IS `--include` to git itself, so this cannot false-positive.
 *  The long `--interactive` is deliberately NOT matched (exact `--include` only). */
export function isIncludeFlag(token: string): boolean {
	if (token === "--include") return true;
	return clusterBooleanLetters(token).includes("i");
}

/** Commit flags that consume the FOLLOWING token as a value (so it is not a pathspec).
 *  `--pathspec-from-file` is deliberately NOT here — it SUPPLIES pathspecs, so it marks
 *  a constructed-content commit (handled first in `hasPathspec`). `-S`/`--gpg-sign` are
 *  deliberately NOT here either: their key id is OPTIONAL and attached-only
 *  (`-Skey`, `--gpg-sign=key`), so `git commit -S file.ts` keeps `file.ts` as a
 *  pathspec — consuming it as a "value" silently dropped the pathspec and the gate
 *  evaluated the wrong commit model (finding 2026-06, attached-value class). */
export const COMMIT_VALUE_FLAGS = new Set([
	"-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message",
	"--author", "--date", "-t", "--template", "--fixup", "--squash", "--cleanup",
	// Repeatable; its "token: value" argument read as a PATHSPEC without this, so
	// `git commit --trailer "X: y" …` narrowed the changed set to a nonexistent
	// path and every staged file bypassed the gate (finding 2026-06).
	"--trailer",
]);

/** Short letters whose value may be ATTACHED (`-mfix`) or the SEPARATE next token
 *  (`-m fix`). Everything after such a letter in a cluster is its value. */
const VALUE_SHORT_LETTERS = "mFCct";

/** Short letters whose value is OPTIONAL and attached-only (`-S[keyid]`,
 *  `-u[mode]`): they terminate cluster scanning (any trailing chars are the
 *  attached value) but NEVER consume the next token. */
const OPTIONAL_ATTACHED_LETTERS = "Su";

/**
 * The BOOLEAN flag letters of a short cluster, respecting attached option
 * values: scanning stops at the first value-taking letter, because everything
 * after it is that option's ATTACHED VALUE, not more flags. `-mfix` is
 * `-m fix` — NO boolean flags — and must not read as a cluster containing `i`
 * (finding 2026-06: it set includesIndex and the default-on commit gate
 * evaluated unrelated staged files, a deterministic false block). `-amfix` is
 * `-a -m fix` → "a". Non-letter characters likewise end the scan. Returns ""
 * for long flags (`--…`) and non-flag tokens.
 */
export function clusterBooleanLetters(token: string): string {
	if (token.length < 2 || token[0] !== "-" || token[1] === "-") return "";
	let letters = "";
	for (const ch of token.slice(1)) {
		if (!/[A-Za-z]/.test(ch)) return letters;
		if (VALUE_SHORT_LETTERS.includes(ch) || OPTIONAL_ATTACHED_LETTERS.includes(ch)) {
			return letters;
		}
		letters += ch;
	}
	return letters;
}

/** True when a short cluster consumes the FOLLOWING token as its value, so that
 *  token is not a pathspec: the cluster's first value-taking letter is its LAST
 *  character (`-am "wip"` → wip is the message). A value-taking letter with
 *  trailing characters has its value ATTACHED (`-amfix`), and an
 *  optional-attached letter (`-S`, `-u`) never consumes the next token. */
export function shortClusterTakesValue(token: string): boolean {
	if (token.length < 2 || token[0] !== "-" || token[1] === "-") return false;
	const letters = token.slice(1);
	for (let i = 0; i < letters.length; i++) {
		const ch = letters[i] ?? "";
		if (!/[A-Za-z]/.test(ch)) return false;
		if (OPTIONAL_ATTACHED_LETTERS.includes(ch)) return false;
		if (VALUE_SHORT_LETTERS.includes(ch)) return i === letters.length - 1;
	}
	return false;
}
