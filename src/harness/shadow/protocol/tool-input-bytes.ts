// ===========================================
// Shadow protocol v1 — EXACT tool-input byte measurement (memo §12.2)
// ===========================================
// `command_stdin_toolinput_bytes` bounds the WHOLE raw hook payload. Three
// generations of this walk were wrong, and every one was reproduced:
//
//  * String-only recursion: `{ pad: [true × 250 000] }` serializes to
//    1 250 048 bytes and passed a 1 MiB cap, because booleans, numbers, null,
//    commas, braces, brackets and quotes all cost zero.
//  * The same recursion threw `RangeError: Maximum call stack size exceeded`
//    on 20 000 nested arrays — a CRASH inside the daemon's hook path. A
//    resource limit that the value it bounds can turn into a crash is not a
//    limit.
//  * A "conservative lower bound" (review 2026-09-04): a string of 600 000
//    newlines serializes to 1 200 002 bytes and measured 600 002, because an
//    escape counted one byte instead of two — so a 1.2 MiB payload passed the
//    1 MiB cap. UNDER-counting is NOT the safe direction. A size
//    gate that understates admits exactly the payloads it exists to refuse.
//
// So this walk counts EXACT `JSON.stringify` bytes: escaped string width (a
// two-byte escape for a quote, a backslash, and the five short control
// escapes; six bytes for any other control character and for a lone
// surrogate) plus the two quotes, every key's text plus its quotes and colon,
// every bracket, brace and comma, and each scalar at its serialized width.
// `measure(v).bytes` equals `Buffer.byteLength(JSON.stringify(v))` for every
// value it accepts, and a property test pins that equality.
//
// Values `JSON.stringify` would NOT carry faithfully — `undefined`, functions,
// symbols (dropped or coerced to `null`), `bigint` (throws), `NaN` and
// `Infinity` (coerced to `null`), and any object with a `toJSON` or an exotic
// internal shape (a `Date`, a boxed primitive) — are REFUSED as `projection`
// rather than costed against a serialization that would never happen.
//
// The walk is ITERATIVE (an explicit stack, never recursion) and bounded in
// DEPTH and NODE COUNT. Containers are held as INDEX frames, so a 10-million-
// element array costs O(1) memory per nesting level, and its cardinality is
// charged against the node budget BEFORE any child is read — a wide payload is
// refused in bounded time, not walked. The total is checked after every value,
// so an over-cap payload is refused after bounded work, never measured in full.

import { isRecord } from "./field-checks.js";

/** Deepest JSON nesting the walk will descend. Beyond it the payload is
 *  refused: no supported tool-input shape nests past a handful of levels, and
 *  a deep chain is an attack on the walker, not a payload. */
export const TOOL_INPUT_MAX_DEPTH = 64;

/** Most JSON nodes (scalars plus containers) the walk will visit. */
export const TOOL_INPUT_MAX_NODES = 100_000;

/** Why a measurement failed. `limits` — the payload is over the cap, wider
 *  than the node budget, or deeper than the depth bound. `projection` — the
 *  payload is not a JSON value the wire could carry, so it has no byte cost to
 *  compare against a cap. Callers map these onto their own failure vocabulary
 *  unchanged; the distinction is the difference between "too big" and "not
 *  representable".
 *  PUBLIC API: it names the failure arm of `ToolInputBytes`, so a consumer
 *  switching on the reason must be able to name the type. */
export type ToolInputBytesFailure = "limits" | "projection";

export type ToolInputBytes =
	| { ok: true; bytes: number }
	| { ok: false; reason: ToolInputBytesFailure; detail: string };

// ── string width ───────────────────────────────────────────────────────────

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

/** Control characters `JSON.stringify` writes as a TWO-byte short escape
 *  (backspace, tab, newline, form feed, carriage return); every other control
 *  character costs the six bytes of a `u`-escape. */
const SHORT_ESCAPES: ReadonlySet<number> = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

/** Serialized width of ONE UTF-16 code unit that does not start a surrogate
 *  pair. A LONE surrogate has no UTF-8 encoding, and well-formed
 *  `JSON.stringify` emits it as a six-byte escape rather than as a
 *  replacement character. */
