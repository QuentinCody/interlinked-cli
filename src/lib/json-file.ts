// ===========================================
// Safe JSON file reads — the ONE "read a JSON file, null on any problem" helper
// ===========================================
// Nine modules had independently written the same
// `existsSync -> JSON.parse(readFileSync(p,"utf-8")) -> catch -> null` body
// before this was extracted (2026-08-17). Two explicit variants exist so the
// call site states which contract it wants:
//
//   readJsonFile<T>()  — cast-based. The caller asserts the shape; a JSON
//                        array or primitive is returned as-is.
//   readJsonObject()   — narrowed. Anything that is not a keyed JSON object
//                        (array, primitive, null) reads as null.
//
// Both are fail-open: a missing file, an unreadable path, and malformed JSON
// are indistinguishable and all yield null. Callers that must tell those
// cases apart should not use these helpers.

import { readFileSync } from "node:fs";
import { isJsonObject, type JsonObject } from "./json-types.js";

/**
 * Read and parse a JSON file, casting the result to `T`.
 *
 * Returns null when the file is missing, unreadable, or not valid JSON. No
 * shape validation happens by default — `T` is the caller's assertion, exactly
 * as at the hand-rolled call sites this replaces. Pass `validate` to actually
 * check the shape instead of asserting it; on a failed validation this
 * returns null, same as a parse failure.
 */
export function readJsonFile<T>(
	path: string,
	validate?: (value: unknown) => value is T,
): T | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (validate) return validate(parsed) ? parsed : null;
		// SAFETY: unvalidated by construction — this is the cast-based variant,
		// documented as "the caller asserts the shape". Use readJsonObject (or a
		// domain parser on top of it) when the shape must actually be checked.
		return parsed as T;
	} catch {
		return null;
	}
}

/**
 * Read and parse a JSON file, narrowing the result to a keyed JSON object.
 *
 * Returns null when the file is missing, unreadable, not valid JSON, or parses
 * to something other than an object (an array, a primitive, or `null`).
 */
export function readJsonObject(path: string): JsonObject | null {
	const parsed: unknown = readJsonFile<unknown>(path);
	return isJsonObject(parsed) ? parsed : null;
}
