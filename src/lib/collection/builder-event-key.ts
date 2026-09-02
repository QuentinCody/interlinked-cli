// ===========================================
// Collection v1 — Tool-event gate + key extraction
// ===========================================
// Split out of `builder.ts` so the record builder stays under the complexity
// cap. Owns the legacy activity `type` sets, phase detection, and the gate that
// decides whether an activity event is a collectible tool event at all.

import type { JsonObject } from "../json-types.js";

/** Legacy activity `type`s the builder projects to a PRE-phase record (which the
 *  collection reader projects back as `tool_use_start`). Exported so the merge
 *  reader's identity dedup can normalize a raw type to its projected display type
 *  — `permission_request` ⇄ `tool_use_start` would otherwise never match across
 *  the two stores (imported, not mirrored: the hand-copied set is what drifted). */
export const PRE_EVENT_TYPES: ReadonlySet<string> = new Set(["tool_use_start", "permission_request"]);
const POST_EVENT_TYPES = new Set(["tool_use", "tool_use_error"]);
/** Every legacy activity `type` the collection builder CONSUMES (projects into
 *  collection.jsonl). Exported as the single source of truth for the merge reader:
 *  when collection.jsonl exists, a legacy row of one of these types is dropped
 *  exactly when its collection twin is present (identity dedup — finding 2026-06:
 *  type-level dropping erased pre-collection history and failed-append events). */
export const TOOL_EVENT_TYPES: ReadonlySet<string> = new Set([...PRE_EVENT_TYPES, ...POST_EVENT_TYPES]);

function detectPhase(eventType: string): "pre" | "post" | null {
	if (PRE_EVENT_TYPES.has(eventType)) return "pre";
	if (POST_EVENT_TYPES.has(eventType)) return "post";
	return null;
}

/** Public API: named in `resolveToolEventKey`'s exported signature, so consumers
 *  (and declaration emit) must be able to name it. */
export interface ToolEventKey {
	eventType: string;
	toolName: string;
	phase: "pre" | "post";
}

/** Gate + key extraction: returns null for anything that is not a collectible
 *  tool event (guard telemetry, unknown type, missing tool name, no phase). */
export function resolveToolEventKey(event: JsonObject): ToolEventKey | null {
	const eventType = String(event.event_type || event.type || "");
	// Guard telemetry (guard_allow/guard_warn/guard_block) is local-only and is
	// never collected — keyed on record TYPE (either discriminator field), not
	// schema_version (the version is the log-format version, shared across families).
	if (eventType.startsWith("guard_") || String(event.type || "").startsWith("guard_")) return null;
	if (!TOOL_EVENT_TYPES.has(eventType)) return null;

	const toolName = String(event.tool_name || event.tool || "");
	if (!toolName) return null;

	const phase = detectPhase(eventType);
	if (!phase) return null;

	return { eventType, toolName, phase };
}

/** Preserve the success/failure discriminator on POST events so the canonical
 *  round-trip can reconstruct `tool_use_error` rather than collapsing every post
 *  event to `tool_use` (finding 5). Pre events carry no outcome yet. */
export function resolveOutcome(phase: "pre" | "post", eventType: string): "ok" | "error" | undefined {
	if (phase !== "post") return undefined;
	return eventType === "tool_use_error" ? "error" : "ok";
}
