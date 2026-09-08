// Single source of truth for the cold-fallback FILE-DUMP gate.
//
// Refuses a `tail`/`head`/`cat` invocation that would dump a large or
// unfiltered payload into the tool result — the cold-path mirror of the
// daemon's richer `src/harness/evaluator/file-dump-guard.ts`. Three block
// conditions:
//   1. `tail -f` / `-F` in the foreground (no trailing `&`, no nohup) — hangs.
//   2. No filter, no redirect, file over 100KB — refused unless an ordinary
//      head/tail window is measured within the byte budget.
//   3. No filter, no redirect, more than 200 lines requested.
// Redirects bypass the size checks; `-c` on tail/head counts as a filter.
//
// The generated `.interlinked/hooks/interlinked-activity.mjs` cannot `import`
// anything, so `guards-inline.ts` embeds `FILE_DUMP_COLD_GUARD_SOURCE` — the
// joined `Function.toString()` of every function below — verbatim into its
// template string. Before this module existed the same logic lived ONLY inside
// that template string, with five helpers nested inside one long function, so
// it could not be unit-tested or reused at all.
//
// IMPORTANT: every function below MUST stay a free-standing, self-contained
// `function` declaration — no module-scope constants, no imports referenced
// from inside a body, and no backtick or dollar-brace anywhere in the source
// (it is spliced into a template literal). Filesystem access arrives as an
// injected `ColdDumpDeps` argument. The `new Function` round-trip test in
// `__tests__/file-dump-cold-guard.test.ts` pins all of that.

import type { ColdWriteVerdict } from "./cold-write-guards.js";

