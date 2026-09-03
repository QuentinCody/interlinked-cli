// ===========================================
// Protocol v3 — structural mutation-report schema
// ===========================================
// Review 2026-08-31 fourth pass: the report is a VERSIONED STRUCTURAL
// SCHEMA, not text to grep. The verifier proves the retrieved bytes match
// BOTH pointer hashes (r2_sha256 AND content_hash bind the same object in
// 3.0), then that the report's rows correspond EXACTLY to the envelope:
// the target file has a structural entry; its non-excluded rows equal the
// envelope's mutant rows (full identity provenance AND statuses); its excluded rows equal the
// envelope's exclusion rows; not_mutatable requires the target present
// with an exact zero-mutant result. `buildStructuralReport` is the shared
// canonical builder — the producer emits this shape, tests use it.
//
// Report schema (report_version "1"):
//   { report_version: "1",
//     files: { [repoRelativePath]: { mutants: [
//       { full identity provenance, status, policy_id? }
//     ] } } }

import { createHash } from "node:crypto";
import {
	checkBoundedString,
	checkBoundedText,
	checkPolicyId,
	checkSafeNonNegInt,
	checkSha256Hex,
	firstReason,
	isRecord,
	unknownKeysIn,
} from "./field-checks.js";
import type { ParsedEnvelope } from "./parse.js";
import type { V3Envelope, V3ExcludedRow, V3MutantRow, V3MutantStatus } from "./types.js";
import { V3_MUTANT_STATUSES } from "./types.js";

type ExcludedReportRow = V3ExcludedRow & { status: "excluded" };
type ReportRow = V3MutantRow | ExcludedReportRow;

const EXECUTABLE_ROW_KEYS = [
	"mutant_id",
	"site_id",
	"symbol_id",
	"qualified_name",
	"symbol_context",
	"mutator",
	"original_lexeme",
	"replacement",
	"start_offset",
	"ordinal_within_symbol",
	"status",
] as const;

/** Build the canonical structural report text for one envelope's evidence.
 *  Used by tests and by the producer's reference path. */
export function buildStructuralReport(
	envelope: Pick<V3Envelope, "job"> & { mutants?: V3MutantRow[]; excluded?: V3ExcludedRow[] },
): string {
	const rows: ReportRow[] = [
		...(envelope.mutants ?? []).map((m) => ({ ...m })),
		...(envelope.excluded ?? []).map((e) => ({ ...e, status: "excluded" as const })),
	];
	return JSON.stringify({ report_version: "1", files: { [envelope.job.target_file]: { mutants: rows } } });
}

/** Recursively strict shell (review 2026-08-31 fifth pass): unknown keys
 *  reject at the root and the file entry, and the report carries EXACTLY
 *  the target's entry (v1 DECISION — single-target whole-file protocol). */
function reportShellFailure(raw: unknown, targetFile: string): { mutantRows: unknown[] } | string {
	if (!isRecord(raw) || raw.report_version !== "1") {
		return 'report must carry report_version "1" — a prose mention is not a structural report';
	}
	const rootKeys = unknownKeysIn(raw, ["report_version", "files"], "report");
	if (rootKeys !== null) return rootKeys;
	if (!isRecord(raw.files)) return "report.files must be an object";
	const fileKeys = Object.keys(raw.files);
	if (fileKeys.length !== 1 || fileKeys[0] !== targetFile) {
		return `report.files must carry exactly one entry — the target "${targetFile}"`;
	}
	const entry = raw.files[targetFile];
	if (!isRecord(entry)) {
		return `report has no structural entry for target "${targetFile}" — an omitted target proves nothing`;
	}
	const entryKeys = unknownKeysIn(entry, ["mutants"], `report.files["${targetFile}"]`);
	if (entryKeys !== null) return entryKeys;
	if (!Array.isArray(entry.mutants)) return "report target entry must carry a mutants array";
	return { mutantRows: entry.mutants };
}

type ReportRowShell = Record<string, unknown> & { mutant_id: string; status: string };

function isReportRowShell(row: unknown): row is ReportRowShell {
	return isRecord(row) && typeof row.mutant_id === "string" && typeof row.status === "string";
}

