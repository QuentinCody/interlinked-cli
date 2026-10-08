// ===========================================
// Network intent — ONE answer to "does this Bash command make a network call?"
// ===========================================
// Consumers (2026-10-05): the taint hard block (evaluator/taint-guards.ts, via
// taint-tracker.ts isOutboundNetworkCommand), secret_read_then_network_call
// (sequence-checks/security.ts), lethal_trifecta_structural leg 3 and
// github_issue_body_then_action (sequence-checks/injection.ts), the leg-2
// fetched_external source (bash-provenance.ts) and the lockdown mirror
// (lockdown-policy.ts). Before this module they used three definitions and
// disagreed: a URL literal in a local command counted as a network call for
// the trifecta, while `for u in …; do curl …; done` and
// `python3 - <<X urlopen(os.environ['U'])` passed every gate (investigation:
// .interlinked/agent-output/antithesis/deep/harness/H3-sensitivity-network-leg.md).
//
// How a command is read:
//   1. heredoc bodies are cut out of the shell text (they are data, or a
//      program for the interpreter that receives them);
//   2. the rest splits into logical lines (quote-aware; comments dropped;
//      `\`-newline joined), then into segments (`;` `&&` `||` `|` `&`);
//   3. each segment's head is found past compound keywords (`do`, `then`,
//      `else`, `!`, `{`, `(`), assignments and wrappers (`sudo`, `env`,
//      `timeout`, `xargs`, `sandbox-exec`, …);
//   4. a network verb is judged by the table in network-verbs.ts; an
//      interpreter's INLINE program by the API table in
//      network-interpreter-apis.ts; `bash -c`, `eval`, a shell heredoc and every
//      `$(…)` / backtick / `<(…)` body are read again as commands.
// A URL string alone is never a network call. An interpreter that runs a
// script FILE (`python3 x.py`) is not inspected — a recorded open gap. For the
// egress legs only, such unreadable code (a script file, a module run, an
// unknown binary — any head outside network-verbs.ts LOCAL_TOOLS) that is handed
// a public or templated URL is recorded as `opaque` and counts as external.

import { classifyHost } from "./host-class.js";
import { findHeredocs, type Heredoc, interpreterName } from "./interpreter-programs.js";
import { parseInterpreterArgs, scanModulesForNetwork, scanProgramForNetwork } from "./network-interpreter-apis.js";
import { classifyVerb, hostsInText, isPublicHost, LOCAL_TOOLS, type NetworkKind } from "./network-verbs.js";
import { shellSplit, splitSegments } from "./shell-structure.js";

export type NetworkVia = "verb" | "interpreter-api" | "none";

/** One segment (or inline program) that makes a network call. */
export interface NetworkSegment {
	/** The segment text, trimmed. */
	text: string;
	/** The command word that makes the call (`curl`, `python3`). */
	head: string;
	via: Exclude<NetworkVia, "none">;
	kind: NetworkKind;
	/** False only for a proven local peer (loopback URL, Unix socket). */
	outbound: boolean;
	hosts: string[];
	hostsUnknown: boolean;
}

export interface NetworkIntent {
	/** Some segment opens an outbound (non-loopback) connection. */
	network: boolean;
	/** How the first outbound segment was recognized. */
	via: NetworkVia;
	/** Every network segment, loopback ones included. */
	segments: NetworkSegment[];
	/** Literal hosts of the outbound segments. */
	hosts: string[];
	/** Segments that are not proven network calls but run code the classifier
	 *  cannot read (script file, unknown binary) and are handed a public or
	 *  templated URL. Only the egress legs read this (isExternalNetworkIntent). */
	opaque: OpaqueSegment[];
}

/** A segment whose head is unreadable code carrying a public or templated URL. */
export interface OpaqueSegment {
	text: string;
	head: string;
	/** Public literal hosts in the segment. */
	hosts: string[];
	/** A URL host is templated (`https://$H/`). */
	hostsUnknown: boolean;
}

interface Collected {
	segments: NetworkSegment[];
	opaque: OpaqueSegment[];
}

