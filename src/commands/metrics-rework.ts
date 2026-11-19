// ===========================================
// interlinked metrics rework — churn age from git blame
// ===========================================
// Measures thrashing: the share of changed lines whose PREVIOUS version was
// itself written within the last `--window` days. High rework means recent
// code is being rewritten — going in circles — as opposed to old code being
// evolved. Spec: docs/design/history-relational-metrics.md §3 #3.
//
// Definition notes (deliberate):
//   - Only the OLD side of a change counts (a replaced/deleted line had an
//     age); brand-new lines and new files have no age and are excluded, so
//     greenfield work does not read as rework.
//   - Unknown blame ages count as NOT rework (fail toward under-counting).
//   - Bulk commits (> --max-commit-files files) are skipped, same rationale
//     as `metrics coupling`.
// On-demand command only: one `git diff` per commit plus one `git blame` per
// touched file — cmd-tier cost, never hook-tier.

import { execFileSync } from "node:child_process";
import { percentileRanks } from "../harness/percentile-rank.js";
import { getOutputMode, output } from "../lib/output.js";
import { nonNull } from "../lib/non-null.js";
import { type HistoryVerdict, historyKind, resolveVerdicts } from "../lib/metrics/history-noise.js";
import { createReworkLedger, type ReworkLedgerSummary } from "./metrics-rework-ledger.js";

