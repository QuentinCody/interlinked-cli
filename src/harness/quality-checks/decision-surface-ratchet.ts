// ===========================================
// Decision Surface Ratchet — growth-since-baseline detector
// ===========================================
// Reports which decision-surface categories grew since the git merge-base
// with origin/main (or fallback refs). Surfaces a per-category list of
// added tools so the agent — and the user — can see exactly what
// introduced new "library A vs library B" forks on the current branch.
//
// Silent on shrinkage (removing a tool is a good thing, no need to
// celebrate it). Silent when not in a git repo or when no baseline ref
// can be resolved (graceful degradation, not failure).
//
// See `docs/design/decision-surface-metric.md` §2 for the full rationale
// (per-PR vs per-edit semantics, why merge-base, baseline storage).

import { execFileSync } from "node:child_process";
import {
	type DecisionSurfaceReport,
	type DetectDecisionSurfaceOptions,
	detectDecisionSurface,
} from "./decision-surface.js";
import {
	DECISION_SURFACE_CATEGORIES,
	type DecisionSurfaceCategory,
} from "./decision-surface-map.js";

export interface DecisionSurfaceRatchetResult {
	/** Git ref used as baseline (e.g. "origin/main"). Null when skipped. */
	baselineRef: string | null;
	/** Reason the ratchet skipped, or null when it ran. */
	skipped: "not-a-repo" | "no-baseline-ref" | "git-error" | null;
	/** Per-category names added since baseline. Empty arrays for any
	 *  category where nothing was added (including shrinkage). */
	growthByCategory: Record<DecisionSurfaceCategory, string[]>;
	/** Sum of distinct new entries across all categories. */
	totalGrowth: number;
	/** Human-readable warning lines, one per category that grew. Empty
	 *  array when nothing grew or the ratchet skipped. */
	warnings: string[];
}

/** Refs tried in order when resolving the baseline. The first one that
 *  exists and has a merge-base with HEAD is used. */
const CANDIDATE_BASE_REFS: readonly string[] = [
	"origin/main",
	"origin/master",
	"main",
	"master",
];

interface ComputeDecisionSurfaceRatchetOptions {
	/** Git commandrunner — for tests. Throws on non-zero exit. */
	runGit?: (args: readonly string[], cwd: string) => string;
}

/**
 * Public API — orchestrate the full ratchet: resolve baseline ref →
 * read decision surface at that ref → diff against current → build
 * warnings.
 */
export function computeDecisionSurfaceRatchet(
	cwd: string,
	options: ComputeDecisionSurfaceRatchetOptions = {},
): DecisionSurfaceRatchetResult {
	const runGit = options.runGit ?? defaultRunGit;

	if (!isGitRepo(cwd, runGit)) {
		return skippedResult("not-a-repo");
	}

	const baselineRef = resolveBaselineRef(cwd, runGit);
	if (baselineRef === null) {
		return skippedResult("no-baseline-ref");
	}

	let baseline: DecisionSurfaceReport;
	try {
		baseline = detectDecisionSurface(cwd, makeGitBackedOptions(cwd, baselineRef, runGit));
	} catch {
		return skippedResult("git-error");
	}

	const current = detectDecisionSurface(cwd);
	return diffDecisionSurface(baseline, current, baselineRef);
}

/**
 * Public API — pure diff over two DecisionSurfaceReports. Exposed so
 * tests can verify diff semantics without involving git.
 */
export function diffDecisionSurface(
	baseline: DecisionSurfaceReport,
	current: DecisionSurfaceReport,
	baselineRef: string,
): DecisionSurfaceRatchetResult {
	const growthByCategory = computeGrowth(baseline, current);
	const totalGrowth = Object.values(growthByCategory).reduce(
		(sum, arr) => sum + arr.length,
		0,
	);
	const warnings = buildWarnings(baselineRef, growthByCategory);
	return {
		baselineRef,
		skipped: null,
		growthByCategory,
		totalGrowth,
		warnings,
	};
}

// ===========================================
// Internals
// ===========================================

function defaultRunGit(args: readonly string[], cwd: string): string {
	return execFileSync("git", [...args], {
		cwd,
		encoding: "utf-8",
		timeout: 10_000,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function isGitRepo(
	cwd: string,
	runGit: (args: readonly string[], cwd: string) => string,
): boolean {
	try {
		runGit(["rev-parse", "--git-dir"], cwd);
		return true;
	} catch {
		return false;
	}
}

function resolveBaselineRef(
	cwd: string,
	runGit: (args: readonly string[], cwd: string) => string,
): string | null {
	for (const ref of CANDIDATE_BASE_REFS) {
		try {
			runGit(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
			const mergeBase = runGit(["merge-base", "HEAD", ref], cwd).trim();
			if (mergeBase) return ref;
		} catch {
			/* best-effort: ref doesn't exist here, try the next candidate base */
		}
	}
	return null;
}

function makeGitBackedOptions(
	cwd: string,
	ref: string,
	runGit: (args: readonly string[], cwd: string) => string,
): DetectDecisionSurfaceOptions {
	const toRelative = (path: string): string => {
		if (path === cwd) return "";
		if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
		return path; // unlikely fallback
	};

	const readFile = (path: string): string | null => {
		const rel = toRelative(path);
		if (rel === "") return null;
		try {
			return runGit(["show", `${ref}:${rel}`], cwd);
		} catch {
			return null;
		}
	};

	const exists = (path: string): boolean => {
		const rel = toRelative(path);
		if (rel === "") return false;
		try {
			runGit(["cat-file", "-e", `${ref}:${rel}`], cwd);
			return true;
		} catch {
			return false;
		}
	};

	const readdir = (path: string): string[] => {
		const rel = toRelative(path);
		const target = rel === "" ? ref : `${ref}:${rel}`;
		try {
			const out = runGit(["ls-tree", "--name-only", target], cwd);
			return out.split("\n").filter(Boolean);
		} catch {
			return [];
		}
	};

	return { readFile, exists, readdir };
}

function computeGrowth(
	baseline: DecisionSurfaceReport,
	current: DecisionSurfaceReport,
): Record<DecisionSurfaceCategory, string[]> {
	const result = Object.fromEntries(
		DECISION_SURFACE_CATEGORIES.map((c) => [c, [] as string[]]),
	) as Record<DecisionSurfaceCategory, string[]>;

	for (const cat of DECISION_SURFACE_CATEGORIES) {
		const before = new Set(baseline.byCategory[cat]);
		for (const name of current.byCategory[cat]) {
			if (!before.has(name)) result[cat].push(name);
		}
	}
	return result;
}

function buildWarnings(
	baselineRef: string,
	growth: Record<DecisionSurfaceCategory, string[]>,
): string[] {
	const lines: string[] = [];
	for (const cat of DECISION_SURFACE_CATEGORIES) {
		const added = growth[cat];
		if (added.length === 0) continue;
		lines.push(
			`[heuristic] decision_surface_growth — ${cat} expanded since ${baselineRef}: added ${added.join(", ")}. If intentional (migration), suppress; otherwise the codebase now requires the agent to pick between additional alternatives on every related edit.`,
		);
	}
	return lines;
}

function skippedResult(
	skipped: "not-a-repo" | "no-baseline-ref" | "git-error",
): DecisionSurfaceRatchetResult {
	const empty = Object.fromEntries(
		DECISION_SURFACE_CATEGORIES.map((c) => [c, [] as string[]]),
	) as Record<DecisionSurfaceCategory, string[]>;
	return {
		baselineRef: null,
		skipped,
		growthByCategory: empty,
		totalGrowth: 0,
		warnings: [],
	};
}
