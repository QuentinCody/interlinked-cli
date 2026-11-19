// ===========================================
// Transcript readers for agent-io capture
// ===========================================
// Two reads the existing capture path does not do:
//
//  1. A HEAD read for the spawn prompt. The prompt is the transcript's FIRST
//     entry, and every existing reader tails (`FINAL_MESSAGE_TAIL_BYTES`,
//     `MAX_ONESHOT_TRANSCRIPT_BYTES`) — so the longer an agent ran, the more
//     certainly its instruction was the first thing dropped.
//
//  2. The last TERMINAL block, not the last text block. `lastAssistantText`
//     walks back for `type:"text"` only, so an agent returning through
//     `StructuredOutput` has its real return value discarded and a trailing
//     narration line kept in its place.
//
// Both are pure functions over transcript text plus one bounded file read, so
// they are testable without a runner and cheap enough for the stop path.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import { PROMPT_HEAD_BYTES, RETURN_VERB_TOOLS, SPAWN_TOOL_NAMES } from "./types.js";

function readUtf8Range(path: string, offset: number, length: number): string {
	const buffer = Buffer.alloc(length);
	const fd = openSync(path, "r");
	try {
		const bytesRead = readSync(fd, buffer, 0, length, offset);
		return buffer.toString("utf-8", 0, bytesRead);
	} finally {
		closeSync(fd);
	}
}

/** Read the last `tailBytes` of a file as utf-8, dropping a partial first
 *  line when the read starts mid-file. Null on any failure. Single definition
 *  of the bounded tail read — the agent-event capture path imports it from
 *  here rather than keeping a second copy. */
export function readTranscriptTail(path: string, tailBytes: number): string | null {
	try {
		if (!existsSync(path)) return null;
		const size = statSync(path).size;
		if (size === 0) return null;
		const offset = Math.max(0, size - tailBytes);
		const text = readUtf8Range(path, offset, size - offset);
		return offset > 0 ? text.slice(text.indexOf("\n") + 1) : text;
	} catch (err) {
		void err; // unreadable transcript — capture degrades to payload-only
		return null;
	}
}

/** Read the first `headBytes` of a file as utf-8, dropping a partial LAST
 *  line when the read stopped mid-file (the mirror of the tail reader's
 *  partial-FIRST-line drop). Null on any failure. */
export function readTranscriptHead(path: string, headBytes = PROMPT_HEAD_BYTES): string | null {
	try {
		if (!existsSync(path)) return null;
		const size = statSync(path).size;
		if (size === 0) return null;
		const length = Math.min(size, headBytes);
		const text = readUtf8Range(path, 0, length);
		if (length >= size) return text;
		const lastBreak = text.lastIndexOf("\n");
		return lastBreak >= 0 ? text.slice(0, lastBreak) : "";
	} catch (err) {
		void err; // unreadable transcript — capture degrades to a placeholder row
		return null;
	}
}

/** Text of one message body, which the runner sends either as a plain string
 *  or as a content-block array. */
function messageText(message: unknown): string | null {
	if (!isJsonObject(message)) return null;
	const content = message.content;
	if (typeof content === "string") return content.trim() ? content : null;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const raw of content) {
		if (!isJsonObject(raw)) continue;
		if (raw.type === "text" && typeof raw.text === "string" && raw.text.trim()) parts.push(raw.text);
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

/** The spawn prompt carried on an assistant entry's own spawn tool_use. A
 *  forked agent's transcript opens with the `Agent` call that created it
 *  rather than with a user entry, so this is the only prompt it has. */
function spawnToolPrompt(entry: JsonObject): string | null {
	if (entry.type !== "assistant") return null;
	const message = entry.message;
	if (!isJsonObject(message) || !Array.isArray(message.content)) return null;
	for (const raw of message.content) {
		if (!isJsonObject(raw)) continue;
		if (raw.type !== "tool_use" || typeof raw.name !== "string") continue;
		if (!SPAWN_TOOL_NAMES.has(raw.name)) continue;
		const input = raw.input;
		if (isJsonObject(input) && typeof input.prompt === "string" && input.prompt.trim()) {
			return input.prompt;
		}
	}
	return null;
}

/**
 * The agent's INSTRUCTION, read from the head of its own transcript: the
 * first `type:"user"` entry, or — for a forked agent, whose transcript opens
 * with the spawning `Agent` call instead — that call's prompt.
 */
export function firstUserMessage(jsonlText: string): string | null {
	let spawnFallback: string | null = null;
	for (const line of jsonlText.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // truncated / non-JSON line — keep walking
		}
		if (!isJsonObject(parsed)) continue;
		if (parsed.type === "user") {
			const text = messageText(parsed.message);
			if (text !== null) return text;
		}
		if (spawnFallback === null) spawnFallback = spawnToolPrompt(parsed);
	}
	return spawnFallback;
}

/** A terminal return-verb tool call and its serialized arguments. */
export interface StructuredReturn {
	tool: string;
	/** `tool_input` serialized as JSON — the agent's actual return value. */
	json: string;
}

/** The return-verb tool_use of one assistant entry, latest block first. */
function entryStructuredReturn(entry: JsonObject): StructuredReturn | null {
	if (entry.type !== "assistant") return null;
	const message = entry.message;
	if (!isJsonObject(message) || !Array.isArray(message.content)) return null;
	for (let i = message.content.length - 1; i >= 0; i--) {
		const raw: unknown = message.content[i];
		if (!isJsonObject(raw)) continue;
		if (raw.type !== "tool_use" || typeof raw.name !== "string") continue;
		if (!RETURN_VERB_TOOLS.has(raw.name)) continue;
		if (raw.input === undefined) continue;
		return { tool: raw.name, json: JSON.stringify(raw.input) };
	}
	return null;
}

/**
 * The agent's STRUCTURED return — the last `StructuredOutput` / `ReportFindings`
 * call in the transcript. Null when the agent returned prose only, in which
 * case the `final_message` row already holds everything there is.
 */
export function lastStructuredReturn(jsonlText: string): StructuredReturn | null {
	const lines = jsonlText.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // truncated / non-JSON line — keep walking
		}
		if (!isJsonObject(parsed)) continue;
		const found = entryStructuredReturn(parsed);
		if (found) return found;
	}
	return null;
}