export interface FileDumpWindowDeps {
    openSync?: ((path: string, flags: string) => number) | null;
    readSync?: ((fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => number) | null;
    closeSync?: ((fd: number) => void) | null;
}

interface FileDumpWindow {
    path: string;
    size: number;
    verb: string;
    lines: number | null;
    maxBytes: number;
}

/** Only ordinary, single-file count forms establish a small line window.
 * Signed counts, multiple options, and unfamiliar forms retain the size gate. */
export function fileDumpWindowLines(tokens: string[]): number | null {
    if (tokens[0] !== "head" && tokens[0] !== "tail") return null;
    let count: string | undefined;
    if (tokens.length === 2) count = "10";
    if (tokens.length === 3) count = tokens[1]?.match(/^(?:-n?|-n=|--lines=)(\d+)$/)?.[1];
    if (tokens.length === 4 && (tokens[1] === "-n" || tokens[1] === "--lines")) count = tokens[2];
    if (count === undefined || !/^\d+$/.test(count)) return null;
    const lines = Number(count);
    return Number.isSafeInteger(lines) && lines <= 200 ? lines : null;
}

function fileDumpHeadBytes(bytes: Uint8Array, lines: number, complete: boolean): number | null {
    let at = -1;
    for (let line = 0; line < lines; line++) {
        at = bytes.indexOf(10, at + 1);
        if (at < 0) return complete ? bytes.length : null;
    }
    return at + 1;
}

function fileDumpTailBytes(bytes: Uint8Array, lines: number, complete: boolean): number | null {
    let at = bytes.length;
    if (bytes[at - 1] === 10) at--;
    for (let line = 0; line < lines; line++) {
        if (at === 0) return complete ? bytes.length : null;
        at = bytes.lastIndexOf(10, at - 1);
        if (at < 0) return complete ? bytes.length : null;
    }
    return bytes.length - at - 1;
}

function readFileDumpWindow(input: FileDumpWindow, deps: FileDumpWindowDeps): number | null {
    const { openSync, readSync, closeSync } = deps;
    if (!openSync || !readSync || !closeSync || input.lines === null) return null;
    if (input.lines === 0) return 0;
    const length = Math.min(input.size, input.maxBytes + 1);
    const position = input.verb === "tail" ? input.size - length : 0;
    const fd = openSync(input.path, "r");
    try {
        const bytes = new Uint8Array(length);
        if (readSync(fd, bytes, 0, length, position) !== length) return null;
        const complete = length === input.size;
        return input.verb === "head" ? fileDumpHeadBytes(bytes, input.lines, complete) : fileDumpTailBytes(bytes, input.lines, complete);
    } finally { closeSync(fd); }
}

/** Read at most the byte budget plus one, even for a multi-gigabyte log.
 * Missing readers, short reads, and oversized lines retain the original size. */
export function measureFileDumpWindow(input: FileDumpWindow, deps: FileDumpWindowDeps): number {
    if (input.lines === null || input.size <= input.maxBytes) return input.size;
    try { return readFileDumpWindow(input, deps) ?? input.size; }
    catch { return input.size; }
}

/** Filesystem/path functions injected by the caller — the .mjs passes its own
 *  top-level imports. Any member may be null; the guard then declines to
 *  evaluate rather than throwing. */
export interface ColdDumpDeps extends FileDumpWindowDeps {
	existsSync: ((p: string) => boolean) | null;
	statSync: ((p: string) => { size: number; isFile: () => boolean }) | null;
	readFileSync: ((p: string, enc: "utf8") => string) | null;
	join: ((...parts: string[]) => string) | null;
}

/** Stat summary over a dump command's file arguments. */
interface ColdDumpStats {
	largestBytes: number;
	largestPath: string;
	newlines: number;
	catLineCountKnown: boolean;
}

/** Parsed shape of a dump command: its pipeline segments, the first segment's
 *  tokens with wrappers stripped, and the dump verb. */
interface ColdDumpShape {
	segments: string[];
	tokens: string[];
	verb: string;
}

/** Split a command on unquoted pipes, keeping `||` intact. */
function fdcSplitPipeline(s: string): string[] {
	const out: string[] = [];
	let buf = "";
	let q: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (q) {
			buf += ch;
			if (ch === q) q = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			q = ch;
			buf += ch;
			continue;
		}
		if (ch === "|") {
			if (s[i + 1] === "|") {
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
	if (buf.length) out.push(buf);
	return out;
}

/** Advance past one quoted char: closes the quote on a match, else appends it. */
function fdcAdvanceQuoted(ch: string | undefined, q: string, buf: string): { q: string | null; buf: string } {
	if (ch === q) return { q: null, buf };
	return { q, buf: buf + ch };
}
/** Push `buf` onto `out` as a completed token when non-empty; returns "". */
function fdcPushIfNonEmpty(out: string[], buf: string): string {
	if (buf) out.push(buf);
	return "";
}
/** Split one pipeline segment into whitespace-separated tokens, dropping the
 *  quote characters themselves. */
function fdcTokenize(seg: string): string[] {
	const out: string[] = [];
	let buf = "";
	let q: string | null = null;
	for (let i = 0; i < seg.length; i++) {
		const ch = seg[i];
		if (q) {
			const r = fdcAdvanceQuoted(ch, q, buf);
			q = r.q;
			buf = r.buf;
			continue;
		}
		if (ch === '"' || ch === "'") {
			q = ch;
			continue;
		}
		if (/\s/.test(ch || "")) {
			buf = fdcPushIfNonEmpty(out, buf);
			continue;
		}
		buf += ch;
	}
	if (buf) out.push(buf);
	return out;
}

/** Drop leading `sudo` / `exec` / `nohup` / `command` / `env VAR=v` wrappers so
 *  the verb ends up at index 0. Mutates `tokens` in place. */
function fdcStripWrappers(tokens: string[]): void {
	while (tokens.length) {
		const t = tokens[0];
		if (t === "sudo" || t === "exec" || t === "nohup" || t === "command") {
			tokens.shift();
			continue;
		}
		if (t === "env") {
			tokens.shift();
			while (tokens[0] && /^[A-Za-z_]\w*=/.test(tokens[0] || "")) tokens.shift();
			continue;
		}
		if (/^[A-Za-z_]\w*=/.test(t || "")) {
			tokens.shift();
			continue;
		}
		break;
	}
}

/** Leading integer of a count argument, or null when it is not numeric. */
function fdcCountOf(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const m = raw.match(/^\+?(\d+)\b/);
	return m ? parseInt(m[1] || "", 10) : null;
}

/** Value of a count flag across every spelling: `-n 5`, `-n=5`, `-n5`,
 *  `--lines=5`, `--lines 5`. Returns null when the flag is absent. */
function fdcParseCount(tokens: string[], shortFlag: string): number | null {
	const longFlag = shortFlag === "-n" ? "--lines" : "--bytes";
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i] || "";
		if (t === shortFlag) return fdcCountOf(tokens[i + 1]);
		if (t.indexOf(shortFlag + "=") === 0) return fdcCountOf(t.slice(shortFlag.length + 1));
		if (
			t.indexOf(shortFlag) === 0 &&
			t.length > shortFlag.length &&
			/^\+?\d/.test(t.charAt(shortFlag.length))
		) {
			return fdcCountOf(t.slice(shortFlag.length));
		}
		if (t.indexOf(longFlag + "=") === 0) return fdcCountOf(t.slice(longFlag.length + 1));
		if (t === longFlag) return fdcCountOf(tokens[i + 1]);
	}
	return null;
}

/** Human-readable byte size for the block message. */
function fdcFmtBytes(b: number): string {
	if (b < 1024) return b + "B";
	if (b < 1024 * 1024) return Math.round(b / 1024) + "KB";
	return (b / (1024 * 1024)).toFixed(1) + "MB";
}

/** True when the command carries an output redirect outside quotes (`>`), which
 *  sends the bytes to disk instead of the tool result. */
function fdcHasRedirect(cmd: string): boolean {
	let q: string | null = null;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (q) {
			if (ch === q) q = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			q = ch;
			continue;
		}
		if (ch === ">") {
			if (cmd[i + 1] === "=" || cmd[i - 1] === "=") continue;
			return true;
		}
	}
	return false;
}

