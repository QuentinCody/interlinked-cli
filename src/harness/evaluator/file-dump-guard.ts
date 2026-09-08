// ===========================================
// File-Dump Guard (PreToolUse) — tail/head/cat budgets
// ===========================================
//
// Stops Bash invocations of `tail`, `head`, and `cat` from dumping a huge
// or unfiltered payload into the tool result. Three blocking cases:
//
//   1. `tail -f` / `tail -F` in the foreground (no trailing `&`) — hangs.
//   2. No downstream filter & no output redirection & file > 100KB — blocks
//      unless an ordinary head/tail window is measured within the byte budget.
//   3. No downstream filter & no output redirection & lines requested > 50
//      — blocks regardless of file size.
//
// And one soft ceiling (warning, not block):
//
//   4. With a filter, but lines requested > 1000 — the filter usually bounds
//      output but at 1000+ lines even a `jq -r '.f'` projection can produce
//      a lot. Caller surfaces this as a warning.
//
// Bypasses:
//   * Output redirection (`>`, `>>`, `&>`, `\d+>`) — bytes never hit the
//     tool result.
//   * `head -c` / `tail -c` — byte-count bounds output, treated as a filter.
//
// The size check requires `fs.statSync` and so cannot be expressed as a
// pure regex rule in `builtin-rules.ts`. Mirrors the inline check in
// `lib/hook-template-chunks/guards-inline.ts` per the two-implementations
// memory (see `project_hook_paths_two_implementations.md`).

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileDumpWindowLines, measureFileDumpWindow } from "../../lib/hook-template-chunks/file-dump-cold-guard.js";
import type { HarnessDecision } from "../types.js";
import {
	extractFilePaths,
	firstCommandGroup,
	formatBytes,
	hasFollowFlag,
	hasOutputRedirect,
	parseCountFlag,
	splitPipeline,
	stripLeadingWrappers,
	stripPathPrefix,
	tokenize,
} from "./file-dump-guard-parse.js";

/** File-size threshold above which an unfiltered dump is refused. */
const FILE_SIZE_BLOCK_BYTES = 100 * 1024;
/** Line-count cap when no filter is present in the pipeline. Raised 50 → 200
 *  (2026-07-24): July telemetry showed 17 blocks on bare `cat` of 76–106-line
 *  files — under the Read tool's own 2000-line default — pure friction with no
 *  budget saved. The 100KB size gate still refuses genuinely large dumps. */
const NO_FILTER_MAX_LINES = 200;
/** Soft warning ceiling when a filter is present. */
const WITH_FILTER_SOFT_CEILING = 1000;

/** Pipeline-FINAL commands that bound output regardless of upstream window
 *  size: `… | tail -n 10`, `… | head -15`, `… | wc -l`. A large upstream
 *  `-n` feeding a small terminal slice is the sanctioned bounded-read shape
 *  (the .interlinked/INDEX.md query recipes) — not a dump. Without this
 *  carve-out the soft nudge fired 10+ times per session on exactly those
 *  recipes (2026-07 telemetry). */
const TERMINAL_BOUNDING_COMMANDS = new Set(["head", "tail", "wc"]);

/**
 * Output-reducing filters the agent can pipe into. First token of each
 * downstream pipeline segment is checked against this set. `cat` and `tee`
 * are deliberately omitted (passthrough, not filters).
 */
const FILTER_COMMANDS = new Set([
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
]);

/** Verb tokens this guard applies to. */
const DUMP_VERBS = new Set(["tail", "head", "cat"]);

export interface FileDumpGuardArgs {
	/** Raw Bash command string from `tool_input.command`. */
	command: string;
	/** Working directory used to resolve relative file paths for stat. */
	cwd: string;
}

export type FileDumpGuardResult =
	| { kind: "block"; decision: HarnessDecision }
	| { kind: "warn"; message: string }
	| { kind: "allow" };

/**
 * Public API — consumed by `evaluator/pre-tool.ts`. Returns a block decision,
 * an advisory warning, or `allow` for the given Bash command. Cheap on
 * non-matching commands: bails out before any fs syscall when the first
 * verb isn't tail/head/cat.
 */
