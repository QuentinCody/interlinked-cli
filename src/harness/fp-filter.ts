// ===========================================
// E18 false-positive filter — "is this heuristic finding worth fixing?"
// ===========================================
// A deterministic logistic over the finding's check id (one-hot), its path
// class (test / scratch / archived), severity, per-session repeat count and
// message length. Port of experiment E18's `logistic_cheap` arm
// (scratch/2026-10-08-decisions-orthogonal/e18-fp-filter/, refit by
// fit_for_ship.py into fp-filter-weights.json). No model on the hook path:
// scoring is one dot product.
//
// CALIBRATION (read before trusting it): fitted on ONE repository
// (interlinked-cli, agent-hardened), 319 train / 148 holdout findings, 26
// holdout true positives. Holdout AUROC 0.906 [0.85, 0.95]; at the shipped
// threshold (highest t keeping >= 90% of train TPs, out-of-fold) it kept 26/26
// holdout TPs and suppressed 66/122 holdout FPs. 400/467 labels are model
// labels. The weights are a per-check genuine-rate prior plus a path rule; in
// another codebase the per-check rates differ, which is why the wiring is
// `fp_filter.enabled: false` by default and every suppression is recorded.
//
// Feature definitions are byte-ports of build.py / build_find.py; the fit
// script re-derives all 467 cohort feature vectors with these regexes and
// asserts equality, and fp-filter.test.ts checks parity samples against the
// Python probabilities.

import weights from "./fp-filter-weights.json" with { type: "json" };

/** One finding as the filter sees it. `file` may be absolute; `cwd` strips it. */
export interface FpFilterFinding {
	check: string;
	file?: string | undefined;
	severity?: string | undefined;
	message: string;
	/** Prior occurrences of the same (session, file, check) this session. */
	repeatCount?: number | undefined;
	/** Repository root used to make `file` repo-relative. */
	cwd?: string | undefined;
}

export interface FpFilterScore {
	/** Probability the finding is a true positive (worth fixing). */
	p: number;
	/** True when p < threshold. */
	suppress: boolean;
	threshold: number;
}

/** Train-set operating point shipped with the weights. */
export const FP_FILTER_DEFAULT_THRESHOLD: number = weights.threshold;

/** Provenance of the shipped weights (cohort hash, holdout numbers). */
export const FP_FILTER_PROVENANCE = weights.provenance;

const TEST_RE = /(\.test\.|\.spec\.|__tests__\/|\/tests?\/|_test\.py$|test_[^/]*\.py$)/;
const SCRATCH_RE = /(^|\/)(scratch|\.interlinked|tmp|evals\/.*?\/runs?)\//;
const ARCHIVE_RE = /(archive|scratchpad-archive|agent-output|\/old\/|legacy|__fixtures__|fixtures?\/)/;

const ONE_HOT_CHECKS: ReadonlySet<string> = new Set(weights.checks);
const COEFFICIENTS: Readonly<Record<string, number>> = weights.coefficients;

/** Repo-relative path the way E18's `norm_path` produced it. */
export function normalizeFindingPath(file: string | undefined, cwd: string | undefined): string {
	let path = (file ?? "").trim();
	const root = cwd ? (cwd.endsWith("/") ? cwd : `${cwd}/`) : undefined;
	if (root && path.startsWith(root)) path = path.slice(root.length);
	while (path.startsWith("./")) path = path.slice(2);
	return path;
}

/** The E18 feature vector, keyed by the names in fp-filter-weights.json. */
export function extractFpFeatures(finding: FpFilterFinding): Record<string, number> {
	const path = normalizeFindingPath(finding.file, finding.cwd);
	const features: Record<string, number> = {};
	for (const check of weights.checks) features[`chk_${check}`] = finding.check === check ? 1 : 0;
	features.chk_other = ONE_HOT_CHECKS.has(finding.check) ? 0 : 1;
	features.is_test = TEST_RE.test(path) ? 1 : 0;
	features.path_scratch = SCRATCH_RE.test(path) || path.startsWith("scratch/") ? 1 : 0;
	features.path_archived = ARCHIVE_RE.test(path) ? 1 : 0;
	features.sev_error = finding.severity === "error" ? 1 : 0;
	features.repeat_count = finding.repeatCount ?? 0;
	// Python len(): code points, not UTF-16 units.
	features.message_len = Array.from(finding.message).length;
	return features;
}

/** Score one finding. Pure; `minP` overrides the shipped threshold. */
export function scoreFinding(finding: FpFilterFinding, minP?: number): FpFilterScore {
	const features = extractFpFeatures(finding);
	let z = weights.intercept;
	for (const name of weights.features) z += (COEFFICIENTS[name] ?? 0) * (features[name] ?? 0);
	const p = 1 / (1 + Math.exp(-z));
	const threshold = minP !== undefined && Number.isFinite(minP) ? minP : FP_FILTER_DEFAULT_THRESHOLD;
	return { p, suppress: p < threshold, threshold };
}

/** One suppressed finding, for the trailer and the verify report. */
export interface FpSuppressedEntry {
	check: string;
	p: number;
}

/** The single trailer line that replaces suppressed findings. */
export function formatFpFilterTrailer(
	suppressed: readonly FpSuppressedEntry[],
	mode: "downgrade" | "hide",
	threshold: number,
): string | null {
	if (suppressed.length === 0) return null;
	const noun = suppressed.length === 1 ? "finding" : "findings";
	const head = `[interlinked:fp-filter] [heuristic] ${suppressed.length} ${noun} suppressed by fp_filter (p<${threshold.toPrecision(3)})`;
	const audit = "audit: interlinked query checks --where fp_filter_suppressed=true";
	if (mode === "hide") return `${head}; ${audit}`;
	return `${head}: ${countByCheck(suppressed)}; ${audit}`;
}

/** `a×2, b` — check ids by descending count, then name. */
export function countByCheck(entries: readonly { check: string }[]): string {
	const counts = new Map<string, number>();
	for (const e of entries) counts.set(e.check, (counts.get(e.check) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([check, n]) => (n > 1 ? `${check}×${n}` : check))
		.join(", ");
}