function parseExcludedReportRow(row: ReportRowShell): ExcludedReportRow | string {
	const rowKeys = unknownKeysIn(
		row,
		[...EXECUTABLE_ROW_KEYS.filter((key) => key !== "status"), "policy_id", "status"],
		"report excluded mutant row",
	);
	const shape =
		rowKeys ??
		firstReason([
			checkSha256Hex(row.site_id, "report excluded row.site_id"),
			checkSha256Hex(row.symbol_id, "report excluded row.symbol_id"),
			checkBoundedString(row.qualified_name, "report excluded row.qualified_name"),
			checkBoundedString(row.symbol_context, "report excluded row.symbol_context"),
			checkBoundedString(row.mutator, "report excluded row.mutator"),
			checkBoundedText(row.original_lexeme, "report excluded row.original_lexeme"),
			checkBoundedText(row.replacement, "report excluded row.replacement"),
			checkSafeNonNegInt(row.start_offset, "report excluded row.start_offset"),
			checkSafeNonNegInt(row.ordinal_within_symbol, "report excluded row.ordinal_within_symbol"),
			checkPolicyId(row.policy_id, "report excluded row.policy_id"),
		]);
	if (shape !== null) return shape;
	// SAFETY: the exclusion's full primitive shape was checked above.
	return {
		mutant_id: row.mutant_id,
		site_id: row.site_id as string,
		symbol_id: row.symbol_id as string,
		qualified_name: row.qualified_name as string,
		symbol_context: row.symbol_context as string,
		mutator: row.mutator as string,
		original_lexeme: row.original_lexeme as string,
		replacement: row.replacement as string,
		start_offset: row.start_offset as number,
		ordinal_within_symbol: row.ordinal_within_symbol as number,
		policy_id: row.policy_id as string,
		status: "excluded",
	};
}

function parseExecutableReportRow(row: ReportRowShell): V3MutantRow | string {
	if (!V3_MUTANT_STATUSES.includes(row.status as V3MutantStatus)) {
		return `report mutant status "${row.status}" is not a known status`;
	}
	const shape = firstReason([
		unknownKeysIn(row, [...EXECUTABLE_ROW_KEYS], "report executable mutant row"),
		checkSha256Hex(row.site_id, "report mutant row.site_id"),
		checkSha256Hex(row.symbol_id, "report mutant row.symbol_id"),
		checkBoundedString(row.qualified_name, "report mutant row.qualified_name"),
		checkBoundedString(row.symbol_context, "report mutant row.symbol_context"),
		checkBoundedString(row.mutator, "report mutant row.mutator"),
		checkBoundedText(row.original_lexeme, "report mutant row.original_lexeme"),
		checkBoundedText(row.replacement, "report mutant row.replacement"),
		checkSafeNonNegInt(row.start_offset, "report mutant row.start_offset"),
		checkSafeNonNegInt(row.ordinal_within_symbol, "report mutant row.ordinal_within_symbol"),
	]);
	if (shape !== null) return shape;
	// SAFETY: every V3MutantRow field was validated above and status membership
	// was established before the constructed copy.
	return {
		mutant_id: row.mutant_id,
		site_id: row.site_id as string,
		symbol_id: row.symbol_id as string,
		qualified_name: row.qualified_name as string,
		symbol_context: row.symbol_context as string,
		mutator: row.mutator as string,
		original_lexeme: row.original_lexeme as string,
		replacement: row.replacement as string,
		start_offset: row.start_offset as number,
		ordinal_within_symbol: row.ordinal_within_symbol as number,
		status: row.status as V3MutantStatus,
	};
}

/** One strict mutant row: executable and excluded rows both carry every
 * identity input/output, so the report cannot disagree with the signed
 * envelope about provenance; exclusions additionally bind their policy. */
function parseReportRow(row: unknown): ReportRow | string {
	if (!isReportRowShell(row)) {
		return "report mutant rows must be {mutant_id, status} objects";
	}
	const idFormat = checkSha256Hex(row.mutant_id, "report mutant row.mutant_id");
	if (idFormat !== null) return idFormat;
	return row.status === "excluded" ? parseExcludedReportRow(row) : parseExecutableReportRow(row);
}