/** True when a downstream pipeline segment starts with an output-reducing
 *  filter command. */
function fdcHasDownstreamFilter(segments: string[]): boolean {
	const filters = [
		"jq",
		"grep",
		"egrep",
		"fgrep",
		"rg",
		"ripgrep",
		"ag",
		"awk",
		"gawk",
		"mawk",
		"sed",
		"head",
		"tail",
		"wc",
		"cut",
		"sort",
		"uniq",
		"fzf",
		"less",
		"more",
	];
	for (let i = 1; i < segments.length; i++) {
		const m = (segments[i] || "").trim().match(/^([\w.-]+)/);
		if (!m) continue;
		const raw = m[1] || "";
		const idx = raw.lastIndexOf("/");
		const name = idx >= 0 ? raw.slice(idx + 1) : raw;
		if (filters.indexOf(name) !== -1) return true;
	}
	return false;
}

/** True when a `-f` / `-F` follow flag sits in the verb's flag run. */
function fdcHasFollowFlag(tokens: string[]): boolean {
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i] || "";
		if (t.indexOf("--") === 0) continue;
		if (t.indexOf("-") !== 0) return false;
		if (/[fF]/.test(t.slice(1))) return true;
	}
	return false;
}

/** Pushes every remaining token from `startIndex` onto `files`, skipping
 *  empty ones — the `--` separator's "rest are literal paths" rule. */
function fdcCollectRestArgs(tokens: string[], startIndex: number, files: string[]): void {
	for (let j = startIndex; j < tokens.length; j++) {
		if (tokens[j]) files.push(tokens[j] || "");
	}
}

/** File-path arguments of the dump verb. Returns null when a glob or a shell
 *  variable makes the target set unknowable — the guard then stands down
 *  rather than guessing. */
function fdcFilePaths(tokens: string[]): string[] | null {
	const files: string[] = [];
	const flagsWithValue = ["-n", "-c", "--lines", "--bytes"];
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t) continue;
		if (t === "--") {
			fdcCollectRestArgs(tokens, i + 1, files);
			break;
		}
		if (t.indexOf("-") === 0) {
			if (flagsWithValue.indexOf(t) !== -1) i++;
			continue;
		}
		if (/[*?[\]]/.test(t)) return null;
		if (t.indexOf("$") !== -1) return null;
		files.push(t);
	}
	return files;
}

/** Absolute form of a dump argument against `cwd`. */
function fdcAbsolute(fp: string, cwd: string, deps: ColdDumpDeps): string {
	if (fp.charAt(0) === "/") return fp;
	if (deps.join) return deps.join(cwd, fp);
	return cwd + "/" + fp;
}

