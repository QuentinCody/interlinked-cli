// tsconfig texts read the way TypeScript reads them (red team 2026-10-21,
// round 4: "judge tsconfig water-lines with TypeScript's OWN parser").
//
// The config-loosening gate and the config effect arm used to read a tsconfig
// with the JSONC-tolerant `safeJsonParse` and treat a post-image that did not
// parse as "no finding". Two shapes slipped through:
//   - "" and whitespace-only text: TypeScript reads them as `{}` with NO error,
//     so every strictness flag silently falls back to its loose default;
//   - "null", "garbage", "{" (and every other text TypeScript reports a parse
//     error for): TypeScript enforces nothing it cannot read.
// This module is the one place that decides what a tsconfig text means:
// `ts.parseConfigFileTextToJson` when the optional `typescript` dependency is
// present, else the JSONC parse (`safeJsonParse`), where a text that does not
// parse to an object is unparseable. Callers judge strictness on the parsed
// object, and treat an existing parseable tsconfig whose post-image is
// unparseable as a loosening (`unparseablePostImage`).

import { createRequire } from "node:module";
import type * as TS from "typescript";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";

type TsModule = typeof TS;

/** What one tsconfig text means: an object of options, or a parse failure. */
export type TsconfigParse = { kind: "object"; value: JsonObject } | { kind: "unparseable"; detail: string };

/** Public API — the JSONC-tolerant JSON parse (// and block comments, trailing
 *  commas); `null` for empty or invalid text. The fallback tsconfig reader, and
 *  the parser the package.json / ledger arms use. */
export function safeJsonParse(text: string): unknown {
	if (!text) return null;
	try {
		// Tolerate JSONC (// comments and trailing commas) in tsconfig / biome.
		const cleaned = text
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/,(\s*[}\]])/g, "$1");
		return JSON.parse(cleaned);
	} catch {
		return null;
	}
}

let tsCache: TsModule | null | undefined;

/** `typescript`, resolved once; `null` when the optional dependency is absent. */
function loadTs(): TsModule | null {
	if (tsCache !== undefined) return tsCache;
	try {
		// SAFETY: the installed TypeScript package exposes the compiler API described by the erased TS module import.
		tsCache = createRequire(import.meta.url)("typescript") as TsModule;
	} catch {
		tsCache = null;
	}
	return tsCache;
}

/** Test-only: force the TypeScript module (`null` = unavailable); `undefined` re-resolves. */
export function __setTsconfigTypescriptForTesting(mod: TsModule | null | undefined): void {
	tsCache = mod;
}

/** Which reader decides tsconfig texts in this process. */
export function tsconfigParserKind(): "typescript" | "jsonc-fallback" {
	return loadTs() === null ? "jsonc-fallback" : "typescript";
}

function parseWithTypescript(ts: TsModule, text: string): TsconfigParse {
	try {
		const result = ts.parseConfigFileTextToJson("tsconfig.json", text);
		if (result.error) {
			return { kind: "unparseable", detail: ts.flattenDiagnosticMessageText(result.error.messageText, " ") };
		}
		const config: unknown = result.config;
		return isJsonObject(config) ? { kind: "object", value: config } : { kind: "unparseable", detail: "the root value is not an object" };
	} catch (err) {
		return { kind: "unparseable", detail: `the TypeScript parser threw (${err instanceof Error ? err.message : String(err)})` };
	}
}

/** Public API — what TypeScript reads from one tsconfig text. */
export function parseTsconfig(text: string): TsconfigParse {
	const ts = loadTs();
	if (ts !== null) return parseWithTypescript(ts, text);
	const value = safeJsonParse(text);
	return isJsonObject(value)
		? { kind: "object", value }
		: { kind: "unparseable", detail: "not a JSON object (the optional `typescript` dependency is unavailable; JSONC fallback parse)" };
}

/** Public API — the parse function for the extends resolver: the options object, or `null`. */
export function parseTsconfigObject(text: string): JsonObject | null {
	const parsed = parseTsconfig(text);
	return parsed.kind === "object" ? parsed.value : null;
}

/**
 * Public API — the loosening message when an EXISTING tsconfig that parses
 * (`beforeText`) is replaced by text TypeScript cannot parse (`afterText`), or
 * `null`. An absent side (`null` / `undefined`) is a creation or a deletion,
 * never this finding; a pre-image that does not parse holds no water-line.
 */
export function unparseablePostImage(
	beforeText: string | null | undefined,
	afterText: string | null | undefined,
): string | null {
	if (typeof beforeText !== "string" || typeof afterText !== "string") return null;
	if (parseTsconfig(beforeText).kind !== "object") return null;
	const after = parseTsconfig(afterText);
	if (after.kind === "object") return null;
	const reader = tsconfigParserKind() === "typescript" ? "TypeScript" : "the JSONC fallback reader";
	return (
		`the new contents of this tsconfig cannot be parsed by ${reader} (${after.detail}), while the previous contents parsed. ` +
		"A tsconfig the compiler cannot read enforces none of its strictness flags, so this is a loosening. Write valid tsconfig JSON that keeps every strictness flag."
	);
}

/** One parse-loosening finding, shaped like the gate's ConfigLooseningFinding. */
export interface TsconfigParseFinding {
	rule: string;
	before: unknown;
	after: unknown;
	file: string;
	message: string;
}

/**
 * Public API — the gate's findings for a parse loosening: an EXISTING tsconfig
 * (non-empty HEAD text; the gate reads "" as "absent at HEAD") that parses,
 * replaced by text that does not. Creating an absent tsconfig is never one.
 */
export function tsconfigParseFindings(filePath: string, beforeText: string, afterText: string): TsconfigParseFinding[] {
	const message = beforeText ? unparseablePostImage(beforeText, afterText) : null;
	return message === null ? [] : [{ rule: "tsconfig-parse", before: "parseable", after: "unparseable", file: filePath, message }];
}
