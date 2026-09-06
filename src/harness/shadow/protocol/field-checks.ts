// ===========================================
// Shadow protocol v1 — primitive field validators
// ===========================================
// Every check returns `null` (valid) or a SPECIFIC reason. Nothing here
// decides policy; the parsers compose these. Bounded by construction: ids
// ≤ 128 bytes and URL-safe, strings ≤ their limit, integers safe and
// non-negative, and no empty-string value is ever accepted for a branded
// field (memo §8.0 — "no empty-string sentinel is ever a valid brand").

import { isWellFormedString } from "../../mutation/protocol-v3/canonical.js";

export type Reason = string | null;

/** Ids are opaque, server-issued, and travel in URLs and ref names. */
export const MAX_ID_BYTES = 128;
/** General bounded string (detail text, versions, urls), in BYTES. */
export const MAX_STRING = 2048;
/** A tool-input payload field (file content, patch text). Bounded by the
 *  aggregate `command_stdin_toolinput_bytes` wire limit, in BYTES. */
export const MAX_TOOL_INPUT_BYTES = 1_048_576;

/** Every wire limit is a BYTE limit. `String.length` counts UTF-16 code
 *  units, so it under-counts every non-ASCII character — a 1.2 MB UTF-8
 *  payload of two-byte characters passed a 1 MiB "length" cap (review
 *  2026-09-04). Allocation and transport are paid in bytes; measure bytes. */
export function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First non-null reason, or null when every check passed. */
export function firstReason(...reasons: readonly Reason[]): Reason {
	for (const reason of reasons) {
		if (reason !== null) return reason;
	}
	return null;
}

/** Keys present on `value` that the caller did not declare. Unknown keys are
 *  a REJECTION everywhere in this protocol: an unrecognized field is either a
 *  version the parser does not implement or an injection attempt. */
export function unknownKeysIn(value: Record<string, unknown>, allowed: readonly string[]): string[] {
	const permitted = new Set(allowed);
	return Object.keys(value).filter((key) => !permitted.has(key));
}

export function checkNoUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): Reason {
	const unknown = unknownKeysIn(value, allowed);
	return unknown.length === 0 ? null : `${where} has unknown field(s): ${unknown.sort().join(", ")}`;
}

export function checkLiteral<T extends string | number | boolean>(value: unknown, expected: T, where: string): Reason {
	return value === expected ? null : `${where} must be ${JSON.stringify(expected)}`;
}

export function checkEnum(value: unknown, allowed: readonly string[], where: string): Reason {
	return typeof value === "string" && allowed.includes(value)
		? null
		: `${where} must be one of: ${[...allowed].sort().join(", ")}`;
}

export function checkBool(value: unknown, where: string): Reason {
	return typeof value === "boolean" ? null : `${where} must be a boolean`;
}

/** Non-empty, bounded (in BYTES), well-formed Unicode. Lone surrogates would
 *  break the canonical serializer, so they are refused at the schema
 *  boundary — and refused BEFORE the byte count, since an ill-formed string
 *  has no well-defined UTF-8 encoding to measure. */
export function checkBoundedString(value: unknown, where: string, maxBytes = MAX_STRING): Reason {
	if (typeof value !== "string" || value.length === 0) return `${where} must be a non-empty string`;
	if (!isWellFormedString(value)) return `${where} must be well-formed Unicode (no lone surrogates)`;
	return utf8Bytes(value) > maxBytes ? `${where} exceeds ${maxBytes} bytes` : null;
}

/** Bounded well-formed text that MAY be empty (a Write of an empty file, an
 *  Edit that deletes text). Bounded in BYTES, for the same reason. */
export function checkBoundedText(value: unknown, where: string, maxBytes = MAX_TOOL_INPUT_BYTES): Reason {
	if (typeof value !== "string") return `${where} must be a string`;
	if (!isWellFormedString(value)) return `${where} must be well-formed Unicode (no lone surrogates)`;
	return utf8Bytes(value) > maxBytes ? `${where} exceeds ${maxBytes} bytes` : null;
}

