// ===========================================
// Edit-tool reconstruction — the bytes a str-replace / Write call would leave
// ===========================================
//
// The baseline-integrity gate judges what an edit WOULD leave on disk. It used
// to borrow `reconstructEditContent` from config-loosening-gate.ts, which
// ignored `replace_all` and returned null for any old_string that occurred
// more than once; the gate then failed OPEN on null. An Edit with
// `replace_all: true` therefore loosened any water-line with no finding (red
// team 2026-10-21, "Scope-string re-anchor" round 2).
//
// This module models the Edit tool's real semantics and never collapses "I
// cannot tell" into "nothing changed":
//   - Write: the full `content` is the result.
//   - Edit: `replace_all: true` replaces EVERY occurrence. Without it, a unique
//     occurrence is replaced; an absent or non-unique old_string is
//     UNDECIDABLE. The client would reject it, but a gate must not assume the
//     client's validation.
//   - MultiEdit: `edits[]` applied sequentially under the same rules.
//   - Empty new_string: Claude Code's applier also consumes the newline after
//     old_string when one follows. Both readings are returned as candidates so
//     the caller judges each one; no single guess decides.
// Pure: no disk, no clock.

import { isJsonObject, type JsonObject } from "../../lib/json-types.js";

/** Upper bound on simultaneous candidate results before we stop guessing. */
const MAX_CANDIDATES = 16;

/** What a tool call would leave in one file. */
export type Reconstruction =
	| { readonly kind: "decided"; readonly contents: readonly string[] }
	| { readonly kind: "undecidable"; readonly reason: string };

function decided(contents: readonly string[]): Reconstruction {
	return { kind: "decided", contents: [...new Set(contents)] };
}

/** Public API — the undecidable result, for callers that hit a shape this module does not model. */
export function undecidable(reason: string): Reconstruction {
	return { kind: "undecidable", reason };
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function replaceFirst(content: string, search: string, replacement: string): string {
	const at = content.indexOf(search);
	return at < 0 ? content : content.slice(0, at) + replacement + content.slice(at + search.length);
}

function replaceEvery(content: string, search: string, replacement: string): string {
	return content.split(search).join(replacement);
}

interface ReplaceEntry {
	oldString: string;
	newString: string;
	replaceAll: boolean;
	/** Gemini `expected_replacements`: the client applies the edit to every
	 *  occurrence only when exactly this many exist, and rejects it otherwise. */
	expected?: number;
}

/**
 * Runner spellings of each str-replace / Write field, canonical name first
 * (red team 2026-10-21 round 3): OpenCode and VS Code Copilot send camelCase,
 * Copilot CLI `old_str` / `new_str` / `file_text`, the MCP filesystem server
 * `oldText` / `newText`, Gemini `expected_replacements`.
 */
const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
	old_string: ["old_string", "oldString", "old_str", "oldText"],
	new_string: ["new_string", "newString", "new_str", "newText"],
	replace_all: ["replace_all", "replaceAll"],
	expected_replacements: ["expected_replacements", "expectedReplacements"],
	content: ["content", "file_text", "fileText"],
};

/**
 * The input with every aliased field under its canonical name. Returns a
 * reason string when two spellings of one field disagree: a client honours
 * one of them, and the gate cannot tell which.
 */
function canonicalEditFields(input: JsonObject): JsonObject | string {
	const out: JsonObject = { ...input };
	for (const [canonical, spellings] of Object.entries(FIELD_ALIASES)) {
		const present = spellings.filter((key) => input[key] !== undefined);
		const first = present[0];
		if (first === undefined) continue;
		const value = input[first];
		if (present.some((key) => JSON.stringify(input[key]) !== JSON.stringify(value))) {
			return `the input spells \`${canonical}\` as ${present.join(" and ")} with different values`;
		}
		out[canonical] = value;
	}
	return out;
}

/**
 * Narrow one untrusted str-replace entry. `null` = malformed (not an object,
 * or old_string / new_string not a string): a schema error the client rejects,
 * so it is skipped rather than coerced. A string = well-typed but not
 * applicable, which makes the call undecidable.
 */
function readEntry(raw: unknown): ReplaceEntry | string | null {
	if (!isJsonObject(raw)) return null;
	const edit = canonicalEditFields(raw);
	if (typeof edit === "string") return edit;
	const { old_string: oldString, new_string: newString, replace_all: replaceAll, expected_replacements: expected } = edit;
	if (typeof oldString !== "string" || typeof newString !== "string") return null;
	if (replaceAll !== undefined && typeof replaceAll !== "boolean") return "replace_all is not a boolean";
	if (expected !== undefined && !(typeof expected === "number" && Number.isInteger(expected) && expected >= 1)) {
		return "expected_replacements is not a positive integer";
	}
	if (oldString === "") return "old_string is empty";
	return { oldString, newString, replaceAll: replaceAll === true, ...(expected === undefined ? {} : { expected }) };
}

