// ===========================================
// apply_patch per-section metric check (sibling of per-function-metric-gate.ts)
// ===========================================
// Isolated purely to keep `per-function-metric-gate.ts` under the repo's
// line cap: `checkApplyPatch`'s per-section branching (unanalyzable
// extension, unreconstructable hunk, non-cappable file, analyzer-unavailable)
// used to nest inside its `for` loop, which pushed the function's cognitive
// complexity over the cap. Extracted here it starts fresh at depth 0 per
// section; the caller keeps only a flat `for` + outcome switch.
//
// `computeViolations` is passed in (rather than imported) so this module has
// no runtime dependency back on per-function-metric-gate.ts — only type-only
// imports, which avoids a value-level circular import between the two files.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ApplyPatchSection } from "../apply-patch-content.js";
import { reconstructAfterContent } from "../apply-patch-content.js";
import type { FileGrandfather } from "../function-complexity-baseline.js";
import { isCappableFile } from "../large-file-policy.js";
import type { MetricAnalyzer, MetricGateSpec, MetricObserver, NamedMetricEntry } from "./per-function-metric-gate.js";

/** Outcome of reconstructing + metric-checking one apply_patch section against
 *  `spec`: `"skip"` when the section can't or shouldn't be analyzed under this
 *  metric, `"fail-open"` when the analyzer itself is unavailable (the caller
 *  must fail open entirely, not just for this section), or the violation
 *  strings (possibly empty) plus the grandfather record that produced them. */
export type ApplyPatchSectionOutcome =
	| "skip"
	| "fail-open"
	| { items: string[]; gf: FileGrandfather | null };

function safeReadSection(abs: string): string | null {
	try {
		return readFileSync(abs, "utf-8");
	} catch {
		return null;
	}
}

/** Reconstruct one apply_patch section's post-edit content and run the same
 *  metric comparison an explicit file_path edit gets. `computeViolations` is
 *  the caller's `metricViolations` (injected, not imported — see file header). */
export function processApplyPatchSection<E extends NamedMetricEntry>(
	spec: MetricGateSpec<E>,
	section: ApplyPatchSection,
	cwd: string,
	cap: number,
	observe: MetricObserver<E> | undefined,
	computeViolations: (
		spec: MetricGateSpec<E>,
		before: string,
		after: string,
		filePath: string,
		analyzer: MetricAnalyzer<E>,
		cap: number,
		observe: MetricObserver<E> | undefined,
		gf: FileGrandfather | null,
	) => string[] | null,
): ApplyPatchSectionOutcome {
	const analyzer = spec.selectAnalyzer(section.path);
	if (!analyzer) return "skip"; // extension the metric can't analyze → skip
	// Read before-content from the SOURCE path for a moved section — the
	// destination doesn't exist yet, so reading it yields "" and the update
	// hunks fail to reconstruct → the gate would silently fail open on a move
	// that introduced an over-cap function (finding 2026-06).
	const readPath = section.fromPath ?? section.path;
	const abs = isAbsolute(readPath) ? readPath : resolve(cwd, readPath);
	const before = existsSync(abs) ? (safeReadSection(abs) ?? "") : "";
	const after = reconstructAfterContent(section, before);
	if (after === null) return "skip"; // can't reconstruct confidently → fail open for this file
	if (!isCappableFile({ filePath: section.path, content: after, root: cwd })) return "skip";
	const gf = spec.grandfatherFor?.(cwd, section.path) ?? null;
	const fileViolations = computeViolations(spec, before, after, section.path, analyzer, cap, observe, gf);
	if (fileViolations === null) return "fail-open"; // analyzer unavailable → fail open entirely
	return { items: fileViolations, gf };
}