export function checkOpaqueId(value: unknown, where: string): Reason {
	return typeof value === "string" && ID_RE.test(value)
		? null
		: `${where} must be an opaque URL-safe id of 1..${MAX_ID_BYTES} characters`;
}

export function checkSha256Hex(value: unknown, where: string): Reason {
	return typeof value === "string" && SHA256_HEX_RE.test(value) ? null : `${where} must be a lowercase 64-hex sha-256`;
}

/** A full commit sha — never a branch, tag, or abbreviation. */
export function checkGitSha(value: unknown, where: string): Reason {
	return typeof value === "string" && GIT_SHA_RE.test(value)
		? null
		: `${where} must be a full lowercase 40-hex commit sha`;
}

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) return isLeapYear(year) ? 29 : 28;
	return DAYS_IN_MONTH[month - 1] ?? 0;
}

/** The shape regex admits impossible instants — `2026-02-30T12:00:00Z` and
 *  `2026-01-01T24:00:00Z` both match it, and `Date.parse` accepts the first
 *  by rolling it into March (review 2026-09-04). A timestamp that is not a
 *  real instant is refused here, not normalized: two parties normalizing
 *  differently is a hash difference. Leap seconds (`:60`) are refused too —
 *  admitting one would mean agreeing on a leap-second table. */
function calendarFailure(stamp: string, where: string): Reason {
	const [year, month, day] = [stamp.slice(0, 4), stamp.slice(5, 7), stamp.slice(8, 10)].map(Number);
	const [hour, minute, second] = [stamp.slice(11, 13), stamp.slice(14, 16), stamp.slice(17, 19)].map(Number);
	if (month === undefined || month < 1 || month > 12) return `${where} has month outside 01..12`;
	if (year === undefined || day === undefined || day < 1 || day > daysInMonth(year, month)) {
		return `${where} has a day that does not exist in that month`;
	}
	if (hour === undefined || hour > 23) return `${where} has hour outside 00..23`;
	if (minute === undefined || minute > 59) return `${where} has minute outside 00..59`;
	if (second === undefined || second > 59) return `${where} has second outside 00..59 (no leap seconds)`;
	return offsetFailure(stamp, where);
}

function offsetFailure(stamp: string, where: string): Reason {
	const offset = stamp.slice(-6);
	if (!offset.startsWith("+") && !offset.startsWith("-")) return null; // trailing Z
	const offsetHour = Number(offset.slice(1, 3));
	const offsetMinute = Number(offset.slice(4, 6));
	// FAIL CLOSED on a non-numeric slice: a NaN comparison is always false,
	// which would read an unparseable offset as an in-range one.
	if (!Number.isFinite(offsetHour) || !Number.isFinite(offsetMinute)) {
		return `${where} has an unreadable UTC offset`;
	}
	if (offsetHour > 23) return `${where} has a UTC offset hour outside 00..23`;
	return offsetMinute > 59 ? `${where} has a UTC offset minute outside 00..59` : null;
}

export function checkRfc3339(value: unknown, where: string): Reason {
	if (typeof value !== "string" || !RFC3339_RE.test(value)) return `${where} must be an RFC3339 timestamp`;
	const calendar = calendarFailure(value, where);
	if (calendar !== null) return calendar;
	return Number.isFinite(Date.parse(value)) ? null : `${where} must be a parseable RFC3339 timestamp`;
}

/** Safe, non-negative integer. Applied BEFORE allocation everywhere. */
export function checkSafeNonNegInt(value: unknown, where: string, max?: number): Reason {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		return `${where} must be a safe non-negative integer`;
	}
	if (max !== undefined && value > max) return `${where} exceeds ${max}`;
	return null;
}

export function checkArray(value: unknown, where: string, maxLength: number): Reason {
	if (!Array.isArray(value)) return `${where} must be an array`;
	return value.length <= maxLength ? null : `${where} exceeds ${maxLength} entries`;
}