function parseReportRows(bytes: Uint8Array, targetFile: string): { rows: ReportRow[] } | string {
	let raw: unknown;
	try {
		raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		return "report is not valid JSON";
	}
	const shell = reportShellFailure(raw, targetFile);
	if (typeof shell === "string") return shell;
	const rows: ReportRow[] = [];
	const seen = new Set<string>();
	for (const rawRow of shell.mutantRows) {
		const row = parseReportRow(rawRow);
		if (typeof row === "string") return row;
		if (seen.has(row.mutant_id)) return "report mutant ids must be unique";
		seen.add(row.mutant_id);
		rows.push(row);
	}
	return { rows };
}

/** One envelope mutant's disagreement with its report row, or null when it
 *  matches. Extracted so the loop in `rowCorrespondenceFailure` stays flat. */
function envMutantMismatch(m: V3MutantRow, reportById: Map<string, ReportRow>): string | null {
	const reportRow = reportById.get(m.mutant_id);
	if (reportRow === undefined) return `envelope mutant "${m.mutant_id}" is missing from the report`;
	if (reportRow.status === "excluded") {
		return `report marks executable mutant "${m.mutant_id}" as excluded`;
	}
	for (const key of EXECUTABLE_ROW_KEYS) {
		if (reportRow[key] !== m[key]) {
			return `report ${key} for "${m.mutant_id}" disagrees with the signed envelope`;
		}
	}
	return null;
}

/** One envelope exclusion's disagreement with its report row, or null when it
 *  matches. Extracted so the loop in `rowCorrespondenceFailure` stays flat. */
function envExcludedMismatch(e: V3ExcludedRow, reportById: Map<string, ReportRow>): string | null {
	const reportRow = reportById.get(e.mutant_id);
	if (reportRow?.status !== "excluded") {
		return `envelope exclusion "${e.mutant_id}" is not an excluded row in the report`;
	}
	for (const key of [...EXECUTABLE_ROW_KEYS.filter((field) => field !== "status"), "policy_id"] as const) {
		if (reportRow[key] !== e[key]) {
			return `report ${key} for excluded mutant "${e.mutant_id}" disagrees with the signed envelope`;
		}
	}
	return null;
}

function rowCorrespondenceFailure(envelope: ParsedEnvelope, rows: ReportRow[]): string | null {
	// SAFETY: keyed access across the union; report-requiring kinds carry these.
	const record = envelope as unknown as Record<string, unknown>;
	const envMutants = (record.mutants as V3MutantRow[] | undefined) ?? [];
	const envExcluded = (record.excluded as V3ExcludedRow[] | undefined) ?? [];
	if (envelope.kind === "not_mutatable" && rows.length !== 0) {
		return "not_mutatable requires an exact zero-mutant result for the target — the report carries rows";
	}
	const reportById = new Map(rows.map((r) => [r.mutant_id, r]));
	for (const m of envMutants) {
		const mismatch = envMutantMismatch(m, reportById);
		if (mismatch !== null) return mismatch;
	}
	for (const e of envExcluded) {
		const mismatch = envExcludedMismatch(e, reportById);
		if (mismatch !== null) return mismatch;
	}
	if (rows.length !== envMutants.length + envExcluded.length) {
		return `report carries ${rows.length} row(s) but the envelope accounts for exactly ${envMutants.length + envExcluded.length} (mutants + exclusions)`;
	}
	return null;
}

/** Verify retrieved report bytes against one parsed envelope's pointer and
 *  evidence. Returns null when the report structurally proves the
 *  envelope's claims about the target; a specific reason otherwise. */
export function verifyReportAgainstEnvelope(
	envelope: ParsedEnvelope,
	bytes: Uint8Array,
): string | null {
	// SAFETY: keyed access across the union; kinds without a pointer skip.
	const pointer = (envelope as unknown as Record<string, unknown>).report as
		| { r2_sha256: string; bytes: number; content_hash: string }
		| undefined;
	if (pointer === undefined) return null;
	if (bytes.byteLength !== pointer.bytes) {
		return `report is ${bytes.byteLength} bytes but the pointer declares ${pointer.bytes}`;
	}
	const hash = createHash("sha256").update(bytes).digest("hex");
	if (hash !== pointer.content_hash) return "report bytes do not match report.content_hash";
	if (hash !== pointer.r2_sha256) {
		return "report bytes do not match report.r2_sha256 — both hashes bind the same stored object in 3.0";
	}
	const parsedRows = parseReportRows(bytes, envelope.job.target_file);
	if (typeof parsedRows === "string") return parsedRows;
	return rowCorrespondenceFailure(envelope, parsedRows.rows);
}
