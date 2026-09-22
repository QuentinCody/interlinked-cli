// ===========================================
// interlinked metrics jit — just-in-time commit risk (Kamei 2013)
// ===========================================
// Scores one commit (a ref, or the staged diff) and ranks it against the
// repo's own recent commits. The percentile is the deliverable; the score's
// magnitude is ordinal and the per-group contributions say WHY it ranked
// there. On-demand only — two git walks per call.

import { getOutputMode, output } from "../lib/output.js";
import { DEFAULT_CALIBRATION_COMMITS, type JitRank, rankRefCommit, rankStagedCommit } from "../harness/jit-commit-rank.js";
import type { JitGroup } from "../harness/jit-commit-score.js";

export interface MetricsJitOpts {
	ref?: string | undefined;
	staged?: boolean;
	message?: string;
	calibrate?: string;
	cwd?: string;
	json?: boolean;
	short?: boolean;
}

const GROUPS: readonly JitGroup[] = ["size", "diffusion", "history", "experience", "purpose"];
const GROUP_COLUMN = 11;

function signed(n: number): string {
	return `${n < 0 ? "-" : "+"}${Math.abs(n).toFixed(2)}`;
}

function purposeLabel(r: JitRank): string {
	const p = r.inputs.purpose;
	const tags: string[] = [];
	if (p.isSecurityFix) tags.push("security-fix");
	else if (p.isFix) tags.push("fix");
	if (p.isRevert) tags.push("revert");
	return tags.length ? tags.join(", ") : "feature/other";
}

export interface JitRenderers {
	json: () => unknown;
	short: () => string;
	normal: () => string;
}

function rulerLine(r: JitRank): string {
	return r.percentile === null ? "unranked (no history)" : `p${r.percentile} of ${r.population} commits`;
}

export function renderJitRank(r: JitRank): JitRenderers {
	return {
		json: () => ({ ...r, jit_score_version: r.version }),
		short: () => `jit ${r.target}: score ${r.score.toFixed(2)} · ${rulerLine(r)}`,
		normal: () => {
			const i = r.inputs;
			const lines = [
				`JIT commit risk — ${r.target}: score ${r.score.toFixed(2)}, ${rulerLine(r)}`,
				"(ordinal: rank against this repo's own commits; not a defect probability)",
				"",
				...GROUPS.map((g) => `  ${g.padEnd(GROUP_COLUMN)} ${signed(r.contributions[g])}`),
				"",
				`  size        ${i.linesAdded} added / ${i.linesDeleted} deleted, ${i.filesTouched} files, ${i.hunks} hunks`,
				`  diffusion   ${i.subsystems} subsystems, ${i.directories} directories, entropy ${i.changeEntropy.toFixed(2)} bits`,
				`  history     ${i.priorChanges} prior changes, ${i.priorAuthors} authors, ${i.priorFixes} fixes on touched files`,
				`  experience  author ${i.authorCommitsLong} commits (long) / ${i.authorCommitsRecent} (recent)`,
				`  purpose     ${purposeLabel(r)}`,
			];
			return lines.join("\n");
		},
	};
}

export function metricsJitCommand(opts: MetricsJitOpts): void {
	const cwd = opts.cwd || process.cwd();
	const mode = getOutputMode(opts);
	const calibrate = Number(opts.calibrate ?? "") || DEFAULT_CALIBRATION_COMMITS;
	const rank = opts.staged
		? rankStagedCommit(cwd, opts.message ?? "", { calibrate })
		: rankRefCommit(cwd, opts.ref ?? "HEAD", { calibrate });
	if (!rank) {
		process.stderr.write(opts.staged ? "nothing staged, or git unavailable\n" : `cannot resolve commit ${opts.ref ?? "HEAD"}\n`);
		process.exitCode = 1;
		return;
	}
	output(mode, rank, renderJitRank(rank));
}
