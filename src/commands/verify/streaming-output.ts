// ===========================================
// Streaming (human-readable) output
// ===========================================
// When `verify` runs without `--json`, it streams ANSI-colored progress
// directly to stderr. This module owns:
//   - The spinner/section formatter helpers.
//   - Tool subprocess runners (`runToolWithSpinner`, `runToolSilent`).
//
// The declarative table of sections walked by `streamAllCqSections` lives
// in `./section-table.ts`.

import { runProcessAsync } from "../../harness/check-engine/spawn-async.js";

import { SECTIONS } from "./section-table.js";
import { incompleteProcessReason } from "../../harness/check-engine/tool-runners/file-process-verdict.js";
import type { CodeQualityIssue, CodeQualityResults } from "./tool-results-types.js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const MAX_LISTED_FILES = 15;
const MAX_FILE_DETAIL_LINES = 5;
const MESSAGE_MAX_LENGTH = 100;

/**
 * Public API — consumed by `verify.ts`.
 *
 * Only one module-global mutable: the active skip-check set used by
 * `streamCqSection` to short-circuit when the caller's verify run has
 * elected to skip this check family. Set by verify.ts before streaming.
 */
let activeSkipChecks: Set<string> = new Set();

/** Public API — consumed by `verify.ts`. Clear/replace the active skip set. */
export function setActiveSkipChecks(next: Set<string>): void {
	activeSkipChecks = next;
}

/** Public API — consumed by `verify.ts` and tests. */
export function getActiveSkipChecks(): Set<string> {
	return activeSkipChecks;
}

interface StreamCqSectionArgs {
	label: string;
	skipId?: string | undefined;
	issues: CodeQualityIssue[];
	noun: string;
	passLabel: string;
	details: boolean;
	color: string;
	allFlaggedFiles: Set<string>;
}

/**
 * Write one flagged file's line, plus its per-issue detail lines when
 * `details` is set. Extracted from `streamCqSection` to keep the section
 * loop flat.
 */