/** Nested shell programs (`bash -c`, `$(…)`) are followed this deep. */
const MAX_DEPTH = 4;
const HEREDOC_MARK = "<<HEREDOC_";
const HEREDOC_MARK_RE = /<<HEREDOC_(\d+)/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `$(…)`, `<(…)`, `>(…)` (one nesting level) and backtick substitutions. */
const SUBSTITUTION_RE = /[$<>]\(((?:[^()]|\([^()]*\))*)\)|`([^`]*)`/g;
/** The scan buffer ends at a word start, so a `#` here opens a comment. */
const COMMENT_START_RE = /(?:^|[\s;&|(])$/;

/** Words that open a compound command and are followed by a real command. */
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "time", "coproc"]);
/** Words that start a segment which runs no command of its own. */
const NOT_A_COMMAND = new Set(["for", "case", "select", "done", "fi", "esac", "in", "}", ")"]);
/** `name()` / `name(){` — a function header; its body's first command follows. */
const FUNCTION_HEADER_RE = /^[A-Za-z_][\w.:-]*\(\)\{?$/;
/** `pat)` / `a|b)` / `*)` — a case-arm pattern; the arm's first command follows. */
const CASE_PATTERN_RE = /^[^()\s]+\)$/;

interface Wrapper {
	/** Flags that consume the following word. */
	valueFlags?: readonly string[];
	/** Positional words consumed after the flags (`timeout 10`). */
	positional?: number;
	/** The wrapped command receives arguments the classifier cannot see. */
	dynamic?: boolean;
	/** A first flag that makes the wrapper look the word up instead of running it. */
	lookupFlags?: readonly string[];
}

