// ===========================================
// Literal-context classifier for Bash guard rules
// ===========================================
// A destructive-command rule regex sees the whole command line, so it also
// fires when the destructive text is only DATA: the argument of
// `interlinked harness test "…"`, a string inside a `node -e` regex
// self-test, a `grep` pattern, or `printf '…' | base64`. Two raters judged
// 18–25 of 50 sampled guard blocks to be exactly that shape
// (scratch/2026-10-08-decisions-orthogonal/e16-adjudication/).
//
// `literalContextRegions` returns the byte ranges of a command that are
// provably data, in one of four syntactic contexts:
//   (a) an argument of `interlinked harness test` (incl. a `for` loop list
//       whose variable is consumed only by `harness test` / echo / printf);
//   (b) a string literal or comment inside an inline interpreter program
//       (`node -e`, `python3 -c`, `python3 - <<'PY'`, `perl -e`, `ruby -e`)
//       whose program text has no execution token;
//   (c) the PATTERN argument of grep/rg/ugrep/ag, a `sed -n '/re/p'`
//       script, or an awk program with no system/pipe/getline;
//   (d) an echo/printf argument whose output goes nowhere that executes.
// In every context the segment's pipeline must end only in plain data
// sinks (never sh/bash/eval/xargs). echo/printf output may land in a file
// under scratch/ or /tmp only when EVERY segment of the command is an
// allowlisted inert command (a denylist of executors — sudo bash, make,
// php, find -exec — can never be complete). A string literal that is the
// argument of a file-access call (`open('.env')`, `readFileSync(p)`) is an
// operand, not data. Anything the parser does not model yields no region,
// so the block stands: this module may only remove a block when it fully
// understands the command.

import { nonNull } from "../../lib/non-null.js";
import { type ProgramLang, type ProgramRange, programCanExecute, programLiteralRanges } from "./literal-context-program.js";
import { type ShellSegment, type ShellWord, parseShellSegments } from "./literal-context-shell.js";

export interface LiteralRegion {
	start: number;
	end: number;
	/** Human-readable context, e.g. "grep pattern". */
	context: string;
}

interface Simple {
	name: string;
	args: ShellWord[];
	redirects: { op: string; target: string }[];
}

interface Ctx {
	segments: ShellSegment[];
	/** Every segment is an inert command, so a data file stays data. */
	fileWritesAreData: boolean;
}

const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{", "}", "time", "command", "nohup", "builtin"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DATA_SINKS = new Set(["head", "tail", "wc", "base64", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "cat", "grep", "rg", "jq", "sort", "uniq", "cut", "tr", "column", "less", "od", "xxd", "hexdump", "true"]);
/** Commands that can neither run a file nor make one runnable. A file written
 *  under scratch/ or /tmp stays data only when every segment is one of these
 *  (or an inert interpreter program / `harness test`); `sudo bash`, `make`,
 *  `php`, `find -exec` and `ssh` are all simply absent. */
const INERT_COMMANDS = new Set([...DATA_SINKS, "echo", "printf", "mkdir", "ls", "pwd", "date", "test", "[", "[[", "false", ":", "cd", "touch", "stat", "diff", "cmp", "sleep", "for", "done", "fi", "esac"]);
const INTERPRETERS: Record<string, ProgramLang> = { node: "js", python: "python", python3: "python", perl: "perl", ruby: "ruby" };
/** Callees whose string argument names a file (or a module the program loads):
 *  the literal is an operand the program acts on, not data it holds. */
