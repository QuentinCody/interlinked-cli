// ===========================================
// Just-in-time commit score — input gathering from git
// ===========================================
// Turns git history into the `JitCommitInputs` record that
// `jit-commit-score.ts` scores. Two layers, kept apart on purpose:
//
//   PURE   parseNumstatLog / countHunks / extractCommitMessage / deriveJitInputs
//          — text in, record out; every branch is unit-testable.
//   SHELL  loadHistory / loadHunkCounts / gatherStagedInputs — the git calls.
//          cmd-tier cost (one history walk ≈ 1s on a 2000-commit window);
//          the commit gate pays it once per real `git commit`, never per edit.
//
// History semantics: first-parent only, the long window (default 365d) capped
// at 2000 commits, bulk commits over `maxCommitFiles` files excluded from file
// priors (same rationale as `metrics coupling`). Priors are measured BEFORE
// the subject commit — only commits with a timestamp at or before the subject's
// count (same-second neighbours from a rebase are treated as prior; the subject
// itself is excluded by sha) — so a historical commit scored for calibration
// sees the history it had then, and a staged diff sees all of HEAD's.

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { churnEntropy, classifyCommitPurpose, type JitCommitInputs } from "./jit-commit-score.js";

export interface FileChurn {
	file: string;
	added: number;
	deleted: number;
}

export interface HistoryCommit {
	sha: string;
	author: string;
	/** Unix seconds. */
	timestamp: number;
	subject: string;
	files: FileChurn[];
}

export interface DeriveOptions {
	/** The commit being scored (its `files` are the diff under judgement). */
	subject: HistoryCommit;
	hunks: number;
	history: readonly HistoryCommit[];
	/** Unix seconds; the recent-window anchor. */
	now: number;
	recentDays: number;
	/** Commits touching more files than this contribute no file priors. */
	maxCommitFiles: number;
}

const DAY_SECONDS = 86_400;
export const DEFAULT_LONG_WINDOW_DAYS = 365;
export const DEFAULT_RECENT_WINDOW_DAYS = 90;
export const DEFAULT_MAX_COMMIT_FILES = 30;
const HISTORY_COMMIT_CAP = 2000;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const HEADER_PREFIX = "COMMIT\t";

// ---------- pure ----------

/** Parse `git log --format='COMMIT%x09%H%x09%an%x09%ct%x09%s' --numstat` output. */
export function parseNumstatLog(text: string): HistoryCommit[] {
	const commits: HistoryCommit[] = [];
	let cur: HistoryCommit | null = null;
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith(HEADER_PREFIX)) {
			const [, sha, author, ts, ...rest] = line.split("\t");
			cur = { sha: sha ?? "", author: author ?? "", timestamp: Number(ts), subject: rest.join("\t"), files: [] };
			commits.push(cur);
			continue;
		}
		if (!cur || line.trim() === "") continue;
		const [added, deleted, ...pathParts] = line.split("\t");
		const file = pathParts.join("\t");
		if (file === "") continue;
		// Binary rows print `-\t-\tpath`; they carry no line churn.
		cur.files.push({ file, added: Number(added) || 0, deleted: Number(deleted) || 0 });
	}
	return commits;
}

/** Count unified-diff hunk headers. */
export function countHunks(diffText: string): number {
	let n = 0;
	for (const line of diffText.split(/\r?\n/)) if (line.startsWith("@@")) n++;
	return n;
}

const MESSAGE_FLAG_RE = /(?:^|\s)(?:-[a-zA-Z]*m|--message)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g;

/** The `-m` / `--message` text of a `git commit` command; several `-m` join as paragraphs. */
export function extractCommitMessage(command: string): string {
	const parts: string[] = [];
	for (const m of command.matchAll(MESSAGE_FLAG_RE)) {
		const text = m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3] ?? "");
		parts.push(text);
	}
	return parts.join("\n\n");
}

function topLevelDir(file: string): string {
	const i = file.indexOf("/");
	return i === -1 ? "." : file.slice(0, i);
}

interface FilePriors {
	priorChanges: number;
	priorAuthors: number;
	priorFixes: number;
}

function filePriors(subject: HistoryCommit, history: readonly HistoryCommit[], maxCommitFiles: number): FilePriors {
	const touched = new Set(subject.files.map((f) => f.file));
	const authors = new Set<string>();
	let priorChanges = 0;
	let priorFixes = 0;
	for (const c of history) {
		if (c.sha === subject.sha || c.timestamp > subject.timestamp || c.files.length > maxCommitFiles) continue;
		const hits = c.files.filter((f) => touched.has(f.file)).length;
		if (hits === 0) continue;
		priorChanges += hits;
		authors.add(c.author);
		if (classifyCommitPurpose(c.subject).isFix) priorFixes += hits;
	}
	return { priorChanges, priorAuthors: authors.size, priorFixes };
}

