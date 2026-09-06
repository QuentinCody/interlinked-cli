// ===========================================
// The published key sets of `parse-outcome.ts` are the parser's OWN tables
// ===========================================
// The point of publishing them is that `registry.ts` and the generated JSON
// Schema can be checked against what the parser actually enforces. That only
// holds while the published arrays ARE the parser's arrays — a copy would pass
// every key comparison on the day it was written and drift silently after.
// These cases pin identity, not equality.

import { describe, expect, it } from "vitest";
import {
	ATTESTATION_FIELDS,
	BINDING_MISMATCH_FIELDS,
	COMPLETE_RESULT_FIELDS,
	COMPLETED_SHAPES,
	OTHER_UNAVAILABLE_FIELDS,
} from "./parse-outcome.js";
import { RECORD_FIELD_TABLES } from "./parse-outcome-tables.js";

function keysOf(table: readonly (readonly [string, unknown])[]): string[] {
	return table.map(([key]) => key);
}

describe("parse-outcome published key sets — positive (must hold)", () => {
	it("P1: publishes exactly the three record ids this module parses", () => {
		expect(Object.keys(RECORD_FIELD_TABLES).sort()).toEqual(["attestation", "outcome", "verifier_result"]);
	});

	it("P2: every published table is the parser's own array by reference, never a copy", () => {
		expect(RECORD_FIELD_TABLES.verifier_result?.[0]).toBe(COMPLETE_RESULT_FIELDS);
		expect(RECORD_FIELD_TABLES.attestation?.[0]).toBe(ATTESTATION_FIELDS);
		const outcome = RECORD_FIELD_TABLES.outcome ?? [];
		for (const shape of Object.values(COMPLETED_SHAPES)) expect(outcome).toContain(shape);
		expect(outcome).toContain(BINDING_MISMATCH_FIELDS);
		expect(outcome).toContain(OTHER_UNAVAILABLE_FIELDS);
	});

	it("P3: the outcome union publishes one table per variant its dispatchers accept", () => {
		expect(RECORD_FIELD_TABLES.outcome?.length).toBe(Object.keys(COMPLETED_SHAPES).length + 2);
	});
});

describe("parse-outcome published key sets — negative (must not hold)", () => {
	it("N1: no record publishes an empty variant list", () => {
		for (const [id, tables] of Object.entries(RECORD_FIELD_TABLES)) {
			expect(tables.length, id).toBeGreaterThan(0);
			for (const table of tables) expect(table.length, id).toBeGreaterThan(0);
		}
	});

	it("N2: no variant declares the same key twice — a repeated key makes the published set lie", () => {
		for (const [id, tables] of Object.entries(RECORD_FIELD_TABLES)) {
			for (const table of tables) {
				const keys = keysOf(table);
				expect(new Set(keys).size, `${id}: ${keys.join(",")}`).toBe(keys.length);
			}
		}
	});
});