/** Commands that run the command after them. */
const WRAPPERS: Readonly<Record<string, Wrapper>> = {
	sudo: { valueFlags: ["-u", "-g", "-h", "-p", "-C", "-U", "-r", "-t", "-D", "-R"] },
	env: { valueFlags: ["-u", "-C", "-P", "-S"] },
	command: { lookupFlags: ["-v", "-V"] },
	builtin: {},
	exec: { valueFlags: ["-a"] },
	nohup: {},
	nice: { valueFlags: ["-n"] },
	timeout: { valueFlags: ["-s", "-k", "--signal", "--kill-after"], positional: 1 },
	xargs: { valueFlags: ["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "-l"], dynamic: true },
	"sandbox-exec": { valueFlags: ["-p", "-f", "-n", "-D"] },
	caffeinate: { valueFlags: ["-t", "-w"] },
	stdbuf: { valueFlags: ["-i", "-o", "-e"] },
	unbuffer: {},
};

/** Interpreter flags (program, value and module-load flags) are parsed by
 *  network-interpreter-apis.ts parseInterpreterArgs. */
const SHELL_PROGRAM_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;

interface Head {
	head: string;
	headWord: string;
	args: string[];
	prefixes: string[];
	viaXargs: boolean;
}

function basename(word: string): string {
	return (word.split("/").pop() ?? word).toLowerCase();
}

/** Drop a wrapper's own flags and positional words from the front of `rest`. */
function skipWrapperArgs(rest: string[], wrapper: Wrapper): void {
	while (rest.length > 0 && (rest[0] ?? "").startsWith("-")) {
		const flag = rest.shift() ?? "";
		if (flag === "--") break;
		if (wrapper.valueFlags?.includes(flag)) rest.shift();
	}
	rest.splice(0, wrapper.positional ?? 0);
}

/** Drop one leading word that is shell syntax, not a command: `(` / `{`
 *  openers, compound keywords, and a function header (`f(){`, `function f {`).
 *  True when something was dropped. */
function dropSyntaxWord(rest: string[]): boolean {
	const word = (rest[0] ?? "").replace(/^[({]+/, "");
	rest[0] = word;
	if (word === "function") {
		rest.splice(0, 2);
		return true;
	}
	if (word !== "" && !KEYWORDS.has(word) && !FUNCTION_HEADER_RE.test(word) && !CASE_PATTERN_RE.test(word)) return false;
	rest.shift();
	return true;
}

/** The real command of a segment's tokens, or null when it runs none. */
function normalizeHead(tokens: readonly string[]): Head | null {
	const rest = tokens.slice();
	const prefixes: string[] = [];
	let viaXargs = false;
	while (rest.length > 0) {
		if (dropSyntaxWord(rest)) continue;
		const word = rest[0] ?? "";
		if (ASSIGNMENT_RE.test(word)) {
			prefixes.push(rest.shift() ?? word);
			continue;
		}
		const wrapper = WRAPPERS[basename(word)];
		if (!wrapper) break;
		if (wrapper.lookupFlags?.includes(rest[1] ?? "")) return null;
		rest.shift();
		skipWrapperArgs(rest, wrapper);
		viaXargs ||= wrapper.dynamic === true;
	}
	const headWord = rest[0];
	if (headWord === undefined || NOT_A_COMMAND.has(basename(headWord))) return null;
	return { head: basename(headWord), headWord, args: rest.slice(1), prefixes, viaXargs };
}

/** The word after the first flag that matches `flag`; null at the first positional. */
function flagProgram(args: readonly string[], flag: RegExp): string | null {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (!arg.startsWith("-")) return null;
		if (flag.test(arg)) return args[i + 1] ?? null;
	}
	return null;
}

function heredocBodyOf(segment: string, docs: readonly Heredoc[]): string | null {
	const m = HEREDOC_MARK_RE.exec(segment);
	return m ? (docs[Number(m[1])]?.body ?? null) : null;
}

/** Shell text that a segment runs as more shell: `bash -c`, `eval`, `bash <<EOF`. */
function nestedShellProgram(head: Head, segment: string, docs: readonly Heredoc[]): string | null {
	if (head.head === "eval") return head.args.join(" ");
	if (!SHELLS.has(head.head)) return null;
	return flagProgram(head.args, SHELL_PROGRAM_FLAG) ?? heredocBodyOf(segment, docs);
}

/** The interpreter's network segment, or whether its code was readable:
 *  `readable` = an inline program (or module list) was scanned and calls no
 *  network API; `opaque` = it runs a script file or module the scan cannot see. */
function interpreterSegment(interpreter: string, head: Head, segment: string, docs: readonly Heredoc[]): NetworkSegment | "readable" | "opaque" {
	const parsed = parseInterpreterArgs(interpreter, head.args);
	const heredoc = heredocBodyOf(segment, docs);
	const program = parsed.program ?? heredoc;
	const found = scanModulesForNetwork(interpreter, parsed) ?? (program === null ? null : scanProgramForNetwork(interpreter, program));
	if (found !== null) {
		return {
			text: segment.trim(), head: head.head, via: "interpreter-api", kind: "fetch",
			outbound: !found.loopbackOnly, hosts: found.hosts, hostsUnknown: found.hostsUnknown,
		};
	}
	const stdinProgram = heredoc !== null && parsed.run === null && (parsed.script === null || parsed.script === "-");
	return parsed.program !== null || stdinProgram ? "readable" : "opaque";
}

/** Egress legs: a segment whose code is not readable, handed a public (or
 *  templated) URL, is recorded as opaque (review 3b item 1). The host must be
 *  provably public here: a single-label `http://x` in a probe string names no
 *  reachable peer (corpus c698b9a9, `npx tsx -e '… "curl http://x" …'`). */
function noteOpaque(acc: Collected, head: Head, segment: string): void {
	const { hosts, unknown } = hostsInText(segment);
	const external = hosts.filter((h) => classifyHost(h) === "public");
	if (external.length === 0 && !unknown) return;
	acc.opaque.push({ text: segment.trim(), head: head.head, hosts: external, hostsUnknown: unknown });
}

function resolveSegment(segment: string, docs: readonly Heredoc[], depth: number, acc: Collected): void {
	const head = normalizeHead(shellSplit(segment));
	if (head === null) return;
	const nested = nestedShellProgram(head, segment, docs);
	if (nested !== null) return collectInto(nested, depth + 1, acc);
	const interpreter = interpreterName(head.headWord);
	if (interpreter) {
		const result = interpreterSegment(interpreter, head, segment, docs);
		if (typeof result !== "string") acc.segments.push(result);
		else if (result === "opaque") noteOpaque(acc, head, segment);
		return;
	}
	const verb = classifyVerb({ head: head.head, args: head.args, text: segment, prefixes: head.prefixes, viaXargs: head.viaXargs });
	if (verb) acc.segments.push({ text: segment.trim(), head: head.head, via: "verb", ...verb });
	else if (!LOCAL_TOOLS.has(head.head)) noteOpaque(acc, head, segment);
}

/** The command with each heredoc body removed and its operator replaced by a
 *  numbered mark, so the body never parses as commands. */
function maskHeredocs(command: string, docs: readonly Heredoc[]): string {
	let out = "";
	let cursor = 0;
	docs.forEach((doc, i) => {
		out += command.slice(cursor, doc.opIndex) + HEREDOC_MARK + String(i);
		out += command.slice(doc.opIndex + doc.operator.length, doc.bodyStart);
		cursor = doc.bodyEnd;
	});
	return out + command.slice(cursor);
}

interface LineScan {
	lines: string[];
	cur: string;
	inSingle: boolean;
	inDouble: boolean;
}

/** Flip quote state for `c`; true when `c` was a quote character. */
function toggleQuote(scan: LineScan, c: string): boolean {
	if (c === "'" && !scan.inDouble) {
		scan.inSingle = !scan.inSingle;
		return true;
	}
	if (c === '"' && !scan.inSingle) {
		scan.inDouble = !scan.inDouble;
		return true;
	}
	return false;
}

/** An unquoted newline ends a line; an unquoted `#` at a word start skips to the
 *  end of the line. Returns the index of the last character used, or null when
 *  `c` is ordinary text. */
function scanUnquoted(scan: LineScan, text: string, i: number, c: string): number | null {
	if (c === "\n") {
		scan.lines.push(scan.cur);
		scan.cur = "";
		return i;
	}
	if (c !== "#" || !COMMENT_START_RE.test(scan.cur)) return null;
	const eol = text.indexOf("\n", i);
	return eol === -1 ? text.length : eol - 1;
}

/** Consume `text[i]` into the scan; returns the index of the last character used. */
function scanChar(scan: LineScan, text: string, i: number): number {
	const c = text[i] ?? "";
	if (c === "\\" && !scan.inSingle) {
		if (text[i + 1] !== "\n") scan.cur += c + (text[i + 1] ?? "");
		return i + 1;
	}
	if (!toggleQuote(scan, c) && !scan.inSingle && !scan.inDouble) {
		const end = scanUnquoted(scan, text, i, c);
		if (end !== null) return end;
	}
	scan.cur += c;
	return i;
}

/** Quote-aware logical lines: unquoted newlines end a line, `\`-newline joins
 *  two, and an unquoted `#` at a word start comments out the rest of the line. */
function logicalLines(text: string): string[] {
	const scan: LineScan = { lines: [], cur: "", inSingle: false, inDouble: false };
	for (let i = 0; i < text.length; i++) i = scanChar(scan, text, i);
	scan.lines.push(scan.cur);
	return scan.lines.filter((line) => line.trim() !== "");
}

/** Collect every command substitution in `text`. Single-quoted text is literal, and so is any backslash-escaped
 *  character: `\$(` and `` \` `` print literally, while `\\$(` is an escaped backslash before a LIVE `$(` — the
 *  pairwise left-to-right mask keeps that distinction (review 2026-10-06). */
function collectSubstitutions(text: string, depth: number, acc: Collected): void {
	// Length-preserving masks LOCATE the live substitutions; each body is then read from the ORIGINAL text,
	// so `$(\curl …)` is analyzed as `\curl …`, not as masked filler (review 2026-10-06).
	const live = text.replace(/'[^']*'/g, (quoted) => `'${"_".repeat(quoted.length - 2)}'`).replace(/\\[\s\S]/g, "__");
	for (const m of live.matchAll(SUBSTITUTION_RE)) {
		const body = m[1] ?? m[2] ?? "";
		const opener = m[1] !== undefined ? 2 : 1; // `$(` / `<(` / `>(` or a backtick
		const start = (m.index ?? 0) + opener;
		collectInto(text.slice(start, start + body.length), depth + 1, acc);
	}
}

function collectInto(command: string, depth: number, acc: Collected): void {
	if (depth > MAX_DEPTH || command.trim() === "") return;
	const docs = findHeredocs(command);
	// An unquoted heredoc delimiter still expands `$(…)` in its body.
	for (const doc of docs) if (!/['"]/.test(doc.operator)) collectSubstitutions(doc.body, depth, acc);
	for (const line of logicalLines(maskHeredocs(command, docs))) {
		collectSubstitutions(line, depth, acc);
		for (const segment of splitSegments(line)) resolveSegment(segment, docs, depth, acc);
	}
}

/** Classify a Bash command's network intent. Pure; never throws on odd input. */
export function classifyNetworkIntent(command: string): NetworkIntent {
	const acc: Collected = { segments: [], opaque: [] };
	collectInto(command, 0, acc);
	const outbound = acc.segments.filter((s) => s.outbound);
	return {
		network: outbound.length > 0,
		via: outbound[0]?.via ?? "none",
		segments: acc.segments,
		hosts: [...new Set(outbound.flatMap((s) => s.hosts))],
		opaque: acc.opaque,
	};
}

/** Leg 3 / lockdown: an outbound segment reaches a public host or one it
 *  cannot name, or a program whose code is unreadable is handed a public URL. */
export function isExternalNetworkIntent(intent: NetworkIntent): boolean {
	return intent.opaque.length > 0 || intent.segments.some((s) => s.outbound && (s.hostsUnknown || s.hosts.some(isPublicHost)));
}

/** Leg 2 source: an outbound FETCH from a literal public host (content the agent will read). */
export function fetchesPublicContent(intent: NetworkIntent): boolean {
	return intent.segments.some((s) => s.outbound && s.kind === "fetch" && s.hosts.some(isPublicHost));
}
