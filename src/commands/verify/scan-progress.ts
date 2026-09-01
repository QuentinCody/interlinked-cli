// ===========================================
// Scan progress reporter (stderr-only)
// ===========================================
// `interlinked verify` spends the bulk of its wall time inside one CPU-bound
// span: the per-file check battery driven from `tool-results.ts`. Before this
// module that span printed "scanning files..." and then nothing at all until
// it finished — on a 3000-file tree that reads as a hang, and Ctrl-C did not
// work because the loop never yielded to the event loop.
//
// This module owns the two halves of the fix:
//   1. `createScanProgress` — a throttled, single-line, REWRITING progress
//      report. Everything it writes goes to **stderr**, so `--json` stdout
//      stays byte-identical.
//   2. `yieldToEventLoop` / `YIELD_EVERY_FILES` — the cadence the scan loop
//      uses to hand control back to libuv so signals (Ctrl-C) are delivered.
//
// It also accumulates per-file elapsed times so a slow run can name the files
// that cost the most, instead of leaving the reader to guess.

/** How often the progress line is repainted. */
const PROGRESS_INTERVAL_MS = 500;

/** Files processed between event-loop yields. */
export const YIELD_EVERY_FILES = 25;

/** Upper bound on retained per-file timings (bounded memory). */
const SLOWEST_KEEP = 10;

/** Default number of slow files reported to the reader. */
const SLOWEST_REPORT_LIMIT = 3;

/** A run faster than this needs no slow-file breakdown. */
const SLOW_RUN_REPORT_THRESHOLD_MS = 5_000;

/** Longest path tail rendered on the progress line. */
const MAX_PATH_CHARS = 48;

const MS_PER_SECOND = 1000;

/** Carriage return + erase-to-end-of-line: repaints one line in place. */
const CLEAR_LINE = "\r\x1b[K";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** One file's contribution to the scan's wall time. */
interface SlowFile {
	file: string;
	ms: number;
}

/** Injection seams — tests supply their own writer and clock. */
interface ScanProgressDeps {
	/** Defaults to`process.stderr.write`, resolved per call so tests can patch it. */
	write?: (chunk: string) => void;
	/** Defaults to `Date.now`. */
	now?: () => number;
	/** Defaults to `PROGRESS_INTERVAL_MS`. */
	intervalMs?: number;
}

/**
 * Public API — consumed by `verify/tool-results.ts` and `verify.ts`.
 *
 * `start` must be called before the first `advance`; it names the phase and
 * resets both the counter and the phase clock.
 */
export interface ScanProgress {
	start(phase: string): void;
	advance(file: string, elapsedMs: number): void;
	finish(): void;
	slowest(limit?: number): SlowFile[];
}

/** Keep only the informative tail of a long absolute path. */
function truncatePath(file: string): string {
	if (file.length <= MAX_PATH_CHARS) return file;
	return `…${file.slice(file.length - MAX_PATH_CHARS + 1)}`;
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Render a millisecond duration as seconds with one decimal.
 */
export function formatSeconds(ms: number): string {
	return (ms / MS_PER_SECOND).toFixed(1);
}

/** Insert into a descending-by-cost list capped at `SLOWEST_KEEP` entries. */
function recordSlow(slow: SlowFile[], file: string, ms: number): void {
	if (ms <= 0) return;
	slow.push({ file, ms });
	slow.sort((a, b) => b.ms - a.ms);
	if (slow.length > SLOWEST_KEEP) slow.length = SLOWEST_KEEP;
}

/**
 * Public API — consumed by `verify.ts` and `verify/tool-results.ts`.
 *
 * Build a throttled single-line progress reporter over `total` files. Every
 * byte it emits goes to the injected writer (stderr by default).
 */
export function createScanProgress(total: number, deps: ScanProgressDeps = {}): ScanProgress {
	const write = deps.write ?? ((chunk: string) => void process.stderr.write(chunk));
	const now = deps.now ?? Date.now;
	const intervalMs = deps.intervalMs ?? PROGRESS_INTERVAL_MS;
	const slow: SlowFile[] = [];
	let phase = "";
	let startedAt = 0;
	let lastRenderAt = 0;
	let done = 0;

	function render(file: string): void {
		const secs = formatSeconds(now() - startedAt);
		const tail = file === "" ? "" : ` · ${truncatePath(file)}`;
		write(`${CLEAR_LINE}  ${DIM}scanning ${phase} ${done}/${total} · ${secs}s${tail}${RESET}`);
	}

	return {
		start(nextPhase: string): void {
			phase = nextPhase;
			startedAt = now();
			lastRenderAt = startedAt;
			done = 0;
			render("");
		},
		advance(file: string, elapsedMs: number): void {
			done += 1;
			recordSlow(slow, file, elapsedMs);
			const at = now();
			// Always repaint on the final file so the line never stalls short
			// of the total; otherwise throttle to one repaint per interval.
			if (at - lastRenderAt < intervalMs && done < total) return;
			lastRenderAt = at;
			render(file);
		},
		finish(): void {
			write(CLEAR_LINE);
		},
		slowest(limit: number = SLOWEST_REPORT_LIMIT): SlowFile[] {
			return slow.slice(0, limit);
		},
	};
}

/**
 * Public API — consumed by `verify/tool-results.ts`.
 *
 * Hand control back to the event loop for one turn so queued signals and
 * timers run. Without this the scan is one uninterruptible synchronous span.
 */
export function yieldToEventLoop(): Promise<void> {
	return new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Render the slow-file breakdown for a run, or `null` when the run was fast
 * enough that the breakdown is noise. Returns a newline-terminated line.
 */
export function formatSlowestFiles(slow: readonly SlowFile[], totalMs: number): string | null {
	if (totalMs < SLOW_RUN_REPORT_THRESHOLD_MS) return null;
	if (slow.length === 0) return null;
	const rows = slow.map((s) => `${truncatePath(s.file)} ${formatSeconds(s.ms)}s`).join(" · ");
	return `${DIM}  slowest files: ${rows}${RESET}\n`;
}
