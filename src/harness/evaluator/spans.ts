// ===========================================
// Shell command span classification
// ===========================================
// Walk a command character-by-character, classifying each byte range as
// `executed`, `inline_code`, `quoted`, `comment`, or `heredoc`. Used by
// rule-matching to suppress false positives inside quoted strings and
// comments — `git commit -m 'rm -rf /'` should not fire `rm -rf` rules
// (Plan 01 §1.2) — and by command decomposition to know which regions are
// atomic (never split on operators inside them).
//
// Two precision upgrades adapted from destructive_command_guard's #136
// work (mechanisms reimplemented independently — no code ported; see
// docs/external-pulse/destructive-command-guard.md):
//   • Heredoc bodies are masked ONLY when the receiving command is a
//     known non-executing data sink (`cat <<EOF` is data; `bash <<EOF`
//     is code and must stay scannable). Bodies whose target executes —
//     or is unknown — get `scannable: true` so `executed_only` patterns
//     still see them. Target resolution is bounded to the heredoc
//     operator's own line so a data sink on an earlier line can never
//     mask a later executing body.
//   • A quoted string that is the payload of an interpreter's inline
//     exec flag (`bash -c '…'`, `python -u -c "…"`, `perl -e '…'`,
//     `pwsh -Command "…"`) is classified `inline_code`, not `quoted`:
//     scannable like executed text, atomic like a quoted string. The
//     detector is deliberately recall-first — `xargs bash -c '…'` and
//     even `echo "bash -c 'rm -rf /'"` classify as inline code (scanned)
//     because missing a real payload is worse than scanning prose.

type SpanKind = "executed" | "inline_code" | "quoted" | "comment" | "heredoc";

export interface Span {
	kind: SpanKind;
	start: number;
	end: number;
	text: string;
	/** Heredoc bodies only: the receiving command executes its stdin (or is
	 *  unknown), so rule patterns must still scan this region. */
	scannable?: boolean;
}

const QUOTE_SINGLE = "'";
const QUOTE_DOUBLE = '"';
const ANSI_C_QUOTE = "$'";
const COMMENT_CHAR = "#";
const HEREDOC_TOKEN = "<<";

/** Commands whose stdin is consumed strictly as data — a heredoc body fed
 *  to one of these can never execute and is safe to mask. Anything that
 *  can evaluate, forward, or apply its stdin (shells, language runtimes,
 *  SQL/REPL clients, ssh, docker/kubectl exec, xargs, eval) must NOT be
 *  here: unknown targets are treated as executing, so omission fails
 *  toward recall. */
const HEREDOC_DATA_SINKS: ReadonlySet<string> = new Set([
	":",
	"awk",
	"base64",
	"cat",
	"cksum",
	"clip",
	"cmp",
	"column",
	"comm",
	"cut",
	"diff",
	"egrep",
	"false",
	"fgrep",
	"file",
	"gawk",
	"gh",
	"git",
	"glab",
	"grep",
	"head",
	"hexdump",
	"jq",
	"less",
	"mail",
	"mailx",
	"mapfile",
	"md5",
	"md5sum",
	"more",
	"nl",
	"od",
	"paste",
	"pbcopy",
	"read",
	"readarray",
	"rev",
	"rg",
	"sed",
	"sha1sum",
	"sha256sum",
	"sha512sum",
	"shasum",
	"sort",
	"sponge",
	"strings",
	"tac",
	"tail",
	"tee",
	"tr",
	"true",
	"uniq",
	"wc",
	"xxd",
	"yq",
]);

/** Prefix commands that forward to the real command word. `env`, `timeout`
 *  and `nice` get their own argument handling in the resolver loop. */
const WRAPPER_TOKENS = new Set(["builtin", "command", "doas", "exec", "nohup", "sudo", "time"]);

const ENV_ASSIGN_RE = /^[A-Za-z_]\w*=/;

function basenameLower(token: string): string {
	const slash = token.lastIndexOf("/");
	return (slash >= 0 ? token.slice(slash + 1) : token).toLowerCase();
}

/** Walk leading wrapper/assignment tokens and return the effective command
 *  word (lower-cased basename), or null when none is present. */
