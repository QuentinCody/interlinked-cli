// ===========================================
// Per-edit mutation — brownfield adoption
// ===========================================
// The per-edit gate persists a manifest ONLY on a measured-clean pass, and that
// rule is right: if a dirty run could write the baseline, an agent could
// introduce a survivor and have it silently become the accepted floor. That is
// laundering, and it defeats the ratchet.
//
// But it has a consequence that makes the gate greenfield-only: on legacy code
// most files are NOT clean, so they never earn a baseline, stay permanently in
// first-sighting mode, and can never be enforced. Measured on this repo
// 2026-07-28: 9 files out of 1070 had a baseline after months of use.
//
// Adoption is the way out, and it is the same shape every other ratchet here
// already uses — the line cap grandfathers a high-water count per file, coverage
// grandfathers a per-file percentage, and both then allow only improvement.
// Mutation grandfathers the survivors that already exist: they are recorded with
// their measured status, `acceptedSurvivors` treats them as the floor, and
// `computeNewSurvivors` blocks only what an edit ADDS beyond it.
//
// The safety property is preserved by SEPARATION, not by weakening the rule: the
// per-edit path still refuses to persist a dirty run. Only this explicit,
// operator-invoked path may establish a floor from dirty state, and the floor is
// shrink-only afterwards under the baseline-integrity gate.

import { isTestPath } from "../coverage-test-selector.js";
import { computeSymbolHashes, deriveIdentities } from "./identity.js";
import {
	applyMeasuredRun,
	type MeasuredMutant,
	MutationManifestTestTargetError,
	normalizeManifestKey,
} from "./manifest.js";
import { type AdaptedFile, strykerToAdapted } from "./stryker-adapter.js";
import type { MutationManifest } from "./types.js";

/**
 * The report entry for the requested target, or null when the report cannot be
 * trusted to describe that target.
 *
 * The SAME trust boundary, with the same three refusals, as `selectTargetEntry`
 * in cloud-runner.ts (review 2026-08-25, pass 6). Restated here rather than
 * imported: measure.ts already depends on this module, and adoption must not
 * acquire a dependency on the per-edit gate's HTTP client to decide whether a
 * report describes its own file.
 *
 * - EXACT canonical path equality, through the same `normalizeManifestKey`
 *   choke point the manifest keys by. The removed `?? adapted[0]` fallback let
 *   a FOREIGN file's mutants seed this file's baseline whenever the report did
 *   not name the target — and this is the path most of this repo's baselines
 *   were created through, so the fallback was not hypothetical.
 * - An AMBIGUOUS target (two entries collapsing onto one canonical key) is not
 *   a measurement of anything.
 * - The entry's source must equal `content` byte-for-byte. `deriveIdentities`
 *   anchors the mutants against `content`, so a report measured against
 *   different text yields identities that do not describe the mutants being
 *   recorded — a stale or foreign measurement written in as this file's floor.
 *
 * Refuses with null rather than throwing: every other rejection in this module
 * folds into the same "cannot be trusted to establish a baseline" contract.
 */
function selectTargetEntry(
	adapted: AdaptedFile[],
	args: Pick<SeedArgs, "file" | "content" | "cwd">,
): AdaptedFile | null {
	const { file, content, cwd } = args;
	const canonical = normalizeManifestKey(file, cwd);
	const targets = adapted.filter((f) => normalizeManifestKey(f.file, cwd) === canonical);
	if (targets.length !== 1) return null;
	const target = targets[0];
	if (target === undefined || target.content !== content) return null;
	return target;
}

interface SeedArgs {
	/** Manifest toextend — pass the previous result to seed many files. */
	base: MutationManifest;
	/** Repo-relative path of the file being adopted. */
	file: string;
	/** The exact source the report was measured against. */
	content: string;
	/** Raw Stryker JSON for this file. */
	report: unknown;
	/** ISO timestamp recorded as `firstSeen` for newly-recorded mutants. */
	at: string;
	/** Repo root `file` resolves against when absolute — see manifest.ts's
	 *  `normalizeManifestKey`. Omitted callers fall back to `process.cwd()`. */
	cwd?: string;
}

/**
 * Establish a baseline for one file from a possibly-DIRTY measurement.
 *
 * Returns the extended manifest, or null when the report cannot be trusted to
 * describe this file. Null is important: an EMPTY baseline is worse than none,
 * because it asserts "measured, nothing survived", and a real survivor
 * introduced later would then read as pre-existing and be accepted silently.
 */
export function seedFileBaseline(args: SeedArgs): MutationManifest | null {
	// Unlike the per-edit gate (gate.ts's `isMutationTarget`), this entry point
	// has NO test-file filter of its own — it is driven by an operator-supplied
	// file list (e.g. the brownfield sweep script), not the harness's own
	// changeset. A test-file target reaching here is exactly the caller bug
	// `MutationManifestTestTargetError` documents; checked upfront (before any
	// hashing work) using the SAME predicate + normalizer as everywhere else.
	if (isTestPath(normalizeManifestKey(args.file, args.cwd))) return null;

	const adapted = strykerToAdapted(args.report);
	if (adapted === null) return null;

	const forFile = selectTargetEntry(adapted, args);
	if (forFile === null || forFile.mutants.length === 0) return null;

	const identities = deriveIdentities(
		args.file,
		args.content,
		forFile.mutants.map((m) => m.raw),
	);
	const overlayHashes = computeSymbolHashes(args.file, args.content);
	// Both are null when the TypeScript API is unavailable; without identities
	// there is no stable key to record a mutant under, so there is no baseline
	// worth writing.
	if (identities === null || overlayHashes === null) return null;

	const measured: MeasuredMutant[] = [];
	const n = Math.min(identities.length, forFile.mutants.length);
	for (let i = 0; i < n; i++) {
		const identity = identities[i];
		const m = forFile.mutants[i];
		if (identity && m) measured.push({ identity, status: m.status });
	}
	if (measured.length === 0) return null;

	// applyMeasuredRun already records every measured mutant WITH ITS STATUS —
	// survivors included. Reusing it means adoption and the clean-pass refresh
	// build byte-identical manifests, so a file adopted today is indistinguishable
	// from one that earned its baseline honestly. Only the caller differs.
	try {
		return applyMeasuredRun({
			base: args.base,
			file: args.file,
			overlayHashes,
			measured,
			at: args.at,
			...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
		});
	} catch (err) {
		// The upfront check above already covers this in practice; this catch is
		// the non-bypassable BACKSTOP `applyMeasuredRun` itself enforces (spec of
		// this fix — manifest.ts is the one choke point every writer funnels
		// through, not just this caller's own pre-check). Folds into the SAME
		// "cannot be trusted to establish a baseline" contract every other
		// rejection in this function already uses — null, not a throw the CLI /
		// sweep script would have to handle specially.
		if (err instanceof MutationManifestTestTargetError) return null;
		throw err;
	}
}
