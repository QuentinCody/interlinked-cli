// ===========================================
// Telemetry spool — append-only JSONL with ring-buffer preservation
// ===========================================
// Every line is a complete self-contained JSON event (Pattern 7 from the
// agent orchestration skill — parsers can stop reading anywhere and what they
// have is valid). See docs/design/free-cli-architecture.md §"Telemetry wire
// format".
//
// The spool caps disk usage at `max_bytes`. When the cap is hit we trim the
// oldest lines, but preferentially preserve `session_lifecycle` and
// `check_finding` kinds over `hook_decision` — these are the highest-value
// events for post-hoc analysis.

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";

type SpoolEventKind =
	| "hook_decision"
	| "check_finding"
	| "session_lifecycle"
	| "daemon_event"
	| "suppression_applied"
	| "daemon_fallback_cold"
	| "budget_exceeded"
	| "custom";

export interface SpoolEvent {
	schema: "v1";
	kind: SpoolEventKind;
	ts: string;
	[key: string]: unknown;
}

export interface TelemetrySpoolOptions {
	spoolPath: string;
	/** Max bytes before compaction. Default 100 MB. */
	max_bytes?: number;
	/** Proportion of the cap that triggers a trim. Default 0.9. */
	trim_threshold?: number;
	/** Redactors applied to every event before writing. */
	redactors?: Array<(ev: SpoolEvent) => SpoolEvent>;
}

export interface TelemetrySpool {
	append(event: SpoolEvent): void;
	size(): { bytes: number; exists: boolean };
	/** Preserve session_lifecycle + check_finding; trim others when at cap. */
	compact(): { removed: number; kept: number };
	/** Read all current events, parsed. Ignores malformed lines. Intended for
	 *  debugging and tests, not for the hot path — full-file read each call. */
	readAll(): SpoolEvent[];
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_TRIM_THRESHOLD = 0.9;

const PREFERRED_KINDS: ReadonlySet<SpoolEventKind> = new Set([
	"session_lifecycle",
	"check_finding",
]);

export function createTelemetrySpool(opts: TelemetrySpoolOptions): TelemetrySpool {
	const maxBytes = opts.max_bytes ?? DEFAULT_MAX_BYTES;
	const threshold = opts.trim_threshold ?? DEFAULT_TRIM_THRESHOLD;
	const redactors = opts.redactors ?? [];
	const spoolPath = opts.spoolPath;

	ensureDir(spoolPath);

	function triggerCompactIfNeeded(): void {
		const sz = sizeOnDisk(spoolPath);
		if (sz.bytes >= maxBytes * threshold) {
			doCompact(spoolPath, maxBytes);
		}
	}

	return {
		append(event: SpoolEvent): void {
			let redacted = event;
			for (const fn of redactors) redacted = fn(redacted);
			const line = `${JSON.stringify(redacted)}\n`;
			appendFileSync(spoolPath, line);
			triggerCompactIfNeeded();
		},
		size(): { bytes: number; exists: boolean } {
			return sizeOnDisk(spoolPath);
		},
		compact(): { removed: number; kept: number } {
			return doCompact(spoolPath, maxBytes);
		},
		readAll(): SpoolEvent[] {
			if (!existsSync(spoolPath)) return [];
			const text = readFileSafe(spoolPath);
			return parseJsonl(text);
		},
	};
}

function doCompact(spoolPath: string, maxBytes: number): { removed: number; kept: number } {
	if (!existsSync(spoolPath)) return { removed: 0, kept: 0 };
	const text = readFileSafe(spoolPath);
	const events = parseJsonl(text);
	if (events.length === 0) return { removed: 0, kept: 0 };

	// Goal: keep the newest events that fit, but preserve preferred kinds
	// even when older. Compute budget as maxBytes * 0.5 so we have headroom.
	const targetBytes = Math.floor(maxBytes * 0.5);
	const kept = selectEventsToKeep(events, targetBytes);
	const removed = events.length - kept.length;
	const newText = kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length > 0 ? "\n" : "");
	writeFileSync(spoolPath, newText);
	return { removed, kept: kept.length };
}

function selectEventsToKeep(events: SpoolEvent[], targetBytes: number): SpoolEvent[] {
	// Walk from the newest. Always keep preferred kinds; keep others only if
	// we still have budget left. Reverse the results at the end to preserve
	// chronological order on disk.
	const kept: SpoolEvent[] = [];
	let used = 0;
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = nonNull(events[i]);
		const line = `${JSON.stringify(ev)}\n`;
		const size = Buffer.byteLength(line, "utf-8");
		const preferred = PREFERRED_KINDS.has(ev.kind);
		if (used + size > targetBytes && !preferred) continue;
		kept.push(ev);
		used += size;
	}
	kept.reverse();
	return kept;
}

function sizeOnDisk(path: string): { bytes: number; exists: boolean } {
	if (!existsSync(path)) return { bytes: 0, exists: false };
	let bytes = 0;
	try {
		bytes = statSync(path).size;
	} catch {
		bytes = 0;
	}
	return { bytes, exists: true };
}

function ensureDir(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readFileSafe(path: string): string {
	let out = "";
	try {
		out = readFileSync(path, "utf-8");
	} catch {
		out = "";
	}
	return out;
}

export function parseJsonl(text: string): SpoolEvent[] {
	const out: SpoolEvent[] = [];
	if (!text) return out;
	const lines = text.split("\n");
	for (const line of lines) {
		if (line.length === 0) continue;
		const parsed = tryParseEvent(line);
		if (parsed) out.push(parsed);
	}
	return out;
}

function tryParseEvent(line: string): SpoolEvent | null {
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (parsed == null || typeof parsed !== "object") return null;
	const obj = parsed as JsonObject;
	if (obj.schema !== "v1" || typeof obj.kind !== "string" || typeof obj.ts !== "string") {
		return null;
	}
	return obj as SpoolEvent;
}

// -----------------------------------------------------------------------------
// Built-in redactors
// -----------------------------------------------------------------------------

/** Strip `secrets` fields wherever they appear (shallow). */
export function redactSecretsShallow(event: SpoolEvent): SpoolEvent {
	const out = { ...event };
	if ("secrets" in out) delete out.secrets;
	return out;
}

/** Truncate any `file_path` strings over 200 chars. */
export function truncateFilePaths(event: SpoolEvent): SpoolEvent {
	const out = { ...event };
	if (typeof out.file_path === "string" && out.file_path.length > 200) {
		out.file_path = `${out.file_path.slice(0, 200)}...`;
	}
	return out;
}
