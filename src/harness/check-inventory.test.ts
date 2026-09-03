import { describe, expect, it } from "vitest";
import { getCheckInventory } from "./check-inventory.js";
import {
	BEHAVIORAL_CHECK_META,
	GENERIC_CHECK_META,
	QUALITY_CHECK_META,
	STRUCTURAL_CHECK_META,
	SUGGESTION_CHECK_META,
} from "./check-metadata.js";
import { CHECK_REGISTRY } from "./check-registry/index.js";
import { ALL_SEQUENCE_DETECTORS } from "./sequence-checks/registry.js";
import { SPEC_LEDGER_CHECK_KINDS } from "./spec/ledger-drift.js";

// ===========================================================================
// PINNED per-family check counts — the audit trail for "how many checks".
// ===========================================================================
// Editing a check family means updating EXACTLY ONE number here; the diff is
// the record. If a count changes without a matching update, this test fails
// loudly — that is the whole point: the number can never silently drift.
const EXPECTED_BY_FAMILY: Record<string, number> = {
	// +8 Bun-regression detector pack wired (assert-erasure ×3, reinterpret ×2, placeholder-const, unsafe-span ×2), 2026-07-20
	inline: 273, // +single_use_trivial_helper (over-extraction — the counterweight to the complexity caps; advisory post, 2026-09-03); prior: 272 = +placeholder_test (existed as a detector but was never a CHECK_REGISTRY entry — registered pre_block/warning, 2026-09-03); prior: 271 = +new_export_without_importer, +extracted_helper_duplicate (helper-hygiene wave, 2026-09-01); prior: 269 = +dead_type_exports, +duplicate_type_declaration (type-redundancy wave, dead-code campaign, 2026-09-01); prior: 267 = +fetch_without_abort_signal, +public_api_leaks_internal_type (Effect second-look wave, 2026-09-01); prior: 265 = +tag_reflection_type_check (typeof-suffices tag-reflection detector, type-discipline family, 2026-08-22); prior: 264 = −type_smuggling (demoted to VERIFY_ONLY: its per-file ts.Program pulled the whole import closure — ~1.9GB of AST per edit inside the daemon, heap-snapshot-attributed to the recurring RSS-spike restarts, 2026-08-22); prior: 265 = +python_portability_trap (Plan 25 Python parity, 2026-08-17); prior: 264 = +dynamic_code_execution, +builtin_prototype_mutation, +float_equality_comparison, +test_contract_annotation, +unvalidated_input_boundary (Plan 25 lanes 6-8, portability/contract/boundary advisory wave, 2026-08-17); prior: 259 = +conditional_empty_object_spread, +unknown_type_alias (type-discipline wave, ported from dmmulroy/anti-slop detection-algorithm-only, 2026-08-14); prior: 257 = +test_legitimacy (contract-grounded, anti-reward-hacking test audit, 2026-08-13); prior: 256 = +homedir_write_escape (write path derives from the user's real home — the mutation-run corpus-leak class, 2026-08-10); prior: 255 = +anonymous_registration (a registry id whose implementation has no name — unreachable from its own key by grep/index/embedding search; the gap that left four checks unsatisfiable, 2026-08-10); prior: 254 = +type_predicate_drift (`v is T` guards leaving required fields of T unchecked — the unchecked-assertion class, ratcheted by metric-caps → max_predicate_drift, 2026-08-09); prior: 253 = +timing_flake (fixed-wait-then-assert; two live instances each cost a whole coverage measurement, 2026-08-06); prior: 252 = +procfs_probe_in_test (CI-hang class from the 2026-07 unit-lane saga, 2026-07-31); prior: 251 = +8 Bun-regression pack; prior: 250 = (verification-density Track A lane 1, 2026-07-26); prior: 250 = +raw_control_bytes (source invisible to grep, 2026-07-25); prior: 242 = +cognitive_complexity (history-relational-metrics Phase 1, 2026-07-24); +weak_random, +archive_extract_traversal, +python_assert_tautology, +rust_test_nondeterminism, +naive_datetime, +redos_catastrophic (DW P0.4/P0.5/breadth, 2026-07-17)
	sequence: 23,
	structural: 26, // +new_import_cycle (Plan 25 lane 5, "Cycle-delta check" — built concurrently by another lane of the same refactor-readiness program; this pin was simply stale, not authored here), 2026-08-17; prior: 25.
	tool_quality: 33,
	suggestion: 29,
	behavioral: 11, // +assertion_count_regression, +assertion_value_swap (test-oracle integrity, 2026-07-09)
	spec_ledger: 5, // cross-file ledger kinds emitting source "spec" (deep-round #10, 2026-07-16)
};
// +8 Bun-regression detector pack wired (assert-erasure ×3, reinterpret ×2, placeholder-const, unsafe-span ×2), 2026-07-20
// +raw_control_bytes (2026-07-25)
const EXPECTED_TOTAL = 399; // +single_use_trivial_helper (over-extraction detector — the counterweight to the complexity caps, advisory post, 2026-09-03); prior: 398 = +placeholder_test (existed as a detector + verify-pipeline wiring but was never a CHECK_REGISTRY entry — registered pre_block/error alongside its STRICT-mode siblings, 2026-09-03); prior: 397 = +new_export_without_importer, +extracted_helper_duplicate (helper-hygiene wave, 2026-09-01); prior: 395 = +dead_type_exports, +duplicate_type_declaration (type-redundancy wave, 2026-09-01); prior: 393 = +fetch_without_abort_signal, +public_api_leaks_internal_type (Effect second-look wave, 2026-09-01); prior: 391 = +tag_reflection_type_check (2026-08-22); prior: 390 = −type_smuggling (VERIFY_ONLY demotion — daemon RSS-spike root cause, 2026-08-22); prior: 391 = +python_portability_trap (Plan 25 Python parity, 2026-08-17); prior: 390 = +dynamic_code_execution, +builtin_prototype_mutation, +float_equality_comparison, +test_contract_annotation, +unvalidated_input_boundary (Plan 25 lanes 6-8, 2026-08-17) + new_import_cycle (Plan 25 lane 5, stale pin reconciled same day); prior: 384 = +conditional_empty_object_spread, +unknown_type_alias (2026-08-14); prior: 382 = +test_legitimacy (2026-08-13); prior: 381 = +homedir_write_escape (2026-08-10); prior: 380 = +anonymous_registration (2026-08-10); prior: 379 = +type_predicate_drift (2026-08-09); prior: 378 = +timing_flake (2026-08-06); prior: 377 = +procfs_probe_in_test (2026-07-31)

