// ===========================================
// PreToolUse Bash gate — COMMIT-TIME registry-parity backstop
// ===========================================
//
// *** NOT YET WIRED INTO pre-tool-pipeline.ts — see "Wiring status" below. ***
//
// The per-edit backstop (registry-parity-phase.ts) only fires on a
// Write/Edit/MultiEdit the harness itself observes. A commit made through a
// path the harness never saw the edit through (`apply_patch`, a sub-agent,
// a manual editor, or a file staged before `.interlinked/registry-parity.json`
// existed) can still land two declared-parity files out of sync. This closes
// that hole the same way `commit-baseline-gate.ts` closes it for ratchet
// water-lines: on a real `git commit`, read the STAGED content of every
// configured pair's LEFT/RIGHT file (`git show :<file>`, the INDEX blob —
// so a fix made only in the working tree and never re-staged still warns,
// P2) and run the shared `diffPairContent` core against it.
//
// SEVERITY: WARN, never BLOCK — unlike commit-baseline-gate.ts. Registry
// drift is a documentation-consistency defect (two lists disagree), not a
// gate-gaming move, and every other surface that reports it
// (`interlinked verify`, the per-edit PostToolUse phase) is non-blocking
// too; escalating severity only at the commit boundary would be a
// surprising, unrequested change to this detector's severity model.
//
// CALLING CONVENTION — read before wiring this in: because this gate is
// WARN-only, `runCommitRegistryParityGate` does NOT follow
// commit-baseline-gate.ts's `run*` shape (return a decision, caller does
// `if (decision) return decision`). That short-circuit idiom in
// pre-tool-pipeline.ts is reserved for BLOCK decisions — every existing
// commit gate ahead of `runCommitGate` (the heavy coverage/CRAP/cyclomatic
// suite) and `runCommitLaunderingGate` (workaround-laundering) only returns
// non-null to block, so returning early is always safe there. A WARN-only
// gate that returned non-null and got `if (decision) return decision`-ed in
// the SAME slot would silently SKIP both of those heavier gates on any
// commit that happens to touch a registry-parity pair file — a real bug,
// not a hypothetical. So instead this MUTATES `preDecision.warnings` in
// place and returns void, matching the `runClassifierEscalation` /
// `runAutoCoordination` calling convention (`await runX(...)`, no `if`
// afterward) rather than the `runCommitBaselineGate` one.
//
// Wiring status: NOT called from pre-tool-pipeline.ts. That file is
// currently over the repo's 500-line cap (509 lines, no entry in
// large-files-baseline.json) — checkLargeFileLineCountWrite blocks ANY
// net-growing edit to it (verified empirically before writing this module;
// see the fixer's report for the reproduction). Once that file has
// headroom again, wiring this in is a ONE-LINE addition next to the other
// commit-gate calls (no `if` needed, since this never returns a value to
// check):
//
//   runCommitRegistryParityGate(event, preDecision);
//
// (placed anywhere after `preDecision` is known-allow and before the
// function returns — e.g. right after the `runCommitBaselineGate` block).

import { readToolString } from "./tool-input-values.js";
import { resolve } from "node:path";
import {
	diffPairContent,
	loadRegistryParityConfig,
	type RegistryDriftFinding,
} from "../registry-parity.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { gitShow, resolveRepoRoot } from "./commit-git-io.js";
import { parseGitCommit } from "./commit-parse.js";

/** Drift findings across every configured pair, comparing the STAGED (index)
 *  blob of each pair's LEFT/RIGHT file. A pair is skipped (not an error)
 *  when either side isn't resolvable at `:<path>` — not tracked, not part of
 *  this commit's index, or a path git can't show. */
function stagedDrift(repoRoot: string): RegistryDriftFinding[] {
	const config = loadRegistryParityConfig(repoRoot);
	if (!config || config.pairs.length === 0) return [];
	const findings: RegistryDriftFinding[] = [];
	for (const pair of config.pairs) {
		const leftStaged = gitShow(repoRoot, `:${pair.left.file}`);
		const rightStaged = gitShow(repoRoot, `:${pair.right.file}`);
		if (leftStaged === null || rightStaged === null) continue;
		findings.push(...diffPairContent(pair, leftStaged, rightStaged));
	}
	return findings;
}

/**
 * Returns a `{decision: "allow", warnings}` decision when the command is a
 * real `git commit` AND at least one configured registry-parity pair's
 * STAGED content is drifted; `null` for a non-commit command, no config, a
 * repo git can't resolve, or a clean staged state. Never throws
 * (fail-open) and never blocks.
 */
export function checkCommitRegistryParityGate(event: HarnessEvent): HarnessDecision | null {

	const command = readToolString(event.tool_input?.command);
	const parse = parseGitCommit(command);
	if (!parse?.isCommit) return null;

	const baseCwd = event.cwd || process.cwd();
	const commandCwd = parse.cwd ? resolve(baseCwd, parse.cwd) : baseCwd;
	const repoRoot = resolveRepoRoot(commandCwd);
	if (!repoRoot) return null;

	const findings = stagedDrift(repoRoot);
	if (findings.length === 0) return null;

	const messages = findings.map((f) => f.message).join("\n  ");
	return {
		decision: "allow",
		warnings: [
			`[interlinked:registry-parity][proven] this commit stages a drifted registry-parity pair:\n  ${messages}\n` +
				"Update both files together, or add the id to left_only_allowed/right_only_allowed in .interlinked/registry-parity.json if the asymmetry is intentional.",
		],
	};
}

/**
 * Pipeline entry point — NOT YET CALLED (see module header for why and the
 * exact one-line hookup). Mutates `preDecision.warnings` IN PLACE when the
 * command is a real `git commit` and staged registry-parity drift exists;
 * a pure no-op otherwise. Always returns void — deliberately does NOT
 * follow commit-baseline-gate.ts's short-circuiting `run*` shape (see
 * module header: CALLING CONVENTION).
 */
export function runCommitRegistryParityGate(
	event: HarnessEvent,
	preDecision: HarnessDecision,
): void {
	if (preDecision.decision !== "allow") return;
	if (event.tool_name !== "Bash") return;
	const decision = checkCommitRegistryParityGate(event);
	if (!decision?.warnings || decision.warnings.length === 0) return;
	preDecision.warnings = [...(preDecision.warnings ?? []), ...decision.warnings];
}
