import { join } from "node:path";
import { getDataDir } from "../lib/config.js";
import type { TimelineRecord } from "./transcript-record.js";

export const TIMELINE_FILENAME = "timeline.jsonl";

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

export function timelinePath(cwd: string): string {
	return join(getDataDir(cwd), TIMELINE_FILENAME);
}

export function recordKey(record: TimelineRecord): string {
	return `${record.uuid}#${record.seq}`;
}

export function serializeRecord(record: TimelineRecord): string {
	return JSON.stringify(record)
		.replaceAll(LINE_SEPARATOR, "\\u2028")
		.replaceAll(PARAGRAPH_SEPARATOR, "\\u2029");
}

export function sortTimeline(records: TimelineRecord[]): TimelineRecord[] {
	return [...records].sort((a, b) => {
		if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
		if (a.session !== b.session) return a.session < b.session ? -1 : 1;
		return a.seq - b.seq;
	});
}

export function dedupeTimeline(records: TimelineRecord[]): TimelineRecord[] {
	const seen = new Set<string>();
	const out: TimelineRecord[] = [];
	for (const record of records) {
		const key = recordKey(record);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(record);
	}
	return out;
}
