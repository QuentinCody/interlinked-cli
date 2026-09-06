// ===========================================
// The published key sets of `parse-transport.ts` are the parser's OWN tables
// ===========================================
// Seventeen records, one of them a state machine. The published map is only
// useful to `registry.ts` and the schema comparison while it holds the parser's
// own arrays: a copy would agree on the day it was written and drift after.
// These cases pin identity and completeness, not equality.
//
// Four ids left this map with their parsers in the 2026-09-04 public/private
// split — `idempotency_record`, `publication_attempt`, `mirror_version_record`
// and `job_state` are broker-internal and now live in `interlinked-cloud`.

import { describe, expect, it } from "vitest";
import {
	ACCEPTED_FINALIZE_FIELDS,
	CANCEL_ACK_FIELDS,
	CONFLICT_FINALIZE_FIELDS,
	EXECUTION_REQUEST_FIELDS,
	FINALIZE_STATUS_SHAPES,
	IN_FLIGHT_STATUS_FIELDS,
	PREPARE_RESPONSE_FIELDS,
	REFUSED_FINALIZE_FIELDS,
} from "./parse-transport.js";
import { RECORD_FIELD_TABLES } from "./parse-transport-tables.js";

const TRANSPORT_IDS = [
	"cancel_ack",
	"cancel_request",
	"execution_request",
	"input_finalize_request",
	"input_finalize_response",
	"input_prepare_request",
	"input_prepare_response",
	"manifest_upload_init_request",
	"manifest_upload_init_response",
	"mirror_finalize_request",
	"mirror_finalize_response",
	"mirror_finalize_status",
	"mirror_prepare_request",
	"mirror_prepare_response",
	"missing_blob_page",
	"missing_blob_page_request",
	"missing_blob_page_response",
];

describe("parse-transport published key sets — positive (must hold)", () => {
	it("P1: publishes exactly the seventeen record ids this module parses", () => {
		expect(Object.keys(RECORD_FIELD_TABLES).sort()).toEqual(TRANSPORT_IDS);
	});

	it("P2: single-shape records publish the parser's own array by reference", () => {
		expect(RECORD_FIELD_TABLES.execution_request?.[0]).toBe(EXECUTION_REQUEST_FIELDS);
		expect(RECORD_FIELD_TABLES.cancel_ack?.[0]).toBe(CANCEL_ACK_FIELDS);
	});

	it("P3: the two prepare responses publish the ONE table the parser shares between them", () => {
		expect(RECORD_FIELD_TABLES.mirror_prepare_response?.[0]).toBe(PREPARE_RESPONSE_FIELDS);
		expect(RECORD_FIELD_TABLES.input_prepare_response?.[0]).toBe(PREPARE_RESPONSE_FIELDS);
	});

	it("P4: every state machine publishes one table per state its dispatcher accepts", () => {
		// The finalize status adds the bare in-flight shape to its two terminals.
		expect(RECORD_FIELD_TABLES.mirror_finalize_status?.length).toBe(Object.keys(FINALIZE_STATUS_SHAPES).length + 1);
		expect(RECORD_FIELD_TABLES.mirror_finalize_status).toContain(IN_FLIGHT_STATUS_FIELDS);
	});

	it("P5: the finalize response publishes all three of its accepted/conflict/refused shapes", () => {
		const tables = RECORD_FIELD_TABLES.mirror_finalize_response ?? [];
		expect(tables).toContain(ACCEPTED_FINALIZE_FIELDS);
		expect(tables).toContain(CONFLICT_FINALIZE_FIELDS);
		expect(tables).toContain(REFUSED_FINALIZE_FIELDS);
	});
});

describe("parse-transport published key sets — negative (must not hold)", () => {
	it("N1: no record publishes an empty variant list, and no variant is empty", () => {
		for (const [id, tables] of Object.entries(RECORD_FIELD_TABLES)) {
			expect(tables.length, id).toBeGreaterThan(0);
			for (const table of tables) expect(table.length, id).toBeGreaterThan(0);
		}
	});

	it("N2: no variant declares the same key twice — a repeated key makes the published set lie", () => {
		for (const [id, tables] of Object.entries(RECORD_FIELD_TABLES)) {
			for (const table of tables) {
				const keys = table.map(([key]) => key);
				expect(new Set(keys).size, `${id}: ${keys.join(",")}`).toBe(keys.length);
			}
		}
	});
});
