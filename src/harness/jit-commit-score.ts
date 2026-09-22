// ===========================================
// Just-in-time commit score — pure, static, rule-based
// ===========================================
// Scores ONE commit for defect-induction risk from the five feature groups
// of the JIT defect-prediction line (Kamei et al. 2013, IEEE TSE; Commit
// Guru, FSE 2015; McIntosh & Kamei 2018). A static formula, not a trained
// model, so nothing drifts as the repo ages. The score is ORDINAL: rank
// commits against the repo's own distribution (`percentileOf`), never read
// the magnitude as a probability.
//
// This module is pure arithmetic over a `JitCommitInputs` record. Gathering
// the record from git lives in `jit-commit-inputs.ts` (cmd-tier cost); the
// commit gate and `interlinked metrics jit` both call `scoreJitCommit`.
//
// Group signs, from the literature:
//   size       larger         ⇒ riskier  (+)
//   diffusion  more scattered ⇒ riskier  (+)
//   history    turbulent      ⇒ riskier  (+)
//   experience more prior     ⇒ safer    (−)
//   purpose    fix adds, revert dampens

export interface JitCommitInputs {
	/** Lines added across the diff. */
	linesAdded: number;
	/** Lines deleted across the diff. */
	linesDeleted: number;
	/** Distinct files touched. */
	filesTouched: number;
	/** Diff hunks (`@@` headers) across the diff. */
	hunks: number;
	/** Distinct top-level directories touched (`src`, `docs`, …). */
	subsystems: number;
	/** Distinct directories (full dirname) touched. */
	directories: number;
	/** Shannon entropy in bits of the per-file churn distribution. */
	changeEntropy: number;
	/** Sum over touched files of their prior in-window commit counts. */
	priorChanges: number;
	/** Distinct prior authors across the touched files. */
	priorAuthors: number;
	/** Sum over touched files of prior fix-classified commits. */
	priorFixes: number;
	/** Author's prior commits in the long window. */
	authorCommitsLong: number;
	/** Author's prior commits in the recent window. */
	authorCommitsRecent: number;
	/** Message classification. */
	purpose: CommitPurpose;
}

export interface CommitPurpose {
	isFix: boolean;
	isSecurityFix: boolean;
	isRevert: boolean;
}

export type JitGroup = "size" | "diffusion" | "history" | "experience" | "purpose";

export interface JitCommitScore {
	/** Ordinal risk score; higher is riskier. Never negative. */
	score: number;
	/** Signed per-group contribution; `experience` is ≤ 0. */
	contributions: Record<JitGroup, number>;
	/** Bump when the formula changes so consumers can detect it. */
	version: 1;
}

/** Group weights. Size and diffusion carry the most (Kamei: LA/LD and NF/entropy are the strongest). */
const WEIGHTS = {
	size: { lines: 0.3, files: 0.2, hunks: 0.1 },
	diffusion: { subsystems: 0.15, directories: 0.1, entropy: 0.15 },
	history: { changes: 0.15, authors: 0.1, fixes: 0.1 },
	experience: { long: 0.15, recent: 0.1 },
	purpose: { fix: 0.25, securityFix: 0.25, revert: -0.3 },
} as const;

const ln1p = (x: number): number => Math.log1p(Math.max(0, x));

function sizeContribution(i: JitCommitInputs): number {
	const w = WEIGHTS.size;
	return w.lines * ln1p(i.linesAdded + i.linesDeleted) + w.files * ln1p(i.filesTouched) + w.hunks * ln1p(i.hunks);
}

function diffusionContribution(i: JitCommitInputs): number {
	const w = WEIGHTS.diffusion;
	// Subsystems/directories count from 1, so a single-directory commit adds nothing.
	return (
		w.subsystems * ln1p(i.subsystems - 1) +
		w.directories * ln1p(i.directories - 1) +
		w.entropy * Math.max(0, i.changeEntropy)
	);
}

function historyContribution(i: JitCommitInputs): number {
	const w = WEIGHTS.history;
	return w.changes * ln1p(i.priorChanges) + w.authors * ln1p(i.priorAuthors) + w.fixes * ln1p(i.priorFixes);
}

function experienceContribution(i: JitCommitInputs): number {
	const w = WEIGHTS.experience;
	return -(w.long * ln1p(i.authorCommitsLong) + w.recent * ln1p(i.authorCommitsRecent));
}

function purposeContribution(i: JitCommitInputs): number {
	const w = WEIGHTS.purpose;
	let c = 0;
	if (i.purpose.isFix) c += w.fix;
	if (i.purpose.isSecurityFix) c += w.securityFix;
	if (i.purpose.isRevert) c += w.revert;
	return c;
}

/** Score one commit. Pure; throws on a non-finite input so a parser bug cannot become a silent 0. */
export function scoreJitCommit(inputs: JitCommitInputs): JitCommitScore {
	for (const [k, v] of Object.entries(inputs)) {
		if (k !== "purpose" && !Number.isFinite(v)) throw new Error(`JIT input ${k} is not a finite number`);
	}
	const contributions: Record<JitGroup, number> = {
		size: sizeContribution(inputs),
		diffusion: diffusionContribution(inputs),
		history: historyContribution(inputs),
		experience: experienceContribution(inputs),
		purpose: purposeContribution(inputs),
	};
	const raw = Object.values(contributions).reduce((a, b) => a + b, 0);
	return { score: Math.max(0, raw), contributions, version: 1 };
}

/** Shannon entropy (bits) of a churn distribution; 0 for one bucket or no churn. */
export function churnEntropy(churnPerFile: readonly number[]): number {
	const total = churnPerFile.reduce((a, b) => a + Math.max(0, b), 0);
	if (total <= 0) return 0;
	let h = 0;
	for (const c of churnPerFile) {
		if (c <= 0) continue;
		const p = c / total; // total > 0: guarded by the early return above
		h -= p * Math.log2(p);
	}
	return h;
}

const FIX_RE = /\b(fix(es|ed)?|bug|defect|regression|hotfix|patch|repair|resolve[sd]?)\b/i;
const SECURITY_RE = /\b(security|vuln(erability)?|cve-\d{4}-\d+|exploit|injection|xss|csrf|rce|overflow)\b/i;
const REVERT_RE = /^\s*revert\b|\brevert(s|ed)?\b/i;

/** Classify a commit message by its subject + body. */
export function classifyCommitPurpose(message: string): CommitPurpose {
	const isSecurityFix = SECURITY_RE.test(message);
	return { isFix: FIX_RE.test(message) || isSecurityFix, isSecurityFix, isRevert: REVERT_RE.test(message) };
}

/** The ruler every metrics surface shares — re-exported so JIT callers keep one import. */
export { percentileOf } from "./percentile-rank.js";
