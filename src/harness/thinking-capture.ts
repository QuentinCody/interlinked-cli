// Live thinking capture — the daemon-side port of what the old self-contained
// .mjs hook did and the thin hook-entry.js path never replicated (the cause of
// the June-1 thinking-capture regression). On a PreToolUse event the daemon
// resolves the agent's transcript and reads the NEW reasoning blocks recorded
// since the last tool call — that's the thinking that preceded THIS tool — then
// the activity writer attaches it to the tool_use_start record.
//
// Bounded byte-offset cursors per transcript
// (.interlinked/thinking-cursor.json), so parallel sessions resume independently
// and each call returns only thinking appended since the previous one. Thinking
// is SCRUBBED (secrets + PII) before it is returned, since the active write path
// does not otherwise scrub and reasoning is the one field we always redact.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { redactPii, scrubSecrets } from "../lib/secrets.js";

interface ThinkingCursor {
	path: string;
	offset: number;
	offsets: Record<string, number>;
}

const MAX_CURSOR_TRANSCRIPTS = 32;
export const MAX_THINKING_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

function isValidOffset(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function numericOffsets(value: unknown): Record<string, number> {
	if (!isJsonObject(value)) return {};
	const entries: Array<[string, number]> = [];
	for (const [path, offset] of Object.entries(value)) {
		if (isValidOffset(offset)) entries.push([path, offset]);
	}
	return Object.fromEntries(entries);
}

/** Narrow a parsed `thinking-cursor.json` value to a `ThinkingCursor`.
 *  Returns null when the value isn't a JSON object or either field is the
 *  wrong type — the caller falls back to a fresh cursor either way. */
function parseThinkingCursor(value: unknown): ThinkingCursor | null {
	if (!isJsonObject(value)) return null;
	const { path, offset } = value;
	if (typeof path !== "string" || !isValidOffset(offset)) return null;
	const offsets = numericOffsets(value.offsets);
	if (path) {
		delete offsets[path];
		offsets[path] = offset;
	}
	return { path, offset, offsets };
}

function readCursor(cursorPath: string): ThinkingCursor {
	try {
		const cursor = parseThinkingCursor(JSON.parse(readFileSync(cursorPath, "utf-8")));
		if (cursor) return cursor;
	} catch (e) {
		void e; // missing/corrupt cursor → start fresh
	}
	return { path: "", offset: 0, offsets: {} };
}

function updatedCursor(cursor: ThinkingCursor, transcriptPath: string, offset: number): ThinkingCursor {
	const offsets = { ...cursor.offsets };
	delete offsets[transcriptPath];
	offsets[transcriptPath] = offset;
	const paths = Object.keys(offsets);
	for (let i = 0; i < paths.length - MAX_CURSOR_TRANSCRIPTS; i++) {
		const oldest = paths[i];
		if (oldest !== undefined) delete offsets[oldest];
	}
	return { path: transcriptPath, offset, offsets };
}

function readBytes(filePath: string, start: number, length: number): Buffer {
	const fd = openSync(filePath, "r");
	try {
		const buf = Buffer.alloc(length);
		let bytesRead = 0;
		while (bytesRead < length) {
			const count = readSync(fd, buf, bytesRead, length - bytesRead, start + bytesRead);
			if (count === 0) break;
			bytesRead += count;
		}
		return bytesRead === length ? buf : buf.subarray(0, bytesRead);
	} finally {
		closeSync(fd);
	}
}

/** Narrow a transcript JSONL line to an assistant record's `message` object,
 *  or null when the line isn't a recognized `{type: "assistant", message}`
 *  record. Shared by the thinking-block extractor and the latest-model
 *  reader below — both need the same "is this an assistant line" gate. */
function parseAssistantMessage(value: unknown): JsonObject | null {
	if (!isJsonObject(value) || value.type !== "assistant") return null;
	const message = value.message;
	return isJsonObject(message) ? message : null;
}

/** Extract every non-empty `thinking` string from an assistant record's
 *  content blocks. Returns null when the line isn't a recognized assistant
 *  record, or an array (possibly empty) of the thinking strings found —
 *  non-object/non-thinking entries in `content` are skipped, not fatal. */
function parseAssistantThinkingBlocks(value: unknown): string[] | null {
	const message = parseAssistantMessage(value);
	if (!message) return null;
	const content = message.content;
	if (!Array.isArray(content)) return null;
	const blocks: string[] = [];
	for (const entry of content) {
		if (!isJsonObject(entry)) continue;
		if (entry.type === "thinking" && typeof entry.thinking === "string" && entry.thinking) {
			blocks.push(entry.thinking);
		}
	}
	return blocks;
}

/** Narrow an assistant record's `message.model` field to a string, or null
 *  when the line isn't a recognized assistant record or `model` isn't a
 *  string. */
function parseAssistantModel(value: unknown): string | null {
	const message = parseAssistantMessage(value);
	if (!message) return null;
	return typeof message.model === "string" ? message.model : null;
}

/**
 * Read and parse whatever new transcript bytes exist since the cursor,
 * persist the advanced cursor, and return the combined SCRUBBED thinking
 * text (or null when there is none). May throw — the caller fails open.
 */
function collectNewThinking(transcriptPath: string, cursorPath: string): string | null {
	const size = statSync(transcriptPath).size;
	const cursor = readCursor(cursorPath);
	let offset = cursor.offsets[transcriptPath] ?? 0;
	if (offset > size) offset = 0;
	if (offset === size) return null;

	const readStart = Math.max(offset, size - MAX_THINKING_TRANSCRIPT_BYTES);
	const buf = readBytes(transcriptPath, readStart, size - readStart);
	let text = buf.toString("utf-8");
	if (readStart > offset) {
		const firstNewline = text.indexOf("\n");
		text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
	}

	const parts: string[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const blocks = parseAssistantThinkingBlocks(JSON.parse(line));
			if (blocks) parts.push(...blocks);
		} catch (e) {
			void e; // a truncated final line is normal — skip it
		}
	}

	// Persist the cursor even when no thinking was found, so we don't re-scan.
	writeFileSync(cursorPath, JSON.stringify(updatedCursor(cursor, transcriptPath, size)));
	if (parts.length === 0) return null;

	const combined = parts.join("\n---\n");
	return redactPii(scrubSecrets(combined).text).text;
}