const FILE_OPERAND_CALLEES = new Set([
	"open", "Path", "PurePath", "PosixPath", "Pathname", "new",
	"readFile", "readFileSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync", "createReadStream", "createWriteStream",
	"readdir", "readdirSync", "opendir", "opendirSync", "stat", "statSync", "lstat", "lstatSync", "access", "accessSync", "exists", "existsSync",
	"unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync", "rename", "renameSync", "copyFile", "copyFileSync", "cp", "cpSync",
	"mkdir", "mkdirSync", "readlink", "readlinkSync", "realpath", "realpathSync", "symlink", "symlinkSync", "chmod", "chmodSync", "chown", "chownSync",
	"read", "write", "binread", "binwrite", "readlines", "foreach", "read_text", "read_bytes", "write_text", "write_bytes",
	"listdir", "scandir", "walk", "remove", "rmtree", "copy", "copyfile", "copy2", "move", "chdir", "getsize", "isfile", "isdir", "glob", "iglob",
	"require", "import",
]);
const FILE_OPERAND_MODULES = new Set(["fs", "fsPromises", "promises", "os", "shutil", "io", "codecs", "pathlib", "File", "IO", "Dir"]);
/** Characters walked back from a literal to its enclosing call before giving up. */
const OPERAND_WALK_LIMIT = 400;
const GREP_SHORT_WITH_ARG: Record<string, Set<string>> = {
	grep: new Set(["-e", "-f", "-A", "-B", "-C", "-m", "-d", "-D"]),
	rg: new Set(["-e", "-f", "-A", "-B", "-C", "-m", "-g", "-t", "-T", "-j", "-M", "-r", "-E"]),
	ag: new Set(["-G", "-A", "-B", "-C", "-m"]),
};
const GREP_ALIASES: Record<string, string> = { grep: "grep", egrep: "grep", fgrep: "grep", ugrep: "grep", rg: "rg", ag: "ag" };
const GREP_LONG_WITH_ARG = new Set(["--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--max-count", "--context", "--after-context", "--before-context", "--include", "--exclude", "--exclude-dir", "--replace", "--max-depth", "--threads", "--encoding", "--sort", "--sortr", "--color", "--colors", "--ignore-file", "--type-add", "--max-columns", "--max-filesize"]);
const SCRATCH_FILE = /^(?:\/tmp\/|\/private\/tmp\/|scratch\/|\.\/scratch\/)/;
const SED_PRINT_SCRIPT = /^\/(?:[^/\\]|\\.)*\/(?:,\/(?:[^/\\]|\\.)*\/)?p$/;

function basename(word: string): string {
	return word.slice(word.lastIndexOf("/") + 1);
}

/** Skip `timeout [-s SIG|-k N] DURATION` / `nice -n N` / `env VAR=…` wrappers. */
function skipWrapper(words: ShellWord[], i: number): number {
	const name = nonNull(words[i]).text;
	if (name !== "timeout" && name !== "nice" && name !== "env") return i;
	let k = i + 1;
	while (k < words.length) {
		const t = nonNull(words[k]).text;
		if (t === "-s" || t === "-k" || t === "-n") k += 2;
		else if (t.startsWith("-") || ASSIGNMENT.test(t)) k++;
		else break;
	}
	return name === "timeout" ? k + 1 : k;
}

/** Resolve a segment to its command name, arguments and redirections. */
function simpleCommand(seg: ShellSegment): Simple | null {
	const words: ShellWord[] = [];
	const redirects: Simple["redirects"] = [];
	for (let k = 0; k < seg.words.length; k++) {
		const w = nonNull(seg.words[k]);
		if (w.op === undefined) words.push(w);
		else if (!/<<-?$/.test(w.op)) redirects.push({ op: w.op, target: seg.words[++k]?.text ?? "" });
	}
	let i = 0;
	while (i < words.length) {
		const wrapped = skipWrapper(words, i);
		if (wrapped !== i) i = wrapped;
		else if (KEYWORDS.has(nonNull(words[i]).text) || ASSIGNMENT.test(nonNull(words[i]).text)) i++;
		else break;
	}
	const head = words[i];
	return head ? { name: basename(head.text), args: words.slice(i + 1), redirects } : null;
}

function regionsOf(words: ShellWord[], context: string): LiteralRegion[] {
	return words
		.filter((w) => w.offsets.length > 0)
		.map((w) => ({ start: nonNull(w.offsets[0]), end: nonNull(w.offsets[w.offsets.length - 1]) + 1, context }));
}

/** (a) `interlinked harness test …` and its dev-mode spellings. */
function harnessTestArgs(cmd: Simple): ShellWord[] | null {
	const texts = cmd.args.map((w) => w.text);
	const h = texts.indexOf("harness");
	if (h < 0 || (texts[h + 1] !== "test" && texts[h + 1] !== "test-command")) return null;
	const launcher = texts.slice(0, h).join(" ");
	const ok =
		(cmd.name === "interlinked" && launcher === "") ||
		(cmd.name === "npx" && (launcher === "interlinked" || /^tsx \S*index\.ts$/.test(launcher))) ||
		(cmd.name === "node" && /^\S*index\.js$/.test(launcher)) ||
		(cmd.name === "tsx" && /^\S*index\.ts$/.test(launcher));
	return ok ? cmd.args.slice(h + 2) : null;
}