function effectiveCommandWord(tokens: string[]): string | null {
	let idx = 0;
	while (idx < tokens.length) {
		const tok = tokens[idx] as string;
		if (ENV_ASSIGN_RE.test(tok)) {
			idx++;
			continue;
		}
		const base = basenameLower(tok);
		if (WRAPPER_TOKENS.has(base)) {
			idx++;
			continue;
		}
		if (base === "env") {
			idx++;
			while (
				idx < tokens.length &&
				(ENV_ASSIGN_RE.test(tokens[idx] as string) || (tokens[idx] as string).startsWith("-"))
			)
				idx++;
			continue;
		}
		if (base === "timeout" || base === "nice") {
			idx++;
			while (
				idx < tokens.length &&
				((tokens[idx] as string).startsWith("-") || /^\d/.test(tokens[idx] as string))
			)
				idx++;
			continue;
		}
		if (tok.startsWith("-") || tok.startsWith("<") || tok.startsWith(">")) {
			idx++;
			continue;
		}
		return base;
	}
	return null;
}

/** Resolve the command that receives a heredoc's stdin. Bounded to the
 *  operator's own line AND its own pipe/chain segment within that line —
 *  never scans across newlines, so `cat file.txt\nbash <<EOF` resolves to
 *  `bash`, not `cat` (the unbounded-backward-scan soundness bug dcg fixed
 *  in their #136). Checks left of the operator first, then right (bash
 *  permits `<<EOF cmd` as well as `cmd <<EOF`). */
/** Scan backward from `lineStart` to `operatorIndex` to find where the
 *  current pipe/chain segment starts, honoring quotes with a minimal
 *  scanner (the slice is one line) so separators inside strings don't
 *  split the segment. */