/**
 * Return the SCRUBBED reasoning recorded in `transcriptPath` since the last call
 * (tracked by the cursor at `cursorPath`), or null when there is no new thinking
 * (or the transcript is missing/unreadable). Advances the cursor to EOF. Never
 * throws — fail-open so a capture hiccup never breaks the daemon pipeline.
 */
export function extractNewThinking(transcriptPath: string, cursorPath: string): string | null {
	if (!transcriptPath || !existsSync(transcriptPath)) return null;
	try {
		return collectNewThinking(transcriptPath, cursorPath);
	} catch (e) {
		void e;
		return null;
	}
}

/**
 * Resolve a session's Claude Code transcript path. Prefers the explicit
 * `transcript_path` the payload carries; otherwise derives it from the standard
 * layout `~/.claude/projects/<cwd-with-slashes-as-dashes>/<session>.jsonl`
 * (verified: Claude names the transcript by session id). Returns null when it
 * can't resolve to an existing file.
 */
export function resolveTranscriptPath(
	explicit: string | undefined,
	sessionId: string | undefined,
	cwd: string,
	homeDir: string,
): string | null {
	if (explicit && existsSync(explicit)) return explicit;
	if (!sessionId) return null;
	const slug = cwd.replace(/\//g, "-");
	const derived = `${homeDir}/.claude/projects/${slug}/${sessionId}.jsonl`;
	return existsSync(derived) ? derived : null;
}

/**
 * The model id of the most recent assistant turn in the transcript (reads the
 * tail only). Used to attribute a tool_use_start activity record to the model
 * that made the call. Returns null when unresolvable. Never throws.
 */
export function latestTranscriptModel(transcriptPath: string): string | null {
	if (!transcriptPath || !existsSync(transcriptPath)) return null;
	try {
		const size = statSync(transcriptPath).size;
		const start = Math.max(0, size - 256 * 1024);
		const buf = readBytes(transcriptPath, start, size - start);
		let model: string | null = null;
		for (const line of buf.toString("utf-8").split("\n")) {
			if (!line.includes('"model"')) continue;
			try {
				const parsedModel = parseAssistantModel(JSON.parse(line));
				if (parsedModel) model = parsedModel;
			} catch (e) {
				void e;
			}
		}
		return model;
	} catch (e) {
		void e;
		return null;
	}
}
