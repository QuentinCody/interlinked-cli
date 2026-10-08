// ===========================================
// Heredoc runtime mask: when is a body data for a non-shell runtime?
// ===========================================
// A QUOTED-delimiter heredoc body fed to python3 / node is neither expanded
// by the shell nor run as shell by the runtime, so `executed_only` rule
// patterns must not see it (origin: builtin-kill-substitution blocked a
// python3 <<'PYEOF' script whose prose said "the kill `stale`").
//
// This mask is narrower than the data-sink mask in spans.ts on purpose. The
// runtime PRINTS, and printed text becomes shell again when it reaches a
// shell (`| sh`, `eval $(…)`, `bash <(…)`, a `done | sh` loop, an earlier
// `exec > >(sh)`). So the mask applies only when ALL hold:
//   1. the delimiter is quoted (an unquoted body has its `$(…)` / backticks
//      run by the shell before the runtime starts);
//   2. an exact closer line exists (no closer means the scanner cannot tell
//      where shell resumes; bash 3.2 also closes on `EOF)` inside `$(…)`);
//   3. the runtime is the literal command word, reached only through env
//      assignments and wrappers WITHOUT options (`sudo -u node bash` runs
//      bash; `-u` takes an argument this walker cannot know);
//   4. the heredoc sits at top level, read from the RAW command text before
//      it by shell-prefix-scan.ts (quotes, comments and earlier heredoc
//      bodies included): no open quote, `$(` / `(` / `{` / backtick, no
//      open `if` / `case` / `do` compound, no zsh `foreach`, no earlier
//      `>(` process substitution, `coproc`, `mkfifo` / `mknod`, or redirect
//      to a descriptor other than 0-2 (`>&3`, `>&p`, `>&${fd}`, /dev/fd/N);
//   5. its header line has no pipe, no trailing `\` continuation and no
//      redirect to such a descriptor.
// Any failure keeps the body scannable, which fails toward recall.
//
// Ruby, Perl and PHP are not runtimes here: their backtick runs a shell
// command. Recall cost, accepted: a shell string the program itself passes
// to os.system / child_process / Bun's `$` is not scanned (the same as for
// `python3 script.py`), nor is a regular file the runtime writes and a
// shell reads, whether a later command (`> x.sh; sh x.sh`), a concurrent
// one (`tail -f x | sh &`) or a fifo made by an earlier tool call (the same
// gap `cat <<'EOF' > x.sh` has). An alias from the user's shell profile
// that adds a pipe is not visible to any text check.

import { nonNull } from "../../lib/non-null.js";
import { scanShellPrefix } from "./shell-prefix-scan.js";

const NON_SHELL_RUNTIME_RE = /^(?:python[\w.]*|pypy[\w.]*|node|nodejs|deno|bun|tsx)$/;

/** Wrappers that forward to the next word when they carry no options. */
const BARE_WRAPPERS = new Set(["builtin", "command", "doas", "exec", "nohup", "sudo", "time"]);

const ENV_ASSIGN_RE = /^[A-Za-z_]\w*=/;

function base(token: string | undefined): string {
	if (token === undefined) return "";
	return token.slice(token.lastIndexOf("/") + 1).toLowerCase();
}

/** Runtime named by a launcher: `npx tsx`, `npx ts-node`, `uv run python`. */
function launcherRuntime(tokens: string[], idx: number): string | null {
	const head = base(tokens[idx]);
	const next = base(tokens[idx + 1]);
	if (head === "npx" && (next === "tsx" || next === "ts-node")) return next;
	if (head === "uv" && next === "run") {
		const runtime = base(tokens[idx + 2]);
		return NON_SHELL_RUNTIME_RE.test(runtime) ? runtime : null;
	}
	return null;
}

/** Index after an `env` prefix and its assignments, or -1 when `env`
 *  carries an option (`env -u X cmd`: the walker cannot parse it). */
function skipEnv(tokens: string[], idx: number): number {
	let next = idx + 1;
	while (next < tokens.length && ENV_ASSIGN_RE.test(nonNull(tokens[next]))) next++;
	return (tokens[next] ?? "").startsWith("-") ? -1 : next;
}

/** Index of the first token that is not a prefix the walker may skip, or
 *  -1 when a prefix carries an option. */
