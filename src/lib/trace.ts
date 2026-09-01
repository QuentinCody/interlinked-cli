// ===========================================
// Agent Trace Export/Import
// ===========================================
// Exports local activity to a standard trace format and imports back.

import { parseDuration } from "./activity-utils.js";
import { isJsonObject, type JsonObject } from "./json-types.js";
import {
	appendLocalActivity,
	type LocalActivityEvent,
	readLocalActivity,
} from "./local-activity.js";

// ===========================================
// Types
// ===========================================

interface TraceSpan {
	trace_id: string;
	span_id: string;
	name: string;
	timestamp: string;
	duration_ms?: number | undefined;
	attributes: JsonObject;
}

interface TraceDocument {
	format: "interlinked-trace";
	version: 1;
	exported_at: string;
	spans: TraceSpan[];
}

// ===========================================
// Export
// ===========================================

/**
 * Export local activity events as trace spans.
 */
export function exportTrace(opts?: {
	since?: string;
	agent?: string;
	format?: "json" | "jsonl";
	cwd?: string;
}): string {
	const sinceMs = opts?.since ? Date.now() - parseDuration(opts.since) : undefined;

	const events = readLocalActivity({
		since: sinceMs,
		agent: opts?.agent,
		limit: 10000,
		cwd: opts?.cwd,
	});

	const spans: TraceSpan[] = events.map((e, i) => {
		// `readLocalActivity` is a mockable/injectable boundary; a caller can
		// supply an event whose `ts` is missing despite the required `string`
		// type (see the mutation-kill fallback coverage for this file). Read
		// it through `unknown` so the fallbacks below stay real.
		const rawTs: unknown = e.ts;
		const ts = typeof rawTs === "string" ? rawTs : undefined;
		return {
			trace_id: e.session || `trace-${ts?.slice(0, 10) || "unknown"}`,
			span_id: `span-${i}-${ts?.replace(/\D/g, "").slice(0, 14) || i}`,
			name: e.type || "unknown",
			timestamp: e.ts,
			duration_ms: e.duration_ms || undefined,
			attributes: {
				agent: e.agent,
				tool: e.tool || undefined,
				summary: e.summary || undefined,
				hook: e.hook || undefined,
				...(e.tokens ? { tokens: e.tokens } : {}),
				...(e.parent_agent ? { parent_agent: e.parent_agent } : {}),
				...(e.subagent_id ? { subagent_id: e.subagent_id } : {}),
			},
		};
	});

	if (opts?.format === "jsonl") {
		return `${spans.map((s) => JSON.stringify(s)).join("\n")}\n`;
	}

	const doc: TraceDocument = {
		format: "interlinked-trace",
		version: 1,
		exported_at: new Date().toISOString(),
		spans,
	};

	return JSON.stringify(doc, null, 2);
}

// ===========================================
// Import
// ===========================================

export interface ImportTraceResult {
	imported: number;
	skipped: number;
}

/** The subset of `TraceSpan` an import actually reads (`span_id`/`duration_ms`
 *  are export-only — importTrace never consumes them). `attributes` defaults
 *  to `{}` rather than rejecting the span: the old code read `span.attributes
 *  .agent` unconditionally, which THREW on a span missing `attributes`
 *  entirely and crashed the whole import; defaulting fixes that crash while
 *  keeping every other field the span does supply. */
interface ImportedSpan {
	trace_id?: string;
	name: string;
	timestamp: string;
	attributes: JsonObject;
}

/** Validate one candidate span from an imported trace document/JSONL line.
 *  Replaces a bare `JSON.parse(...)` pushed straight into a `TraceSpan[]`
 *  with zero verification — `name`/`timestamp` are required because the
 *  import loop constructs `LocalActivityEvent.type`/`.ts` from them
 *  unconditionally. */
function parseImportedSpan(value: unknown): ImportedSpan | null {
	if (!isJsonObject(value)) return null;
	const { name, timestamp } = value;
	if (typeof name !== "string" || typeof timestamp !== "string") return null;
	const trace_id = typeof value.trace_id === "string" ? value.trace_id : undefined;
	const attributes = isJsonObject(value.attributes) ? value.attributes : {};
	return { name, timestamp, attributes, ...(trace_id !== undefined ? { trace_id } : {}) };
}

/** Pull the candidate span array out of a parsed JSON document: the
 *  `interlinked-trace` envelope, or a bare array of spans. Null when `data`
 *  isn't either shape. */
function extractDocumentSpans(doc: unknown): unknown[] | null {
	if (isJsonObject(doc) && doc.format === "interlinked-trace" && Array.isArray(doc.spans)) {
		return doc.spans;
	}
	return Array.isArray(doc) ? doc : null;
}

/** Parse the raw import payload into validated spans — a JSON document first
 *  (envelope or bare array), falling back to line-by-line JSONL. */
function parseImportedSpans(data: string): ImportedSpan[] {
	try {
		const rawSpans = extractDocumentSpans(JSON.parse(data));
		return rawSpans ? rawSpans.map(parseImportedSpan).filter((s): s is ImportedSpan => s !== null) : [];
	} catch (_err) {
		/* intentional: input isn't a JSON document — fall back to JSONL line-by-line parsing */
		const spans: ImportedSpan[] = [];
		for (const line of data.split("\n").filter(Boolean)) {
			try {
				const span = parseImportedSpan(JSON.parse(line));
				if (span) spans.push(span);
			} catch (_lineErr) {
				/* intentional: skip a malformed JSONL line rather than fail the whole import */
			}
		}
		return spans;
	}
}

/**
 * Import trace spans into the local activity log.
 * Deduplicates by timestamp + agent + type.
 */
export function importTrace(data: string, cwd?: string): ImportTraceResult {
	const spans = parseImportedSpans(data);
	if (spans.length === 0) {
		return { imported: 0, skipped: 0 };
	}

	// Read existing events for dedup
	const existing = readLocalActivity({ limit: 50000, cwd });
	const existingKeys = new Set(existing.map((e) => `${e.ts}|${e.agent}|${e.type}`));

	let imported = 0;
	let skipped = 0;

	for (const span of spans) {
		// `||` (not `??`), matching the pre-fix fallback exactly: an EMPTY
		// string attribute also falls back to the default, not just an absent
		// one — only the wrong-TYPE case is new (the old cast let a non-string
		// attribute value flow into these `string | null` fields untyped).
		const agent = typeof span.attributes.agent === "string" ? span.attributes.agent : "";
		const tool = typeof span.attributes.tool === "string" ? span.attributes.tool : "";
		const summary = typeof span.attributes.summary === "string" ? span.attributes.summary : "";
		const event: LocalActivityEvent = {
			ts: span.timestamp,
			agent: agent || "unknown",
			type: span.name,
			tool: tool || null,
			summary: summary || null,
			session: span.trace_id || null,
		};

		const key = `${event.ts}|${event.agent}|${event.type}`;
		if (existingKeys.has(key)) {
			skipped++;
			continue;
		}

		appendLocalActivity(event, cwd);
		existingKeys.add(key);
		imported++;
	}

	return { imported, skipped };
}