export interface FileHunks {
	/** OLD path (blame runs against the parent commit). */
	file: string;
	ranges: Array<{ start: number; lines: number }>;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** `--- ` line → the FileHunks it starts (null for /dev/null), or undefined if not a header line. */
function parseFileHeaderLine(line: string): FileHunks | null | undefined {
	if (!line.startsWith("--- ")) return undefined;
	const old = line.slice(4).trim();
	return old === "/dev/null" ? null : { file: old.replace(/^a\//, ""), ranges: [] };
}

/** `@@ -start,lines +start,lines @@` line → its old-side range (null when absent or empty) and how many body lines follow. */
function parseHunkRange(line: string): { range: { start: number; lines: number } | null; oldLeft: number; newLeft: number } | null {
	const m = HUNK_RE.exec(line);
	if (!m?.[1]) return null;
	const oldLeft = m[2] === undefined ? 1 : Number(m[2]), newLeft = m[3] === undefined ? 1 : Number(m[3]);
	return { range: oldLeft > 0 ? { start: Number(m[1]), lines: oldLeft } : null, oldLeft, newLeft };
}

/**
 * Old-side ranges per file from `git diff -U0` text; new files are skipped.
 * A body line that git prints with a leading `--` (a deleted SQL comment, `-- 7. Add cohort_id`, appears as `--- 7. Add cohort_id`)
 * looks like a file header. The hunk header says how many old and new lines follow, so a `--- ` line is a header only
 * after that many body lines were read.
 */
export function parseUnifiedZeroHunks(diffText: string): FileHunks[] {
	const out: FileHunks[] = [];
	let cur: FileHunks | null = null;
	let oldLeft = 0, newLeft = 0;
	for (const line of diffText.split("\n")) {
		if (oldLeft > 0 && line.startsWith("-")) { oldLeft--; continue; }
		if (newLeft > 0 && line.startsWith("+")) { newLeft--; continue; }
		const header = parseFileHeaderLine(line);
		if (header !== undefined) {
			cur = header;
			if (cur) out.push(cur);
			continue;
		}
		if (!cur) continue;
		const hunk = parseHunkRange(line);
		if (hunk === null) continue;
		if (hunk.range) cur.ranges.push(hunk.range);
		({ oldLeft, newLeft } = hunk);
	}
	return out.filter((f) => f.ranges.length > 0);
}

const BLAME_SHA_RE = /^([0-9a-f]{40}) \d+ \d+/;
const COMMITTER_TIME_RE = /^committer-time (\d+)$/;

/** One committer-time per content line from `git blame --porcelain` output. */
export function parseBlamePorcelainTimes(blameText: string): number[] {
	const shaTimes = new Map<string, number>();
	const times: number[] = [];
	let curSha = "";
	for (const line of blameText.split("\n")) {
		const sha = BLAME_SHA_RE.exec(line);
		if (sha?.[1]) {
			curSha = sha[1];
			continue;
		}
		const ct = COMMITTER_TIME_RE.exec(line);
		if (ct?.[1]) {
			shaTimes.set(curSha, Number(ct[1]));
			continue;
		}
		if (line.startsWith("\t")) {
			const t = shaTimes.get(curSha);
			if (t !== undefined) times.push(t);
		}
	}
	return times;
}

export interface ReworkCount {
	rework: number;
	total: number;
}

/** A changed line is rework when its previous version is younger than the window. */
export function classifyRework(
	commitTs: number,
	lineTimes: number[],
	windowSecs: number,
): ReworkCount {
	let rework = 0;
	for (const t of lineTimes) {
		if (commitTs - t < windowSecs) rework++;
	}
	return { rework, total: lineTimes.length };
}

const EXCLUDE_RE = /^(dist|build|coverage|docs\/generated|\.interlinked)\//;
const DAY_SECS = 86_400;

interface MetricsReworkOpts {
	cwd?: string;
	days?: string;
	window?: string;
	maxCommits?: string;
	maxCommitFiles?: string;
	json?: boolean;
	short?: boolean;
}

interface CommitHeader {
	sha: string;
	timestamp: number;
}

function listCommits(cwd: string, days: number, max: number): CommitHeader[] {
	const text = execFileSync(
		"git",
		["log", "--no-merges", `--since=${days} days ago`, `--max-count=${max}`, "--pretty=%H\t%ct"],
		{ cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
	);
	const commits: CommitHeader[] = [];
	for (const line of text.split("\n")) {
		const [sha, ts] = line.trim().split("\t");
		if (sha && ts) commits.push({ sha, timestamp: Number(ts) });
	}
	return commits;
}

function blameTimesFor(
	cwd: string,
	sha: string,
	fh: FileHunks,
): number[] | null {
	const args = ["blame", "--porcelain"];
	for (const r of fh.ranges) args.push("-L", `${r.start},+${r.lines}`);
	args.push(`${sha}^`, "--", fh.file);
	try {
		return parseBlamePorcelainTimes(
			execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }),
		);
	} catch {
		return null; // binary, vanished path, root commit — skip, count it
	}
}

interface ReworkAccumulator {
	ledger: ReturnType<typeof createReworkLedger>;
	/** Kept (not set aside) files only; the ranked list never carries a lockfile or a bundle. */
	byFile: Map<string, ReworkCount>;
	verdicts: Map<string, HistoryVerdict>;
	skippedBulk: number;
	skippedBlame: number;
}

/** Resolve one commit's old-side hunks into rework counts, folded into `acc`. */
function processCommitForRework(
	cwd: string,
	commit: CommitHeader,
	maxCommitFiles: number,
	windowDays: number,
	acc: ReworkAccumulator,
): void {
	let diffText: string;
	try {
		diffText = execFileSync(
			"git",
			["diff", "-U0", "--no-color", `${commit.sha}^`, commit.sha],
			{ cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		);
	} catch {
		return; // root commit has no parent
	}
	const hunks = parseUnifiedZeroHunks(diffText).filter((f) => !EXCLUDE_RE.test(f.file));
	if (hunks.length > maxCommitFiles) {
		acc.skippedBulk++;
		return;
	}
	resolveVerdicts(cwd, hunks.map((fh) => ({ path: fh.file, rev: `${commit.sha}^` })), acc.verdicts);
	for (const fh of hunks) {
		const times = blameTimesFor(cwd, commit.sha, fh);
		if (times === null) {
			acc.skippedBlame++;
			continue;
		}
		const c = classifyRework(commit.timestamp, times, windowDays * DAY_SECS);
		const verdict = acc.verdicts.get(fh.file) ?? { kind: historyKind(fh.file) };
		acc.ledger.add(fh.file, verdict, c);
		if (verdict.kind === "set-aside") continue;
		const agg = acc.byFile.get(fh.file) ?? { rework: 0, total: 0 };
		agg.rework += c.rework;
		agg.total += c.total;
		acc.byFile.set(fh.file, agg);
	}
}

/** Per-file rework with its rank among every measured file in this run (0–100, within this repository). */
export interface RankedReworkCount extends ReworkCount {
	percentile: number;
}

/** Rank every file with old-side lines by its rework share; files with no rework rank too (share 0). */
export function rankReworkShares(byFile: ReadonlyMap<string, ReworkCount>): Map<string, RankedReworkCount> {
	const entries = [...byFile.entries()].filter(([, c]) => c.total > 0);
	const ranks = percentileRanks(entries.map(([, c]) => c.rework / c.total));
	return new Map(entries.map(([file, c], i) => [file, { ...c, percentile: nonNull(ranks[i]) }]));
}

interface ReworkTotals {
	commits: CommitHeader[];
	overall: ReworkCount;
	top: Array<[string, RankedReworkCount]>;
	pct: number;
	skippedBulk: number;
	skippedBlame: number;
	ledger: ReworkLedgerSummary;
}

/** Walk every commit, folding old-side blame ages into overall + per-file totals. */
function computeReworkTotals(
	cwd: string,
	commits: CommitHeader[],
	maxCommitFiles: number,
	windowDays: number,
): ReworkTotals {
	const acc: ReworkAccumulator = {
		ledger: createReworkLedger(),
		byFile: new Map(),
		verdicts: new Map(),
		skippedBulk: 0,
		skippedBlame: 0,
	};
	for (const commit of commits) {
		processCommitForRework(cwd, commit, maxCommitFiles, windowDays, acc);
	}
	const ledger = acc.ledger.summary(), overall = ledger.kept;
	const pct = overall.total === 0 ? 0 : (overall.rework / overall.total) * 100;
	const top = [...rankReworkShares(acc.byFile).entries()]
		.filter(([, c]) => c.rework > 0)
		.sort((a, b) => b[1].rework - a[1].rework)
		.slice(0, 10);
	return { commits, overall, top, pct, skippedBulk: acc.skippedBulk, skippedBlame: acc.skippedBlame, ledger };
}

/** A count with its share in percent, one decimal; 0 when there are no lines. */
function withPct(count: ReworkCount): ReworkCount & { pct: number } {
	return { ...count, pct: count.total === 0 ? 0 : Math.round((count.rework / count.total) * 1000) / 10 };
}

/** The sentence that names what was set aside, or nothing when no file was. */
function renderSetAside(ledger: ReworkLedgerSummary): string[] {
	const aside = ledger.setAside;
	if (aside.files === 0) return [];
	const reasons = aside.byReason.map((row) => `${row.reason} ${row.files}`).join(", ");
	return [`Set aside ${aside.files} files (${aside.total} of ${ledger.withSetAside.total} changed lines): ${reasons}`];
}

/** Build the `output()` handler map for a computed rework result. */
function buildReworkOutputHandlers(
	totals: ReworkTotals,
	days: number,
	windowDays: number,
) {
	const { commits, overall, top, pct, skippedBulk, skippedBlame, ledger } = totals;
	return {
		json: () => ({
			days,
			window_days: windowDays,
			commits_scanned: commits.length,
			skipped_bulk_commits: skippedBulk,
			skipped_blame_files: skippedBlame,
			overall: withPct(overall),
			by_kind: { code: withPct(ledger.byKind.code), data: withPct(ledger.byKind.data) },
			set_aside: { files: ledger.setAside.files, ...withPct(ledger.setAside), by_reason: ledger.setAside.byReason, top: ledger.setAside.top },
			with_set_aside: withPct(ledger.withSetAside),
			top_files: top.map(([file, c]) => ({ file, ...c })),
		}),
		short: () => `rework ${pct.toFixed(1)}% of ${overall.total} changed lines (${days}d, window ${windowDays}d)`,
		normal: () => {
			const lines = [
				`Rework — ${pct.toFixed(1)}% of ${overall.total} changed old-side lines were <${windowDays}d old`,
				`(${commits.length} commits over ${days}d; ${skippedBulk} bulk commits + ${skippedBlame} unblameable files skipped)`,
				...renderSetAside(ledger),
				"",
			];
			for (const [file, c] of top) {
				const p = c.total === 0 ? 0 : (c.rework / c.total) * 100;
				lines.push(
					`  ${String(c.rework).padStart(5)} rework lines (${p.toFixed(0).padStart(3)}%) ${`p${c.percentile}`.padStart(4)}  ${file}`,
				);
			}
			return lines.join("\n");
		},
	};
}

function positiveOption(raw: string | undefined, fallback: number, valid = Number.isFinite): number {
	const value = Number(raw);
	return value > 0 && valid(value) ? value : fallback;
}

/** Public API — wired by `interlinked metrics rework` in registrars/metrics.ts. */
export async function metricsReworkCommand(opts: MetricsReworkOpts): Promise<void> {
	const cwd = opts.cwd || process.cwd();
	const days = positiveOption(opts.days, 30);
	const windowDays = positiveOption(opts.window, 14);
	const maxCommits = positiveOption(opts.maxCommits, 100, Number.isSafeInteger);
	const maxCommitFiles = positiveOption(opts.maxCommitFiles, 30, Number.isSafeInteger);
	const mode = getOutputMode(opts);

	let commits: CommitHeader[];
	try {
		commits = listCommits(cwd, days, maxCommits);
	} catch (err) {
		process.stderr.write(
			`git log failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n`,
		);
		process.exitCode = 1;
		return;
	}

	const totals = computeReworkTotals(cwd, commits, maxCommitFiles, windowDays);
	output(mode, { overall: totals.overall, byFile: totals.top }, buildReworkOutputHandlers(totals, days, windowDays));
}
