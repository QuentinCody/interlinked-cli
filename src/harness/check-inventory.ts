// ===========================================================================
// Check inventory — the single source of truth for "how many checks".
// ===========================================================================
// "How many checks does the harness have?" had no authoritative answer: each
// family lives in its own registry, and the doc-metadata records (e.g.
// GENERIC_CHECK_META) neither match the runtime registry nor form a family of
// their own. This module derives each family's count from its OWN authoritative
// source so the number can never drift from reality, and `check-inventory.test.ts`
// pins every count so an add/remove can never land silently.
//
// Families are NOT strictly disjoint: a check id can have variants in more than
// one family (e.g. `dead_exports` = an inline agent-clarity check AND a structural
// check). `total` is therefore the count of DISTINCT check ids across families —
// each id counted once, never the naive sum — and `check-inventory.test.ts` pins
// both the per-family counts and the exact set of ids that span families.
//
// Deliberately excluded:
//   - GENERIC_CHECK_META — the documentation view of a SUBSET of the inline
//     registry (most of its keys ARE CHECK_REGISTRY ids); counting it would
//     double-count the inline family.
//   - Guard rules (BUILTIN_RULES) — a different primitive (PreToolUse command/
//     path gating, not content analysis). Its count is already pinned by the
//     `guard-rules.md` assertion in docs-freshness.test.ts.

import {
	BEHAVIORAL_CHECK_META,
	QUALITY_CHECK_META,
	STRUCTURAL_CHECK_META,
	SUGGESTION_CHECK_META,
} from "./check-metadata.js";
import { CHECK_REGISTRY } from "./check-registry/index.js";
import { ALL_SEQUENCE_DETECTORS } from "./sequence-checks/registry.js";
import { SPEC_LEDGER_CHECK_KINDS } from "./spec/ledger-drift.js";

/** One disjoint family of checks, counted from its authoritative source. */
interface CheckFamily {
	/** Stable machine key (used by --json and the pinning test). */
	key: string;
	/** Human-readable label. */
	label: string;
	/** Number of checks in the family. */
	count: number;
	/** The symbol the count is derived from, so the number is traceable. */
	source: string;
}

/** The authoritative per-family inventory plus the grand total. */
export interface CheckInventory {
	families: CheckFamily[];
	total: number;
}

/**
 * Compute the authoritative check inventory. Every count is read live from the
 * family's own registry/metadata — there is no second place to keep in sync.
 */
export function getCheckInventory(): CheckInventory {
	// Ids per family, from each family's OWN authoritative source. Collected (not
	// merely counted) so `total` can be the DISTINCT union — an id shared across
	// families (dead_exports: inline + structural) is then counted exactly once.
	const inlineIds = CHECK_REGISTRY.map((c) => c.id);
	const sequenceIds = ALL_SEQUENCE_DETECTORS.map((d) => d.id);
	const structuralIds = Object.keys(STRUCTURAL_CHECK_META);
	const toolQualityIds = Object.keys(QUALITY_CHECK_META);
	const suggestionIds = Object.keys(SUGGESTION_CHECK_META);
	const behavioralIds = Object.keys(BEHAVIORAL_CHECK_META);
	// Cross-file spec-ledger checks emit CheckResultEntry with source "spec"
	// from the PostToolUse ledger phase — distinct from the inline spec_*
	// checks in CHECK_REGISTRY, and prefixed here to stay id-disjoint.
	const specLedgerIds = SPEC_LEDGER_CHECK_KINDS.map((k) => `spec_${k}`);

	const families: CheckFamily[] = [
		{
			key: "inline",
			label: "Inline content checks (PreToolUse / PostToolUse + verify)",
			count: inlineIds.length,
			source: "check-registry · CHECK_REGISTRY",
		},
		{
			key: "sequence",
			label: "Sequence / trajectory detectors",
			count: sequenceIds.length,
			source: "sequence-checks/registry · ALL_SEQUENCE_DETECTORS",
		},
		{
			key: "structural",
			label: "Structural (dependency-aware) checks",
			count: structuralIds.length,
			source: "check-metadata · STRUCTURAL_CHECK_META",
		},
		{
			key: "tool_quality",
			label: "Tool-based quality checks (tsc, biome, cargo, …)",
			count: toolQualityIds.length,
			source: "check-metadata · QUALITY_CHECK_META",
		},
		{
			key: "suggestion",
			label: "Scored suggestion-pipeline checks",
			count: suggestionIds.length,
			source: "check-metadata · SUGGESTION_CHECK_META",
		},
		{
			key: "behavioral",
			label: "Session-level behavioral checks",
			count: behavioralIds.length,
			source: "check-metadata · BEHAVIORAL_CHECK_META",
		},
		{
			key: "spec_ledger",
			label: 'Cross-file spec-ledger checks (PostToolUse, source "spec")',
			count: specLedgerIds.length,
			source: "spec/ledger-drift · SPEC_LEDGER_CHECK_KINDS",
		},
	];
	// DISTINCT check ids across families — a shared id (e.g. dead_exports's inline
	// + structural variants) is counted once, so the total can never double-count.
	const total = new Set([
		...inlineIds,
		...sequenceIds,
		...structuralIds,
		...toolQualityIds,
		...suggestionIds,
		...behavioralIds,
		...specLedgerIds,
	]).size;
	return { families, total };
}
