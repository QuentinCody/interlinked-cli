// ===========================================
// Just-in-time commit score — rank one commit against the repo's own history
// ===========================================
// The one number an agent or a gate should read is the PERCENTILE: where this
// commit's score sits among the last `calibrate` first-parent commits of the
// same repository. The literature's advice is relative triggers over absolute
// thresholds, and a static formula's magnitude means nothing across repos.
//
// Cost: two git walks (history with numstat, hunk headers) per call — cmd-tier,
// paid once per `git commit` by the gate and on demand by `metrics jit`. Every
// git failure yields null: no ruler, no verdict, never a throw to the caller.

import { execFileSync } from "node:child_process";
import {
	DEFAULT_MAX_COMMIT_FILES,
	DEFAULT_RECENT_WINDOW_DAYS,
	deriveJitInputs,
	gatherStagedInputs,
	type HistoryCommit,
	loadHistory,
	loadHunkCounts,
} from "./jit-commit-inputs.js";
import { type JitCommitInputs, type JitGroup, percentileOf, scoreJitCommit } from "./jit-commit-score.js";

export interface RankOptions {
	/** Population size: the newest n first-parent commits (default 200). */
	calibrate?: number;
	recentDays?: number;
	maxCommitFiles?: number;
	/** Unix seconds; defaults to the wall clock. Only the staged path reads it. */
	now?: number;
}

export interface JitRank {
	target: string;
	score: number;
	/** 0–100 within the population, or null when there is no history to rank against. */
	percentile: number | null;
	population: number;
	contributions: Record<JitGroup, number>;
	inputs: JitCommitInputs;
	version: 1;
}

export const DEFAULT_CALIBRATION_COMMITS = 200;
const MS_PER_SECOND = 1000;

export interface CalibrationOptions {
	n: number;
	now: number;
	recentDays: number;
	maxCommitFiles: number;
}

/**
 * Scores of the newest `n` commits in `history`, each derived against only the
 * commits before it (deriveJitInputs filters by timestamp), so the population
 * reflects what each commit looked like when it landed.
 */
export function calibrationScores(
	history: readonly HistoryCommit[],
	hunkCounts: ReadonlyMap<string, number>,
	opts: CalibrationOptions,
): number[] {
	return history.slice(0, opts.n).map((subject) => {
		const inputs = deriveJitInputs({
			subject,
			hunks: hunkCounts.get(subject.sha) ?? 0,
			history,
			now: subject.timestamp,
			recentDays: opts.recentDays,
			maxCommitFiles: opts.maxCommitFiles,
		});
		return scoreJitCommit(inputs).score;
	});
}

function resolveOptions(opts: RankOptions): Required<RankOptions> {
	return {
		calibrate: opts.calibrate ?? DEFAULT_CALIBRATION_COMMITS,
		recentDays: opts.recentDays ?? DEFAULT_RECENT_WINDOW_DAYS,
		maxCommitFiles: opts.maxCommitFiles ?? DEFAULT_MAX_COMMIT_FILES,
		now: opts.now ?? Math.floor(Date.now() / MS_PER_SECOND),
	};
}

interface RankBuild {
	target: string;
	subject: HistoryCommit;
	hunks: number;
	history: readonly HistoryCommit[];
	hunkCounts: ReadonlyMap<string, number>;
	o: Required<RankOptions>;
}

function buildRank({ target, subject, hunks, history, hunkCounts, o }: RankBuild): JitRank {
	const calib = { n: o.calibrate, now: o.now, recentDays: o.recentDays, maxCommitFiles: o.maxCommitFiles };
	const inputs = deriveJitInputs({ subject, hunks, history, now: subject.timestamp, recentDays: o.recentDays, maxCommitFiles: o.maxCommitFiles });
	const scored = scoreJitCommit(inputs);
	const population = calibrationScores(history, hunkCounts, calib);
	return {
		target,
		score: scored.score,
		percentile: percentileOf(scored.score, population),
		population: population.length,
		contributions: scored.contributions,
		inputs,
		version: 1,
	};
}

function resolveSha(repoRoot: string, ref: string): string | null {
	try {
		return execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", `${ref}^{commit}`], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

/** Rank an existing commit. The population is the `calibrate` commits ending at `ref` (itself included). */
export function rankRefCommit(repoRoot: string, ref: string, opts: RankOptions = {}): JitRank | null {
	const o = resolveOptions(opts);
	const sha = resolveSha(repoRoot, ref);
	if (!sha) return null;
	try {
		const history = loadHistory(repoRoot, { ref: sha });
		const subject = history[0];
		if (!subject || subject.sha !== sha) return null;
		const hunkCounts = loadHunkCounts(repoRoot, sha, o.calibrate);
		return buildRank({ target: ref, subject, hunks: hunkCounts.get(sha) ?? 0, history, hunkCounts, o });
	} catch {
		return null;
	}
}

/** Rank the STAGED diff as a would-be commit with `message`; null when nothing is staged or git fails. */
export function rankStagedCommit(repoRoot: string, message: string, opts: RankOptions = {}): JitRank | null {
	const o = resolveOptions(opts);
	try {
		const gathered = gatherStagedInputs(repoRoot, message, o.now);
		if (!gathered) return null;
		const history = loadHistory(repoRoot);
		const hunkCounts = loadHunkCounts(repoRoot, "HEAD", o.calibrate);
		return buildRank({ target: "staged", subject: gathered.subject, hunks: gathered.hunks, history, hunkCounts, o });
	} catch {
		return null;
	}
}