function writeFlaggedFileDetail(
	file: string,
	issues: CodeQualityIssue[],
	details: boolean,
): void {
	process.stderr.write(`\x1b[2m         ${file}\x1b[0m\n`);
	if (!details) return;
	const fileItems = issues.filter((r) => r.file === file);
	for (const item of fileItems.slice(0, MAX_FILE_DETAIL_LINES)) {
		const loc = item.line > 0 ? `L${item.line}: ` : "";
		process.stderr.write(
			`\x1b[2m           ${loc}${item.message.slice(0, MESSAGE_MAX_LENGTH)}\x1b[0m\n`,
		);
	}
	if (fileItems.length > MAX_FILE_DETAIL_LINES) {
		process.stderr.write(
			`\x1b[2m           ... and ${fileItems.length - MAX_FILE_DETAIL_LINES} more\x1b[0m\n`,
		);
	}
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Display a code-quality section on stderr with file names always shown.
 * Skips silently when the check is in the active skip-check set.
 */
export function streamCqSection(args: StreamCqSectionArgs): void {
	const { label, skipId, issues, noun, passLabel, details, color, allFlaggedFiles } = args;
	// Skip if this section's explicit check id (or normalized label for legacy
	// sections) is in the skip set.
	const skipKey = skipId ?? label.replace(/[\s-]/g, "_").toLowerCase();
	if (activeSkipChecks.size > 0 && activeSkipChecks.has(skipKey)) {
		return;
	}
	if (issues.length === 0) {
		process.stderr.write(`\n  \x1b[1m${label}\x1b[0m\n`);
		process.stderr.write(`    \x1b[32m✓\x1b[0m ${passLabel}\n`);
		return;
	}
	const issueFiles = new Set(issues.map((r) => r.file));
	for (const f of issueFiles) allFlaggedFiles.add(f);
	process.stderr.write(`\n  \x1b[1m${label}\x1b[0m\n`);
	process.stderr.write(
		`    \x1b[${color}m!\x1b[0m \x1b[${color}m${issues.length}\x1b[0m ${noun} in \x1b[${color}m${issueFiles.size}\x1b[0m files\n`,
	);
	for (const file of [...issueFiles].sort().slice(0, MAX_LISTED_FILES)) {
		writeFlaggedFileDetail(file, issues, details);
	}
	if (issueFiles.size > MAX_LISTED_FILES) {
		process.stderr.write(
			`\x1b[2m         ... and ${issueFiles.size - MAX_LISTED_FILES} more files\x1b[0m\n`,
		);
	}
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Walk the declarative section table and stream each section.
 */
export function streamAllCqSections(
	cq: CodeQualityResults,
	details: boolean,
	allFlaggedFiles: Set<string>,
): void {
	for (const spec of SECTIONS) {
		streamCqSection({
			label: spec.label,
			skipId: spec.skipId,
			issues: cq[spec.key],
			noun: spec.noun,
			passLabel: spec.passLabel,
			details,
			color: spec.color,
			allFlaggedFiles,
		});
	}
}

export interface ToolRun<T> {
	items: T[];
	elapsedMs: string;
	unavailable?: string;
}

interface RunToolArgs<T> {
	/** Composed workflows own their native subprocesses and report partial results. */
	run?: () => Promise<T[]>;
	cmd: string[];
	cwd: string;
	timeoutMs: number;
	parseOutput: (output: string, exitCode: number | null) => T[];
	reportStream?: "stdout" | "combined";
	recoverPartial?: (error: unknown) => T[] | undefined;
	/** Only strict machine-report parsers may recover positives from interrupted output. */
	recoverInterruptedReport?: boolean;
}

interface RunToolWithSpinnerArgs<T> extends RunToolArgs<T> {
	label: string;
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Spawn a tool asynchronously with a live animated spinner on stderr.
 */
export async function runToolWithSpinner<T>(args: RunToolWithSpinnerArgs<T>): Promise<ToolRun<T>> {
	const start = Date.now();
	let frame = 0;
	const frameMs = 80;
	const spinner = setInterval(() => {
		const secs = ((Date.now() - start) / 1000).toFixed(0);
		const f = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
		process.stderr.write(`\r\x1b[K  \x1b[36m${f}\x1b[0m \x1b[1m${args.label}\x1b[0m \x1b[2m${secs}s\x1b[0m`);
		frame++;
	}, frameMs);
	try { return await runToolSilent(args); }
	finally { clearInterval(spinner); process.stderr.write("\r\x1b[K"); }
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Spawn a tool without UI. Shared process ownership reaps timed-out descendants;
 * interruption or incomplete capture never becomes an empty successful report.
 */
export async function runToolSilent<T>(args: RunToolArgs<T>): Promise<ToolRun<T>> {
	const { cmd, cwd, timeoutMs, parseOutput } = args;
	const start = Date.now();
	if (args.run) {
		try { return { items: await args.run(), elapsedMs: `${((Date.now() - start) / 1000).toFixed(1)}s` }; }
		catch (error) { return { items: args.recoverPartial?.(error) ?? [], elapsedMs: `${((Date.now() - start) / 1000).toFixed(1)}s`,
			unavailable: error instanceof Error ? error.message : "Tool workflow incomplete; no complete verdict" }; }
	}
	const bin = cmd[0];
	if (bin === undefined) return { items: [], elapsedMs: "0.0s", unavailable: "Tool command is empty; no complete verdict" };
	const result = await runProcessAsync(bin, cmd.slice(1), { cwd, timeout: timeoutMs, maxBufferBytes: null });
	const elapsedMs = `${((Date.now() - start) / 1000).toFixed(1)}s`;
	const incomplete = incompleteProcessReason(result);
	if (incomplete) {
		let items: T[] = [];
		if (args.recoverInterruptedReport) {
			try { items = parseOutput(result.stdout, result.code); }
			catch (error) { items = args.recoverPartial?.(error) ?? []; }
		}
		return { items, elapsedMs, unavailable: `Tool ${incomplete}; no complete verdict` };
	}
	try {
		const items = parseOutput(args.reportStream === "stdout" ? result.stdout : result.stdout + result.stderr, result.code);
		if (result.code !== 0 && items.length === 0) {
			return { items, elapsedMs, unavailable: `Tool returned exit ${result.code} without a usable report; no complete verdict` };
		}
		return { items, elapsedMs };
	} catch (error) {
		return { items: args.recoverPartial?.(error) ?? [], elapsedMs, unavailable: `Tool report is incomplete: ${error instanceof Error ? error.message : String(error)}` };
	}
}