/** Newline count of a small `cat` target, folded into `out`. No-op for other
 *  verbs, large files, an explicit `-n`, or a host with no reader. */
function fdcCountCatLines(
	abs: string,
	size: number,
	verb: string,
	requestedLines: number | null,
	deps: ColdDumpDeps,
	out: ColdDumpStats,
): void {
	if (verb !== "cat" || requestedLines !== null) return;
	if (size > 100 * 1024 || !deps.readFileSync) return;
	const content = deps.readFileSync(abs, "utf8");
	const matches = content.match(/\n/g);
	out.newlines += matches ? matches.length : 0;
	out.catLineCountKnown = true;
}

/** Stat summary over the dump verb's file arguments. `catLineCountKnown` stays
 *  false when the newline count could not be established, which the caller
 *  treats as the conservative unknown (Infinity). */
function fdcStatFiles(
	files: string[],
	cwd: string,
	verb: string,
	requestedLines: number | null,
	deps: ColdDumpDeps,
	windowLines: number | null,
): ColdDumpStats {
	const out: ColdDumpStats = {
		largestBytes: 0,
		largestPath: "",
		newlines: 0,
		catLineCountKnown: false,
	};
	const existsSyncFn = deps.existsSync;
	const statSyncFn = deps.statSync;
	if (!existsSyncFn || !statSyncFn) return out;
	for (const fp of files) {
		const abs = fdcAbsolute(fp, cwd, deps);
		try {
			if (!existsSyncFn(abs)) continue;
			const st = statSyncFn(abs);
			if (!st.isFile()) continue;
			const outputBytes = measureFileDumpWindow({ path: abs, size: st.size, verb: verb, lines: windowLines, maxBytes: 100 * 1024 }, deps);
			if (outputBytes > out.largestBytes) {
				out.largestBytes = outputBytes;
				out.largestPath = fp;
			}
			fdcCountCatLines(abs, st.size, verb, requestedLines, deps, out);
		} catch {
			// best-effort: stat/read errors must never break the hook.
		}
	}
	return out;
}

/** The foreground-`tail -f` block verdict, or null when it is backgrounded. */
function fdcFollowVerdict(cmd: string): ColdWriteVerdict | null {
	const trailingAmp = /(?:^|[^&])&\s*$/.test(cmd);
	const nohup = /^\s*nohup\s+/.test(cmd);
	if (trailingAmp || nohup) return null;
	return {
		decision: "block",
		reason:
			"BLOCKED: tail -f in the foreground will hang the tool call indefinitely. " +
			"Run it in the background (append ' &'), use the runner's background flag, " +
			"or use the Monitor tool for streaming output.",
		rule_id: "inline-tail-follow-foreground",
		severity: "high",
		category: "command-shape",
	};
}

/** Size / line-count verdict for an unfiltered dump. */
function fdcBudgetVerdict(verb: string, stats: ColdDumpStats, lines: number): ColdWriteVerdict | null {
	const sizeCap = 100 * 1024;
	const lineCap = 200;
	if (stats.largestBytes > sizeCap) {
		return {
			decision: "block",
			reason:
				"BLOCKED: " +
				verb +
				" on " +
				stats.largestPath +
				" (" +
				fdcFmtBytes(stats.largestBytes) +
				") without a downstream filter would dump a large payload into the tool result. " +
				"Pipe through one of: jq | grep | rg | awk | sed | head | wc | cut | sort | uniq. " +
				"If you need the raw bytes on disk, redirect: " +
				verb +
				" ... > /tmp/sample. " +
				"To check the file first, run: wc -l " +
				stats.largestPath +
				".",
			rule_id: "inline-file-dump-large-file",
			severity: "high",
			category: "command-shape",
		};
	}
	if (lines > lineCap) {
		const linesDesc = lines === Infinity ? "an entire file" : lines + " lines";
		return {
			decision: "block",
			reason:
				"BLOCKED: " +
				verb +
				" requesting " +
				linesDesc +
				" without a downstream filter caps out the tool-result budget. " +
				"Cap at " +
				lineCap +
				" lines, or narrow with a filter (jq / grep / awk / head). " +
				"If you really need the raw bytes, redirect: " +
				verb +
				" ... > /tmp/sample.",
			rule_id: "inline-file-dump-too-many-lines",
			severity: "high",
			category: "command-shape",
		};
	}
	return null;
}

