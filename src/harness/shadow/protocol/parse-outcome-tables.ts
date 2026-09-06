// ===========================================
// Shadow protocol v1 — the published key sets of `parse-outcome.ts`
// ===========================================
// The SAME tables `parse-outcome.ts` validates against, keyed by the `where`
// label each parser passes to `parseRecord`, with one entry per union variant.
// Publishing them is what lets `registry.ts` state a record's declared key set
// instead of naming a parser and stopping there — and what lets
// `registry.test.ts` prove the generated JSON Schema and the parser agree about
// which fields a record has. These arrays are REFERENCES to the parser's own
// tables, never copies: a second key list is the drift this export removes.
//
// It sits beside `parse-outcome.ts` rather than inside it only because that
// module is AT the 500-line cap (`large-file-policy.ts`), so the constant could
// not be added there. The five names it re-uses are exported for this importer.

import type { FieldSpec } from "./parse-core-entries.js";
import {
	ATTESTATION_FIELDS,
	BINDING_MISMATCH_FIELDS,
	COMPLETE_RESULT_FIELDS,
	COMPLETED_SHAPES,
	OTHER_UNAVAILABLE_FIELDS,
} from "./parse-outcome.js";

export const RECORD_FIELD_TABLES: Record<string, readonly (readonly FieldSpec[])[]> = {
	verifier_result: [COMPLETE_RESULT_FIELDS],
	attestation: [ATTESTATION_FIELDS],
	// The outcome union: four completed shapes keyed by `kind`, then the two
	// unavailable shapes — `binding_mismatch` and every other reason.
	outcome: [...Object.values(COMPLETED_SHAPES), BINDING_MISMATCH_FIELDS, OTHER_UNAVAILABLE_FIELDS],
};
