// Companion test for the DERIVED GENERIC_CHECK_META.
//
// This file replaces generic-fragments.test.ts and the per-fragment
// content-lock / mutation-kill suites. Those pinned that ~15 hand-written
// metadata fragments held verbatim copies of the CHECK_REGISTRY strings — a
// pin on the duplication itself, which no longer exists. What is worth
// pinning now is the behavior of the merged view:
//
//   1. derivation is LIVE — every registered check's documented fields equal
//      its registration, so the two can never drift again;
//   2. the two hand-written overlays (annotations, unregistered ids) apply
//      exactly, and neither can silently shadow or orphan a registry entry;
//   3. both runtime consumers see the same determinism value.

import { describe, expect, it } from "vitest";
import { buildGenericCheckMeta } from "../check-registry/builders.js";
import { CHECK_REGISTRY } from "../check-registry/registry.js";
import {
	composeGenericCheckMeta,
	GENERIC_CHECK_META,
	GENERIC_CHECK_META_OVERLAYS,
} from "./generic.js";

const { annotations, unregistered } = GENERIC_CHECK_META_OVERLAYS;
const REGISTRY_IDS = new Set(CHECK_REGISTRY.map((c) => c.id));

describe("GENERIC_CHECK_META derivation", () => {
	it("carries an entry for every CHECK_REGISTRY id", () => {
		const missing = CHECK_REGISTRY.map((c) => c.id).filter((id) => !(id in GENERIC_CHECK_META));
		expect(missing).toEqual([]);
	});

	it("copies name/description/tier/determinism verbatim from the registration", () => {
		const mismatches = CHECK_REGISTRY.flatMap((c) => {
			const meta = GENERIC_CHECK_META[c.id];
			if (!meta) return [];
			return (["name", "description", "tier", "determinism"] as const)
				.filter((field) => meta[field] !== c[field])
				.map((field) => `${c.id}.${field}`);
		});
		expect(mismatches).toEqual([]);
	});

	it("is a superset of the derived table (registry ids plus the unregistered ones)", () => {
		const expected = new Set([
			...Object.keys(buildGenericCheckMeta()),
			...Object.keys(unregistered),
		]);
		expect(new Set(Object.keys(GENERIC_CHECK_META))).toEqual(expected);
	});

	it("every entry has the CheckMeta shape", () => {
		for (const [id, entry] of Object.entries(GENERIC_CHECK_META)) {
			expect(entry.name.length, `${id}.name`).toBeGreaterThan(0);
			expect(entry.description.length, `${id}.description`).toBeGreaterThan(0);
			expect([1, 2, 3], `${id}.tier`).toContain(entry.tier);
			expect(
				["fully_deterministic", "partially_deterministic", "heuristic"],
				`${id}.determinism`,
			).toContain(entry.determinism);
		}
	});
});

describe("GENERIC_CHECK_META overlays", () => {
	it("applies every annotation to an existing entry", () => {
		for (const [id, extra] of Object.entries(annotations)) {
			const entry = GENERIC_CHECK_META[id];
			expect(entry, `annotation for unknown id ${id}`).toBeDefined();
			if (extra.asi !== undefined) expect(entry?.asi).toBe(extra.asi);
			if (extra.externality !== undefined) expect(entry?.externality).toBe(extra.externality);
		}
	});

	it("pins the annotated id set (asi + externality)", () => {
		const annotated = Object.entries(GENERIC_CHECK_META)
			.filter(([, m]) => m.asi !== undefined || m.externality !== undefined)
			.map(([id]) => id)
			.sort();
		expect(annotated).toEqual(
			[
				"dangerously_set_inner_html",
				"endpoint_auth_missing",
				"endpoint_idor_shape",
				"endpoint_mass_assignment",
				"endpoint_missing_tenant_filter",
				"endpoint_ssrf_shape",
				"eval_usage",
				"inner_html",
			].sort(),
		);
	});

	it("an annotation never invents fields the registry already supplies", () => {
		for (const [id, extra] of Object.entries(annotations)) {
			const derivedEntry = buildGenericCheckMeta()[id];
			if (!derivedEntry) continue;
			expect(GENERIC_CHECK_META[id]?.name, `${id}.name`).toBe(derivedEntry.name);
			expect(GENERIC_CHECK_META[id]?.description, `${id}.description`).toBe(
				derivedEntry.description,
			);
			expect(Object.keys(extra).every((k) => k === "asi" || k === "externality")).toBe(true);
		}
	});

	it("throws when the annotation overlay names an id absent from both derived and unregistered tables", () => {
		expect(() =>
			composeGenericCheckMeta({ nonexistent_check_id: { asi: "ASI05" } }),
		).toThrow(
			'ANNOTATION_OVERLAY names unknown check id "nonexistent_check_id" — it is neither registered in CHECK_REGISTRY nor listed in UNREGISTERED_CHECK_META.',
		);
	});

	it("unregistered ids do not shadow a registered check", () => {
		const shadowing = Object.keys(unregistered).filter((id) => REGISTRY_IDS.has(id));
		expect(shadowing).toEqual([]);
	});

	it("pins the unregistered id set", () => {
		expect(Object.keys(unregistered).sort()).toEqual([
			"c_strcmp_boolean_misuse",
			"c_unchecked_malloc",
			"complexity",
			"gitignored_written_config",
			"spec_path_ref",
		]);
	});
});

describe("runtime consumer agreement", () => {
	// warning-formatter.ts reads buildGenericCheckMeta(); the PostToolUse
	// quality phase reads GENERIC_CHECK_META. Before the derivation these were
	// two hand-kept tables and could disagree about a check's determinism —
	// which decides the [proven] / [heuristic] tag the agent sees.
	it("both determinism tables agree on every shared id", () => {
		const derived = buildGenericCheckMeta();
		const disagreements = Object.keys(derived).filter(
			(id) => derived[id]?.determinism !== GENERIC_CHECK_META[id]?.determinism,
		);
		expect(disagreements).toEqual([]);
	});
});