function findHeredocSegmentStart(cmd: string, lineStart: number, operatorIndex: number): number {
	let segStart = lineStart;
	let inSingle = false;
	let inDouble = false;
	for (let i = lineStart; i < operatorIndex; i++) {
		const ch = cmd[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (!inSingle && !inDouble && (ch === ";" || ch === "|" || ch === "&" || ch === "("))
			segStart = i + 1;
	}
	return segStart;
}

/** Nothing left of the heredoc operator — look right on the same line
 *  (bash permits `<<EOF cmd`), stopping at a separator (the command after
 *  a pipe receives the pipe, not the heredoc). */
function resolveHeredocTargetRight(cmd: string, headerEnd: number): string | null {
	let lineEnd = cmd.indexOf("\n", headerEnd);
	if (lineEnd === -1) lineEnd = cmd.length;
	let after = cmd.slice(headerEnd, lineEnd);
	const sep = after.search(/[;|&]/);
	if (sep !== -1) after = after.slice(0, sep);
	const trimmed = after.trim();
	if (!trimmed) return null;
	return effectiveCommandWord(trimmed.split(/\s+/).filter(Boolean));
}

export function resolveHeredocTarget(
	cmd: string,
	operatorIndex: number,
	headerEnd: number,
): string | null {
	const lineStart = cmd.lastIndexOf("\n", operatorIndex - 1) + 1;
	// Find the segment start: last top-level separator on the line before the
	// operator, tracked with a minimal quote scanner (the slice is one line).
	const segStart = findHeredocSegmentStart(cmd, lineStart, operatorIndex);
	const before = cmd.slice(segStart, operatorIndex).trim();
	if (before) {
		const word = effectiveCommandWord(before.split(/\s+/).filter(Boolean));
		if (word) return word;
	}
	return resolveHeredocTargetRight(cmd, headerEnd);
}

/** Interpreter inline-exec payload detector: does the executed text ending
 *  just before a quote opener look like `<interpreter> … <exec-flag> `?
 *  Matches `bash -c`, `sh -xc`, `python3 -u -c`, `node -e`/`-p`,
 *  `perl -pe`, `pwsh -Command`, `powershell -EncodedCommand`, with
 *  optional sudo/env wrappers and a path prefix on the interpreter.
 *  Recall-first: the interpreter name may appear mid-command (covers
 *  `xargs bash -c …` / `find -exec sh -c …` at the cost of scanning
 *  prose like `echo "bash -c '…'"`). */
const INLINE_EXEC_FLAG_RE =
	/(?:^|[\s;&|`(])(?:(?:sudo|doas|command|nohup|time)\s+)*(?:[A-Za-z_]\w*=\S*\s+)*(?:[\w./-]*\/)?(?:sh|bash|zsh|ksh|dash|fish|python[\w.]*|pypy[\w.]*|node|nodejs|deno|bun|ruby|perl|php|pwsh|powershell)(?:\.exe)?\s[^;&|`\n]*?(?:-\w*[ce]|-p|-pe|--command|--eval|-Command|-EncodedCommand)(?:=|\s+)$/i;

/** True when the quote opening at `quoteStart` is an interpreter's inline
 *  exec payload. Looks back only within the opener's own line. */
function isInlineExecPayload(cmd: string, quoteStart: number): boolean {
	const lineStart = cmd.lastIndexOf("\n", quoteStart - 1) + 1;
	return INLINE_EXEC_FLAG_RE.test(cmd.slice(lineStart, quoteStart));
}

// Closes the current run at `end` (pushing a span if non-empty) and re-opens a
// fresh run of `nextKind` starting at `nextStart`; `nextScannable` marks the
// new run as scannable (heredoc bodies feeding an executing target). Mutates
// the scanner state the closure captures in `classifySpans`.
type FlushFn = (
	end: number,
	nextKind: SpanKind,
	nextStart: number,
	nextScannable?: boolean,
) => void;

// Each `scan*` byte-class handler below is invoked only while the scanner is in
// the `executed` state. It returns the index to resume at when it consumed a
// region, or `null` when its trigger byte(s) aren't present so the orchestrator
// can try the next handler (and finally advance one byte). Handlers themselves
// call `flush` to record the regions they consume.

/**
 * Scan an escaped-quote body: from `i` (positioned just past the opening quote)
 * to just past the matching `closer`, honoring backslash escapes. Returns the
 * index after the closing quote, or `cmd.length` if unterminated. Shared by the
 * double-quote and ANSI-C (`$'…'`) handlers, which differ only in their closer.
 */
function scanEscapedQuoteBody(cmd: string, i: number, closer: string): number {
	while (i < cmd.length) {
		if (cmd[i] === "\\" && i + 1 < cmd.length) {
			i += 2;
			continue;
		}
		if (cmd[i] === closer) {
			i++;
			break;
		}
		i++;
	}
	return i;
}

/** Heredoc: `<<TAG` / `<<-TAG` (optionally quoted tag). The body — from the
 *  line after the header to the closer line — is `heredoc`; the rest of the
 *  header line (pipes, redirects) stays executed. Bodies whose target is not
 *  a known data sink are marked `scannable`. */
function scanHeredoc(cmd: string, i: number, flush: FlushFn): number | null {
	if (cmd.slice(i, i + 2) !== HEREDOC_TOKEN) return null;
	const m = cmd.slice(i).match(/^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/);
	if (!m) return null;
	const dashed = m[1] === "-";
	const tag = m[3] as string;
	const headerEnd = i + m[0].length;

	// Body begins after the header line's newline — `cat <<EOF > out.txt`
	// keeps its redirect in executed text.
	const headerNewline = cmd.indexOf("\n", headerEnd);
	if (headerNewline === -1) {
		// No body in this string at all; header stays executed text.
		return headerEnd;
	}
	const bodyStart = headerNewline + 1;

	const target = resolveHeredocTarget(cmd, i, headerEnd);
	const masked = target !== null && HEREDOC_DATA_SINKS.has(target);

	if (masked) {
		flush(bodyStart, "heredoc", bodyStart);
	} else {
		flush(bodyStart, "heredoc", bodyStart, true);
	}
	// `<<-` strips leading tabs from the closer line.
	const closer = new RegExp(dashed ? `(^|\\n)\\t*${tag}(\\n|$)` : `(^|\\n)${tag}(\\n|$)`);
	const after = cmd.slice(bodyStart);
	const closerMatch = after.match(closer);
	let bodyEnd: number;
	if (closerMatch && closerMatch.index !== undefined) {
		bodyEnd = bodyStart + closerMatch.index + (closerMatch[1] ? 1 : 0);
	} else {
		bodyEnd = cmd.length;
	}
	flush(bodyEnd, "executed", bodyEnd);
	return bodyEnd;
}

/** `#` comment — only at a word boundary — runs to end of line. */
function scanComment(cmd: string, i: number, flush: FlushFn): number | null {
	if (cmd[i] !== COMMENT_CHAR) return null;
	const prev = i > 0 ? (cmd[i - 1] as string) : "";
	const isWordBoundary = prev === "" || /\s/.test(prev);
	if (!isWordBoundary) return null;
	flush(i, "comment", i);
	const newline = cmd.indexOf("\n", i);
	const stop = newline === -1 ? cmd.length : newline;
	flush(stop, "executed", stop);
	return stop;
}

/** ANSI-C `$'…'` quoting (escape-aware, single-quote terminator). */
function scanAnsiCQuote(cmd: string, i: number, flush: FlushFn): number | null {
	if (cmd.slice(i, i + 2) !== ANSI_C_QUOTE) return null;
	const kind: SpanKind = isInlineExecPayload(cmd, i) ? "inline_code" : "quoted";
	flush(i, kind, i);
	const end = scanEscapedQuoteBody(cmd, i + 2, QUOTE_SINGLE);
	flush(end, "executed", end);
	return end;
}

/** `'…'` single quoting — literal, no backslash escapes. */
function scanSingleQuote(cmd: string, i: number, flush: FlushFn): number | null {
	if (cmd[i] !== QUOTE_SINGLE) return null;
	const kind: SpanKind = isInlineExecPayload(cmd, i) ? "inline_code" : "quoted";
	flush(i, kind, i);
	let j = i + 1;
	while (j < cmd.length && cmd[j] !== QUOTE_SINGLE) j++;
	if (j < cmd.length) j++;
	flush(j, "executed", j);
	return j;
}

/** `"…"` double quoting (escape-aware). */
function scanDoubleQuote(cmd: string, i: number, flush: FlushFn): number | null {
	if (cmd[i] !== QUOTE_DOUBLE) return null;
	const kind: SpanKind = isInlineExecPayload(cmd, i) ? "inline_code" : "quoted";
	flush(i, kind, i);
	const end = scanEscapedQuoteBody(cmd, i + 1, QUOTE_DOUBLE);
	flush(end, "executed", end);
	return end;
}

export function classifySpans(cmd: string): Span[] {
	const spans: Span[] = [];
	let i = 0;
	let runStart = 0;
	let runKind: SpanKind = "executed";
	let runScannable = false;

	const flush: FlushFn = (end, nextKind, nextStart, nextScannable) => {
		if (end > runStart) {
			const span: Span = {
				kind: runKind,
				start: runStart,
				end,
				text: cmd.slice(runStart, end),
			};
			if (runScannable) span.scannable = true;
			spans.push(span);
		}
		runKind = nextKind;
		runStart = nextStart;
		runScannable = nextScannable === true;
	};

	while (i < cmd.length) {
		const next =
			scanHeredoc(cmd, i, flush) ??
			scanComment(cmd, i, flush) ??
			scanAnsiCQuote(cmd, i, flush) ??
			scanSingleQuote(cmd, i, flush) ??
			scanDoubleQuote(cmd, i, flush);
		if (next !== null) {
			i = next;
			continue;
		}
		i++;
	}
	flush(cmd.length, "executed", cmd.length);
	return spans.filter((s) => s.end > s.start);
}

/** True when rule patterns should see this span's text: executed text,
 *  interpreter inline-exec payloads, and heredoc bodies that feed an
 *  executing (or unknown) target. */
function isScannableSpan(s: Span): boolean {
	if (s.kind === "executed" || s.kind === "inline_code") return true;
	return s.kind === "heredoc" && s.scannable === true;
}

export function extractScannableText(cmd: string, spans?: Span[]): string {
	const ss = spans ?? classifySpans(cmd);
	const buf: string[] = [];
	for (const s of ss) {
		if (isScannableSpan(s)) {
			buf.push(s.text);
		} else {
			buf.push(" ".repeat(s.end - s.start));
		}
	}
	return buf.join("");
}
