// ===========================================
// interlinked metrics stale-readme — READMEs the code has moved past
// ===========================================
// For every tracked README.md: how many commits touched its directory since
// the README itself last changed (the README excluded from the count)? A high
// number says the README describes a directory that no longer exists in that
// form — the agent must reread it before editing there, and a human should
// refresh it. Adapted from valknut's doc-audit `detect_stale_readmes`
// (intake docs/external-pulse/valknut.md §7 spike 1); the threshold there is
// uncalibrated, ours is measured against this tree (see the test header).
//
// Telemetry only: the command never blocks and never sets an exit code on a
// stale README. A README "fixed" by a content-free touch earns nothing that
// `spec-drift` does not take back. Two git calls per README — command-tier
// cost, never on the hook path.

import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { getOutputMode, output } from "../lib/output.js";

/** Calibrated on this tree 2026-09-21 (18 READMEs: 116, 59, 32, 16, 7, 3, 3, 1, 1, 0×9): sits in the 7→16 gap. */
export const DEFAULT_STALE_README_THRESHOLD = 10;

/** One README's raw count. `since_sha` is null when git has no commit for it yet. */
export interface ReadmeCount {
	/** Repo-relative POSIX path of the README. */
	readme: string;
	/** Its directory; `.` for a root README. */
	dir: string;
	since_sha: string | null;
	/** Commits that touched `dir` after `since_sha`, excluding `readme` itself. */
	commits_since: number;
}

export interface ReadmeStaleness extends ReadmeCount {
	stale: boolean;
}

interface StaleReadmeReport {
	threshold: number;
	tracked: number;
	stale: number;
	readmes: ReadmeStaleness[];
}

/** Directory segments whose READMEs nobody keeps current on purpose. */
const SKIPPED_SEGMENTS = new Set(["fixtures", "__fixtures__", "__tests__", "node_modules"]);

/** A tracked `README.md` outside fixture / test-fixture / dependency trees. */
export function isAuditableReadme(rel: string): boolean {
	if (basename(rel) !== "README.md") return false;
	return !rel.split("/").slice(0, -1).some((seg) => SKIPPED_SEGMENTS.has(seg));
}

/** Stale = committed AND strictly over the threshold. Sorted by count desc, then path. */
export function classifyReadmes(rows: readonly ReadmeCount[], threshold: number): ReadmeStaleness[] {
	return rows
		.map((r) => ({ ...r, stale: r.since_sha !== null && r.commits_since > threshold }))
		.sort((a, b) => b.commits_since - a.commits_since || a.readme.localeCompare(b.readme));
}

function gitOut(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function listReadmes(cwd: string): string[] {
	const raw = gitOut(cwd, ["ls-files", "-z", "--", "README.md", ":(glob)**/README.md"]);
	return raw.split("\0").filter((p) => p !== "" && isAuditableReadme(p)).sort();
}

function countReadme(cwd: string, readme: string): ReadmeCount {
	const dir = dirname(readme);
	const sha = gitOut(cwd, ["log", "-1", "--format=%H", "--", readme]);
	if (sha === "") return { readme, dir, since_sha: null, commits_since: 0 };
	const count = gitOut(cwd, ["rev-list", "--count", `${sha}..HEAD`, "--", dir, `:(exclude)${readme}`]);
	return { readme, dir, since_sha: sha, commits_since: Number(count) || 0 };
}

function renderReport(report: StaleReadmeReport): string {
	const lines = [
		`Stale READMEs — ${report.tracked} tracked, ${report.stale} over ${report.threshold} commits`,
		"",
	];
	for (const r of report.readmes) {
		lines.push(`  ${String(r.commits_since).padStart(5)}  ${r.stale ? "STALE" : "     "}  ${r.readme}`);
	}
	lines.push(
		"",
		"count = commits that touched the README's directory since the README last changed (README excluded).",
		"Telemetry only — nothing blocks on it. Reread a STALE README before editing its directory; refresh it after.",
	);
	return lines.join("\n");
}

/** Absent or blank → the calibrated default; `Number("")` is 0, which silently marked everything stale (found live 2026-09-21). */
function parseThreshold(raw: string | undefined): number {
	const text = (raw ?? "").trim();
	if (text === "") return DEFAULT_STALE_README_THRESHOLD;
	const n = Number(text);
	return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : DEFAULT_STALE_README_THRESHOLD;
}

interface MetricsStaleReadmeOpts {
	cwd?: string;
	threshold?: string;
	json?: boolean;
	short?: boolean;
}

/** Public API — wired by `interlinked metrics stale-readme` in registrars/metrics.ts. */
export async function metricsStaleReadmeCommand(opts: MetricsStaleReadmeOpts): Promise<void> {
	const cwd = opts.cwd || process.cwd();
	const threshold = parseThreshold(opts.threshold);
	let readmes: string[];
	try {
		readmes = listReadmes(cwd);
	} catch (err) {
		process.stderr.write(`git ls-files failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n`);
		process.exitCode = 1;
		return;
	}
	const rows = classifyReadmes(
		readmes.map((r) => countReadme(cwd, r)),
		threshold,
	);
	const report: StaleReadmeReport = {
		threshold,
		tracked: rows.length,
		stale: rows.filter((r) => r.stale).length,
		readmes: rows,
	};
	output(getOutputMode(opts), report, {
		json: () => report,
		short: () => `${report.stale}/${report.tracked} READMEs over ${threshold} commits since their last change`,
		normal: () => renderReport(report),
	});
}
