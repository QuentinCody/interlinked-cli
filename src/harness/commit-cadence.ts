// ===========================================
// Commit Cadence — Stop-time + mid-session-backstop nudge
// ===========================================
//
// Encourages agents to bundle uncommitted code-file edits into commits
// (one commit per concern) before ending a session, while explicitly
// telling them not to push. Two triggers:
//
// 1. Stop / SessionEnd — primary nudge. Fires when the count of distinct
//    non-doc files edited since the last commit exceeds `stop_threshold`.
//    Message strength escalates if cumulative session tokens are known
//    and cross the configured low/high bands.
//
// 2. Mid-session backstop — one-shot per session. Fires when the same
//    count crosses `mid_session_threshold` (default 40), which is a high
//    water mark — no agent should reach it under normal cadence.
//
// Doc/plan files are excluded from the count (markdown, /docs, /plans,
// /notes, CLAUDE.md, AGENTS.md, PLAN*.md). Editing transient planning
// scratch shouldn't trigger a commit nudge.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { nonNull } from "../lib/non-null.js";

/** Default doc-file globs. Editable via `commit_cadence.doc_globs` config.
 *  These are paths/patterns whose edits do NOT count toward "uncommitted
 *  code-file work" — they're transient agent-scratch (plans, notes, docs)
 *  that legitimately churn during a session without needing commits. */
export const DEFAULT_DOC_GLOBS: readonly string[] = [
	"**/*.md",
	"**/*.mdx",
	"**/*.txt",
	"**/*.rst",
	"docs/**",
	"plans/**",
	"notes/**",
	"**/CLAUDE.md",
	"**/AGENTS.md",
	"**/PLAN*.md",
];

/**
 * Public API — pure predicate. Returns true iff the path should be
 * excluded from the "uncommitted code-file edits" count.
 *
 * Intentionally simple: a glob is matched against either the full path
 * or the basename. The recursive star, the single-segment star, and
 * the `?` wildcard are supported via a tiny custom matcher rather
 * than pulling in `minimatch` — this runs on every PostToolUse so
 * the hot-path matters more than feature completeness.
 */
export function isDocFile(filePath: string, docGlobs?: readonly string[]): boolean {
	const globs = docGlobs ?? DEFAULT_DOC_GLOBS;
	const normalized = filePath.replace(/\\/g, "/");
	const base = basename(normalized);
	for (const glob of globs) {
		if (matchesGlob(normalized, glob)) return true;
		if (matchesGlob(base, glob)) return true;
	}
	return false;
}

// Glob match: `**` is a recursive-segment wildcard, `*` matches non-slash
// chars, `?` matches a single non-slash char. Anchored by default, but
// relative-style globs like `plans/**` also try a recursive-prefix variant
// so absolute paths (e.g., `/repo/plans/q3.yaml`) still match.
function matchesGlob(target: string, glob: string): boolean {
	if (compileGlob(glob).test(target)) return true;
	if (!glob.startsWith("**") && !glob.startsWith("/")) {
		if (compileGlob(`**/${glob}`).test(target)) return true;
	}
	return false;
}

