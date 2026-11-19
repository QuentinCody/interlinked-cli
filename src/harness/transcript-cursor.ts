import { isJsonObject } from "../lib/json-types.js";

export interface TranscriptCursor {
	path: string;
	offset: number;
	offsets: Record<string, number>;
}

const MAX_CURSOR_TRANSCRIPTS = 32;

export function isValidOffset(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function numericOffsets(value: unknown): Record<string, number> {
	const offsets: Record<string, number> = Object.create(null);
	if (isJsonObject(value)) {
		for (const [path, offset] of Object.entries(value)) {
			if (isValidOffset(offset)) offsets[path] = offset;
		}
	}
	return offsets;
}

export function transcriptOffset(cursor: TranscriptCursor, path: string): number {
	return Object.hasOwn(cursor.offsets, path) ? (cursor.offsets[path] ?? 0) : 0;
}

export function updatedCursor(cursor: TranscriptCursor, path: string, offset: number): TranscriptCursor {
	const offsets = new Map(Object.entries(cursor.offsets));
	offsets.delete(path);
	offsets.set(path, offset);
	return { path, offset, offsets: Object.fromEntries([...offsets].slice(-MAX_CURSOR_TRANSCRIPTS)) };
}