function authorExperience(
	subject: HistoryCommit,
	history: readonly HistoryCommit[],
	recentCutoff: number,
): { long: number; recent: number } {
	let long = 0;
	let recent = 0;
	for (const c of history) {
		if (c.sha === subject.sha || c.timestamp > subject.timestamp || c.author !== subject.author) continue;
		long++;
		if (c.timestamp >= recentCutoff) recent++;
	}
	return { long, recent };
}

/** Combine a subject commit, its hunk count and the prior history into the scorer's record. */
export function deriveJitInputs(o: DeriveOptions): JitCommitInputs {
	const files = o.subject.files;
	const priors = filePriors(o.subject, o.history, o.maxCommitFiles);
	const exp = authorExperience(o.subject, o.history, o.now - o.recentDays * DAY_SECONDS);
	return {
		linesAdded: files.reduce((a, f) => a + f.added, 0),
		linesDeleted: files.reduce((a, f) => a + f.deleted, 0),
		filesTouched: new Set(files.map((f) => f.file)).size,
		hunks: o.hunks,
		subsystems: new Set(files.map((f) => topLevelDir(f.file))).size,
		directories: new Set(files.map((f) => dirname(f.file))).size,
		changeEntropy: churnEntropy(files.map((f) => f.added + f.deleted)),
		priorChanges: priors.priorChanges,
		priorAuthors: priors.priorAuthors,
		priorFixes: priors.priorFixes,
		authorCommitsLong: exp.long,
		authorCommitsRecent: exp.recent,
		purpose: classifyCommitPurpose(o.subject.subject),
	};
}

// ---------- shell ----------

function git(repoRoot: string, args: string[]): string {
	return execFileSync("git", ["-C", repoRoot, ...args], {
		encoding: "utf-8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: GIT_MAX_BUFFER,
		stdio: ["ignore", "pipe", "ignore"],
	});
}

/** `git` output, or null when the call fails (missing config key, no git). Callers treat null as "unknown". */
function gitOrNull(repoRoot: string, args: string[]): string | null {
	try {
		return git(repoRoot, args);
	} catch {
		return null;
	}
}

const LOG_FORMAT = "--format=COMMIT%x09%H%x09%an%x09%ct%x09%s";

/**
 * First-parent history from `ref` back over the long window (capped). The
 * returned list carries per-file churn, so it serves both as the priors
 * source and as the subject list for calibration.
 */
export function loadHistory(
	repoRoot: string,
	opts: { ref?: string; longWindowDays?: number; cap?: number } = {},
): HistoryCommit[] {
	const ref = opts.ref ?? "HEAD";
	const days = opts.longWindowDays ?? DEFAULT_LONG_WINDOW_DAYS;
	const cap = opts.cap ?? HISTORY_COMMIT_CAP;
	const text = git(repoRoot, ["log", "--first-parent", `--since=${days}.days`, "-n", String(cap), LOG_FORMAT, "--numstat", ref]);
	return parseNumstatLog(text);
}

/** Hunk counts for the last `n` first-parent commits from `ref`, keyed by sha. */
export function loadHunkCounts(repoRoot: string, ref: string, n: number): Map<string, number> {
	const text = git(repoRoot, ["log", "--first-parent", "-n", String(n), "--format=COMMIT%x09%H", "-U0", "-p", ref]);
	const counts = new Map<string, number>();
	let sha: string | null = null;
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith(HEADER_PREFIX)) {
			sha = line.slice(HEADER_PREFIX.length).trim();
			counts.set(sha, 0);
		} else if (sha && line.startsWith("@@")) counts.set(sha, (counts.get(sha) ?? 0) + 1);
	}
	return counts;
}

export interface GatheredCommit {
	subject: HistoryCommit;
	hunks: number;
}

/** The STAGED diff as a would-be commit by the configured git user, with the given message. */
export function gatherStagedInputs(repoRoot: string, message: string, now: number): GatheredCommit | null {
	const numstat = git(repoRoot, ["diff", "--cached", "--numstat"]);
	const files = parseNumstatLog(`${HEADER_PREFIX}staged\t\t${now}\t\n${numstat}`)[0]?.files ?? [];
	if (files.length === 0) return null;
	const hunks = countHunks(git(repoRoot, ["diff", "--cached", "-U0"]));
	// An unset user.name reads as an unknown author: experience 0, as the literature prescribes.
	const author = gitOrNull(repoRoot, ["config", "user.name"])?.trim() ?? "";
	return { subject: { sha: "staged", author, timestamp: now, subject: message, files }, hunks };
}
