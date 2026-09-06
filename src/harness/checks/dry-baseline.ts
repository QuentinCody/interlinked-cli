// Pre-edit DRY (code-clone) baseline snapshot + post-edit riser filter.
//
// Mirrors `crap-baseline.ts`: the harness takes a snapshot of the clone pairs
// a file already contained BEFORE an edit, and at PostToolUse only surfaces
// clone findings the edit *introduced or worsened*. Pre-existing duplication
// is the state of a file the agent merely touched -- it should not be blamed
// on that agent, in the same way the CRAP and complexity checks only flag
// newly-introduced regressions.
//
// A "riser" is a clone pair that is either brand new (the pair did not exist
// at snapshot time) or whose similarity rose above its snapshot value. Pure
// module -- the caller supplies pre-edit content and the bounded
// sibling-candidate set.

import type { CloneFinding, FunctionShingles } from "./dry.js";
import { extractFunctionShingles, findClones } from "./dry.js";

// ==================================================================
// Public types
// ==================================================================

/**
 * Keyed by the edited file path -> inner map keyed by the pair key (see
 * `pairKey`) -> similarity at snapshot time.
 */
export type DryBaseline = Map<string, Map<string, number>>;

/** Input bundle for {@link snapshotDryShingles}. */
export interface SnapshotDryInput {
	/** File content BEFORE the edit. */
	preContent: string;
	/** Path of the file being edited. */
	filePath: string;
	/**
	 * Sibling-file functions to compare against, captured pre-edit. The caller
	 * assembles this from same-directory files; passing `[]` baselines only the
	 * within-file clones.
	 */
	candidates: FunctionShingles[];
	/** Optional similarity cutoff; forwarded to {@link findClones}. */
	threshold?: number;
}

// ==================================================================
// Public API
// ==================================================================

/**
 * Capture a pre-edit clone-similarity snapshot for a single file.
 * Public API -- consumed by the harness PreToolUse baseline block.
 *
 * Stores similarity keyed by a name-based pair key so small line drifts from
 * the edit still match during the post-edit comparison. Returns an empty
 * baseline when the pre-edit file had no extractable functions.
 */
export function snapshotDryShingles(input: SnapshotDryInput): DryBaseline {
	const baseline: DryBaseline = new Map();
	const edited = extractFunctionShingles(input.preContent, input.filePath);
	if (edited.length === 0) return baseline;

	const findings = findClones({
		edited,
		candidates: input.candidates,
		threshold: input.threshold,
	});

	const fileMap = new Map<string, number>();
	for (const f of findings) {
		fileMap.set(pairKey(f), f.similarity);
	}
	baseline.set(input.filePath, fileMap);
	return baseline;
}

/**
 * Filter clone findings to just those representing a regression relative to
 * the pre-edit baseline: brand-new pairs, or existing pairs whose similarity
 * rose.
 *
 * Public API -- consumed by the harness PostToolUse DRY block. When the
 * baseline is empty (no snapshot was taken, e.g. a brand-new file) every
 * finding is passed through.
 */
export function filterToRisers(current: CloneFinding[], baseline: DryBaseline): CloneFinding[] {
	if (baseline.size === 0) return current;

	// The baseline holds exactly one entry (the edited file).
	const fileMap = firstValue(baseline);
	if (!fileMap) return current;

	return current.filter((finding) => {
		const prior = fileMap.get(pairKey(finding));
		if (prior === undefined) return true; // new clone pair -> keep
		return finding.similarity > prior; // similarity rose -> keep
	});
}

// ==================================================================
// Internal
// ==================================================================

/**
 * Return the first value of a map, or undefined when empty.
 * Exported for direct unit coverage of the empty-map path -- {@link filterToRisers}
 * short-circuits before this ever sees an empty baseline in production use.
 */
export function firstValue(baseline: DryBaseline): Map<string, number> | undefined {
	for (const map of baseline.values()) return map;
	return undefined;
}

/**
 * Pair key -- order-independent, name-based. Two functions form the same
 * logical pair regardless of which side an edit happened to land on, and the
 * key survives the small line drift an edit introduces (line numbers are
 * deliberately excluded). Two same-named functions in different files are
 * disambiguated by including the other file path.
 */
function pairKey(f: CloneFinding): string {
	const left = `${f.name}`;
	const right = `${f.otherFile}::${f.otherName}`;
	return [left, right].sort().join(" <=> ");
}
