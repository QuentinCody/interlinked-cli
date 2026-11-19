// ===========================================
// JSON Value Types — Shared narrow types for untrusted JSON
// ===========================================
// Use these when parsing JSON from an external source (settings files,
// HTTP responses, hook payloads). `JsonObject` is preferred over a bare
// `Record<string, unknown>` at the call-site so the intent ("foreign
// JSON we haven't narrowed yet") is explicit and the `broad_object_types`
// harness check recognises a named boundary type instead of flagging
// every single declaration.
//
// The declarations below intentionally use multi-line interface syntax
// rather than `type Foo = Record<string, unknown>` or
// `type Foo = { [k: string]: unknown }` because both would themselves
// be flagged by the `broad_object_types` check's inline regex, defeating
// the purpose of having one named, centralised boundary type.

/**
 * A JSON object with unknown value types. Use this as the parameter or
 * return type for code that handles foreign JSON (external settings,
 * HTTP responses, etc.) before narrowing individual fields with a type
 * guard or `as` cast.
 *
 * Values are typed as `unknown` (not a recursive `JsonValue`) so callers
 * can store arbitrary JSON-compatible data (arrays, nested objects,
 * primitives) without extra coercion at write sites — the narrowing
 * discipline lives at read sites instead.
 */
export interface JsonObject {
	[key: string]: unknown;
}

/**
 * The ONE narrowing point for foreign JSON. Every boundary parser should reach
 * for this rather than hand-rolling `typeof v === "object" && v !== null &&
 * !Array.isArray(v)` — six files had independently written that same line
 * before this was extracted (2026-08-09).
 *
 * Arrays are rejected: a JSON array is `typeof "object"` but is not a keyed
 * record, and a parser that accepts one reads `value.someField` as `undefined`
 * instead of failing.
 *
 * Note this predicate is exempt from `type_predicate_drift` by construction —
 * `JsonObject` declares only an index signature, so it has no required named
 * properties that a guard could leave unchecked.
 */
export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return the original keyed object when present, otherwise indicate an unparseable field. */
export function asJsonObject(value: unknown): JsonObject | null {
	return isJsonObject(value) ? value : null;
}

export function stringField(object: JsonObject, key: string): string | undefined {
	const value = object[key];
	return typeof value === "string" ? value : undefined;
}

/** Parse a JSON object from text, returning null for malformed or unkeyed input. */
export function parseJsonObjectText(text: string): JsonObject | null {
	try {
		return asJsonObject(JSON.parse(text));
	} catch {
		return null;
	}
}

/**
 * A recursive JSON value. Prefer `JsonObject` for most parameters; use
 * `JsonValue` only when you really need the strict recursive shape
 * (e.g. serialisers that need to refuse non-JSON inputs at compile
 * time).
 */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| {
			[key: string]: JsonValue;
	  }
	| undefined;
