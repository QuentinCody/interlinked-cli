// Cross-file drift computation (docs/design/spec-audit-runtime-checks.md
// §3.2) — the pure append helpers behind SpecLedger.computeDrift, split out
// of ledger.ts for the per-file line cap. The suppression rules encode two
// review rounds: a local REGISTRY that already disagrees is the single-file
// check's beat (round-4 #8/#9), but only when the global census says nothing
// MORE — a split registry's global count/max is a distinct cross-file
// finding (round-5 #3).

import type { CountClaim, IdNamespace, SpecFacts } from "./types.js";

/** The cross-file drift kinds the ledger emits (source "spec" in
 *  CheckResultEntry). Authoritative list for the check-inventory spec_ledger
 *  family — these run at PostToolUse and enter recurrence, so they must be
 *  counted (deep-round #10). */
export const SPEC_LEDGER_CHECK_KINDS = [
	"count_claim_drift",
	"range_claim_drift",
	"declared_fact_drift",
	"xref_missing_anchor",
	"xref_missing_file",
] as const;

/** One cross-file inconsistency, anchored where an edit would surface it. */
export interface SpecDriftFinding {
	kind: (typeof SPEC_LEDGER_CHECK_KINDS)[number];
	/** Repo-relative file the finding is anchored to. */
	file: string;
	line: number;
	/** Human-readable message carrying BOTH provenances (evidence-only). */
	message: string;
	/** Other repo-relative files involved — sibling-site propagation targets. */
	relatedFiles: string[];
}

/** A namespace merged across every ledger file. */
export interface GlobalNamespace {
	prefix: string;
	style: "dashed" | "compact";
	nums: Set<number>;
	max: number;
	/** Files that contain any id of this namespace. */
	files: string[];
	/** Files with at least one definition site — the registry homes. */
	definingFiles: string[];
}

/** Fold sub-threshold DEFINED id fragments into census entries that ALREADY
 *  qualify (sol-max #1): a lone "- B7" in a file that doesn't independently form
 *  a B namespace still extends a B1..B6 registry defined elsewhere. Only existing
 *  census prefixes are extended — a fragment with no qualifying home is ignored,
 *  so this never fabricates a namespace (FP-safe). */
export function foldLooseDefinedIds(
	global: Map<string, GlobalNamespace>,
	files: Map<string, SpecFacts>,
): void {
	for (const [file, facts] of files) {
		for (const loose of facts.looseDefinedIds) {
			const g = global.get(`${loose.style} ${loose.prefix}`);
			if (!g) continue;
			g.nums.add(loose.num);
			g.max = Math.max(g.max, loose.num);
			if (!g.files.includes(file)) g.files.push(file);
			if (!g.definingFiles.includes(file)) g.definingFiles.push(file);
		}
	}
}

/** Count-claim drift for a single claim against the global census — the
 *  per-claim body of appendCountDrift, extracted so the outer loop carries
 *  none of this nesting (cognitive-complexity split; no behavior change).
 *  Returns the number of findings emitted for this claim. */
function appendCountDriftForClaim(
	claim: CountClaim,
	out: SpecDriftFinding[],
	file: string,
	global: Map<string, GlobalNamespace>,
	bindings: Map<string, Set<string>>,
	localByKey: Map<string, IdNamespace>,
): number {
	const keys = bindings.get(claim.nounSingular);
	if (!keys) return 0;
	// A noun that binds to MORE THAN ONE namespace across the repo is
	// ambiguous ("phase" → W in one doc, P in another). Comparing such a
	// claim against every bound namespace double-reports a correct "three
	// phases" (W1–W3) claim against the unrelated P1–P4 registry (round-2
	// #19). Disambiguate by locality: only keep a key that co-occurs in
	// THIS file. A single-key binding stays unambiguous, so the D-1 case
	// (a README count claim about a registry defined in another file, where
	// the claim's file has no local ids) still fires.
	const ambiguous = keys.size > 1;
	// Disambiguate by locality: for an ambiguous noun keep only the bound
	// namespaces that also occur in THIS file (round-2 #19). If MORE THAN ONE
	// such candidate is local, the claim cannot be attributed to a single
	// registry — comparing against each double-reports (sol-max #14) — so skip
	// it entirely. A single-key binding stays unambiguous, preserving D-1.
	const candidates = ambiguous ? [...keys].filter((k) => localByKey.has(k)) : [...keys];
	if (ambiguous && candidates.length > 1) return 0;
	let emittedHere = 0;
	for (const key of candidates) {
		const g = global.get(key);
		if (!g || g.nums.size < 2) continue;
		if (claim.value === g.nums.size) continue;
		const local = localByKey.get(key);
		// A finding whose ENTIRE census lives in this one file is not cross-file
		// drift — the inline single-file check (checkSpecCountClaim) owns it, and
		// it fires for ANY bound namespace, registry or not. Suppress the ledger's
		// duplicate (sol-max #13). The old `hasDefSites(local)` gate let a local
		// namespace WITHOUT definition-shaped lines leak through, double-reporting
		// a purely-local contradiction the inline check already catches.
		if (local && g.nums.size === local.uniqueCount) continue;
		out.push({
			kind: "count_claim_drift",
			file,
			line: claim.line,
			message: `"${claim.raw}" (${file}:${claim.line}) vs the ${g.prefix} census: ${g.nums.size} distinct ids across ${formatFileList(g.definingFiles.length > 0 ? g.definingFiles : g.files)} (max ${g.prefix}-${g.max}). Either this claim is stale or the extra ids are vestigial.`,
			relatedFiles: uniqueOthers(g.files, file),
		});
		emittedHere++;
	}
	return emittedHere;
}

