// ===========================================
// Water-line JSON — the ONE strict parser for `.interlinked/` ratchet baselines
// ===========================================
//
// Red team 2026-10-21 round 3 ("coverage-high-water" parse differential): the
// baseline-integrity gate parsed water-lines with the JSONC-tolerant
// `safeJsonParse` (config-loosening-gate.ts — comment stripping, trailing-comma
// removal), while every runtime consumer (coverage-obligation-ledger.ts,
// metric-caps.ts, large-file-policy.ts, …) parses with strict `JSON.parse`.
// A trailing comma or a `//` line made the gate see "unchanged" and the
// runtime see "no ledger"; a `/* … */` pair inside two string KEYS made the
// gate strip a lowered duplicate entry that the runtime then read as the
// winner. Water-lines are written by `JSON.stringify` only, so they are
// strict JSON by construction: this module is the parser both sides share.
//
// tsconfig / biome files are JSONC by specification and keep `safeJsonParse`;
// nothing here applies to them.

import { readFileSync } from "node:fs";
import { isJsonObject } from "../lib/json-types.js";

/** Result of a strict water-line parse. `duplicateKeys` lists the path of every
 *  object key that appears more than once in its object (`JSON.parse` keeps the
 *  LAST copy, so an earlier copy is text no consumer reads). */
export type WaterLineParse =
	| { ok: true; value: unknown; duplicateKeys: string[] }
	| { ok: false; error: string };

/** The byte-order mark `JSON.parse` rejects and `readFileSync(…, "utf8")` keeps. */
const BYTE_ORDER_MARK = 0xfeff;

/**
 * Parse water-line text with strict `JSON.parse` semantics — the same value
 * every runtime consumer reads. Fails (with a named reason) on an empty text,
 * a byte-order mark, or any JSON syntax error; never strips or repairs.
 */
export function parseWaterLineJson(text: string): WaterLineParse {
	if (text.trim() === "") return { ok: false, error: "the file is empty" };
	if (text.charCodeAt(0) === BYTE_ORDER_MARK) {
		return { ok: false, error: "the file starts with a UTF-8 byte-order mark, which JSON.parse rejects" };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	return { ok: true, value, duplicateKeys: duplicateKeyPaths(text) };
}

/**
 * Read and strictly parse one water-line file. Returns null when the file is
 * absent or unreadable, so a caller can tell "no water-line" from "a water-line
 * that does not parse" (the `readJsonFile` helper conflates the two).
 */
export function readWaterLineFile(path: string): WaterLineParse | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	return parseWaterLineJson(text);
}

/** One way a post-image drops what an existing water-line held. */
export interface PostImageDefect {
	rule: string;
	message: string;
}

/**
 * Defects of the text an edit leaves in an EXISTING, parseable water-line,
 * judged before any value comparison. Each one is a loosening, because the
 * runtime then reads something other than what a value comparison would judge:
 *   - an unparseable or empty post-image reads as "no water-line", so every
 *     floor and high-water it held is gone at once;
 *   - a repeated key hides its earlier copy from every consumer (JSON.parse
 *     keeps the last), so the text shows one value and the ratchet uses another;
 *   - a non-object post-image of an object water-line reads as empty.
 */
export function postImageDefects(before: unknown, after: WaterLineParse): PostImageDefect[] {
	if (!after.ok) {
		return [{
			rule: "water-line-unparseable",
			message: `the post-image is not strict JSON (${after.error}). Every consumer parses water-lines with strict JSON.parse and would read this file as absent, so every ratchet it holds would decide unconstrained. Write strict JSON: no comments, no trailing commas, no byte-order mark.`,
		}];
	}
	const out: PostImageDefect[] = [];
	if (after.duplicateKeys.length > 0) {
		out.push({
			rule: "water-line-duplicate-key",
			message: `the post-image repeats ${after.duplicateKeys.join(", ")}. JSON.parse keeps only the last copy, so the ratchet would read a value the earlier copy hides. Keep each key once.`,
		});
	}
	if (isJsonObject(before) && !isJsonObject(after.value)) {
		out.push({
			rule: "water-line-shape",
			message: "the post-image is not a JSON object, so every consumer would read the water-line as empty.",
		});
	}
	return out;
}