// Ids per family, mirroring getCheckInventory's own sources — so the union/overlap
// assertions verify the DISTINCT total against reality, not a restated sum.
const FAMILY_IDS: Record<string, string[]> = {
	inline: CHECK_REGISTRY.map((c) => c.id),
	sequence: ALL_SEQUENCE_DETECTORS.map((d) => d.id),
	structural: Object.keys(STRUCTURAL_CHECK_META),
	tool_quality: Object.keys(QUALITY_CHECK_META),
	suggestion: Object.keys(SUGGESTION_CHECK_META),
	behavioral: Object.keys(BEHAVIORAL_CHECK_META),
	spec_ledger: SPEC_LEDGER_CHECK_KINDS.map((k) => `spec_${k}`),
};

describe("check inventory — single source of truth for check counts", () => {
	const { families, total } = getCheckInventory();

	it("pins every per-family count", () => {
		const actual = Object.fromEntries(families.map((f) => [f.key, f.count]));
		expect(actual).toEqual(EXPECTED_BY_FAMILY);
	});

	it("pins the grand total", () => {
		expect(total).toBe(EXPECTED_TOTAL);
	});

	it("the total is the DISTINCT union of ids across families (shared ids counted once)", () => {
		const union = new Set(Object.values(FAMILY_IDS).flat());
		expect(total).toBe(union.size);
	});

	it("the gross per-family sum exceeds the distinct total by exactly the cross-family ids", () => {
		const gross = families.reduce((n, f) => n + f.count, 0);
		const grossExpected = Object.values(EXPECTED_BY_FAMILY).reduce((n, v) => n + v, 0);
		expect(gross).toBe(grossExpected); // 392 — dead_exports counted in both inline and structural
		expect(gross - total).toBe(1); // exactly one id spans two families
	});

	it("pins the exact set of ids that span multiple counted families", () => {
		const byId = new Map<string, string[]>();
		for (const [family, ids] of Object.entries(FAMILY_IDS)) {
			for (const id of ids) byId.set(id, [...(byId.get(id) ?? []), family]);
		}
		const crossFamily = [...byId.entries()]
			.filter(([, fams]) => fams.length > 1)
			.map(([id]) => id)
			.sort();
		// dead_exports has an inline (agent-clarity) AND a structural variant; any
		// NEW cross-family id must be a deliberate, reviewed addition.
		expect(crossFamily).toEqual(["dead_exports"]);
	});

	it("the pinned family set matches the inventory's family set (no family added/dropped silently)", () => {
		expect(families.map((f) => f.key).sort()).toEqual(
			Object.keys(EXPECTED_BY_FAMILY).sort(),
		);
	});

	it("every family has a positive count, a label, and a traceable source", () => {
		for (const f of families) {
			expect(f.count, `${f.key} count`).toBeGreaterThan(0);
			expect(f.label, `${f.key} label`).toBeTruthy();
			expect(f.source, `${f.key} source`).toBeTruthy();
		}
	});

	it("family keys are unique", () => {
		const keys = families.map((f) => f.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("the inline family equals CHECK_REGISTRY exactly (authoritative runtime count)", () => {
		const inline = families.find((f) => f.key === "inline");
		expect(inline?.count).toBe(CHECK_REGISTRY.length);
	});

	// Guards the deliberate exclusion: GENERIC_CHECK_META is the documentation
	// view of a SUBSET of the inline registry (not a disjoint family), so it must
	// NOT be summed into the total. This pins that it still overlaps the registry
	// heavily — if that ever stops being true it needs reclassifying.
	it("GENERIC_CHECK_META is a doc-subset of the inline registry, not a separate family", () => {
		const registryIds = new Set(CHECK_REGISTRY.map((c) => c.id));
		const overlap = Object.keys(GENERIC_CHECK_META).filter((k) => registryIds.has(k));
		expect(overlap.length).toBeGreaterThan(100);
	});
});
