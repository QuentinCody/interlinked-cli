// interlinked-tdd: exempt
// Mock-configuration and SUT-exemption helpers for `checkMockReturnEcho`
// (test-mock-return-echo.ts). Extracted to a sibling module to keep the
// orchestrator under the per-file line cap. Pure functions over
// content/masked-content pairs — no project-wide state.

import { nonNull } from "../../lib/non-null.js";
import { findCallSpan } from "./test-hygiene-shared.js";
import type { Block } from "./test-mock-return-echo-types.js";

const MOCK_METHODS = "mockReturnValue|mockReturnValueOnce|mockResolvedValue|mockResolvedValueOnce|mockImplementation";
const RECEIVER_METHOD_RE = new RegExp(
	`\\b([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\.(?:${MOCK_METHODS})\\s*\\(`,
	"g",
);
const VI_MOCKED_RE = new RegExp(
	`\\bvi\\.mocked\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\s*\\.\\s*(?:${MOCK_METHODS})\\s*\\(`,
	"g",
);
const VI_FN_CHAINED_RE = new RegExp(`\\bvi\\.fn\\s*\\(\\s*\\)\\s*\\.\\s*(?:${MOCK_METHODS})\\s*\\(`, "g");
const VI_FN_BARE_RE = /\bvi\.fn\s*\(/g;

const LEAF_LITERAL_RE =
	/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\btrue\b|\bfalse\b|\bnull\b|\bundefined\b|-?\d+(?:\.\d+)?\b/g;

/** Canonical, quote-agnostic form of one matched literal token — comparable
 *  across a mock argument and an assertion argument written with different
 *  quote styles. */
function canonicalLiteral(raw: string): string {
	if (raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`")) {
		return `str:${raw.slice(1, -1)}`;
	}
	if (raw === "true" || raw === "false") return `bool:${raw}`;
	if (raw === "null" || raw === "undefined") return raw;
	return `num:${Number(raw)}`;
}

/** Human-readable form of a canonical literal, for the warning message. */
export function displayLiteral(canonical: string): string {
	if (canonical.startsWith("str:")) return canonical.slice(4);
	if (canonical.startsWith("bool:")) return canonical.slice(5);
	if (canonical.startsWith("num:")) return canonical.slice(4);
	if (canonical === "arr:[]") return "[]";
	if (canonical === "obj:{}") return "{}";
	return canonical;
}

/** Canonical literals coarse enough that echoing them alone is weak
 *  evidence — see exemption (c) in the module header. */
export const COARSE_LITERALS = new Set([
	"bool:true",
	"bool:false",
	"null",
	"undefined",
	"num:0",
	"str:",
	"arr:[]",
	"obj:{}",
]);

/** Every leaf literal token found in `text` (a mock/assertion argument
 *  slice of the ORIGINAL content). An argument that is exactly `[]`/`{}`
 *  yields one synthetic "empty container" literal instead of none, so an
 *  echoed empty array/object still compares equal on both sides. */
export function extractLiteralsFromText(text: string): Set<string> {
	const out = new Set<string>();
	const trimmed = text.trim();
	if (trimmed === "[]") return out.add("arr:[]");
	if (trimmed === "{}") return out.add("obj:{}");
	LEAF_LITERAL_RE.lastIndex = 0;
	let m: RegExpExecArray | null = LEAF_LITERAL_RE.exec(text);
	while (m !== null) {
		if (!/^\s*:/.test(text.slice(m.index + m[0].length))) out.add(canonicalLiteral(m[0]));
		m = LEAF_LITERAL_RE.exec(text);
	}
	return out;
}

/** True when `text` (trimmed) opens an arrow function (`() => …` /
 *  `x => …` / `async (x) => …`) — checked before any quote so a plain
 *  string literal that happens to contain the substring `"=>"` is never
 *  mistaken for one. */
function isLikelyArrow(text: string): boolean {
	const t = text.trimStart();
	if (t.startsWith('"') || t.startsWith("'") || t.startsWith("`")) return false;
	return /^(?:async\s*)?\(?[^)]*\)?\s*=>/.test(t);
}

/**
 * Literals supplied by a mock-configuration CALL ARGUMENT — the whole
 * argument text for a plain literal (`mockReturnValue(lit)`), but for an
 * arrow function (`mockImplementation(() => …)`, `vi.fn(() => …)`) only the
 * part AFTER `=>`, and only when that part is a bare expression. A
 * block-bodied arrow (`() => { throw …; return …; }`) yields no literals at
 * all — a regex scan can't tell whether the block actually RETURNS the
 * literal it contains (it might only throw it, as in a rejection stub), so
 * treating its contents as "supplied" would echo a value the mock never
 * returned.
 */
export function extractLiteralsFromMockArg(text: string): Set<string> {
	if (!isLikelyArrow(text)) return extractLiteralsFromText(text);
	const arrowIdx = text.indexOf("=>");
	const body = text.slice(arrowIdx + 2).trim();
	if (body.startsWith("{")) return new Set();
	return extractLiteralsFromText(body);
}

/** Test-file basename minus its `.test`/`.spec` suffix — the companion SUT
 *  module name (`foo.test.ts` → `foo`), or `""` when the path doesn't match
 *  that convention. */
export function sutBaseFromPath(filePath: string): string {
	const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
	const base = fileName.replace(/\.(test|spec)\.(tsx?|jsx?|mjs|cjs|mts|cts)$/, "");
	return base === fileName ? "" : base;
}

/** A module specifier's basename, extension stripped (`"./calc.js"` → `"calc"`). */
function importBasename(spec: string): string {
	const last = spec.split("/").pop() ?? "";
	return last.replace(/\.(js|ts|tsx|jsx|mjs|cjs|mts|cts)$/, "");
}

/** Split `"a as b"` / `"a"` into its local binding name. */
function localImportName(specifier: string): string {
	const parts = specifier.split(/\s+as\s+/);
	return nonNull(parts[parts.length - 1]).trim();
}

/** Add every named import (`import { a, b as c } from "spec"`) to `map`. */
function addNamedImports(content: string, map: Map<string, string>): void {
	const re = /\bimport\s+(?:type\s+)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
	let m: RegExpExecArray | null = re.exec(content);
	while (m !== null) {
		const basename = importBasename(nonNull(m[2]));
		for (const raw of nonNull(m[1]).split(",")) {
			const trimmed = raw.trim();
			if (trimmed.length === 0) continue;
			map.set(localImportName(trimmed), basename);
		}
		m = re.exec(content);
	}
}

/** Add every default import (`import foo from "spec"`) to `map`. */
function addDefaultImports(content: string, map: Map<string, string>): void {
	const re = /\bimport\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']([^"']+)["']/g;
	let m: RegExpExecArray | null = re.exec(content);
	while (m !== null) {
		map.set(nonNull(m[1]), importBasename(nonNull(m[2])));
		m = re.exec(content);
	}
}