// ---- duplicate-key scan ------------------------------------------------------

/** One open container during the scan. `keys` is null for an array. */
interface Frame {
	path: string;
	keys: Set<string> | null;
	expectKey: boolean;
	lastKey: string;
	index: number;
}

/** Index just past the string literal that opens at `start` (a `"`). */
function stringEnd(text: string, start: number): number {
	let i = start + 1;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") i += 2;
		else if (ch === '"') return i + 1;
		else i += 1;
	}
	return text.length;
}

function keyPath(parent: string, key: string): string {
	return `${parent}[${JSON.stringify(key)}]`;
}

/** Path of a container that opens inside `parent` (`$` at the top level). */
function childContainerPath(parent: Frame | undefined): string {
	if (!parent) return "$";
	return parent.keys ? keyPath(parent.path, parent.lastKey) : `${parent.path}[${parent.index}]`;
}

/** Decoded text of one key literal. The scan runs only on text JSON.parse has
 *  already accepted, so the fallback (the raw literal) is unreachable in
 *  practice; it keeps the scan total. */
function decodeKey(literal: string): string {
	try {
		const decoded: unknown = JSON.parse(literal);
		return typeof decoded === "string" ? decoded : literal;
	} catch {
		return literal;
	}
}

/** Record a string literal; when it sits in key position, check it for a repeat. */
function visitString(top: Frame | undefined, literal: string, out: string[]): void {
	if (!top?.keys || !top.expectKey) return;
	const key = decodeKey(literal);
	if (top.keys.has(key)) out.push(keyPath(top.path, key));
	top.keys.add(key);
	top.lastKey = key;
	top.expectKey = false;
}

/** Apply one structural character to the container stack. */
function visitStructural(stack: Frame[], ch: string): void {
	const top = stack.at(-1);
	if (ch === "{" || ch === "[") {
		const isObject = ch === "{";
		stack.push({ path: childContainerPath(top), keys: isObject ? new Set() : null, expectKey: isObject, lastKey: "", index: 0 });
	} else if (ch === "}" || ch === "]") {
		stack.pop();
	} else if (ch === "," && top) {
		if (top.keys) top.expectKey = true;
		else top.index += 1;
	}
}

/** Paths of every repeated object key in already-valid JSON text. */
function duplicateKeyPaths(text: string): string[] {
	const out: string[] = [];
	const stack: Frame[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i] ?? "";
		if (ch === '"') {
			const end = stringEnd(text, i);
			visitString(stack.at(-1), text.slice(i, end), out);
			i = end;
			continue;
		}
		visitStructural(stack, ch);
		i += 1;
	}
	return out;
}

// ---- canonical text ------------------------------------------------------------

/** Characters a JSONC-tolerant parser rewrites even inside string literals. */
const JSONC_SENSITIVE = /[/,]/g;

function escapeSensitive(ch: string): string {
	return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/**
 * Serialize a strictly parsed water-line value so that ANY JSON reader —
 * strict, or a JSONC-tolerant one that strips line comments, block comments
 * and trailing commas — decodes the same value. Inside string literals, `/`
 * and `,` are written as `/` / `,` (valid JSON escapes), so no
 * comment or trailing-comma pattern can match. Used to hand a sibling detector
 * that still parses its own text the exact value the strict parser read.
 */
export function canonicalWaterLineText(value: unknown): string {
	const text = JSON.stringify(value) ?? "null";
	return text.replace(/"(?:[^"\\]|\\.)*"/g, (literal) => literal.replace(JSONC_SENSITIVE, escapeSensitive));
}
