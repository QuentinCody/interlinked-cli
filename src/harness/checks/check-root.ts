// ===========================================
// Check root — the project a registry detector reads
// ===========================================
//
// A registry detector has the `(content, filePath)` contract. Detectors that
// read more than the file (a git file listing, companion tests, package
// files, an installed `typescript`) need the project ROOT too. The PostToolUse
// and verify callers run inside that project, so `process.cwd()` was the
// answer. A scan of another tree (`interlinked recurrence scan --cwd <dir>`)
// is not: there, `process.cwd()` is the caller's checkout and the detectors
// read the wrong project in silence.
//
// This module is the ONE mechanism that carries the root. A caller that scans
// a tree other than its own runs the detectors inside `withCheckRoot(root,
// ...)`. A detector or registry wrapper that needs the root reads
// `checkRoot()`, which falls back to `process.cwd()` outside such a run, so
// the hook paths keep their behavior.
//
// The same run collects NOT MEASURED disclosures: a detector that cannot run
// (no `typescript` to parse with) calls `reportNotMeasured` instead of
// returning an empty list in silence. Inside a run, the caller receives the
// lines and decides where to print them. Outside a run, each distinct line is
// written to stderr once per process.
//
// The state is synchronous and scoped by try/finally. Detectors are
// synchronous, so no other work can observe a root it did not set.

let activeRoot: string | null = null;
let activeNotices: Set<string> | null = null;
const reportedOutsideRun = new Set<string>();

/** The project root a detector reads: the active run's root, else the process cwd. */
export function checkRoot(): string {
	return activeRoot ?? process.cwd();
}

/** The result of `run` plus every NOT MEASURED line reported while it ran. */
export interface CheckRootRun<T> {
	result: T;
	notMeasured: string[];
}

/**
 * Run `run` with `root` as the check root. Restores the previous root on exit,
 * also when `run` throws. NOT MEASURED lines reported inside a nested run also
 * reach the enclosing run.
 */
export function withCheckRoot<T>(root: string, run: () => T): CheckRootRun<T> {
	const previousRoot = activeRoot;
	const previousNotices = activeNotices;
	const notices = new Set<string>();
	activeRoot = root;
	activeNotices = notices;
	try {
		const result = run();
		return { result, notMeasured: [...notices] };
	} finally {
		activeRoot = previousRoot;
		activeNotices = previousNotices;
		for (const line of notices) previousNotices?.add(line);
	}
}

/** The standard `[interlinked:<check>] NOT MEASURED: <reason>` disclosure line. */
export function notMeasuredLine(checkId: string, reason: string): string {
	return `[interlinked:${checkId}] NOT MEASURED: ${reason}`;
}

/**
 * Disclose that `checkId` ran no measurement. Inside a `withCheckRoot` run the
 * line goes to that run; outside one it goes to stderr, once per distinct line.
 */
export function reportNotMeasured(checkId: string, reason: string): void {
	const line = notMeasuredLine(checkId, reason);
	if (activeNotices !== null) {
		activeNotices.add(line);
		return;
	}
	if (reportedOutsideRun.has(line)) return;
	reportedOutsideRun.add(line);
	process.stderr.write(`${line}\n`);
}