/** Count-claim drift for one file against the global census. */
export function appendCountDrift(
	out: SpecDriftFinding[],
	file: string,
	facts: SpecFacts,
	global: Map<string, GlobalNamespace>,
	bindings: Map<string, Set<string>>,
	localByKey: Map<string, IdNamespace>,
): void {
	// Per-file, per-kind output bound (sol-max #11): a shared-accumulator cap let
	// one file's (or the range pass's) findings starve later files.
	let emitted = 0;
	for (const claim of facts.countClaims) {
		if (emitted >= MAX_DRIFT_FINDINGS) break;
		emitted += appendCountDriftForClaim(claim, out, file, global, bindings, localByKey);
	}
}

/** Range-claim drift for one file against the global census. */
export function appendRangeDrift(
	out: SpecDriftFinding[],
	file: string,
	facts: SpecFacts,
	global: Map<string, GlobalNamespace>,
	localByKey: Map<string, IdNamespace>,
): void {
	const minCache = new Map<string, number>();
	// Per-file, per-kind output bound (sol-max #11) — not a shared-accumulator cap.
	let emitted = 0;
	for (const claim of facts.rangeClaims) {
		if (emitted >= MAX_DRIFT_FINDINGS) break;
		{
			// Compare only against the namespace of the claim's OWN notation
			// (sol-max #10): a compact "A1..A3" must not be checked against a
			// dashed "A-01, A-02, A-04" registry sharing the prefix.
			const style = claim.style;
			const key = `${style} ${claim.prefix}`;
			const g = global.get(key);
			if (!g || g.nums.size < 2) continue;
			if (claim.to === g.max) continue;
			// A claim STARTING ABOVE the census min is an intentional sub-range (a
			// slice, not drift). A claim starting AT or BELOW the min asserts the
			// whole registry extent — and starting below it OVERCLAIMS ids that do
			// not exist, which is drift, not a slice (sol-max #14).
			let gmin = minCache.get(key);
			if (gmin === undefined) {
				gmin = Math.min(...g.nums);
				minCache.set(key, gmin);
			}
			if (claim.from > gmin) continue;
			const local = localByKey.get(key);
			// Purely-local range drift (this file's registry IS the whole census) is
			// the inline check's beat — suppress the ledger's duplicate (sol-max #13).
			// Compare census SIZE, not max: another file contributing lower ids makes
			// the census cross-file even when the maxima match (sol-max #5).
			if (local && g.nums.size === local.uniqueCount) continue;
			out.push({
				kind: "range_claim_drift",
				file,
				line: claim.line,
				message: `"${claim.raw}" (${file}:${claim.line}) but the ${g.prefix} census reaches ${g.prefix}-${g.max} across ${formatFileList(g.definingFiles.length > 0 ? g.definingFiles : g.files)}. Update the range or reconcile the registry.`,
				relatedFiles: uniqueOthers(g.files, file),
			});
			emitted++;
		}
	}
}

function uniqueOthers(files: string[], self: string): string[] {
	return [...new Set(files)].filter((f) => f !== self);
}

const FILE_LIST_CAP = 3;
/** Max drift findings appended per (file, kind) — bounds output on adversarial input (sol-max #8). */
const MAX_DRIFT_FINDINGS = 50;

function formatFileList(files: string[]): string {
	const unique = [...new Set(files)];
	const shown = unique.slice(0, FILE_LIST_CAP).join(", ");
	return unique.length > FILE_LIST_CAP
		? `${shown} (+${unique.length - FILE_LIST_CAP} more)`
		: shown;
}
