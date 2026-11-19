// Spec-structure family: single-file markdown/spec consistency checks over
// the spec-facts substrate (docs/design/spec-audit-runtime-checks.md §3.3,
// spikes 1+3). All post-phase warnings; the fix instructions are
// evidence-only by policy — the harness never writes a fix (§6.2).

import {
	checkSpecClaimUntagged,
	checkSpecPitfalls,
} from "../../checks/spec-pitfalls.js";
import {
	checkSpecCapacityClaims,
	checkSpecTableSums,
} from "../../checks/spec-quantities.js";
import {
	checkSpecCountClaim,
	checkSpecDanglingAnchor,
	checkSpecNumbering,
	checkSpecStageOrder,
} from "../../checks/spec-structure.js";
import type { CheckRegistration } from "../types.js";

export const SPEC_STRUCTURE_ENTRIES: CheckRegistration[] = [
	{
		id: "spec_dangling_anchor",
		phase: "post",
		name: "Spec Dangling Anchor",
		description:
			"Detects same-file references that resolve to nothing: [text](#slug) with no matching heading, §N.N / Section N refs in section-numbered docs with no such heading, and Appendix X refs in docs whose appendices don't include X. Docs without numbered headings or appendices never fire (their refs point at other documents).",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This reference points at a heading/anchor that does not exist in this file. Either the target was renamed or removed — update the reference to the current heading — or the reference targets another document, so qualify it (\"see §7.3 of <doc>\"). Don't delete the reference without checking what it intended to point at.",
		fn: checkSpecDanglingAnchor,
		resultsPropName: "specDanglingAnchor",
		content_keywords: ["](#", "§", "Appendix", "Section"],
	},
	{
		id: "spec_numbering",
		phase: "post",
		name: "Spec Registry Numbering",
		description:
			"Detects numbering defects in ID registries (FG-INV-xx / B7 / W4 style): an id defined on two definition lines (table rows, headings and bold-named bullets always count; a plain bullet under a table or heading registry is a note about the id, not a redefinition), or small gaps in a definition registry (renumber residue after consolidation). Gaps are computed over definition sites only — prose citing a sparse subset of ids never fires.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A registry id is duplicated or the registry's numbering has gaps. Stable ids are external reference targets: never renumber existing entries. For a duplicate, rename the NEWER entry to the next free number. For a gap, either restore the missing rows or note the retirement where the registry is defined so readers know the gap is deliberate.",
		fn: checkSpecNumbering,
		resultsPropName: "specNumbering",
	},
	{
		id: "spec_count_claim",
		phase: "post",
		name: "Spec Count Claim Drift",
		description:
			"Detects a stated count or ID range that disagrees with the ids actually enumerated in the same file — \"six bets\" above a B1..B7 table, \"FG-INV-01 through FG-INV-20\" while the census reaches FG-INV-28. Claims fire only when bound to a namespace by same-line or heading-section co-occurrence; ordinary prose quantities are inert.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A stated count/range disagrees with the enumerated ids. Two legitimate resolutions — the claim is stale (update the number or range) or the extra ids are vestigial (remove or demote them). Decide which, apply it, and recount; then check sibling documents (README/AGENTS/plan) that state the same fact.",
		fn: checkSpecCountClaim,
		resultsPropName: "specCountClaim",
	},
	{
		id: "spec_pitfall",
		phase: "post",
		name: "Spec Pitfall Lexicon",
		description:
			"Curated recurring spec falsehoods, seeded from external audit corpora: exactly-once to external sinks, in-house crypto primitives, forbid+allow(unsafe_code), truncated-hash-as-identity, post-filter visibility, self-oracle validation, cross-machine float byte-identity. Same-line co-occurrence with hedge exemptions; each entry carries a citation.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This claim shape is one external audits refute repeatedly (citation in the finding). Verify the claim against the cited pitfall: either scope/hedge it to what actually holds, or state the mechanism that makes the strong form true. Do not delete the claim — decide what is actually guaranteed and say that.",
		fn: checkSpecPitfalls,
		resultsPropName: "specPitfalls",
	},
	{
		id: "spec_claim_untagged",
		phase: "post",
		name: "Spec Claim Untagged",
		description:
			"Guarantee-verb sentences (guarantees/proves/exactly-once/byte-identical/…) lacking a [claim: theorem|model|runtime|statistical|benchmark] tag — only in files that already use claim tags (per-file opt-in, no repo-wide nag). The audit-recommended claim taxonomy as a nudge.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This file classifies its guarantee claims with [claim: …] tags, but this claim has none. Decide what backs it — theorem, model check, runtime assertion, statistical evidence, or benchmark — and tag it so reviewers know what evidence to demand.",
		fn: checkSpecClaimUntagged,
		resultsPropName: "specClaimUntagged",
	},
	{
		id: "spec_capacity_claim",
		phase: "post",
		name: "Spec Capacity Claim",
		description:
			"Detects an N-bit field discussed with reuse/counter/generation vocabulary and no wrap/widen/prohibition statement — the bounded-field wraparound class (an 8-bit generation field wraps after 256 reuses). Emits the wrap point as a pointed obligation, never a verdict.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A bounded field with reuse semantics needs its wraparound story stated where the field is defined: reuse prohibited past the wrap point, the field widened, saturation, or explicit wraparound handling. Say which — the wrap point in the finding is the number your spec must survive.",
		fn: checkSpecCapacityClaims,
		resultsPropName: "specCapacityClaims",
		content_keywords: ["-bit"],
	},
	{
		id: "spec_table_sum",
		phase: "post",
		name: "Spec Table Sum",
		description:
			"Recomputes Total/Sum rows in markdown tables against their numeric columns — byte-layout tables and cost breakdowns whose totals drifted from their rows (audit class A arithmetic). Comma-grouped numbers supported; needs ≥2 numeric data rows.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A Total/Sum row disagrees with the rows above it. Either the total is stale (recompute it) or a row was added/removed without updating the total — decide which and fix that side. If the total intentionally excludes rows, label it (\"subtotal\") so the arithmetic reads as intended.",
		fn: checkSpecTableSums,
		resultsPropName: "specTableSums",
		content_keywords: ["total", "sum"],
	},
	{
		id: "spec_stage_order",
		phase: "post",
		name: "Spec Stage Order",
		description:
			"Detects workstream/gate sequencing defects in W/G-staged plans: a stage that depends on a LATER stage (W4 depends on W8), or a later stage that changes what an earlier stage already fixed (W8 rewrites W2's cursors) — the Sol workstream class, single-line id-to-id form. Requires a ≥3-stage registry in the file.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A stage's stated dependencies point the wrong way along the schedule. Either resequence the stages, split the dependency so the early stage needs only what exists by then, or move the invalidating work into (or before) the stage whose output it changes. Sequencing tables and prose must tell the same story.",
		fn: checkSpecStageOrder,
		resultsPropName: "specStageOrder",
		content_keywords: ["depends on", "rewrites", "requires", "builds on", "reworks"],
	},
];