function codeUnitBytes(code: number): number {
	if (code < 0x20) return SHORT_ESCAPES.has(code) ? 2 : 6;
	if (code === QUOTE || code === BACKSLASH) return 2;
	if (code < 0x80) return 1;
	if (code < 0x800) return 2;
	if (code >= HIGH_SURROGATE_FIRST && code <= LOW_SURROGATE_LAST) return 6;
	return 3;
}

/** UTF-8 width of a well-formed surrogate PAIR starting at `index`, or 0 when
 *  the unit at `index` does not start one. */
function surrogatePairBytes(text: string, index: number, code: number): number {
	if (code < HIGH_SURROGATE_FIRST || code > HIGH_SURROGATE_LAST || index + 1 >= text.length) return 0;
	const low = text.charCodeAt(index + 1);
	return low >= LOW_SURROGATE_FIRST && low <= LOW_SURROGATE_LAST ? 4 : 0;
}

/** EXACT `JSON.stringify` width of a string, its two quotes included. Walks
 *  code UNITS with no allocation — a 1 MiB payload field is measured in one
 *  linear pass. */
function jsonStringBytes(text: string): number {
	let bytes = 2;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		const pair = surrogatePairBytes(text, index, code);
		if (pair > 0) {
			bytes += pair;
			index += 1;
			continue;
		}
		bytes += codeUnitBytes(code);
	}
	return bytes;
}

// ── scalars ────────────────────────────────────────────────────────────────

/** A measured scalar, a container to descend into (`bytes: null`), or a
 *  rejection when `JSON.stringify` would not carry the value faithfully. */
type ScalarResult = { ok: true; bytes: number | null } | { ok: false; detail: string };

function refuse(detail: string): ScalarResult {
	return { ok: false, detail };
}

function numberBytes(value: number): ScalarResult {
	if (!Number.isFinite(value)) return refuse(`JSON.stringify coerces ${String(value)} to null`);
	return { ok: true, bytes: String(value).length };
}

const PLAIN_OBJECT_TAG = "[object Object]";
const ARRAY_TAG = "[object Array]";

/** Only a plain object or an array is a JSON container. A `Date`, a boxed
 *  primitive, a `Map` — anything with a `toJSON` or an exotic internal tag —
 *  serializes to something other than a walk of its own keys, so it is refused
 *  rather than mis-costed. */
function objectBytes(value: object): ScalarResult {
	const tag = Object.prototype.toString.call(value);
	if (tag !== PLAIN_OBJECT_TAG && tag !== ARRAY_TAG) {
		return refuse(`JSON.stringify does not carry ${tag} as a plain container`);
	}
	const toJson = "toJSON" in value ? value.toJSON : undefined;
	if (typeof toJson === "function") return refuse("value defines toJSON, so its serialized form is not its own shape");
	return { ok: true, bytes: null };
}

function scalarBytes(value: unknown): ScalarResult {
	if (typeof value === "string") return { ok: true, bytes: jsonStringBytes(value) };
	if (typeof value === "number") return numberBytes(value);
	if (typeof value === "boolean") return { ok: true, bytes: value ? 4 : 5 };
	if (value === null) return { ok: true, bytes: 4 };
	if (typeof value === "object") return objectBytes(value);
	return refuse(`JSON.stringify drops or throws on a value of type ${typeof value}`);
}

// ── containers, held as index frames ───────────────────────────────────────

interface ListFrame {
	readonly kind: "list";
	readonly items: readonly unknown[];
	readonly depth: number;
	index: number;
}

interface MapFrame {
	readonly kind: "map";
	readonly record: Record<string, unknown>;
	readonly keys: readonly string[];
	readonly depth: number;
	index: number;
}

type Frame = ListFrame | MapFrame;
type Child = { readonly value: unknown; readonly depth: number };
type Opened =
	| { kind: "list"; items: readonly unknown[] }
	| { kind: "map"; record: Record<string, unknown>; keys: readonly string[] };