/** Add every namespace import (`import * as ns from "spec"`) to `map`. */
function addNamespaceImports(content: string, map: Map<string, string>): void {
	const re = /\bimport\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s*from\s*["']([^"']+)["']/g;
	let m: RegExpExecArray | null = re.exec(content);
	while (m !== null) {
		map.set(nonNull(m[1]), importBasename(nonNull(m[2])));
		m = re.exec(content);
	}
}

/** Local identifier → import-specifier basename, over the COMMENT-STRIPPED
 *  (not string-masked — specifiers are string literals) file content. */
export function buildImportMap(strippedContent: string): Map<string, string> {
	const map = new Map<string, string>();
	addNamedImports(strippedContent, map);
	addDefaultImports(strippedContent, map);
	addNamespaceImports(strippedContent, map);
	return map;
}

/** True when `target` (a dotted identifier chain's base) resolves, via
 *  `importMap`, to the file's own companion SUT module — exemption (d). */
function isSutTarget(target: string, importMap: Map<string, string>, sutBase: string): boolean {
	if (target === "" || sutBase === "") return false;
	const base = target.split(".")[0] ?? target;
	return importMap.get(base) === sutBase;
}

/** The identifier assigned/keyed immediately before `matchIndex` in `masked`
 *  (`ident = vi.fn(...)` / `ident: vi.fn(...)`), or `""` when none is found —
 *  used to recover a target name for bare `vi.fn(...)` calls. */
