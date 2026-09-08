// Wire shapes and span validation for the local scanner sidecar.
import type { JsonObject } from "../../lib/json-types.js";

export interface SidecarSpan {
	label: string;
	start: number;
	end: number;
	text: string;
	score?: number;
}

export interface SidecarResponse {
	ok: boolean;
	error?: string | undefined;
	spans?: SidecarSpan[] | undefined;
	redacted_text?: string | undefined;
}

export function parseSpans(value: unknown): SidecarSpan[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const spans: SidecarSpan[] = [];
	for (const entry of value) {
		const span = parseSpan(entry);
		if (span) spans.push(span);
	}
	return spans;
}

function parseSpan(value: unknown): SidecarSpan | null {
	if (!isRecord(value)) return null;
	const { label, start, end, text, score } = value;
	if (typeof label !== "string" || typeof text !== "string") return null;
	if (typeof start !== "number" || typeof end !== "number") return null;
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
	if (score !== undefined && (typeof score !== "number" || !Number.isFinite(score))) return null;
	return { label, start, end, text, ...(score === undefined ? {} : { score }) };
}

/** Type predicate that narrows `unknown` to a plain object (but not `null`). */
export function isRecord(x: unknown): x is JsonObject {
	return x !== null && typeof x === "object";
}