export function evaluateFileDumpGuard(args: FileDumpGuardArgs): FileDumpGuardResult {
	const { command, cwd } = args;
	if (!command) return { kind: "allow" };

	// Bound to the first command group (see firstCommandGroup) so a later
	// command's tokens can't leak onto this verb.
	const group = firstCommandGroup(command);

	const segments = splitPipeline(group);
	if (segments.length === 0) return { kind: "allow" };

	const first = segments[0] ?? "";
	const tokens = tokenize(first);
	stripLeadingWrappers(tokens);
	const verb = tokens[0];
	if (!verb || !DUMP_VERBS.has(verb)) return { kind: "allow" };

	// 1. tail -f / -F. Foreground hangs the tool call → block. Backgrounded
	// (with trailing `&` or wrapped in `nohup`) is a streaming command whose
	// total output is unbounded and not in the tool-result budget, so skip
	// the remaining size/line-count checks entirely.
	if (verb === "tail" && hasFollowFlag(tokens)) {
		return followBlockResult(group) ?? { kind: "allow" };
	}

	// 2. Output redirection → bypass size/line-count checks; the bytes go
	// to disk, not the tool result.
	if (hasOutputRedirect(group)) return { kind: "allow" };

	// 3-4. Detect a filter (downstream filter command, or head/tail `-c` slice).
	const hasFilter = hasDownstreamFilter(segments, tokens, verb);

	// 5. Extract requested line count and file path args.
	const requestedLines = parseCountFlag(tokens, "-n");
	const filePaths = extractFilePaths(tokens, verb);

	// 6. If we couldn't resolve any concrete file path (glob, command
	// substitution, stdin), be permissive — don't risk false positives.
	if (filePaths.length === 0) return { kind: "allow" };

	// 7. Stat the file args and resolve the effective line count.
	const windowLines = filePaths.length === 1 && !hasFilter ? fileDumpWindowLines(tokens) : null;
	const summary = statDumpFiles(filePaths, cwd, verb, requestedLines, windowLines);
	const lines = resolveDumpLines(requestedLines, verb, summary);

	// 8. Verdict: filtered (soft ceiling, waived for terminal-bounded pipes)
	// vs. unfiltered (size/line blocks).
	return hasFilter
		? filteredVerdict(verb, lines, endsWithBoundingStage(segments))
		: unfilteredVerdict(verb, summary, lines);
}

/** True when the pipeline's last segment is a bounding command (head/tail/wc). */
function endsWithBoundingStage(segments: string[]): boolean {
	if (segments.length < 2) return false;
	const last = (segments[segments.length - 1] ?? "").trim();
	const verb = (last.match(/^([\w.-]+)/) || [])[1];
	return verb !== undefined && TERMINAL_BOUNDING_COMMANDS.has(stripPathPrefix(verb));
}

/** Stat summary across the resolved file-path args of a dump command. */
interface DumpStatSummary {
	largestBytes: number;
	largestPath: string;
	aggregateNewlines: number;
	catLineCountKnown: boolean;
}

/**
 * Foreground-`tail -f` block decision. Returns a block result when the command
 * follows a file without backgrounding it (`&`) or `nohup`; otherwise `null`
 * (background follow is unbounded streaming, intentionally not size-checked).
 * Only meaningful when `verb === "tail"` and a follow flag is present.
 */
function followBlockResult(command: string): FileDumpGuardResult | null {
	const trailingAmp = /(?:^|[^&])&\s*$/.test(command);
	const nohup = /^\s*nohup\s+/.test(command);
	if (trailingAmp || nohup) return null;
	return {
		kind: "block",
		decision: {
			decision: "block",
			reason:
				"BLOCKED: `tail -f` in the foreground will hang the tool call indefinitely. " +
				"Run it in the background (`tail -f ... &`), use the runner's background flag, " +
				"or use the Monitor tool for streaming output.",
			rule_id: "builtin-tail-follow-foreground",
			severity: "high",
			category: "command-shape",
		},
	};
}

/**
 * True when output is effectively bounded: a recognized filter command appears
 * downstream in the pipeline, OR the verb is head/tail with a `-c N` byte slice
 * (byte-bounded output, treated as filter-equivalent).
 */
function hasDownstreamFilter(segments: string[], tokens: string[], verb: string): boolean {
	for (const seg of segments.slice(1)) {
		const t = (seg.trim().match(/^([\w.-]+)/) || [])[1];
		if (t && FILTER_COMMANDS.has(stripPathPrefix(t))) return true;
	}
	const cFlag = parseCountFlag(tokens, "-c");
	return cFlag !== null && (verb === "head" || verb === "tail");
}

/**
 * Stats every resolved file path, returning the largest file's size/path plus
 * (for `cat` without `-n` on small files) an aggregate newline count so a small
 * file isn't blocked just for the verb. Stat/read errors are swallowed
 * (best-effort) — a read failure leaves `catLineCountKnown` false, which the
 * caller treats as the conservative (block-favoring) unknown line count.
 */
