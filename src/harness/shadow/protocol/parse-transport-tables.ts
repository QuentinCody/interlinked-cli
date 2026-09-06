// ===========================================
// Shadow protocol v1 — the published key sets of `parse-transport.ts`
// ===========================================
// The SAME tables `parse-transport.ts` validates against, keyed by the `where`
// label each parser passes to `parseRecord`, with one entry per union variant.
// Publishing them is what lets `registry.ts` state a record's declared key set
// instead of naming a parser and stopping there — and what lets
// `registry.test.ts` prove the generated JSON Schema and the parser agree about
// which fields a record has. These arrays are REFERENCES to the parser's own
// tables, never copies: a second key list is the drift this export removes.
//
// It sits beside `parse-transport.ts` rather than inside it because that module
// has no room under the 500-line cap (`large-file-policy.ts`) for a map this
// size. The names it re-uses are exported from the parser for this importer.

import type { FieldSpec } from "./parse-core-entries.js";
import {
	ACCEPTED_FINALIZE_FIELDS,
	CANCEL_ACK_FIELDS,
	CANCEL_REQUEST_FIELDS,
	CONFLICT_FINALIZE_FIELDS,
	EXECUTION_REQUEST_FIELDS,
	FINALIZE_STATUS_SHAPES,
	IN_FLIGHT_STATUS_FIELDS,
	INPUT_FINALIZE_OK_FIELDS,
	INPUT_FINALIZE_REFUSED_FIELDS,
	INPUT_FINALIZE_REQUEST_FIELDS,
	INPUT_PREPARE_REQUEST_FIELDS,
	MANIFEST_UPLOAD_INIT_REQUEST_FIELDS,
	MANIFEST_UPLOAD_INIT_RESPONSE_FIELDS,
	MIRROR_FINALIZE_REQUEST_FIELDS,
	MIRROR_PREPARE_REQUEST_FIELDS,
	MISSING_BLOB_PAGE_REQUEST_FIELDS,
	MISSING_BLOB_PAGE_RESPONSE_FIELDS,
	MISSING_PAGE_FIELDS,
	PREPARE_RESPONSE_FIELDS,
	REFUSED_FINALIZE_FIELDS,
} from "./parse-transport.js";

export const RECORD_FIELD_TABLES: Record<string, readonly (readonly FieldSpec[])[]> = {
	manifest_upload_init_request: [MANIFEST_UPLOAD_INIT_REQUEST_FIELDS],
	manifest_upload_init_response: [MANIFEST_UPLOAD_INIT_RESPONSE_FIELDS],
	missing_blob_page: [MISSING_PAGE_FIELDS],
	missing_blob_page_request: [MISSING_BLOB_PAGE_REQUEST_FIELDS],
	missing_blob_page_response: [MISSING_BLOB_PAGE_RESPONSE_FIELDS],
	mirror_prepare_request: [MIRROR_PREPARE_REQUEST_FIELDS],
	// One table, two records: prepare and input-prepare answer identically.
	mirror_prepare_response: [PREPARE_RESPONSE_FIELDS],
	input_prepare_response: [PREPARE_RESPONSE_FIELDS],
	mirror_finalize_request: [MIRROR_FINALIZE_REQUEST_FIELDS],
	mirror_finalize_response: [ACCEPTED_FINALIZE_FIELDS, CONFLICT_FINALIZE_FIELDS, REFUSED_FINALIZE_FIELDS],
	// The two terminal states carry a payload; every in-flight state is bare, so
	// the bare shape is one published variant rather than five.
	mirror_finalize_status: [...Object.values(FINALIZE_STATUS_SHAPES), IN_FLIGHT_STATUS_FIELDS],
	input_prepare_request: [INPUT_PREPARE_REQUEST_FIELDS],
	input_finalize_request: [INPUT_FINALIZE_REQUEST_FIELDS],
	input_finalize_response: [INPUT_FINALIZE_OK_FIELDS, INPUT_FINALIZE_REFUSED_FIELDS],
	execution_request: [EXECUTION_REQUEST_FIELDS],
	cancel_request: [CANCEL_REQUEST_FIELDS],
	cancel_ack: [CANCEL_ACK_FIELDS],
};
