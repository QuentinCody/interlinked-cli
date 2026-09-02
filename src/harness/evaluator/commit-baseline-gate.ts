// ===========================================
// PreToolUse Bash gate — COMMIT-TIME baseline-integrity backstop
// ===========================================
//
// The edit-time gate (`baseline-integrity-gate.ts`) blocks an agent hand-LOOSENING
// a ratchet water-line at Write/Edit time. This backstop closes the residual hole:
// an agent could stage a loosened baseline through a path the write gate didn't
// reconstruct (an apply_patch, a sub-agent, a manual editor) and then `git commit`
// it. On a real `git commit` we diff HEAD vs the STAGED blob of each git-TRACKED
// baseline through the SAME pure `detectBaselineGaming` detector and block the
// commit if the staged change loosens a water-line.
//
// Scope: only the baselines carved out of the `.interlinked/*` gitignore can ever
// be staged (large-files / untested-files / metric-caps); the other baselines are
// gitignored local state and never appear in a commit. Always-on (mirrors the
// edit-time gate — only the INTERLINKED_DISABLE_BASELINE_GUARD=1 env bypass). Cheap
// (two `git show` reads per baseline, no suite). FAIL-OPEN on every uncertainty.

import { resolve } from "node:path";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { detectBaselineGaming } from "./baseline-integrity-gate.js";
import { gitShow, resolveRepoRoot } from "./commit-git-io.js";
import { parseGitCommit } from "./commit-parse.js";

/** Baselines carved out of the `.interlinked/*` gitignore — the only ones that can
 *  stage. The other baselines are gitignored, so they never reach a commit. */
const TRACKED_BASELINES = [
	".interlinked/large-files-baseline.json",
	".interlinked/untested-files-baseline.json",
	".interlinked/metric-caps.json",
	".interlinked/skipped-tests-baseline.json",
	// Per-function complexity grandfather ledger (2026-09-01) — its sibling
	// detector lives in function-complexity-baseline-gate.ts, reached via
	// detectBaselineGaming like the disposition ledger below.
	".interlinked/function-complexity-baseline.json",
	// Mutation adjudication ledger (plan 18 M0) — committed sidecar; its monotonic
	// detector lives in disposition-ledger-gate.ts and reaches here via detectBaselineGaming.
	".interlinked/mutation-dispositions.json",
] as const;

/**
 * Returns a `block` decision when the command is a real `git commit` AND a tracked
 * baseline's STAGED content loosens a water-line vs HEAD; otherwise null. A pure
 * no-op (no git shell-out) for non-commit commands. Never throws (fail-open).
 */
export function checkCommitBaselineGate(event: HarnessEvent): HarnessDecision | null {
	if (process.env.INTERLINKED_DISABLE_BASELINE_GUARD === "1") return null;

	const command = (event.tool_input?.command as string) || "";
	const parse = parseGitCommit(command);
	if (!parse?.isCommit) return null;

	const baseCwd = event.cwd || process.cwd();
	const commandCwd = parse.cwd ? resolve(baseCwd, parse.cwd) : baseCwd;
	const repoRoot = resolveRepoRoot(commandCwd);
	if (!repoRoot) return null;

	const findings = [];
	for (const rel of TRACKED_BASELINES) {
		const staged = gitShow(repoRoot, `:${rel}`); // index (staged) blob
		if (staged === null) continue; // not staged in this commit
		const head = gitShow(repoRoot, `HEAD:${rel}`) ?? ""; // "" → new baseline, never a loosening
		findings.push(...detectBaselineGaming(resolve(repoRoot, rel), head, staged));
	}
	if (findings.length === 0) return null;

	const messages = findings.map((f) => `[${f.rule}] ${f.message}`).join("\n  ");
	return {
		decision: "block",
		reason:
			`BLOCKED: this commit stages a loosened ratchet baseline:\n  ${messages}\n\n` +
			"Ratchet water-lines may only move in the tightening direction. Unstage the baseline change, or set INTERLINKED_DISABLE_BASELINE_GUARD=1 for an intentional reset.",
		rule_id: "commit_baseline_integrity_gate",
		severity: "high",
		category: "config",
	};
}

/**
 * Pipeline wrapper (wired in pre-tool-pipeline.ts before runCommitGate). Only fires
 * while the running decision is still `allow` and the tool is Bash; merges any
 * accumulated warnings onto the block. Never throws.
 */
export function runCommitBaselineGate(
	event: HarnessEvent,
	preDecision: HarnessDecision,
): HarnessDecision | null {
	if (preDecision.decision !== "allow") return null;
	if (event.tool_name !== "Bash") return null;
	const decision = checkCommitBaselineGate(event);
	if (!decision) return null;
	if (preDecision.warnings && preDecision.warnings.length > 0) {
		decision.warnings = [...preDecision.warnings, ...(decision.warnings ?? [])];
	}
	return decision;
}