/** Read a container's shape WITHOUT touching any child. Cardinality is
 *  available immediately, so the node budget can refuse a 10-million-element
 *  array before a single element is visited. */
function openContainer(value: unknown): Opened {
	if (Array.isArray(value)) return { kind: "list", items: value };
	if (!isRecord(value)) throw new Error("Expected a JSON object container");
	return { kind: "map", record: value, keys: Object.keys(value) };
}

function openedCount(opened: Opened): number {
	return opened.kind === "list" ? opened.items.length : opened.keys.length;
}

/** Structural bytes of a container: its two delimiters, its separating commas,
 *  and — for an object — every key's escaped text, quotes and colon. Keys are
 *  payload bytes too. */
function openedBytes(opened: Opened): number {
	let bytes = 2 + Math.max(0, openedCount(opened) - 1);
	if (opened.kind === "map") {
		for (const key of opened.keys) bytes += jsonStringBytes(key) + 1;
	}
	return bytes;
}

function pushOpened(opened: Opened, depth: number, stack: Frame[]): void {
	if (opened.kind === "list") stack.push({ kind: "list", items: opened.items, depth, index: 0 });
	else stack.push({ kind: "map", record: opened.record, keys: opened.keys, depth, index: 0 });
}

function frameCount(frame: Frame): number {
	return frame.kind === "list" ? frame.items.length : frame.keys.length;
}

function frameChild(frame: Frame): unknown {
	if (frame.kind === "list") return frame.items[frame.index];
	const key = frame.keys[frame.index];
	// An out-of-range key cannot occur — `frameCount` gates the index — and an
	// `undefined` read is refused as a projection failure anyway.
	return key === undefined ? undefined : frame.record[key];
}

/** The next child to measure, or null once every open container is drained.
 *  Advancing an index instead of pushing every child is what keeps a wide
 *  container at O(1) frames. */
function nextChild(stack: Frame[]): Child | null {
	while (stack.length > 0) {
		const frame = stack[stack.length - 1];
		if (frame === undefined) break;
		if (frame.index >= frameCount(frame)) {
			stack.pop();
			continue;
		}
		const value = frameChild(frame);
		frame.index += 1;
		return { value, depth: frame.depth + 1 };
	}
	return null;
}

// ── the walk ───────────────────────────────────────────────────────────────

function overLimit(detail: string): ToolInputBytes {
	return { ok: false, reason: "limits", detail };
}

function walkToolInput(root: unknown, cap: number): ToolInputBytes {
	const stack: Frame[] = [];
	let total = 0;
	let nodes = 1; // the root itself
	let next: Child | null = { value: root, depth: 0 };
	while (next !== null) {
		if (next.depth > TOOL_INPUT_MAX_DEPTH) {
			return overLimit(`tool input nests deeper than ${TOOL_INPUT_MAX_DEPTH} levels`);
		}
		const scalar = scalarBytes(next.value);
		if (!scalar.ok) return { ok: false, reason: "projection", detail: scalar.detail };
		if (scalar.bytes === null) {
			const opened = openContainer(next.value);
			nodes += openedCount(opened);
			if (nodes > TOOL_INPUT_MAX_NODES) return overLimit(`tool input exceeds ${TOOL_INPUT_MAX_NODES} JSON nodes`);
			total += openedBytes(opened);
			pushOpened(opened, next.depth, stack);
		} else total += scalar.bytes;
		if (total > cap) return overLimit(`tool input is over ${cap} bytes`);
		next = nextChild(stack);
	}
	return { ok: true, bytes: total };
}

/** EXACT `JSON.stringify` byte cost of a raw hook payload, refused the moment
 *  it passes `cap` or trips a walk bound. Never recurses, and never throws —
 *  the payload is attacker-shaped, so a hostile getter or proxy is a rejection
 *  rather than an exception on the daemon's hook path. */
export function measureToolInputBytes(root: unknown, cap: number): ToolInputBytes {
	try {
		return walkToolInput(root, cap);
	} catch {
		return { ok: false, reason: "projection", detail: "tool input could not be read (a property access threw)" };
	}
}
