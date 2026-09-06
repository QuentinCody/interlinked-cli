// ===========================================
// Plan 00 exit gate G4 — product declarations ≡ the design-time reference
// ===========================================
// The public reference snapshot carries the frozen design declarations. It
// travels with these tests because operator design docs live in a private
// repository and are absent from public checkouts. Intentional public contract
// changes update the snapshot with the product declarations (decision D1).
//
// The first version of this file compared a HAND-LISTED set of types, which
// proved nothing about completeness: a type exported on one side only was
// invisible unless somebody remembered to add a line, and `ShadowExecConfigV1`
// had been missing from that list since it landed. The comparison is now
// DERIVED — both exported-name sets are read out of the source at test time —
// so a name added or removed on either side fails here without an edit.
//
// Three layers, cheapest first:
//   1. name sets, derived (below), with a named allowlist for the two
//      legitimate directions of difference;
//   2. the three runtime tables, value-by-value and key-set-by-key-set;
//   3. a handful of `Equal<>` assertions on the shapes where STRUCTURE, not
//      just the name, is load-bearing — the bindings and the outcome union.
// Record-level completeness (every record has a parser and a schema) is the
// registry's job: `../registry.test.ts`.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	BINDING_PROVENANCE as REF_PROVENANCE,
	DOMAIN_PURPOSE as REF_DOMAIN_PURPOSE,
	REASON_PHASES as REF_REASON_PHASES,
} from "../../__fixtures__/reference-schema.js";
import type * as Ref from "../../__fixtures__/reference-schema.js";
import { BINDING_PROVENANCE } from "../provenance.js";
import { REASON_PHASES } from "../reason-phases.js";
import { DOMAIN_PURPOSE } from "../signing-domains.js";
import type * as Binding from "../types-binding.js";
import type * as Outcome from "../types-outcome.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_DIR = join(HERE, "..");
const REFERENCE = join(HERE, "../../__fixtures__/reference-schema.ts");

const TYPE_MODULES = [
	"types-attestation.ts",
	"types-binding.ts",
	"types-core.ts",
	"types-lifecycle.ts",
	"types-outcome.ts",
	"types-transport.ts",
];

/** Bounded, line-anchored scan for top-level exports of one kind. */
function exportedNames(source: string, kind: "interface|type" | "const"): string[] {
	const pattern = new RegExp(`^export (?:${kind}) ([A-Za-z0-9_]+)`);
	const names: string[] = [];
	for (const line of source.split("\n")) {
		const match = pattern.exec(line);
		if (match?.[1] !== undefined) names.push(match[1]);
	}
	return names;
}

function referenceSource(): string {
	return readFileSync(REFERENCE, "utf8");
}

function productTypeNames(): string[] {
	return TYPE_MODULES.flatMap((file) => exportedNames(readFileSync(join(PROTOCOL_DIR, file), "utf8"), "interface|type"));
}

/** Every non-test module of the package — the reference's runtime tables may
 *  live in any of them, so the const check must not guess which. */
function productConstNames(): string[] {
	return readdirSync(PROTOCOL_DIR)
		.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
		.flatMap((file) => exportedNames(readFileSync(join(PROTOCOL_DIR, file), "utf8"), "const"));
}

// ── the two legitimate directions of difference ────────────────────────────
// A name leaves the comparison ONLY through this table, with a reason. The
// alternative — quietly narrowing what is compared — is exactly the failure
// mode that let ShadowExecConfigV1 sit unpinned.

/** Declared by the product, written inline in the reference. Naming a shape
 *  the reference spells out anonymously is a refinement, not a divergence. */
const PRODUCT_ONLY_EXPORTS: readonly (readonly [name: string, reason: string])[] = [
	["MultiEditEntryV1", "reference inlines the MultiEdit `edits` element as an anonymous object (schema.ts L132)"],
	["ApplyPatchSourceField", "reference inlines the apply_patch `raw_source_field` literal union (schema.ts L133)"],
	["ToolInputSchema", 'reference repeats the "shadow-tool-input-v1" literal on each NormalizedToolInputV1 variant'],
	["ExecutionProfileId", 'reference repeats the "shadow-typecheck-v1" literal at each use site'],
];