/** (b) Program text and its raw-offset map for an inline interpreter. */
function interpreterProgram(seg: ShellSegment, cmd: Simple, lang: ProgramLang): { text: string; offsets: number[] } | null {
	const flag = lang === "js" ? /^(?:-e|--eval|-p|--print)$/ : lang === "python" ? /^-c$/ : /^-[a-zA-Z]*e$/i;
	const at = cmd.args.findIndex((w) => flag.test(w.text));
	const program = at >= 0 ? cmd.args[at + 1] : undefined;
	if (program) return { text: program.text, offsets: program.offsets };
	const doc = seg.heredoc;
	if (at >= 0 || !doc || cmd.args.some((w) => w.text !== "-")) return null;
	if (!doc.quoted && /[$`\\]/.test(doc.body)) return null;
	return { text: doc.body, offsets: Array.from({ length: doc.body.length }, (_c, k) => doc.bodyStart + k) };
}

/** The dotted callee whose argument list opens at `parenAt`, split into its
 *  parts; empty when no identifier precedes the parenthesis. */
function calleeBefore(text: string, parenAt: number): string[] {
	const head = text.slice(Math.max(0, parenAt - 120), parenAt).trimEnd();
	return (/[\w$.]+$/.exec(head)?.[0] ?? "").split(".").filter((part) => part !== "");
}

function isFileAccessCall(text: string, parenAt: number): boolean {
	const parts = calleeBefore(text, parenAt);
	return parts.length > 0 && (FILE_OPERAND_CALLEES.has(nonNull(parts[parts.length - 1])) || FILE_OPERAND_MODULES.has(nonNull(parts[0])));
}

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

/** True when the literal at `range` is a direct argument of a file-access
 *  call. Walks back over earlier arguments (other literals skipped by range)
 *  to the call's opening parenthesis. A walk that runs out inside a call is
 *  an operand, never data; reaching the start of the program is data. */
function isFileOperand(text: string, ranges: ProgramRange[], range: ProgramRange): boolean {
	const literalAt = new Uint8Array(text.length);
	for (const r of ranges) literalAt.fill(1, r.start, r.end);
	let i = range.start - 1;
	while (i >= 0 && /['"`]/.test(nonNull(text[i]))) i--;
	let depth = 0;
	for (let steps = 0; i >= 0; i--, steps++) {
		if (steps >= OPERAND_WALK_LIMIT) return true;
		const c = nonNull(text[i]);
		if (literalAt[i]) continue;
		if (CLOSERS.has(c)) depth++;
		else if (OPENERS.has(c)) {
			if (depth === 0) return c === "(" && isFileAccessCall(text, i);
			depth--;
		}
	}
	return false;
}

/** Literal regions of an interpreter program, or null when it is not exempt. */
function interpreterRegions(seg: ShellSegment, cmd: Simple): LiteralRegion[] | null {
	const lang = INTERPRETERS[cmd.name];
	const program = lang ? interpreterProgram(seg, cmd, lang) : null;
	if (!lang || !program || programCanExecute(program.text, lang)) return null;
	const ranges = programLiteralRanges(program.text, lang);
	if (!ranges) return null;
	const context = `${cmd.name} program string literal`;
	return ranges
		.filter((r) => !isFileOperand(program.text, ranges, r))
		.map((r) => ({ start: nonNull(program.offsets[r.start]), end: nonNull(program.offsets[r.end - 1]) + 1, context }));
}

/** The pipeline that continues after `segments[idx]` ends only in data sinks. */
function downstreamIsData(ctx: Ctx, idx: number): boolean {
	let k = idx;
	while (nonNull(ctx.segments[k]).sepAfter === "|" || nonNull(ctx.segments[k]).sepAfter === "|&") {
		k++;
		const seg = ctx.segments[k];
		const next = seg ? simpleCommand(seg) : null;
		if (!seg || !next || !redirectsAreData(ctx, next)) return false;
		if (!DATA_SINKS.has(next.name) && interpreterRegions(seg, next) === null) return false;
	}
	return true;
}

type OptionArg = { kind: "attached"; flag: string; from: number } | { kind: "next"; flag: string } | null;

/** How a grep option word binds its argument: attached to the same word
 *  (`--regexp=X`, `-eX`, `-ieX`, `-A3`), the next word (`-e X`, `-ie X`), or
 *  none. Short clusters follow getopt: the first arg-taking letter owns the rest. */
