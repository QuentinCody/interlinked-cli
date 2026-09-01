// ===========================================
// Stop-time actor attribution — which files a SUBAGENT wrote
// ===========================================
// The problem this closes: a subagent's tool calls reach the daemon under the
// PARENT session id with no agent marker (CLAUDE.md, `agent-metrics.ts`), and
// `session-state.ts`'s subagent rollup unions `files_written` into the parent
// set — so at Stop the main actor is told to fix files it never opened. A
// fleet of five review agents turns one Stop into a wall of cross-attributed
// findings, which is exactly the noise the digest exists to remove.
//
// The join that IS available on disk: `.interlinked/timeline.jsonl` carries
// `agent_id`, `is_sidechain`, `tool_name` and `tool_input.file_path` per
// record (written by `transcript-record.ts`; the subagent-transcript drain in
// `server/agent-event-capture.ts` is what puts sidechain rows there). One
// bounded TAIL read of that file answers "which files did a subagent write
// this session" with no cross-file join at all.
//
// Bounded on purpose: timeline.jsonl is hundreds of MB (CLAUDE.md: "never
// full-read collection.jsonl / activity.jsonl / timeline.jsonl"). We read the
// last DEFAULT_TAIL_BYTES only and discard the first line of that window,
// which is almost certainly cut mid-record.
//
// FAIL OPEN, always. Every failure path — absent file, unreadable, malformed
// JSON, missing fields — yields NO attribution, which leaves the file in the
// main actor's list. Wrongly hiding a real finding from the main actor is the
// expensive error; wrongly showing one is merely the status quo.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** Basename of the per-session tool timeline, relative to `.interlinked/`. */
export const TIMELINE_FILE = "timeline.jsonl";

/** Tail window read from the timeline. Large enough to span a long session's
 *  sidechain rows, small enough that Stop never pays a full-file read. */
const DEFAULT_TAIL_BYTES = 4 * 1024 * 1024;

/** The line separator of a JSONL file, built from its code point rather than
 *  written as an escape. Tool-authored source has arrived here with the escape
 *  already decoded into a raw byte, which `raw_control_bytes` correctly
 *  refuses (a raw control byte makes rg classify the file as binary and skip
 *  it). One named constant is both safe and clearer at the call sites. */
const LF = String.fromCharCode(10);

/** Tool names that put content on disk. A subagent that only READ a file is
 *  not its author, so a read must never move the file out of the main list. */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
	"Write",
	"Edit",
	"MultiEdit",
	"NotebookEdit",
	"apply_patch",
]);

export interface SubagentAttribution {
	/** File path (verbatim as the tool reported it) → sorted subagent ids. */
	byFile: Map<string, string[]>;
	/** Every distinct subagent id that wrote at least one file. */
	agents: Set<string>;
}

function emptyAttribution(): SubagentAttribution {
	return { byFile: new Map(), agents: new Set() };
}

/** Narrow an unknown value to a plain record, or null. Constructed, not cast:
 *  timeline rows are foreign data and any row may be truncated or hand-edited. */
function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = v;
	return out;
}

/** The (agentId, filePath) pair a timeline row attributes, or null when the row
 *  is not a subagent write for this session. */
function attributableWrite(
	row: Record<string, unknown>,
	sessionId: string,
): { agentId: string; file: string } | null {
	if (row.is_sidechain !== true) return null; // main actor — stays in the main list
	if (typeof row.session === "string" && row.session !== sessionId) return null;
	const agentId = typeof row.agent_id === "string" && row.agent_id !== "" ? row.agent_id : null;
	if (agentId === null) return null; // unattributable ⇒ fail open
	if (typeof row.tool_name !== "string" || !WRITE_TOOLS.has(row.tool_name)) return null;
	const input = asRecord(row.tool_input);
	const file = input !== null && typeof input.file_path === "string" ? input.file_path : null;
	if (file === null || file === "") return null;
	return { agentId, file };
}

/**
 * Parse timeline JSONL text into per-file subagent attribution. Pure — the
 * whole detector is testable without touching disk. A malformed line is
 * skipped without disturbing the lines around it.
 */
export function parseSubagentFileWrites(
	jsonlText: string,
	sessionId: string,
): SubagentAttribution {
	const out = emptyAttribution();
	const seen = new Set<string>(); // `${file} ${agentId}` — de-dup repeat writes
	for (const raw of jsonlText.split(LF)) {
		const trimmed = raw.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (err) {
			void err; // truncated or corrupt row — skip it, keep scanning
			continue;
		}
		const row = asRecord(parsed);
		const hit = row === null ? null : attributableWrite(row, sessionId);
		if (hit === null) continue;
		const key = `${hit.file} ${hit.agentId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const list = out.byFile.get(hit.file) ?? [];
		list.push(hit.agentId);
		out.byFile.set(hit.file, list);
		out.agents.add(hit.agentId);
	}
	for (const list of out.byFile.values()) list.sort();
	return out;
}

/** Read the last `bytes` of a file. Returns null when absent or unreadable. */
function readFileTail(path: string, bytes: number): string | null {
	if (!existsSync(path)) return null;
	let fd: number | null = null;
	try {
		const size = statSync(path).size;
		const length = Math.min(size, bytes);
		if (length === 0) return "";
		const buf = Buffer.alloc(length);
		fd = openSync(path, "r");
		readSync(fd, buf, 0, length, size - length);
		return buf.toString("utf-8");
	} catch (err) {
		void err; // permissions, race with rotation — fail open
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

interface LoadSubagentAttributionArgs {
	/** Absolute path to the repo's `.interlinked/` directory. */
	interlinkedDir: string;
	sessionId: string;
	/** Tail window; defaults to {@link DEFAULT_TAIL_BYTES}. */
	tailBytes?: number;
	/** Injected for tests. Defaults to a real bounded tail read. */
	readTail?: (path: string, bytes: number) => string | null;
	/** Injected for tests: forces the partial-first-line drop that a real
	 *  byte-bounded tail triggers. Production infers it from the read size. */
	truncatedTail?: boolean;
}

/**
 * Load subagent→file attribution for one session from the timeline tail.
 * Returns an empty attribution on ANY failure — see the module docstring on
 * why this direction of error is the safe one.
 */
export function loadSubagentAttribution(
	args: LoadSubagentAttributionArgs,
): SubagentAttribution {
	const bytes = args.tailBytes ?? DEFAULT_TAIL_BYTES;
	const path = join(args.interlinkedDir, TIMELINE_FILE);
	let text: string | null;
	try {
		text = (args.readTail ?? readFileTail)(path, bytes);
	} catch (err) {
		void err; // injected reader threw — fail open
		return emptyAttribution();
	}
	if (text === null) return emptyAttribution();
	// A byte-bounded tail almost certainly starts mid-record. Drop that first
	// line rather than letting a half-object become a parse error every Stop.
	const truncated = args.truncatedTail ?? text.length >= bytes;
	const body = truncated ? text.slice(text.indexOf(LF) + 1) : text;
	return parseSubagentFileWrites(body, args.sessionId);
}
