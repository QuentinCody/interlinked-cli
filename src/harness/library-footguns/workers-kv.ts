// ============================================================
// Cloudflare Workers KV footgun detectors
// ============================================================
// Two real anti-patterns specific to KV's API surface:
//
//   - `env.KV.put(k, v)` without an `expirationTtl` or
//     `expiration` option — silent leak. KV writes are billed by
//     storage volume; values without TTL persist forever.
//   - `env.KV.list()` without checking the returned cursor /
//     `list_complete` flag — only the first page (default 1000)
//     of results is returned; downstream code silently truncates.

import type { InlineMatch } from "../checks/shared.js";
import { balancedArgList, shouldSkipFootgunScan } from "./scan-helpers.js";
import type { LibraryFootgunCheck } from "./types.js";

const KV_PUT_OPEN_RE = /\b(?:env\s*\.\s*\w+|\w+\s*\.\s*KV)\s*\.\s*put\s*\(/g;
const KV_LIST_RE = /\b(?:env\s*\.\s*\w+|\w+\s*\.\s*KV)\s*\.\s*list\s*\(/g;

function detectPutNoTtl(content: string, filePath: string): InlineMatch[] {
	if (shouldSkipFootgunScan(filePath, content)) return [];
	const out: InlineMatch[] = [];
	const lines = content.split("\n");
	KV_PUT_OPEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null = KV_PUT_OPEN_RE.exec(content);
	while (m !== null) {
		const openIdx = m.index + m[0].length - 1; // index of `(`
		const args = balancedArgList(content, openIdx);
		if (args !== null) {
			const hasTtl = /\b(?:expirationTtl|expiration|metadata)\b/.test(args);
			if (!hasTtl) {
				const lineNo = content.slice(0, m.index).split("\n").length;
				out.push({
					line: lineNo,
					text: (lines[lineNo - 1] || "").trim().slice(0, 150),
				});
			}
		}
		m = KV_PUT_OPEN_RE.exec(content);
	}
	return out;
}

function detectListNoCursor(content: string, filePath: string): InlineMatch[] {
	if (shouldSkipFootgunScan(filePath, content)) return [];
	const out: InlineMatch[] = [];
	const lines = content.split("\n");
	KV_LIST_RE.lastIndex = 0;
	let m: RegExpExecArray | null = KV_LIST_RE.exec(content);
	while (m !== null) {
		// Look 300 chars after the call for any cursor / list_complete
		// reference. If absent, the caller is dropping paginated results.
		const windowEnd = Math.min(content.length, m.index + 500);
		const window = content.slice(m.index, windowEnd);
		if (!/\b(?:cursor|list_complete)\b/.test(window)) {
			const lineNo = content.slice(0, m.index).split("\n").length;
			out.push({
				line: lineNo,
				text: (lines[lineNo - 1] || "").trim().slice(0, 150),
			});
		}
		m = KV_LIST_RE.exec(content);
	}
	return out;
}

export const WORKERS_KV_FOOTGUNS: LibraryFootgunCheck[] = [
	{
		id: "workers_kv_put_no_ttl",
		name: "Workers KV put() without expirationTtl",
		library: "workers-kv",
		detect: detectPutNoTtl,
		fixInstruction:
			"`env.KV.put(key, value)` with no options creates a permanent entry that you'll pay storage for forever. Pass `{ expirationTtl: <seconds> }` for time-bounded data, `{ expiration: <unix-seconds> }` for absolute expiry, or document the permanent intent in a comment.",
	},
	{
		id: "workers_kv_list_no_cursor",
		name: "Workers KV list() without cursor pagination",
		library: "workers-kv",
		detect: detectListNoCursor,
		fixInstruction:
			"`env.KV.list()` returns at most 1000 keys per page — any additional keys are silently dropped from your result. Check `list_complete` and loop with `cursor: result.cursor` until done, or pass `{ limit: <N> }` and document the partial-result intent.",
	},
];
