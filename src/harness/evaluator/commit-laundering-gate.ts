// ===========================================
// Workaround-laundering commit gate (DW P3 §5.2 — the single outflow block)
// ===========================================
// Completes the P1 trajectory arc: workaround detection is SHADOW everywhere
// (never derails a running agent) EXCEPT at the commit outflow, where it
// escalates to a block — safe because a commit is a deliberate boundary, not a
// mid-edit action. When a block fires this session, the refused action is
// fingerprinted (block-fingerprint-session.ts). If the SAME class of violation
// reaches the staging area — through ANY channel, including ones the per-edit
// gate never saw (a bash heredoc, a subagent write) — this gate blocks the
// commit with the provenance story.
//
// ZERO-FP BY CONSTRUCTION: it reuses runPreBlockRegistryGate's introduced-only
// semantics (staged content vs HEAD). A legitimately FIXED commit yields no
// introduced findings — running `empty_catch` on a now-handled catch produces
// nothing — so a correct fix that merely resembles the refused text never
// blocks. Only the still-present violation of a rule that ACTUALLY blocked this
// session (an armed fingerprint) blocks. FAIL-OPEN on every git / check error.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { runPreBlockRegistryGate } from "../pre-block-gate.js";
import { pruneExpired } from "../trajectory/block-fingerprint.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import { parseGitCommit } from "./commit-parse.js";

/** Bound the per-commit work — a huge commit fails open past this many files. */
const MAX_STAGED_FILES = 200;

/** Injectable git reader: `(repoRoot, args) => stdout | null`. */
export type GitReader = (repoRoot: string, args: string[]) => string | null;

interface LaunderingGateDeps {
	git?: GitReader;
	resolveRepoRoot?: (dir: string) => string | null;
	/** ms epoch for pruning expired fingerprints (default Date.now via caller). */
	nowMs?: number;
}

const realGit: GitReader = (repoRoot, args) => {
	try {
		return execFileSync("git", ["-C", repoRoot, ...args], {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
		});
	} catch {
		return null;
	}
};

function realRepoRoot(dir: string): string | null {
	const out = realGit(dir, ["rev-parse", "--show-toplevel"]);
	return out ? out.trim() : null;
}

/** One staged file → the first armed-rule violation still introduced in it, or null. */
function launderingHitInFile(
	repoRoot: string,
	rel: string,
	armedRuleIds: ReadonlySet<string>,
	git: GitReader,
): { file: string; checkId: string } | null {
	const staged = git(repoRoot, ["show", `:${rel}`]);
	if (staged === null) return null;
	const head = git(repoRoot, ["show", `HEAD:${rel}`]); // null on a new file → strict
	const outcomes = runPreBlockRegistryGate({
		content: staged,
		filePath: resolve(repoRoot, rel),
		baselineContent: head,
		projectRoot: repoRoot,
	});
	for (const o of outcomes) {
		if (o.introduced.length > 0 && armedRuleIds.has(o.checkId)) {
			return { file: rel, checkId: o.checkId };
		}
	}
	return null;
}

function launderingReason(file: string, checkId: string): string {
	return (
		`BLOCKED (workaround-laundering): ${file} stages a change that check '${checkId}' refused earlier ` +
		"this session, and the violation is still present (introduced vs HEAD). The block was not advisory — " +
		"routing the refused change into a commit through another channel defeats the guarantee it protects. " +
		`Fix the flagged issue in ${file}, or if the check itself is wrong, report it. ` +
		"One-time bypass: INTERLINKED_DISABLE_LAUNDERING_GATE=1."
	);
}

/**
 * Block a `git commit` whose staged content still contains a violation of a rule
 * that blocked earlier this session. Returns a block decision or null (allow /
 * not-applicable). Never throws.
 */
export function runCommitLaunderingGate(
	event: HarnessEvent,
	session: SessionTrajectory,
	deps: LaunderingGateDeps = {},
): HarnessDecision | null {
	if (process.env.INTERLINKED_DISABLE_LAUNDERING_GATE === "1") return null;
	const command = typeof event.tool_input?.command === "string" ? event.tool_input.command : "";
	const parse = parseGitCommit(command);
	if (!parse?.isCommit) return null;

	const armed = pruneExpired(session.block_fingerprints ?? [], deps.nowMs ?? 0);
	if (armed.length === 0) return null;
	const armedRuleIds = new Set(armed.map((f) => f.ruleId));

	const git = deps.git ?? realGit;
	const resolveRoot = deps.resolveRepoRoot ?? realRepoRoot;
	try {
		const baseCwd = event.cwd || process.cwd();
		const commandCwd = parse.cwd ? resolve(baseCwd, parse.cwd) : baseCwd;
		const repoRoot = resolveRoot(commandCwd);
		if (!repoRoot) return null;
		const nameList = git(repoRoot, ["diff", "--cached", "--name-only"]);
		if (nameList === null) return null;
		const staged = nameList
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean)
			.slice(0, MAX_STAGED_FILES);

		for (const rel of staged) {
			const hit = launderingHitInFile(repoRoot, rel, armedRuleIds, git);
			if (hit) return { decision: "block", rule_id: "workaround_laundering", reason: launderingReason(hit.file, hit.checkId) };
		}
		return null;
	} catch (err) {
		void err; // fail-open on any git / check error
		return null;
	}
}