const globCache = new Map<string, RegExp>();
function compileGlob(glob: string): RegExp {
	const cached = globCache.get(glob);
	if (cached) return cached;
	let re = "^";
	for (let i = 0; i < glob.length; i++) {
		const c = nonNull(glob[i]);
		if (c === "*" && glob[i + 1] === "*") {
			re += ".*";
			i++;
			// consume optional trailing slash so `docs/**` matches `docs/x/y`
			if (glob[i + 1] === "/") i++;
		} else if (c === "*") {
			re += "[^/]*";
		} else if (c === "?") {
			re += "[^/]";
		} else if (c === ".") {
			re += "\\.";
		} else if (/[\\^$+()|{}[\]]/.test(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	re += "$";
	const compiled = new RegExp(re);
	globCache.set(glob, compiled);
	return compiled;
}

interface SessionTokens {
	input: number;
output: number;
	total: number;
}

/**
 * Public API — read cumulative token usage for a session by parsing the
 * Claude Code transcript JSONL. Returns null when the source is not Claude,
 * the path is missing/unreadable, or the transcript contains no usage rows.
 * Tolerates malformed lines.
 *
 * The source gate is deliberately before any filesystem call: Codex also
 * supplies a transcript path, but its rollout uses an ordinal/payload schema
 * this parser cannot consume and can be hundreds of megabytes. Reading that
 * file only to return null caused large Stop-time RSS spikes.
 */
export function readSessionTokens(
	transcriptPath: string | undefined,
	agentSource = "claude",
): SessionTokens | null {
	if (agentSource !== "claude") return null;
	if (!transcriptPath) return null;
	if (!existsSync(transcriptPath)) return null;
	let raw: string;
	try {
		raw = readFileSync(transcriptPath, "utf-8");
	} catch {
		return null;
	}
	let input = 0;
	let output = 0;
	let saw = false;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		const usage = extractUsage(obj);
		if (!usage) continue;
		input += usage.input_tokens;
		output += usage.output_tokens;
		saw = true;
	}
	if (!saw) return null;
	return { input, output, total: input + output };
}

interface RawUsage {
	input_tokens: number;
	output_tokens: number;
}

function extractUsage(obj: unknown): RawUsage | null {
	if (!obj || typeof obj !== "object") return null;
	const o = obj as Record<string, unknown>;
	if (o.type !== "assistant") return null;
	const message = o.message as Record<string, unknown> | undefined;
	const usage = (message?.usage ?? o.usage) as Record<string, unknown> | undefined;
	if (!usage) return null;
	const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
	const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
	if (input === 0 && output === 0) return null;
	return { input_tokens: input, output_tokens: output };
}

interface FormatStopNudgeOpts {
	uncommittedNonDocCount: number;
	docFilesExcluded: number;
	threshold: number;
	cumulativeTokens?: number;
	tokenBandLow: number;
	tokenBandHigh: number;
}

/**
 * Public API — build the Stop-hook nudge string, or null when the count
 * is at or below the threshold. Strength scales by token band when
 * `cumulativeTokens` is provided.
 *
 * Wording is deliberately advisory ("strongly recommend", "before
 * ending") rather than imperative — this is a stderr nudge the agent
 * may choose to act on, not a `decision: "block"`. Hard-blocking at
 * Stop is the lever held in reserve.
 */
export function formatStopNudge(opts: FormatStopNudgeOpts): string | null {
	if (opts.uncommittedNonDocCount <= opts.threshold) return null;

	const docNote =
		opts.docFilesExcluded > 0
			? ` (${opts.docFilesExcluded} doc/plan file${opts.docFilesExcluded === 1 ? "" : "s"} excluded)`
			: "";

	const tokens = opts.cumulativeTokens;
	if (tokens !== undefined && tokens > opts.tokenBandHigh) {
		const tk = formatTokenK(tokens);
		return (
			`[interlinked:commit-cadence] Stopping with ${opts.uncommittedNonDocCount} uncommitted code-file edit(s)${docNote}, ` +
			`very long session (~${tk} tokens). Your context window is degrading, so this work is ` +
			"best captured soon. Committing is the USER's call — surface it to them with a " +
			"suggested bundling (`git status` to review, then group by concern) rather than " +
			"running `git commit` to clear this notice. Don't push."
		);
	}
	if (tokens !== undefined && tokens > opts.tokenBandLow) {
		const tk = formatTokenK(tokens);
		return (
			`[interlinked:commit-cadence] Stopping with ${opts.uncommittedNonDocCount} uncommitted code-file edit(s)${docNote}, ` +
			`long session (~${tk} tokens). Worth surfacing to the user as a good point to commit ` +
			"while context is fresh — their call, not an action to take unprompted. " +
			"Bundle by concern: `git status` to review, then `git add <files> && git commit -m '<concern>'`. " +
			"Don't push."
		);
	}
	return (
		`[interlinked:commit-cadence] Stopping with ${opts.uncommittedNonDocCount} uncommitted code-file edit(s)${docNote}. ` +
		"Before ending: `git status` to review, then bundle by concern: " +
		"`git add <files> && git commit -m '<concern>'`. Don't push — leave that to the user."
	);
}

interface FormatMidSessionBackstopOpts {
	uncommittedNonDocCount: number;
	threshold: number;
}

/**
 * Public API — build the mid-session backstop nudge, or null when below
 * threshold. Designed to fire ONCE per session at a high-water count
 * (default 40). Caller is responsible for the one-shot guard.
 */
export function formatMidSessionBackstop(opts: FormatMidSessionBackstopOpts): string | null {
	if (opts.uncommittedNonDocCount <= opts.threshold) return null;
	return (
		`[interlinked:commit-cadence] ${opts.uncommittedNonDocCount} distinct code file(s) edited since last commit — ` +
		"that's a lot to bundle into one concern. Run `git status` and " +
		"Commit incrementally now: group by concern, one commit per concern. Don't push."
	);
}

function formatTokenK(tokens: number): string {
	return `${Math.round(tokens / 1000)}k`;
}

// ---------------------------------------------------------------------------
// WIP-commit cleanup nudge (Stop backlog 3B, stop-event-checks.md)
// ---------------------------------------------------------------------------
// The commit-cadence Stop nudge above pushes agents to commit MORE often,
// which increases the small-commit count — this is its cleanup counterweight:
// at Stop, commits the session created whose subject reads as scratch
// ("wip", "fixup", "tmp"…) earn a one-line "clean up before PR" reflection.
// Same contract as every Stop nudge: string | null, stderr-only, never blocks.

/** Commit subjects that read as WIP scratch. Anchored to the START of the
 *  subject — "fix wip detection" is a legitimate message about wip, not a
 *  wip commit. */
const WIP_SUBJECT_RE = /^(?:wip|fixup|tmp|temp|squash)\b/i;

/** Autosquash markers `fixup! <subject>` / `squash! <subject>` are excluded:
 *  they are DELIBERATE `git rebase -i --autosquash` inputs, not forgotten
 *  scratch (the known-FP case the design doc names). */
const AUTOSQUASH_PREFIX_RE = /^(?:fixup|squash)!/i;

/** Public API — pure predicate: does this commit subject read as a WIP-style
 *  scratch commit worth cleaning up before a PR? */
export function isWipCommitSubject(subject: string): boolean {
	const s = subject.trim();
	if (AUTOSQUASH_PREFIX_RE.test(s)) return false;
	return WIP_SUBJECT_RE.test(s);
}

/**
 * Public API — the WIP-style commit subjects the session created: `git log
 * <baselineHeadSha>..HEAD` subjects filtered through {@link isWipCommitSubject}.
 * The baseline sha is the session-start HEAD from `git_session_baseline`, so
 * the range is exactly "commits made since this session began".
 *
 * Called once at Stop (never per-event — the Stop branch's latency budget
 * covers a git shell-out, per stop-event-checks.md §design principle 3).
 * Total: any git failure (not a repo, unborn HEAD, sha gone after a rebase)
 * returns [] rather than throwing.
 */
export function collectWipCommitSubjects(cwd: string, baselineHeadSha: string): string[] {
	if (!baselineHeadSha) return [];
	let out: string;
	try {
		out = execFileSync("git", ["log", "--format=%s", `${baselineHeadSha}..HEAD`], {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return [];
	}
	return out
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && isWipCommitSubject(s));
}

interface FormatWipCommitsNudgeOpts {
	/** WIP-style commit subjects from {@link collectWipCommitSubjects}. */
	wipSubjects: readonly string[];
	maxShown?: number;
}

/**
 * Public API — one-line Stop nudge listing the session's WIP-style commits,
 * or null when there are none. Suggests `git rebase -i` cleanup before a PR
 * and — consistent with every commit-cadence nudge — explicitly does NOT
 * suggest pushing.
 */
export function formatWipCommitsNudge(opts: FormatWipCommitsNudgeOpts): string | null {
	if (opts.wipSubjects.length === 0) return null;
	const max = opts.maxShown ?? 3;
	const shown = opts.wipSubjects
		.slice(0, max)
		.map((s) => `"${s}"`)
		.join(", ");
	const more = opts.wipSubjects.length > max ? ", ..." : "";
	return (
		`[interlinked:commit-cadence] This session created ${opts.wipSubjects.length} WIP-style ` +
		`commit(s) (${shown}${more}) — squash/reword them (\`git rebase -i\`) before opening a PR. ` +
		"Don't push — leave that to the user."
	);
}