/** Parse a Bash command into its dump shape, or null when the first command is
 *  not one of tail/head/cat. */
function fdcDumpShape(cmd: string): ColdDumpShape | null {
	if (!/^\s*(tail|head|cat)\b/.test(cmd) && !/[;&|]\s*(tail|head|cat)\b/.test(cmd)) return null;
	const segments = fdcSplitPipeline(cmd);
	if (!segments.length) return null;
	const tokens = fdcTokenize(segments[0] || "");
	fdcStripWrappers(tokens);
	const verb = tokens[0] || "";
	if (["tail", "head", "cat"].indexOf(verb) === -1) return null;
	return { segments: segments, tokens: tokens, verb: verb };
}

/** Effective line count the command would emit: the explicit `-n`, the counted
 *  newlines for a bare `cat`, Infinity when a bare `cat` could not be counted,
 *  else the tail/head default of 10. */
function fdcEffectiveLines(requestedLines: number | null, verb: string, stats: ColdDumpStats): number {
	if (requestedLines !== null) return requestedLines;
	if (verb !== "cat") return 10;
	return stats.catLineCountKnown ? stats.newlines : Infinity;
}

/** True when the command's own flags bound its output: a `-c` byte slice on
 *  head/tail, or a downstream filter stage. */
function fdcIsBounded(shape: ColdDumpShape): boolean {
	if (fdcHasDownstreamFilter(shape.segments)) return true;
	const cFlag = fdcParseCount(shape.tokens, "-c");
	return cFlag !== null && (shape.verb === "head" || shape.verb === "tail");
}

/**
 * Cold fail-closed gate: refuse an oversized or unfiltered tail/head/cat dump.
 * Returns a block verdict, or null when the command is bounded, redirected,
 * filtered, or not a dump at all.
 */
export function checkFileDumpCold(
	toolName: string,
	toolInput: { command?: unknown },
	cwd: string,
	deps: ColdDumpDeps,
): ColdWriteVerdict | null {
	const bashTools = ["Bash", "Shell", "shell", "run_command", "bash"];
	if (!toolName || bashTools.indexOf(toolName) === -1) return null;
	const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
	if (!cmd) return null;
	const shape = fdcDumpShape(cmd);
	if (!shape) return null;
	if (shape.verb === "tail" && fdcHasFollowFlag(shape.tokens)) return fdcFollowVerdict(cmd);
	if (fdcHasRedirect(cmd)) return null;
	if (fdcIsBounded(shape)) return null;

	const requestedLines = fdcParseCount(shape.tokens, "-n");
	const files = fdcFilePaths(shape.tokens);
	if (!files || !files.length) return null;
	const windowLines = files.length === 1 ? fileDumpWindowLines(shape.tokens) : null;
	const stats = fdcStatFiles(files, cwd, shape.verb, requestedLines, deps, windowLines);
	return fdcBudgetVerdict(shape.verb, stats, fdcEffectiveLines(requestedLines, shape.verb, stats));
}

/**
 * Source text of every function above, joined as a run of plain function
 * declarations, for embedding into the zero-import generated .mjs hook.
 * Declarations hoist, so the join order does not matter.
 */
export const FILE_DUMP_COLD_GUARD_SOURCE: string = [
	fileDumpWindowLines, fileDumpHeadBytes, fileDumpTailBytes, readFileDumpWindow, measureFileDumpWindow,
	fdcSplitPipeline, fdcAdvanceQuoted, fdcPushIfNonEmpty, fdcTokenize,
	fdcStripWrappers,
	fdcCountOf,
	fdcParseCount,
	fdcFmtBytes,
	fdcHasRedirect,
	fdcHasDownstreamFilter,
	fdcHasFollowFlag,
	fdcCollectRestArgs,
	fdcFilePaths,
	fdcAbsolute,
	fdcCountCatLines,
	fdcStatFiles,
	fdcFollowVerdict,
	fdcBudgetVerdict,
	fdcDumpShape,
	fdcEffectiveLines,
	fdcIsBounded,
	checkFileDumpCold,
]
	.map((fn) => fn.toString())
	.join("\n");