function optionArg(t: string, shortWithArg: Set<string>): OptionArg {
	if (t.startsWith("--")) {
		const eq = t.indexOf("=");
		if (eq > 0) return { kind: "attached", flag: t.slice(0, eq), from: eq + 1 };
		return GREP_LONG_WITH_ARG.has(t) ? { kind: "next", flag: t } : null;
	}
	if (!t.startsWith("-")) return null;
	for (let k = 1; k < t.length; k++) {
		const flag = `-${t[k]}`;
		if (!shortWithArg.has(flag)) continue;
		return k + 1 < t.length ? { kind: "attached", flag, from: k + 1 } : { kind: "next", flag };
	}
	return null;
}

function subWord(w: ShellWord, from: number): ShellWord {
	return { ...w, text: w.text.slice(from), offsets: w.offsets.slice(from) };
}

interface GrepScan {
	explicit: ShellWord[];
	fromFile: boolean;
}

/** Record one option's pattern / pattern-file contribution; true when the
 *  option consumed the following word. */
function noteGrepOption(opt: NonNullable<OptionArg>, w: ShellWord, next: ShellWord | undefined, scan: GrepScan): boolean {
	const isPattern = opt.flag === "-e" || opt.flag === "--regexp";
	if (opt.flag === "-f" || opt.flag === "--file") scan.fromFile = true;
	if (opt.kind === "attached") {
		if (isPattern) scan.explicit.push(subWord(w, opt.from));
		return false;
	}
	if (isPattern && next) scan.explicit.push(next);
	return true;
}

/** (c) The pattern word(s) of a grep-like command. */
function grepPatternWords(cmd: Simple, shortWithArg: Set<string>): ShellWord[] {
	if (cmd.args.some((w) => /^--(?:pre|filter|exec)/.test(w.text))) return [];
	const scan: GrepScan = { explicit: [], fromFile: false };
	let positional: ShellWord | null = null;
	for (let k = 0; k < cmd.args.length; k++) {
		const w = nonNull(cmd.args[k]);
		if (w.text === "--") {
			positional = positional ?? cmd.args[k + 1] ?? null;
			break;
		}
		const opt = optionArg(w.text, shortWithArg);
		if (opt === null) {
			if (!w.text.startsWith("-") && positional === null) positional = w;
		} else if (noteGrepOption(opt, w, cmd.args[k + 1], scan)) k++;
	}
	if (scan.explicit.length > 0) return scan.explicit;
	return positional && !scan.fromFile ? [positional] : [];
}

function patternRegions(cmd: Simple): LiteralRegion[] {
	const grepFamily = GREP_ALIASES[cmd.name];
	if (grepFamily) return regionsOf(grepPatternWords(cmd, nonNull(GREP_SHORT_WITH_ARG[grepFamily])), `${cmd.name} pattern`);
	if (cmd.name === "sed" && cmd.args.some((w) => w.text === "-n")) {
		return regionsOf(cmd.args.filter((w) => SED_PRINT_SCRIPT.test(w.text)), "sed -n /pattern/p script");
	}
	if (cmd.name !== "awk" && cmd.name !== "gawk") return [];
	if (cmd.args.some((w) => w.text === "-f")) return [];
	const program = cmd.args.find((w, k) => !w.text.startsWith("-") && !/^-[Fv]$/.test(cmd.args[k - 1]?.text ?? ""));
	if (!program || /system|\||getline/.test(program.text)) return [];
	return regionsOf([program], "awk program");
}

/** A redirection that cannot turn its data into code. An fd duplication is
 *  data only onto stdout/stderr: `>&p` feeds a zsh coprocess (`coproc sh`). */
function redirectIsData(ctx: Ctx, r: Simple["redirects"][number]): boolean {
	if (/^\d*<(?!&)/.test(r.op) || r.target === "/dev/null") return true;
	if (r.op.endsWith("&")) return /^[12-]$/.test(r.target);
	return ctx.fileWritesAreData && SCRATCH_FILE.test(r.target);
}

function redirectsAreData(ctx: Ctx, cmd: Simple): boolean {
	return cmd.redirects.every((r) => redirectIsData(ctx, r));
}

