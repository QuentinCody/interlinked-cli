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

import { spawn } from "node:child_process";

import { SECTIONS } from "./section-table.js";
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

interface ToolRun<T> {
	items: T[];
	elapsedMs: string;
}

interface RunToolArgs<T> {
	cmd: string[];
	cwd: string;
	timeoutMs: number;
	parseOutput: (output: string, exitCode: number | null) => T[];
}

interface RunToolWithSpinnerArgs<T> extends RunToolArgs<T> {
	label: string;
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Spawn a tool asynchronously with a live animated spinner on stderr.
 */
export function runToolWithSpinner<T>(args: RunToolWithSpinnerArgs<T>): Promise<ToolRun<T>> {
	const { label, cmd, cwd, timeoutMs, parseOutput } = args;
	return new Promise((resolvePromise) => {
		const start = Date.now();
		let frame = 0;

		const spinner = setInterval(() => {
			const secs = ((Date.now() - start) / 1000).toFixed(0);
			const f = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
			process.stderr.write(
				`\r\x1b[K  \x1b[36m${f}\x1b[0m \x1b[1m${label}\x1b[0m \x1b[2m${secs}s\x1b[0m`,
			);
			frame++;
		}, 80);

		const bin = cmd[0];
		if (bin === undefined) {
			clearInterval(spinner);
			resolvePromise({ items: [], elapsedMs: `${((Date.now() - start) / 1000).toFixed(1)}s` });
			return;
		}
		const proc = spawn(bin, cmd.slice(1), {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
		}, timeoutMs);

		proc.on("error", () => {
			clearTimeout(timer);
			clearInterval(spinner);
			process.stderr.write("\r\x1b[K");
			resolvePromise({
				items: [],
				elapsedMs: `${((Date.now() - start) / 1000).toFixed(1)}s`,
			});
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			clearInterval(spinner);
			process.stderr.write("\r\x1b[K");
			const output = stdout + stderr;
			const items = parseOutput(output, code);
			resolvePromise({ items, elapsedMs: `${((Date.now() - start) / 1000).toFixed(1)}s` });
		});
	});
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Spawn a tool without UI — used for parallel execution where the caller owns
 * the progress indicator.
 */
export function runToolSilent<T>(args: RunToolArgs<T>): Promise<ToolRun<T>> {
	const { cmd, cwd, timeoutMs, parseOutput } = args;
	return new Promise((resolvePromise) => {
		const start = Date.now();
		const bin = cmd[0];
		if (bin === undefined) {
			resolvePromise({ items: [], elapsedMs: `${((Date.now() - start) / 1000).toFixed(1)}s` });
			return;
		}
		const proc = spawn(bin, cmd.slice(1), {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
		}, timeoutMs);

		proc.on("error", () => {
			clearTimeout(timer);
			resolvePromise({
				items: [],
				elapsedMs: `${((Date.now() - start) / 1000).toFixed(1)}s`,
			});
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			const output = stdout + stderr;
			const items = parseOutput(output, code);
			resolvePromise({ items, elapsedMs: `${((Date.now() - start) / 1000).toFixed(1)}s` });
		});
	});
}
