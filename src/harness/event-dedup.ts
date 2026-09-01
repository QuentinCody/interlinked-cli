// ===========================================
// Event de-duplication — shadow mode
// ===========================================
// One logical tool call fires the harness hooks several times: the `.mjs`
// and `hook-entry.js` entry points are each registered in project AND
// global settings, so the daemon evaluates every tool call ~3-4x. That
// inflates the tdd / escalation counters and multiplies the check work.
//
// This module identifies redundant deliveries of the same call. The key is
// the runner's `tool_use_id` (identical across the duplicates, distinct
// across genuinely different calls), with a composite fallback for events
// that still lack one. `hook_event` is always folded into the key so a
// call's PreToolUse and PostToolUse deliveries never collide with each other.
//
// SHADOW MODE: `recordDeliveryForShadow` only *detects and logs* — it never
// skips or blocks, so behaviour is unchanged. Each redundant delivery is
// appended to `.interlinked/dedup-shadow.jsonl`; the `ms_since_first` field
// there lets us confirm, on real traffic, that the key only ever collides
// on genuine re-deliveries (sub-second) before flipping to live skipping.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent } from "./types.js";

/** Re-deliveries of one call arrive within milliseconds; nothing legitimate
 *  repeats an identical key this fast. Older entries are evicted, so a later
 *  identical key counts as a fresh call. */
const DEDUP_WINDOW_MS = 5_000;

/** Hard cap on tracked keys — a long session can't grow the map unbounded
 *  even if time-eviction lags. */
const MAX_TRACKED_KEYS = 2_000;

interface SeenEntry {
	firstTs: number;
	lastTs: number;
	count: number;
}

const seen = new Map<string, SeenEntry>();

/** Non-cryptographic djb2 hash — bounds the composite key size so a large
 *  tool_input (e.g. a Write payload) can't become a giant Map key. */
function hashToolInput(input: unknown): string {
	let json: string;
	try {
		json = JSON.stringify(input) ?? "";
	} catch {
		// Circular/unserialisable input — fall back to a stringified form.
		json = String(input);
	}
	let h = 5381;
	for (let i = 0; i < json.length; i++) {
		h = ((h << 5) + h + json.charCodeAt(i)) >>> 0;
	}
	return h.toString(16);
}

interface DedupKey {
	key: string;
	kind: "tool_use_id" | "composite";
}

/** Identity of a hook delivery for de-dup. Prefers `tool_use_id` (precise);
 *  falls back to session + tool + input-hash. `hook_event` is always part of
 *  the key so a call's PreToolUse and PostToolUse deliveries stay distinct. */
export function dedupKey(event: HarnessEvent): DedupKey {
	const ev = event.hook_event ?? "?";
	if (event.tool_use_id) {
		return { key: `tuid:${ev}:${event.tool_use_id}`, kind: "tool_use_id" };
	}
	const session = event.session_id ?? "?";
	const tool = event.tool_name ?? "?";
	return {
		key: `cmp:${ev}:${session}|${tool}|${hashToolInput(event.tool_input)}`,
		kind: "composite",
	};
}

function evict(now: number): void {
	// Collect stale keys, then delete after iterating — never mutate the
	// Map mid-iteration.
	const drop: string[] = [];
	for (const [k, e] of seen) {
		if (now - e.lastTs > DEDUP_WINDOW_MS) drop.push(k);
	}
	for (const k of drop) seen.delete(k);
	// Overflow guard: if time-eviction lagged, drop the oldest keys. Map
	// iteration order is insertion order, so the leading keys are oldest.
	if (seen.size > MAX_TRACKED_KEYS) {
		for (const k of [...seen.keys()].slice(0, seen.size - MAX_TRACKED_KEYS)) {
			seen.delete(k);
		}
	}
}

interface ShadowObservation {
	/** True when an identical key was seen inside the window — i.e. a live
	 *  de-dup would have skipped this delivery. */
	isDuplicate: boolean;
	/** 1 for the first delivery of a call; 2+ for redundant ones. */
	deliveryIndex: number;
	kind: DedupKey["kind"];
}

/** Record one hook delivery. SHADOW MODE — never skips, never blocks. It
 *  returns what a live de-dup *would* have done and appends a line to
 *  dedup-shadow.jsonl for redundant deliveries. */
export function recordDeliveryForShadow(event: HarnessEvent): ShadowObservation {
	const now = Date.now();
	try {
		evict(now);
		const dk = dedupKey(event);
		const prior = seen.get(dk.key);
		if (!prior) {
			seen.set(dk.key, { firstTs: now, lastTs: now, count: 1 });
			return { isDuplicate: false, deliveryIndex: 1, kind: dk.kind };
		}
		prior.count += 1;
		prior.lastTs = now;
		appendShadowRecord(event, dk, prior);
		return { isDuplicate: true, deliveryIndex: prior.count, kind: dk.kind };
	} catch {
		// Intentional fail-open: a telemetry/IO failure (e.g. dedup-shadow.jsonl
		// unwritable) must never disturb evaluation. Reporting "not a duplicate"
		// is the safe direction — a live de-dup would then evaluate, not skip.
		return { isDuplicate: false, deliveryIndex: 1, kind: "composite" };
	}
}

/** Append one redundant-delivery record to dedup-shadow.jsonl. May throw if
 *  `.interlinked` is missing/unwritable; the caller's outer catch handles
 *  that (fail-open — telemetry never disturbs evaluation). */
function appendShadowRecord(event: HarnessEvent, dk: DedupKey, prior: SeenEntry): void {
	const record = {
		ts: new Date(prior.lastTs).toISOString(),
		key_kind: dk.kind,
		key: dk.key,
		tool: event.tool_name ?? null,
		hook_event: event.hook_event ?? null,
		delivery_index: prior.count,
		ms_since_first: prior.lastTs - prior.firstTs,
	};
	appendFileSync(
		join(process.cwd(), ".interlinked", "dedup-shadow.jsonl"),
		`${JSON.stringify(record)}\n`,
	);
}

/** Test hook — clears the in-memory window between cases. */
export function __resetDedupForTesting(): void {
	seen.clear();
}
