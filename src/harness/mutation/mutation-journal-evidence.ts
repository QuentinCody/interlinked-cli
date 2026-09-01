// ======================================================
// Durable mutation journal — authenticated evidence rows
// ======================================================

import {
	asRow,
	bytesField,
	normalizeRetainedEvidence,
	nullableString,
	numberField,
	stringField,
} from "./mutation-journal-codec.js";
import type { SqliteDatabase } from "./mutation-journal-driver.js";
import type {
	JournalRetainedCanonicalJson,
	JournalRetainedEvidence,
	JournalRetainedReport,
} from "./mutation-journal-types.js";

function nullableJson(
	row: Record<string, unknown>,
	jsonKey: string,
	hashKey: string,
): JournalRetainedCanonicalJson | null {
	const canonicalJson = nullableString(row, jsonKey);
	const sha256 = nullableString(row, hashKey);
	if (canonicalJson === null && sha256 === null) return null;
	if (canonicalJson === null || sha256 === null) {
		throw new Error(`mutation evidence row has an incomplete ${jsonKey}/${hashKey} pair`);
	}
	return { canonicalJson, sha256 };
}

function nullableReport(row: Record<string, unknown>): JournalRetainedReport | null {
	const sha256 = nullableString(row, "report_sha256");
	if (row.report_bytes === null && sha256 === null) return null;
	if (row.report_bytes === null || sha256 === null) {
		throw new Error("mutation evidence row has an incomplete report_bytes/report_sha256 pair");
	}
	return { bytes: bytesField(row, "report_bytes"), sha256 };
}

function evidenceFromRow(row: Record<string, unknown>): JournalRetainedEvidence {
	return normalizeRetainedEvidence({
		formatVersion: numberField(row, "format_version"),
		envelope: {
			canonicalJson: stringField(row, "envelope_json"),
			sha256: stringField(row, "envelope_sha256"),
		},
		acceptanceReceipt: {
			canonicalJson: stringField(row, "acceptance_receipt_json"),
			sha256: stringField(row, "acceptance_receipt_sha256"),
		},
		executionReceipt: nullableJson(row, "execution_receipt_json", "execution_receipt_sha256"),
		terminalizationRecord: nullableJson(
			row,
			"terminalization_record_json",
			"terminalization_record_sha256",
		),
		report: nullableReport(row),
	});
}

function canonicalEqual(
	left: JournalRetainedCanonicalJson | null,
	right: JournalRetainedCanonicalJson | null,
): boolean {
	if (left === null || right === null) return left === right;
	return left.canonicalJson === right.canonicalJson && left.sha256 === right.sha256;
}

function reportEqual(left: JournalRetainedReport | null, right: JournalRetainedReport | null): boolean {
	if (left === null || right === null) return left === right;
	return left.sha256 === right.sha256 && Buffer.from(left.bytes).equals(Buffer.from(right.bytes));
}

export function insertRetainedEvidence(
	db: SqliteDatabase,
	evaluationId: number,
	evidence: JournalRetainedEvidence,
): void {
	db.prepare(`INSERT INTO mutation_evidence_bundles (
		evaluation_id, format_version, envelope_json, envelope_sha256,
		acceptance_receipt_json, acceptance_receipt_sha256,
		execution_receipt_json, execution_receipt_sha256,
		terminalization_record_json, terminalization_record_sha256,
		report_bytes, report_sha256
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		evaluationId,
		evidence.formatVersion,
		evidence.envelope.canonicalJson,
		evidence.envelope.sha256,
		evidence.acceptanceReceipt.canonicalJson,
		evidence.acceptanceReceipt.sha256,
		evidence.executionReceipt?.canonicalJson ?? null,
		evidence.executionReceipt?.sha256 ?? null,
		evidence.terminalizationRecord?.canonicalJson ?? null,
		evidence.terminalizationRecord?.sha256 ?? null,
		evidence.report === null ? null : Uint8Array.from(evidence.report.bytes),
		evidence.report?.sha256 ?? null,
	);
}

export function readRetainedEvidence(db: SqliteDatabase, evaluationId: number): JournalRetainedEvidence {
	const found = db.prepare("SELECT * FROM mutation_evidence_bundles WHERE evaluation_id = ?")
		.get(evaluationId);
	return evidenceFromRow(asRow(found, "retained evidence"));
}

export function retainedEvidenceMatches(
	db: SqliteDatabase,
	evaluationId: number,
	expected: JournalRetainedEvidence,
): boolean {
	const actual = readRetainedEvidence(db, evaluationId);
	return canonicalEqual(actual.envelope, expected.envelope) &&
		canonicalEqual(actual.acceptanceReceipt, expected.acceptanceReceipt) &&
		canonicalEqual(actual.executionReceipt, expected.executionReceipt) &&
		canonicalEqual(actual.terminalizationRecord, expected.terminalizationRecord) &&
		reportEqual(actual.report, expected.report);
}