function excused(table: readonly (readonly [string, string])[]): Set<string> {
	return new Set(table.map(([name]) => name));
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

/** Structure, not just the name: the two bindings and the outcome union are
 *  what every verdict is computed from, so a silent field change in either
 *  must fail the TYPECHECK, not only the name comparison. */
export type ReferenceParity = [
	Expect<Equal<Binding.ShadowExecutionBinding, Ref.ShadowExecutionBinding>>,
	Expect<Equal<Binding.ShadowFreshnessBinding, Ref.ShadowFreshnessBinding>>,
	Expect<Equal<Binding.ExecutionBindingLeaf, Ref.ExecutionBindingLeaf>>,
	Expect<Equal<Binding.ProvenanceLeaf, Ref.ProvenanceLeaf>>,
	Expect<Equal<Binding.LeafContract, Ref.LeafContract>>,
	Expect<Equal<Outcome.ShadowOutcome, Ref.ShadowOutcome>>,
	Expect<Equal<Outcome.CompletedShadowOutcome, Ref.CompletedShadowOutcome>>,
	Expect<Equal<Outcome.BindingFieldMismatchV1, Ref.BindingFieldMismatchV1>>,
];

describe("reference parity — derived name sets (G4) — positive (must hold)", () => {
	it("P1: the exported TYPE names match, name for name, once the allowlists are applied", () => {
		const product = productTypeNames().filter((name) => !excused(PRODUCT_ONLY_EXPORTS).has(name));
		const reference = exportedNames(referenceSource(), "interface|type");
		expect([...new Set(product)].sort()).toEqual([...new Set(reference)].sort());
	});

	it("P2: every runtime table the reference exports also exists in the product package", () => {
		const product = new Set(productConstNames());
		for (const name of exportedNames(referenceSource(), "const")) {
			expect(product.has(name), name).toBe(true);
		}
	});

	it("P3: the product declares no duplicate type name across its six type modules", () => {
		const names = productTypeNames();
		expect(new Set(names).size).toBe(names.length);
	});

	it("P4: every allowlist entry names a real export and carries a reason", () => {
		const product = new Set(productTypeNames());
		const reference = new Set(exportedNames(referenceSource(), "interface|type"));
		for (const [name, reason] of PRODUCT_ONLY_EXPORTS) {
			expect(product.has(name), name).toBe(true);
			expect(reference.has(name), `${name} must be absent from the reference to be product-only`).toBe(false);
			expect(reason.length, name).toBeGreaterThan(20);
		}
	});
});

describe("reference parity — derived name sets (G4) — negative (must not hold)", () => {
	it("N1: a type exported by the product alone FAILS the comparison when it is not allowlisted", () => {
		const product = [...productTypeNames(), "UnportedShapeV1"].filter(
			(name) => !excused(PRODUCT_ONLY_EXPORTS).has(name),
		);
		const reference = exportedNames(referenceSource(), "interface|type");
		expect([...new Set(product)].sort()).not.toEqual([...new Set(reference)].sort());
	});

	it("N2: a type dropped from the product FAILS the comparison", () => {
		const product = productTypeNames().filter(
			(name) => !excused(PRODUCT_ONLY_EXPORTS).has(name) && name !== "ShadowExecutionBinding",
		);
		const reference = exportedNames(referenceSource(), "interface|type");
		expect([...new Set(product)].sort()).not.toEqual([...new Set(reference)].sort());
	});

	it("N3: the reference contains no duplicate exported type names", () => {
		const names = exportedNames(referenceSource(), "interface|type");
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("reference parity — runtime tables (G4) — positive (must hold)", () => {
	it("P5: BINDING_PROVENANCE is value-identical to the reference table", () => {
		expect(BINDING_PROVENANCE).toEqual(REF_PROVENANCE);
	});

	it("P6: REASON_PHASES is value-identical to the reference table", () => {
		expect(REASON_PHASES).toEqual(REF_REASON_PHASES);
	});

	it("P7: DOMAIN_PURPOSE is value-identical to the reference table", () => {
		expect(DOMAIN_PURPOSE).toEqual(REF_DOMAIN_PURPOSE);
	});

	it("P8: the tables have the same KEY SETS, so neither side grew a leaf alone", () => {
		expect(Object.keys(BINDING_PROVENANCE).sort()).toEqual(Object.keys(REF_PROVENANCE).sort());
		expect(Object.keys(REASON_PHASES).sort()).toEqual(Object.keys(REF_REASON_PHASES).sort());
		expect(Object.keys(DOMAIN_PURPOSE).sort()).toEqual(Object.keys(REF_DOMAIN_PURPOSE).sort());
	});
});
