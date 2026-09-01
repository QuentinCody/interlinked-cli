// interlinked-tdd: exempt
// ===========================================
// Graph-prediction parser — scalar / token primitives
// ===========================================
// Leaf helpers split out of graph-prediction-parser.ts to keep that module
// under the per-file line cap. Pure value/token parsing only — no module-private
// state, no import back from the parent module (this file is a true leaf).

import { nonNull } from "../lib/non-null.js";

const MAX_LIST_ENTRIES = 50;

/** Local copy of the parent module's sentinel. Same literal value; kept here so
 *  this leaf file imports nothing back from graph-prediction-parser.ts. */
const UNKNOWN_SENTINEL = "unknown" as const;

export interface KeyValueLine {
	indent: number;
	key: string;
	rest: string;
	/** Populated by `tokenizeBody` when block-style `- item` lines follow a
	 *  `key:` with empty rest. The post-pass synthesizes these into a
	 *  flow-list representation in `rest` so the downstream value parser
	 *  doesn't need a separate code path for the two YAML forms. */
	blockItems?: string[];
}

export function tokenizeKeyValue(line: string): KeyValueLine | null {
	if (line.trim() === "") return null;
	const indentMatch = line.match(/^( *)/);
	const indent = indentMatch ? indentMatch[0].length : 0;
	const trimmed = line.slice(indent);
	if (trimmed.startsWith("#")) return null;
	const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
	if (!m) return null;
	return { indent, key: nonNull(m[1]), rest: nonNull(m[2]).trim() };
}

interface ParsedScalarOrList {
	value: string |number | string[] | "unknown";
	formatViolation: boolean;
}

export function parseScalar(text: string): string | number {
	if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
	if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text);
	if (
		(text.startsWith('"') && text.endsWith('"')) ||
		(text.startsWith("'") && text.endsWith("'"))
	) {
		return text.slice(1, -1);
	}
	return text;
}

export function splitInlineList(text: string): string[] {
	const parts: string[] = [];
	const buffer: string[] = [];
	const flush = (): void => {
		const piece = buffer.join("").trim();
		if (piece) parts.push(piece);
		buffer.length = 0;
	};
	let inQuote: '"' | "'" | null = null;
	for (let j = 0; j < text.length; j++) {
		const ch = nonNull(text[j]);
		if (inQuote) {
			if (ch === inQuote) inQuote = null;
			buffer.push(ch);
			continue;
		}
		if (ch === '"' || ch === "'") {
			inQuote = ch;
			buffer.push(ch);
			continue;
		}
		if (ch === ",") {
			flush();
			continue;
		}
		buffer.push(ch);
	}
	flush();
	return parts;
}

/** Parse the value to the right of `key:` on a single line. Recognizes
 *  inline `[a, b]` lists, bare `unknown` sentinel, quoted strings,
 *  integers, and floats. Returns format-violation when an inline list
 *  exceeds the entry cap. */
export function parseInlineValue(rest: string): ParsedScalarOrList {
	if (rest === UNKNOWN_SENTINEL) return { value: UNKNOWN_SENTINEL, formatViolation: false };
	if (rest === "[]") return { value: [], formatViolation: false };
	if (rest.startsWith("[") && rest.endsWith("]")) {
		const inner = rest.slice(1, -1).trim();
		if (inner === "") return { value: [], formatViolation: false };
		const items = splitInlineList(inner).map((p) => {
			const scalar = parseScalar(p);
			return typeof scalar === "string" ? scalar : String(scalar);
		});
		if (items.length > MAX_LIST_ENTRIES) {
			return { value: items, formatViolation: true };
		}
		return { value: items, formatViolation: false };
	}
	return { value: parseScalar(rest) as string | number, formatViolation: false };
}

export interface ListItemLine {
	indent: number;
	value: string;
}

export function tokenizeListItem(line: string): ListItemLine | null {
	const indentMatch = line.match(/^( *)/);
	const indent = indentMatch ? indentMatch[0].length : 0;
	const trimmed = line.slice(indent);
	if (trimmed === "-") return { indent, value: "" };
	if (!trimmed.startsWith("- ")) return null;
	return { indent, value: trimmed.slice(2).trim() };
}

export function flowQuote(item: string): string {
	// Wrap each block-list item in double quotes for the synthesized flow-list
	// representation so commas/brackets inside items don't confuse the
	// downstream `splitInlineList`. parseScalar strips the outer quote pair.
	return `"${item.replace(/"/g, '\\"')}"`;
}

const RISK_VALUES = new Set<"low" | "medium" | "high" | typeof UNKNOWN_SENTINEL>([
	"low",
	"medium",
	"high",
	UNKNOWN_SENTINEL,
]);

export function parseRisk(text: string): "low" | "medium" | "high" | typeof UNKNOWN_SENTINEL {
	if (RISK_VALUES.has(text as "low" | "medium" | "high" | typeof UNKNOWN_SENTINEL)) {
		return text as "low" | "medium" | "high" | typeof UNKNOWN_SENTINEL;
	}
	return UNKNOWN_SENTINEL;
}

export function parseCount(text: string): number | typeof UNKNOWN_SENTINEL {
	if (text === UNKNOWN_SENTINEL) return UNKNOWN_SENTINEL;
	const n = Number.parseInt(text, 10);
	if (!Number.isFinite(n)) return UNKNOWN_SENTINEL;
	return n;
}
