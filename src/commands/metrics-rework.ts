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
import { getOutputMode, output } from "../lib/output.js";

export interface FileHunks {
	/** OLD path (blame runs against the parent commit). */
	file: string;
	ranges: Array<{ start: number; lines: number }>;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;

/** Old-side ranges per file from `git diff -U0` text; new files are skipped. */
export function parseUnifiedZeroHunks(diffText: string): FileHunks[] {
	const out: FileHunks[] = [];
	let cur: FileHunks | null = null;
	for (const line of diffText.split("\n")) {
		if (line.startsWith("--- ")) {
			const old = line.slice(4).trim();
			cur = old === "/dev/null" ? null : { file: old.replace(/^a\//, ""), ranges: [] };
			if (cur) out.push(cur);
			continue;
		}
		if (!cur) continue;
		const m = HUNK_RE.exec(line);
		if (!m?.[1]) continue;
		const lines = m[2] === undefined ? 1 : Number(m[2]);
		if (lines > 0) cur.ranges.push({ start: Number(m[1]), lines });
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
	overall: ReworkCount;
	byFile: Map<string, ReworkCount>;
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
	for (const fh of hunks) {
		const times = blameTimesFor(cwd, commit.sha, fh);
		if (times === null) {
			acc.skippedBlame++;
			continue;
		}
		const c = classifyRework(commit.timestamp, times, windowDays * DAY_SECS);
		acc.overall.rework += c.rework;
		acc.overall.total += c.total;
		const agg = acc.byFile.get(fh.file) ?? { rework: 0, total: 0 };
		agg.rework += c.rework;
		agg.total += c.total;
		acc.byFile.set(fh.file, agg);
	}
}

interface ReworkTotals {
	commits: CommitHeader[];
	overall: ReworkCount;
	top: Array<[string, ReworkCount]>;
	pct: number;
	skippedBulk: number;
	skippedBlame: number;
}

/** Walk every commit, folding old-side blame ages into overall + per-file totals. */
function computeReworkTotals(
	cwd: string,
	commits: CommitHeader[],
	maxCommitFiles: number,
	windowDays: number,
): ReworkTotals {
	const acc: ReworkAccumulator = {
		overall: { rework: 0, total: 0 },
		byFile: new Map(),
		skippedBulk: 0,
		skippedBlame: 0,
	};
	for (const commit of commits) {
		processCommitForRework(cwd, commit, maxCommitFiles, windowDays, acc);
	}
	const pct = acc.overall.total === 0 ? 0 : (acc.overall.rework / acc.overall.total) * 100;
	const top = [...acc.byFile.entries()]
		.filter(([, c]) => c.rework > 0)
		.sort((a, b) => b[1].rework - a[1].rework)
		.slice(0, 10);
	return { commits, overall: acc.overall, top, pct, skippedBulk: acc.skippedBulk, skippedBlame: acc.skippedBlame };
}

/** Build the `output()` handler map for a computed rework result. */
function buildReworkOutputHandlers(
	totals: ReworkTotals,
	days: number,
	windowDays: number,
) {
	const { commits, overall, top, pct, skippedBulk, skippedBlame } = totals;
	return {
		json: () => ({
			days,
			window_days: windowDays,
			commits_scanned: commits.length,
			skipped_bulk_commits: skippedBulk,
			skipped_blame_files: skippedBlame,
			overall: { ...overall, pct: Math.round(pct * 10) / 10 },
			top_files: top.map(([file, c]) => ({ file, ...c })),
		}),
		short: () => `rework ${pct.toFixed(1)}% of ${overall.total} changed lines (${days}d, window ${windowDays}d)`,
		normal: () => {
			const lines = [
				`Rework — ${pct.toFixed(1)}% of ${overall.total} changed old-side lines were <${windowDays}d old`,
				`(${commits.length} commits over ${days}d; ${skippedBulk} bulk commits + ${skippedBlame} unblameable files skipped)`,
				"",
			];
			for (const [file, c] of top) {
				const p = c.total === 0 ? 0 : (c.rework / c.total) * 100;
				lines.push(`  ${String(c.rework).padStart(5)} rework lines (${p.toFixed(0).padStart(3)}%)  ${file}`);
			}
			return lines.join("\n");
		},
	};
}

/** Public API — wired by `interlinked metrics rework` in registrars/quality.ts. */
export async function metricsReworkCommand(opts: MetricsReworkOpts): Promise<void> {
	const cwd = opts.cwd || process.cwd();
	const days = Number(opts.days ?? "") || 30;
	const windowDays = Number(opts.window ?? "") || 14;
	const maxCommits = Number(opts.maxCommits ?? "") || 100;
	const maxCommitFiles = Number(opts.maxCommitFiles ?? "") || 30;
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