/** (d) echo/printf arguments (the caller has already vetted redirections). */
function echoRegions(cmd: Simple): LiteralRegion[] {
	if (cmd.name !== "echo" && cmd.name !== "printf") return [];
	return regionsOf(cmd.args, `${cmd.name} argument`);
}

function segmentRegions(ctx: Ctx, idx: number): LiteralRegion[] {
	const seg = nonNull(ctx.segments[idx]);
	const cmd = simpleCommand(seg);
	if (!cmd || !redirectsAreData(ctx, cmd) || !downstreamIsData(ctx, idx)) return [];
	const harness = harnessTestArgs(cmd);
	if (harness) return regionsOf(harness, "interlinked harness test argument");
	return [...(interpreterRegions(seg, cmd) ?? []), ...patternRegions(cmd), ...echoRegions(cmd)];
}

/** A body segment that mentions the loop variable is a pure data consumer. */
function consumesAsData(ctx: Ctx, idx: number, varRef: RegExp): boolean {
	const seg = nonNull(ctx.segments[idx]);
	if (!seg.words.some((w) => varRef.test(w.text)) && !varRef.test(seg.heredoc?.body ?? "")) return true;
	const cmd = simpleCommand(seg);
	if (!cmd || !redirectsAreData(ctx, cmd) || !downstreamIsData(ctx, idx)) return false;
	const asHarnessArg = harnessTestArgs(cmd)?.some((w) => varRef.test(w.text)) ?? false;
	return asHarnessArg || echoRegions(cmd).length > 0;
}

/** (a) `for v in 'x' 'y'; do … "$v" …; done` where `$v` only feeds data consumers. */
function forLoopRegions(ctx: Ctx, idx: number): LiteralRegion[] | null {
	const words = nonNull(ctx.segments[idx]).words;
	const name = words[1]?.text ?? "";
	if (words[0]?.text !== "for" || words[2]?.text !== "in" || !/^[A-Za-z_]\w*$/.test(name)) return null;
	const varRef = new RegExp(`\\$(?:\\{${name}\\}|${name}\\b)`);
	for (let k = idx + 1; k < ctx.segments.length; k++) {
		const done = simpleCommand(nonNull(ctx.segments[k]));
		const first = nonNull(ctx.segments[k]).words[0]?.text;
		if (first === "for" || first === "while" || first === "until") return null;
		if (first === "done") {
			const dataOut = done !== null && redirectsAreData(ctx, done) && downstreamIsData(ctx, k);
			return dataOut ? regionsOf(words.slice(3), "for-loop list fed to interlinked harness test / echo") : null;
		}
		if (!consumesAsData(ctx, k, varRef)) return null;
	}
	return null;
}

/** A segment that provably cannot run a file or make one runnable: an
 *  allowlisted command, a `harness test` call, an inert interpreter program,
 *  or bare assignments/keywords (substitutions already failed the parse). */
function isInertSegment(seg: ShellSegment): boolean {
	const cmd = simpleCommand(seg);
	if (!cmd) return true;
	if (INERT_COMMANDS.has(cmd.name) || harnessTestArgs(cmd) !== null) return true;
	return cmd.name in INTERPRETERS && interpreterRegions(seg, cmd) !== null;
}

/** Public API — the data-only regions of `cmd`; empty when unsure. */
export function literalContextRegions(cmd: string): LiteralRegion[] {
	const segments = parseShellSegments(cmd);
	if (!segments) return [];
	const ctx: Ctx = { segments, fileWritesAreData: segments.every(isInertSegment) };
	const regions: LiteralRegion[] = [];
	for (let idx = 0; idx < segments.length; idx++) {
		regions.push(...(forLoopRegions(ctx, idx) ?? segmentRegions(ctx, idx)));
	}
	return regions;
}

/** Public API — true when [start, end) lies entirely inside one data-only region. */
export function isLiteralContext(cmd: string, start: number, end: number): boolean {
	if (end <= start) return false;
	return literalContextRegions(cmd).some((r) => r.start <= start && end <= r.end);
}

/** Public API — `cmd` with every data-only region blanked (newlines kept), so a
 *  rule re-run on the result matches only executed text. */
export function maskLiteralContext(cmd: string, regions: LiteralRegion[] = literalContextRegions(cmd)): string {
	const chars = cmd.split("");
	for (const r of regions) {
		for (let k = r.start; k < r.end; k++) if (chars[k] !== "\n") chars[k] = " ";
	}
	return chars.join("");
}
