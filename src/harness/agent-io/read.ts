// ===========================================
// agent-io reader — recovery + dedup keys
// ===========================================
// The recover half of the store/recover pair activity.jsonl already has: a
// row written by the daemon must be re-readable by a later process with no
// daemon state, and blob-spilled content must resolve back to the exact bytes
// that were stored.
//
// Reads are BOUNDED by row count the same way `interlinked query` bounds its
// scans — the log is append-only and long-lived, so no reader may assume it
// fits in memory. A corrupt line is skipped, never fatal: this file is
// analytics, and losing one hand-edited row beats losing every row after it.

import { existsSync, readFileSync } from "node:fs";
import { isJsonObject } from "../../lib/json-types.js";
import { agentIoBlobPath, agentIoLogPath } from "./store.js";
import type { AgentIoRecord } from "./types.js";

/** Default cap on rows returned — mirrors `interlinked query`'s newest-N
 *  bound so the two readers agree about what "recent" means. */
const DEFAULT_READ_LIMIT = 20_000;

export interface ReadAgentIoOpts {
	/** Newest N rows; 0 or negative means unbounded. */
	limit?: number;
	/** Keep only rows for this agent. */
	agentId?: string;
}

/**
 * Narrow one parsed line. Only the fields a reader must be able to TRUST are
 * checked — schema tag, the two ids, and the content-identity triple. The rest
 * pass through: this is a self-written store, and rejecting a row over a field
 * a later schema version added would make the reader the fragile part.
 */
function parseAgentIoRecord(value: unknown): AgentIoRecord | null {
	if (!isJsonObject(value)) return null;
	if (value.schema !== "agent-io.v1") return null;
	if (typeof value.ts !== "string") return null;
	if (typeof value.content_sha256 !== "string" || value.content_sha256 === "") return null;
	if (value.direction !== "input" && value.direction !== "output") return null;
	if (typeof value.kind !== "string") return null;
	// SAFETY: the five discriminating fields above are validated; the remainder
	// is our own serialized record shape, read back verbatim.
	return value as unknown as AgentIoRecord;
}

/** Rows from the log, oldest-first, bounded to the newest `limit`. */
export function readAgentIoRecords(cwd: string, opts: ReadAgentIoOpts = {}): AgentIoRecord[] {
	try {
		const path = agentIoLogPath(cwd);
		if (!existsSync(path)) return [];
		const lines = readFileSync(path, "utf-8").split("\n");
		const out: AgentIoRecord[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // corrupt line — skip, keep reading
			}
			const record = parseAgentIoRecord(parsed);
			if (!record) continue;
			if (opts.agentId !== undefined && record.agent_id !== opts.agentId) continue;
			out.push(record);
		}
		const limit = opts.limit ?? DEFAULT_READ_LIMIT;
		return limit > 0 && out.length > limit ? out.slice(out.length - limit) : out;
	} catch (err) {
		void err; // unreadable log — read as empty rather than throwing at a caller
		return [];
	}
}

/**
 * The content of one record, inline or blob-resolved. Null when the row is a
 * typed placeholder (encrypted / unavailable) or the blob is missing — the
 * caller can tell which from `content_status`.
 */
export function resolveAgentIoContent(record: AgentIoRecord, cwd: string): string | null {
	if (record.content !== null) return record.content;
	if (record.content_ref === null) return null;
	try {
		const path = agentIoBlobPath(cwd, record.content_ref);
		if (!existsSync(path)) return null;
		return readFileSync(path, "utf-8");
	} catch (err) {
		void err; // missing/unreadable blob — the row still reports its sha + size
		return null;
	}
}

/** Identity of one row for dedup: agent + kind + stored-content hash. This is
 *  what makes a re-drain and a backfill converge instead of duplicating — the
 *  guarantee `timeline-writer.ts` gets from `uuid#seq`, which a projection
 *  store has no natural equivalent for. */
function agentIoKey(record: {
	agent_id: string | null;
	kind: string;
	content_sha256: string;
}): string {
	return `${record.agent_id ?? "?"}|${record.kind}|${record.content_sha256}`;
}

/** Every identity key already in the log — the set a backfill diffs against. */
export function existingAgentIoKeys(cwd: string, opts: ReadAgentIoOpts = {}): Set<string> {
	const keys = new Set<string>();
	for (const record of readAgentIoRecords(cwd, opts)) keys.add(agentIoKey(record));
	return keys;
}