function statDumpFiles(
	filePaths: string[],
	cwd: string,
	verb: string,
	requestedLines: number | null,
	windowLines: number | null,
): DumpStatSummary {
	const summary: DumpStatSummary = {
		largestBytes: 0,
		largestPath: "",
		aggregateNewlines: 0,
		catLineCountKnown: false,
	};
	for (const fp of filePaths) {
		const abs = isAbsolute(fp) ? fp : resolve(cwd, fp);
		try {
			if (!existsSync(abs)) continue;
			const stat = statSync(abs);
			if (!stat.isFile()) continue;
			const outputBytes = measureFileDumpWindow({ path: abs, size: stat.size, verb, lines: windowLines, maxBytes: FILE_SIZE_BLOCK_BYTES }, { openSync, readSync, closeSync });
			if (outputBytes > summary.largestBytes) {
				summary.largestBytes = outputBytes;
				summary.largestPath = fp;
			}
			countCatNewlines(abs, verb, requestedLines, stat.size, summary);
		} catch {
			// Best-effort; stat errors must not break the guard.
		}
	}
	return summary;
}

/**
 * For `cat` with no `-n` on a sub-threshold file, reads it and accumulates its
 * newline count into `summary`. No-op for other verbs / large files. A read
 * failure is non-fatal: `catLineCountKnown` is left as-is (Infinity fallback).
 */
function countCatNewlines(
	abs: string,
	verb: string,
	requestedLines: number | null,
	size: number,
	summary: DumpStatSummary,
): void {
	if (verb !== "cat" || requestedLines !== null || size > FILE_SIZE_BLOCK_BYTES) return;
	try {
		const content = readFileSync(abs, "utf8");
		summary.aggregateNewlines += (content.match(/\n/g) || []).length;
		summary.catLineCountKnown = true;
	} catch {
		// non-fatal: leaves catLineCountKnown unchanged → Infinity fallback (block-favoring).
	}
}

/**
 * Resolves the effective requested line count. Explicit `-n N` wins; for `cat`
 * without `-n` we use the counted newlines when known, else `Infinity`
 * (conservative); every other verb defaults to 10.
 */
function resolveDumpLines(requestedLines: number | null, verb: string, summary: DumpStatSummary): number {
	if (requestedLines !== null) return requestedLines;
	if (verb === "cat") return summary.catLineCountKnown ? summary.aggregateNewlines : Infinity;
	return 10;
}

/**
 * Verdict when NO filter is present: block on a too-large file, then on a
 * too-high line count, else allow.
 */
function unfilteredVerdict(verb: string, summary: DumpStatSummary, lines: number): FileDumpGuardResult {
	if (summary.largestBytes > FILE_SIZE_BLOCK_BYTES) {
		return {
			kind: "block",
			decision: {
				decision: "block",
				reason:
					`BLOCKED: \`${verb}\` on ${summary.largestPath} (${formatBytes(summary.largestBytes)}) without a downstream filter ` +
					`would dump a large payload into the tool result. Pipe through one of: ` +
					`jq | grep | rg | awk | sed | head | wc | cut | sort | uniq. ` +
					`If you need the raw bytes on disk, redirect: \`${verb} ... > /tmp/sample\`. ` +
					`To check the file first, run \`wc -l ${summary.largestPath}\`.`,
				rule_id: "builtin-file-dump-large-file",
				severity: "high",
				category: "command-shape",
			},
		};
	}
	if (lines > NO_FILTER_MAX_LINES) {
		const linesDesc = lines === Infinity ? "an entire file" : `${lines} lines`;
		return {
			kind: "block",
			decision: {
				decision: "block",
				reason:
					`BLOCKED: \`${verb}\` requesting ${linesDesc} without a downstream filter caps out the tool-result budget. ` +
					`Cap at ${NO_FILTER_MAX_LINES} lines, or narrow with a filter (jq / grep / awk / head). ` +
					`If you really need the raw bytes, redirect: \`${verb} ... > /tmp/sample\`.`,
				rule_id: "builtin-file-dump-too-many-lines",
				severity: "high",
				category: "command-shape",
			},
		};
	}
	return { kind: "allow" };
}

/**
 * Verdict when a filter IS present: a soft warning past the line-count ceiling,
 * else allow. The filter bounds output in practice but 1000+ lines is still
 * worth flagging — unless the pipeline's FINAL stage is itself a bounding
 * command (head/tail/wc), which caps the tool-result payload no matter how
 * wide the upstream window was.
 */
function filteredVerdict(verb: string, lines: number, endsBounded = false): FileDumpGuardResult {
	if (endsBounded) return { kind: "allow" };
	if (lines !== Infinity && lines > WITH_FILTER_SOFT_CEILING) {
		return {
			kind: "warn",
			message:
				`[interlinked:file-dump] \`${verb} -n ${lines}\` is past the ${WITH_FILTER_SOFT_CEILING}-line soft ceiling even with a filter. ` +
				`If the filter is selective the output stays small, but tighten the line count if you can.`,
		};
	}
	return { kind: "allow" };
}