function lookbackTarget(masked: string, matchIndex: number): string {
	const windowStart = Math.max(0, matchIndex - 80);
	const before = masked.slice(windowStart, matchIndex);
	const m = /([A-Za-z_$][\w$]*)\s*[:=]\s*$/.exec(before);
	return m ? nonNull(m[1]) : "";
}

/** One resolved mock-configuration hit before the SUT-exemption check. */
interface MockHit {
	target: string;
	literals: Set<string>;
}

/** Every match of `re` inside `[start, end)` of `masked`. */
function execInBounds(re: RegExp, masked: string, start: number, end: number): RegExpExecArray[] {
	const hits: RegExpExecArray[] = [];
	re.lastIndex = start;
	let m: RegExpExecArray | null = re.exec(masked);
	while (m !== null && m.index < end) {
		hits.push(m);
		m = re.exec(masked);
	}
	return hits;
}

/** Resolve one regex hit whose capture group (or a lookback) supplies the
 *  target identifier, into a `MockHit` — or null when the call's argument
 *  list never balances. */
function resolveHit(content: string, masked: string, m: RegExpExecArray, target: string): MockHit | null {
	const argsStart = m.index + m[0].length;
	const span = findCallSpan(masked, argsStart);
	if (span === null) return null;
	return { target, literals: extractLiteralsFromMockArg(content.slice(argsStart, span.end)) };
}

/** `ident.mockReturnValue(lit)` / `ident.mockResolvedValueOnce(lit)` / … */
function receiverMethodHits(content: string, masked: string, start: number, end: number): MockHit[] {
	return execInBounds(RECEIVER_METHOD_RE, masked, start, end)
		.map((m) => resolveHit(content, masked, m, nonNull(m[1])))
		.filter((h): h is MockHit => h !== null);
}

/** `vi.mocked(ident).mockReturnValue(lit)`. */
function viMockedHits(content: string, masked: string, start: number, end: number): MockHit[] {
	return execInBounds(VI_MOCKED_RE, masked, start, end)
		.map((m) => resolveHit(content, masked, m, nonNull(m[1])))
		.filter((h): h is MockHit => h !== null);
}

/** `vi.fn().mockReturnValue(lit)` — the receiver carries no identifier of
 *  its own, so target resolution falls back to the assignment lookback. */
function viFnChainedHits(content: string, masked: string, start: number, end: number): MockHit[] {
	return execInBounds(VI_FN_CHAINED_RE, masked, start, end)
		.map((m) => resolveHit(content, masked, m, lookbackTarget(masked, m.index)))
		.filter((h): h is MockHit => h !== null);
}

/** Bare `vi.fn(() => lit)` (also matches the empty `vi.fn()` half of a
 *  chained call, contributing no literals in that case). */
function viFnBareHits(content: string, masked: string, start: number, end: number): MockHit[] {
	return execInBounds(VI_FN_BARE_RE, masked, start, end)
		.map((m) => resolveHit(content, masked, m, lookbackTarget(masked, m.index)))
		.filter((h): h is MockHit => h !== null);
}

/**
 * Every mock-configuration literal reachable from the given spans (an `it`
 * block plus its same-describe-level `beforeEach` siblings), with any hit
 * whose target resolves to the file's own companion SUT module dropped
 * (exemption d). Returns the union literal set plus the named mock targets
 * seen, for the warning message.
 */
export function collectMockLiteralsInSpan(
	content: string,
	masked: string,
	spans: Block[],
	importMap: Map<string, string>,
	sutBase: string,
): { literals: Set<string>; targets: Set<string> } {
	const literals = new Set<string>();
	const targets = new Set<string>();
	for (const span of spans) {
		const hits = [
			...receiverMethodHits(content, masked, span.argsStart, span.end),
			...viMockedHits(content, masked, span.argsStart, span.end),
			...viFnChainedHits(content, masked, span.argsStart, span.end),
			...viFnBareHits(content, masked, span.argsStart, span.end),
		];
		for (const hit of hits) {
			if (isSutTarget(hit.target, importMap, sutBase)) continue;
			for (const lit of hit.literals) literals.add(lit);
			targets.add(hit.target || "an unnamed mock");
		}
	}
	if (targets.size !== 1) {
		for (const literal of COARSE_LITERALS) literals.delete(literal);
	}
	return { literals, targets };
}
