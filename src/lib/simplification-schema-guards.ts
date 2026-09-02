// ===========================================
// Simplification review — JSON boundary guard helpers
// ===========================================
// Extracted from simplification-schema.ts so each parser there stays small.
// Every function is a pure predicate/parser over already-untrusted JSON values.

import { isJsonObject } from "./json-types.js";
import {
	SIMPLIFICATION_REMEDIES,
	SIMPLIFICATION_REPORT_SCHEMA_VERSION,
	type SimplificationRemedy,
	type SimplificationReport,
} from "./simplification-types.js";

/** A finding location's line bounds: positive integers, end never before start. */
export function isValidLineRange(start: number | null, end: number | null): boolean {
	if (start !== null && (!Number.isInteger(start) || start < 1)) return false;
	if (end !== null && (!Number.isInteger(end) || end < 1)) return false;
	return start === null || end === null || end >= start;
}

/** All-or-nothing narrowing of a handoff's requested remedies. */
export function parseRequestedRemedies(
	values: readonly string[],
): SimplificationRemedy[] | null {
	const out: SimplificationRemedy[] = [];
	for (const remedy of values) {
		if (!isRemedy(remedy)) return null;
		out.push(remedy);
	}
	return out;
}

function isRemedy(value: string): value is SimplificationRemedy {
	return SIMPLIFICATION_REMEDIES.some((choice) => choice === value);
}

/** The reason attached to a handoff's `not_submitted` submission block. */
export function parseHandoffSubmissionReason(value: unknown): string | null {
	if (!isJsonObject(value) || value.status !== "not_submitted") return null;
	const reason = value.reason;
	return typeof reason === "string" && reason.length > 0 ? reason : null;
}

/** Report envelope check: schema version, lens, read-only flag, then the command. */
export function parseReportCommand(
	value: Record<string, unknown>,
): SimplificationReport["command"] | null {
	if (value.schema_version !== SIMPLIFICATION_REPORT_SCHEMA_VERSION) return null;
	if (value.lens !== "simplification" || value.read_only !== true) return null;
	const command = value.command;
	if (command !== "scan" && command !== "review" && command !== "audit") return null;
	return command;
}
