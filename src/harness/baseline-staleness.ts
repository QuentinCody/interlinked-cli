// ===========================================
// Stop-event reflection: stale quality baselines
// ===========================================
// Every ratchet in this repo decides by comparing today against a committed
// water-line. That makes the water-line's FRESHNESS load-bearing, and nothing
// was reporting it: found live 2026-07-25 with `coverage-baseline.json` six
// weeks old, `untested-files-baseline.json` seven, and `mutation-baseline.json`
// never generated at all.
//
// A stale baseline does not fail loudly — it silently stops catching things.
// Coverage that regressed after the baseline was written compares clean, and a
// file that improved never gets its gain locked in. The ratchet still runs, still
// passes, and measures the wrong month.
//
// Stop-event nudge, never a block: refreshing a baseline needs an expensive
// measurement run, which must not be forced mid-session.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** Days before a baseline is considered stale enough to mention. Two weeks is
 *  long enough that an ordinary working fortnight will not trip it, short enough
 *  that a baseline never silently ages into irrelevance. */
export const DEFAULT_STALE_AFTER_DAYS = 14;

/** One day in ms — the unit every age in this module is reported in. */
const MS_PER_DAY = 86_400_000;

interface TrackedBaseline {
	file: string;
	refresh: string;
}

/**
 * The water-lines a ratchet reads, with the command that regenerates each. A
 * baseline with no refresh path would be a trap, so every entry names one — and
 * every command named here must EXIST, which `baseline-staleness.test.ts` pins
 * against the CLI's own registrar-built command tree. It did not before
 * 2026-08-16: this table sent readers to `interlinked metrics --update-baseline`,
 * a command that has never existed, so the one nudge whose whole job is "your
 * measurement is out of date" ended in a command-not-found (followup #27a).
 *
 * `mutation-baseline.json` is deliberately absent: the per-file mutation score
 * ratchet it fed was superseded by the per-edit manifest, so nudging anyone to
 * refresh it would be nudging them to feed a dead gate.
 */
export const TRACKED_BASELINES: readonly TrackedBaseline[] = [
	{ file: "coverage-baseline.json", refresh: "interlinked coverage check --update-baseline" },
	{ file: "coverage-edit-baseline.json", refresh: "interlinked coverage check --update-baseline" },
	{ file: "untested-files-baseline.json", refresh: "interlinked adopt" },
];

interface BaselineAge {
	file: string;
	refresh: string;
	/** Whole days since last write; null when the baseline has never been generated. */
	ageDays: number | null;
}

interface BaselineStalenessOpts {
	interlinkedDir:string;
	/** Epoch ms; injected so tests need no clock control. */
	now: number;
	staleAfterDays?: number;
	/** Injectable mtime lookup (epoch ms), or null when absent. Defaults to fs. */
	readMtime?: (path: string) => number | null;
}

function defaultReadMtime(path: string): number | null {
	try {
		if (!existsSync(path)) return null;
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

/** Age every tracked baseline. Pure apart from the injected mtime reader. */
export function collectBaselineAges(opts: BaselineStalenessOpts): BaselineAge[] {
	const read = opts.readMtime ?? defaultReadMtime;
	return TRACKED_BASELINES.map(({ file, refresh }) => {
		const mtime = read(join(opts.interlinkedDir, file));
		return {
			file,
			refresh,
			ageDays: mtime === null ? null : Math.floor((opts.now - mtime) / MS_PER_DAY),
		};
	});
}

/** Marker recording when this nudge last fired, so it stays bounded. */
export const NUDGE_MARKER = ".baseline-staleness-nudged";
/** Minimum gap between nudges. A stale baseline stays stale for weeks; repeating
 *  the same warning at every Stop would train the reader to ignore it. */
export const NUDGE_INTERVAL_MS = 86_400_000;

interface NudgeThrottleOpts {
	interlinkedDir:string;
	now: number;
	intervalMs?: number;
	readMtime?: (path: string) => number | null;
}

/**
 * Whether enough time has passed to nudge again. Absent marker => yes (never
 * nudged). Kept separate from the formatter so the decision is testable without
 * touching a clock or the filesystem.
 */
export function shouldNudge(opts: NudgeThrottleOpts): boolean {
	const read = opts.readMtime ?? defaultReadMtime;
	const last = read(join(opts.interlinkedDir, NUDGE_MARKER));
	if (last === null) return true;
	return opts.now - last >= (opts.intervalMs ?? NUDGE_INTERVAL_MS);
}

function isStale(age: BaselineAge, staleAfterDays: number): boolean {
	return age.ageDays === null || age.ageDays >= staleAfterDays;
}

function describe(age: BaselineAge): string {
	return age.ageDays === null ? `${age.file} — never generated` : `${age.file} — ${age.ageDays}d old`;
}

/**
 * One warning naming every stale baseline, or null when all are current.
 *
 * Absent counts as stale: a ratchet with no baseline is not "passing", it is
 * not measuring. That case is the more urgent of the two and must not read as
 * healthy merely because there is no file to age.
 */
export function formatStaleBaselineWarning(opts: BaselineStalenessOpts): string | null {
	const threshold = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
	const stale = collectBaselineAges(opts).filter((a) => isStale(a, threshold));
	if (stale.length === 0) return null;
	const lines = stale.map((a) => `    ${describe(a)}`);
	const refreshes = [...new Set(stale.map((a) => a.refresh))].map((r) => `    ${r}`);
	return [
		`[interlinked:baseline-staleness] ${stale.length} quality baseline(s) at/over ${threshold}d —`,
		"  the ratchets are comparing against an out-of-date water-line:",
		...lines,
		"  Refresh when convenient (each needs a measurement run):",
		...refreshes,
	].join("\n");
}
