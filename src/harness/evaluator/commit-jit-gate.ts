// ===========================================
// PreToolUse Bash gate — COMMIT-TIME just-in-time risk nudge (WARN-only)
// ===========================================
// On a real `git commit`, score the STAGED diff with the JIT defect-induction
// formula (`jit-commit-rank.ts`) and rank it against the repo's own recent
// commits. When it lands in the top decile, append ONE `[interlinked:jit]`
// warning. Never blocks: the score is ordinal and heuristic, and the
// literature's own advice is a relative trigger, not an absolute threshold.
//
// CALLING CONVENTION: WARN-only, so `runCommitJitGate` mutates
// `preDecision.warnings` in place and returns void — the same convention as
// `runCommitRegistryParityGate`. It must NOT use the short-circuiting `run*`
// shape reserved for BLOCK gates (a non-null return there would skip the
// heavier commit gates behind it).
//
// Cost: two git walks (~1s on a 2000-commit window). FAIL-OPEN on everything.

import { readToolString } from "./tool-input-values.js";
import { resolve } from "node:path";
import { extractCommitMessage } from "../jit-commit-inputs.js";
import { type JitRank, rankStagedCommit } from "../jit-commit-rank.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { resolveRepoRoot } from "./commit-git-io.js";
import { parseGitCommit } from "./commit-parse.js";

/** Percentile at or above which the nudge speaks (top decile). */
export const JIT_WARN_PERCENTILE = 90;

function formatWarning(r: JitRank): string {
	const groups = (["size", "diffusion", "history", "experience", "purpose"] as const)
		.map((g) => `${g} ${r.contributions[g] < 0 ? "-" : "+"}${Math.abs(r.contributions[g]).toFixed(2)}`)
		.join(", ");
	return (
		`[interlinked:jit][heuristic] this commit's staged diff ranks p${r.percentile} of ${r.population} recent commits ` +
		`for defect-induction risk (score ${r.score.toFixed(2)}: ${groups}). Ordinal, not a probability. ` +
		"Smaller, single-subsystem commits are easier to review and to revert — consider splitting this one. " +
		"Inspect with `interlinked metrics jit --staged`."
	);
}

/** `allow` + one warning when the staged diff ranks in the top decile; null otherwise. Never throws. */
export function checkCommitJitGate(event: HarnessEvent): HarnessDecision | null {
	const command = readToolString(event.tool_input?.command);
	const parse = parseGitCommit(command);
	if (!parse?.isCommit) return null;

	const baseCwd = event.cwd || process.cwd();
	const repoRoot = resolveRepoRoot(parse.cwd ? resolve(baseCwd, parse.cwd) : baseCwd);
	if (!repoRoot) return null;

	let rank: JitRank | null;
	try {
		rank = rankStagedCommit(repoRoot, extractCommitMessage(command), {});
	} catch {
		return null;
	}
	if (!rank || rank.percentile === null || rank.percentile < JIT_WARN_PERCENTILE) return null;
	return { decision: "allow", warnings: [formatWarning(rank)] };
}

/** Pipeline entry: appends the nudge to an allow decision's warnings; a no-op otherwise. */
export function runCommitJitGate(event: HarnessEvent, preDecision: HarnessDecision): void {
	if (preDecision.decision !== "allow" || event.tool_name !== "Bash") return;
	const decision = checkCommitJitGate(event);
	if (!decision?.warnings?.length) return;
	preDecision.warnings = [...(preDecision.warnings ?? []), ...decision.warnings];
}