/** Every result one entry can produce against one content (1 or 2 readings). */
function applyEntry(content: string, entry: ReplaceEntry): string[] | string {
	const count = countOccurrences(content, entry.oldString);
	if (count === 0) return "old_string does not occur in the current file";
	if (entry.expected !== undefined && count !== entry.expected) {
		return `old_string occurs ${count} times but expected_replacements is ${entry.expected}`;
	}
	const every = entry.replaceAll || entry.expected !== undefined;
	if (count > 1 && !every) {
		return `old_string occurs ${count} times and replace_all is not set`;
	}
	const apply = every ? replaceEvery : replaceFirst;
	const plain = apply(content, entry.oldString, entry.newString);
	const withNewline = `${entry.oldString}\n`;
	const stripsNewline = entry.newString === "" && !entry.oldString.endsWith("\n") && content.includes(withNewline);
	return stripsNewline ? [apply(content, withNewline, ""), plain] : [plain];
}

/**
 * Public API — apply one Edit entry (`old_string` / `new_string` /
 * `replace_all`) with the Edit tool's semantics. Absent, non-unique without
 * replace_all, empty, or mistyped input is undecidable.
 */
export function reconstructEdit(content: string, edit: unknown): Reconstruction {
	return reconstructMultiEdit(content, [edit]);
}

/**
 * Public API — apply MultiEdit `edits[]` sequentially, each entry against the
 * result of the previous ones. Any undecidable entry makes the whole call
 * undecidable; malformed entries are skipped, but a non-empty list with no
 * well-formed entry left is undecidable (skipping must never mean "unchanged").
 */
export function reconstructMultiEdit(content: string, edits: readonly unknown[]): Reconstruction {
	let candidates = [content];
	let applied = 0;
	for (const [index, raw] of edits.entries()) {
		const entry = readEntry(raw);
		if (entry === null) continue;
		if (typeof entry === "string") return undecidable(`edit ${index + 1}: ${entry}`);
		applied += 1;
		const next: string[] = [];
		for (const candidate of candidates) {
			const results = applyEntry(candidate, entry);
			if (typeof results === "string") return undecidable(`edit ${index + 1}: ${results}`);
			next.push(...results);
		}
		candidates = [...new Set(next)];
		if (candidates.length > MAX_CANDIDATES) return undecidable("too many possible results to judge");
	}
	if (edits.length > 0 && applied === 0) return undecidable("no edit entry has string old_string and new_string");
	return decided(candidates);
}

const EDIT_KEYS = ["old_string", "new_string", "replace_all"] as const;

/**
 * Public API — every result a Write / Edit / MultiEdit tool input could leave
 * in its target, given the current text (`before`, null when the file does
 * not exist). Each shape the input carries is reconstructed and its results
 * are pooled, because a client that ignores an unexpected key would apply the
 * OTHER shape. An input with no recognizable shape is undecidable.
 */
export function reconstructToolInput(before: string | null, rawInput: JsonObject): Reconstruction {
	const toolInput = canonicalEditFields(rawInput);
	if (typeof toolInput === "string") return undecidable(toolInput);
	const contents: string[] = [];
	const hasWrite = typeof toolInput.content === "string";
	if (typeof toolInput.content === "string") contents.push(toolInput.content);
	const hasMulti = toolInput.edits !== undefined;
	const hasSingle = EDIT_KEYS.some((key) => toolInput[key] !== undefined);
	if (!hasWrite && !hasMulti && !hasSingle) {
		return undecidable("the tool input carries neither full `content` nor a str-replace edit");
	}
	const editShapes: Reconstruction[] = [];
	if (hasMulti) {
		editShapes.push(Array.isArray(toolInput.edits) ? reconstructAgainst(before, toolInput.edits) : undecidable("`edits` is not an array"));
	}
	if (hasSingle) editShapes.push(reconstructAgainst(before, [toolInput]));
	for (const shape of editShapes) {
		if (shape.kind === "undecidable") return shape;
		contents.push(...shape.contents);
	}
	return decided(contents);
}

function reconstructAgainst(before: string | null, edits: readonly unknown[]): Reconstruction {
	if (before === null) return undecidable("a str-replace edit targets a file that does not exist");
	return reconstructMultiEdit(before, edits);
}
