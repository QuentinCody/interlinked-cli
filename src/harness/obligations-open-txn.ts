// ===========================================
// Obligation ledger — `open` txn field parsing
// ===========================================
// Split out of obligations.ts (line-cap): parseOpenTxn there is a thin
// orchestrator over the two functions below, kept self-contained here (its
// own private copies of the generic JSON-narrowing primitives) so this
// module has no runtime dependency back on obligations.ts — only the
// type-only imports it needs to describe the shape it returns.
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import type { ObligationKind, ObligationRegion, OpenTxn } from "./obligations.js";

function isObligationKind(v: unknown): v is ObligationKind {
	return v === "coverage" || v === "mutation" || v === "red_suite" || v === "transient";
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((entry): entry is string => typeof entry === "string");
}

function asString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
	return typeof v === "number" ? v : null;
}

function parseRegion(value: unknown): ObligationRegion | null {
	if (!isJsonObject(value)) return null;
	const { start, end } = value;
	if (typeof start !== "number" || typeof end !== "number") return null;
	return { start, end };
}

const INVALID = Symbol("invalid-optional-field");

function optionalField<T>(value: unknown, parse: (v: unknown) => T | null): T | undefined | typeof INVALID {
	if (value === undefined) return undefined;
	const parsed = parse(value);
	return parsed === null ? INVALID : parsed;
}

/** The `open` txn's required (non-optional) fields. */
export type OpenTxnRequired = Pick<OpenTxn, "kind" | "file" | "contentHash" | "sessionId" | "atMs">;

export function parseOpenTxnRequired(value: JsonObject): OpenTxnRequired | null {
	if (value.op !== "open") return null;
	if (!isObligationKind(value.kind)) return null;
	if (typeof value.file !== "string") return null;
	if (typeof value.contentHash !== "string") return null;
	if (typeof value.sessionId !== "string") return null;
	if (typeof value.atMs !== "number") return null;
	return { kind: value.kind, file: value.file, contentHash: value.contentHash, sessionId: value.sessionId, atMs: value.atMs };
}

/** The `open` txn's optional fields, each individually absent-vs-malformed
 *  checked, then assembled honoring `exactOptionalPropertyTypes` (an absent
 *  field is omitted, never set to `undefined`). */
export type OpenTxnOptional = Omit<OpenTxn, "op" | keyof OpenTxnRequired>;

export function parseOpenTxnOptional(value: JsonObject): OpenTxnOptional | null {
	const region = optionalField(value.region, parseRegion);
	if (region === INVALID) return null;
	const editSeq = optionalField(value.editSeq, asNumber);
	if (editSeq === INVALID) return null;
	const detector = optionalField(value.detector, asString);
	if (detector === INVALID) return null;
	const strikes = optionalField(value.strikes, asNumber);
	if (strikes === INVALID) return null;
	const failingTestFiles = optionalField(value.failingTestFiles, (v) => (isStringArray(v) ? v : null));
	if (failingTestFiles === INVALID) return null;
	return {
		...(region !== undefined ? { region } : {}),
		...(editSeq !== undefined ? { editSeq } : {}),
		...(detector !== undefined ? { detector } : {}),
		...(strikes !== undefined ? { strikes } : {}),
		...(failingTestFiles !== undefined ? { failingTestFiles } : {}),
	};
}
