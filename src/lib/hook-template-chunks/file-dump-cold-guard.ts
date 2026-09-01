// Single source of truth for the cold-fallback FILE-DUMP gate.
//
// Refuses a `tail`/`head`/`cat` invocation that would dump a large or
// unfiltered payload into the tool result — the cold-path mirror of the
// daemon's richer `src/harness/evaluator/file-dump-guard.ts`. Three block
// conditions:
//   1. `tail -f` / `-F` in the foreground (no trailing `&`, no nohup) — hangs.
//   2. No filter, no redirect, file over 100KB — refused regardless of `-n`.
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

/** Filesystem/path functions injected by the caller — the .mjs passes its own
 *  top-level imports. Any member may be null; the guard then declines to
 *  evaluate rather than throwing. */
export interface ColdDumpDeps {
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

/** Split one pipeline segment into whitespace-separated tokens, dropping the
 *  quote characters themselves. */
function fdcTokenize(seg: string): string[] {
	const out: string[] = [];
	let buf = "";
	let q: string | null = null;
	for (let i = 0; i < seg.length; i++) {
		const ch = seg[i];
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
		if (/\s/.test(ch || "")) {
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
			for (let j = i + 1; j < tokens.length; j++) if (tokens[j]) files.push(tokens[j] || "");
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
	if (deps?.join) return deps.join(cwd, fp);
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
): ColdDumpStats {
	const out: ColdDumpStats = {
		largestBytes: 0,
		largestPath: "",
		newlines: 0,
		catLineCountKnown: false,
	};
	const existsSyncFn = deps?.existsSync;
	const statSyncFn = deps?.statSync;
	if (!existsSyncFn || !statSyncFn) return out;
	for (const fp of files) {
		const abs = fdcAbsolute(fp, cwd, deps);
		try {
			if (!existsSyncFn(abs)) continue;
			const st = statSyncFn(abs);
			if (!st.isFile()) continue;
			if (st.size > out.largestBytes) {
				out.largestBytes = st.size;
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
	const cmd = toolInput && typeof toolInput.command === "string" ? toolInput.command : "";
	if (!cmd) return null;
	const shape = fdcDumpShape(cmd);
	if (!shape) return null;
	if (shape.verb === "tail" && fdcHasFollowFlag(shape.tokens)) return fdcFollowVerdict(cmd);
	if (fdcHasRedirect(cmd)) return null;
	if (fdcIsBounded(shape)) return null;

	const requestedLines = fdcParseCount(shape.tokens, "-n");
	const files = fdcFilePaths(shape.tokens);
	if (!files || !files.length) return null;
	const stats = fdcStatFiles(files, cwd, shape.verb, requestedLines, deps);
	return fdcBudgetVerdict(shape.verb, stats, fdcEffectiveLines(requestedLines, shape.verb, stats));
}

/**
 * Source text of every function above, joined as a run of plain function
 * declarations, for embedding into the zero-import generated .mjs hook.
 * Declarations hoist, so the join order does not matter.
 */
export const FILE_DUMP_COLD_GUARD_SOURCE: string = [
	fdcSplitPipeline,
	fdcTokenize,
	fdcStripWrappers,
	fdcCountOf,
	fdcParseCount,
	fdcFmtBytes,
	fdcHasRedirect,
	fdcHasDownstreamFilter,
	fdcHasFollowFlag,
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