function skipPrefixes(tokens: string[]): number {
	let idx = 0;
	while (idx < tokens.length) {
		const tok = nonNull(tokens[idx]);
		const name = base(tok);
		if (name === "env") {
			idx = skipEnv(tokens, idx);
			if (idx < 0) return -1;
			continue;
		}
		const bareWrapper = BARE_WRAPPERS.has(name) && !(tokens[idx + 1] ?? "").startsWith("-");
		if (!ENV_ASSIGN_RE.test(tok) && !bareWrapper) return idx;
		idx++;
	}
	return idx;
}

/** The non-shell runtime that is the literal command word of `tokens`, or
 *  null. Unlike the data-sink resolver, an option on a wrapper (or a
 *  leading redirect) stops the walk: its argument could be the real command. */
export function strictRuntimeWord(tokens: string[]): string | null {
	const idx = skipPrefixes(tokens);
	if (idx < 0 || idx >= tokens.length) return null;
	const name = base(tokens[idx]);
	if (NON_SHELL_RUNTIME_RE.test(name)) return name;
	return launcherRuntime(tokens, idx);
}

const COMPOUND_WORD_RE = /(?:^|[\n;&|(){}])[ \t]*(if|fi|case|esac|do|done)(?=[\s;&|()]|$)/g;
const COMPOUND_DELTA: Readonly<Record<string, number>> = {
	if: 1,
	case: 1,
	do: 1,
	fi: -1,
	esac: -1,
	done: -1,
};

/** Words that make a later command's stdout reach a shell without a pipe:
 *  a coprocess, a named pipe, a zsh `foreach … end` loop (`end | sh`). */
const ROUTING_WORD_RE = /(?:^|[\s;&|(){}`])(?:coproc|mkfifo|mknod|foreach)(?=[\s;&|()]|$)/;

/** A redirect to a descriptor other than 0-2: `>&3`, zsh `>&p` (the
 *  coprocess), `>&${COPROC[1]}`, or a /dev/fd/N or /proc/…/fd/N path. */
const FD_ROUTE_RE = /[<>]&\s*(?:p\b|[$3-9]|\d{2,})|\/dev\/fd\/|\/proc\/\S*\/fd\//;

function compoundOpen(bareShell: string): boolean {
	let depth = 0;
	for (const m of bareShell.matchAll(COMPOUND_WORD_RE)) {
		depth = Math.max(0, depth + (COMPOUND_DELTA[nonNull(m[1])] ?? 0));
	}
	return depth > 0;
}

/** True when the raw command text before a heredoc operator leaves it at
 *  top level, so the runtime's stdout cannot be routed into a shell by an
 *  enclosing construct or an earlier redirect. */
export function isTopLevelShellContext(shellPrefix: string): boolean {
	const scan = scanShellPrefix(shellPrefix);
	if (!scan.topLevel || scan.bare.includes(">(")) return false;
	if (ROUTING_WORD_RE.test(scan.bare) || FD_ROUTE_RE.test(scan.bare)) return false;
	return !compoundOpen(scan.bare);
}

export interface RuntimeHeredocContext {
	quotedTag: boolean;
	/** An exact `TAG` closer line was found (not `TAG)`, not end of input). */
	exactCloser: boolean;
	/** Segment text left of the operator on its own line. */
	segmentBefore: string;
	/** Header line text after the delimiter word, up to the newline. */
	headerRest: string;
	/** Raw command text before the operator. */
	shellPrefix: string;
}

/** Quoted strings removed, so a quoted `)` or `|` cannot change the count. */
function stripQuoted(text: string): string {
	return text.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "");
}

function headerRouted(headerRest: string): boolean {
	if (headerRest.trimEnd().endsWith("\\")) return true;
	const piped = /[|(`]/.test(stripQuoted(headerRest).replace(/\|\|/g, ""));
	return piped || FD_ROUTE_RE.test(headerRest);
}

function runtimeTarget(segmentBefore: string, headerRest: string): string | null {
	const before = segmentBefore.trim();
	const text = before || (headerRest.split(/[;|&]/)[0] ?? "").trim();
	return strictRuntimeWord(text.split(/\s+/).filter(Boolean));
}

/** True when the heredoc body is data for a non-shell runtime and its
 *  output cannot reach a shell (see the module header for the five rules). */
export function isRuntimeDataHeredoc(ctx: RuntimeHeredocContext): boolean {
	if (!ctx.quotedTag || !ctx.exactCloser) return false;
	if (headerRouted(ctx.headerRest)) return false;
	if (runtimeTarget(ctx.segmentBefore, ctx.headerRest) === null) return false;
	return isTopLevelShellContext(ctx.shellPrefix);
}
