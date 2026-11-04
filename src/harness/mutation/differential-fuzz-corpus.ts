// ===========================================
// Differential fuzz — corpus-seeded inputs for SOURCE-TEXT parameters
// ===========================================
// Random strings never reach the branches of a function that scans source code
// (`content.split("\n")`, regex matches, "fires when >= 3 matches"). So a string
// parameter that LOOKS like source text is drawn from real text instead:
//   (a) the string / template literals (>= 20 chars) of the function's OWN
//       companion test files (`x.ts` -> `x.test.ts`, `x.*.test.ts`, `__tests__/`),
//   (b) a caller-provided sample of repo source files,
//   (c) fast-check EDITS of those seeds: drop / duplicate / swap a line, delete a
//       token, flip a comparison operator, insert a line from another seed,
//       truncate, window.
// The plain type-driven arbitrary stays in the mix as a fallback branch, so the
// random space is still searched. Everything here is deterministic: the seed
// list is ordered (shortest first, which also steers fast-check's shrinker to
// short counterexamples) and every edit is a pure function of its integer draws.
//
// This file imports nothing from the arbitraries module (structural `CorpusArb`
// / `CorpusFc` below), so the two files form no import cycle.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type * as TS from "typescript";
import type { TsModule } from "./differential-fuzz-deps.js";
import type { FuzzCorpusConfig } from "./differential-fuzz-types.js";

export interface CorpusArb {
	map: (fn: (value: never) => unknown) => CorpusArb;
}

/** The slice of fast-check the corpus arbitrary calls. */
export interface CorpusFc {
	constantFrom: (...values: unknown[]) => CorpusArb;
	integer: (constraints?: { min?: number; max?: number }) => CorpusArb;
	tuple: (...arbs: unknown[]) => CorpusArb;
	oneof: (...arbs: unknown[]) => CorpusArb;
}

export interface CorpusSeeds {
	/** Ordered seed texts, shortest first. */
	texts: string[];
	fromTests: number;
	fromRepo: number;
}

export const MIN_LITERAL_CHARS = 20;
const MAX_SEEDS = 300;
const MAX_COMPANION_TESTS = 12;
const MAX_TEST_BYTES = 400_000;
const POSITION_MAX = 1 << 16;

// ----- seed collection -----

const TEST_SUFFIX = /\.(test|spec)\.[mc]?[tj]sx?$/;

/** Test files that belong to `absPath`: same stem, same directory or `__tests__/`. */
export function companionTestFiles(absPath: string): string[] {
	const stem = basename(absPath, extname(absPath));
	const dir = dirname(absPath);
	const found: string[] = [];
	for (const candidateDir of [dir, join(dir, "__tests__")]) {
		if (!existsSync(candidateDir)) continue;
		for (const name of readdirSync(candidateDir).sort()) {
			if (name.startsWith(`${stem}.`) && TEST_SUFFIX.test(name)) found.push(join(candidateDir, name));
		}
	}
	return found.slice(0, MAX_COMPANION_TESTS);
}

function templateText(node: TS.TemplateExpression): string {
	return node.head.text + node.templateSpans.map((span) => `x${span.literal.text}`).join("");
}

/** String and template literals of at least `minChars` characters, in source order. */
export function extractStringLiterals(ts: TsModule, fileName: string, text: string, minChars = MIN_LITERAL_CHARS): string[] {
	const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
	const out: string[] = [];
	const visit = (node: TS.Node): void => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
		else if (ts.isTemplateExpression(node)) out.push(templateText(node));
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out.filter((s) => s.length >= minChars);
}

/** Cut `text` to at most `maxBytes` characters, on a line boundary when one exists. */
export function capText(text: string, maxBytes: number): string {
	if (text.length <= maxBytes) return text;
	const cut = text.slice(0, maxBytes);
	const nl = cut.lastIndexOf("\n");
	return nl > 0 ? cut.slice(0, nl) : cut;
}

interface CachedFile {
	key: string;
	text: string;
}
const fileCache = new Map<string, CachedFile>();

function readCapped(path: string, maxBytes: number): string | null {
	try {
		const st = statSync(path);
		const key = `${st.mtimeMs}:${st.size}:${maxBytes}`;
		const hit = fileCache.get(path);
		if (hit?.key === key) return hit.text;
		const text = capText(readFileSync(path, "utf8"), maxBytes);
		fileCache.set(path, { key, text });
		return text;
	} catch {
		return null;
	}
}

function testSeeds(ts: TsModule, absPath: string, maxBytes: number): string[] {
	const out: string[] = [];
	for (const file of companionTestFiles(absPath)) {
		const text = readCapped(file, MAX_TEST_BYTES);
		if (text !== null) out.push(...extractStringLiterals(ts, file, text).map((s) => capText(s, maxBytes)));
	}
	return out;
}

/** Companion-test literals + explicit seeds + repo files, deduplicated, shortest first. */
export function loadCorpusSeeds(ts: TsModule, absPath: string, config: FuzzCorpusConfig): CorpusSeeds {
	const fromTests = [...testSeeds(ts, absPath, config.maxBytes), ...(config.seeds ?? [])];
	const tagged = new Map<string, "test" | "repo">();
	for (const file of config.files) {
		const text = readCapped(file, config.maxBytes);
		if (text !== null && text.length > 0) tagged.set(text, "repo");
	}
	for (const s of fromTests) tagged.set(s, "test");
	const ordered = [...tagged.entries()].sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1));
	const kept = ordered.slice(0, MAX_SEEDS);
	return {
		texts: kept.map(([text]) => text),
		fromTests: kept.filter(([, kind]) => kind === "test").length,
		fromRepo: kept.filter(([, kind]) => kind === "repo").length,
	};
}

// ----- which parameters look like source text -----

const TEXT_NAME = /^(content|source|text|code|src|input|lines?|body|raw|snippet|diff|patch|markdown|haystack)$/i;
const LINES_NAME = /^(lines?|sourceLines|codeLines)$/i;
const SCAN_METHODS = new Set(["split", "match", "matchAll", "search", "replace", "replaceAll"]);
const SCAN_ARG_METHODS = new Set(["test", "exec", "matchAll"]);

function isIdentifierNamed(ts: TsModule, node: TS.Node | undefined, name: string): boolean {
	return node !== undefined && ts.isIdentifier(node) && node.text === name;
}

function isScanCall(ts: TsModule, node: TS.CallExpression, name: string): boolean {
	const callee = node.expression;
	if (!ts.isPropertyAccessExpression(callee)) return false;
	if (isIdentifierNamed(ts, callee.expression, name) && SCAN_METHODS.has(callee.name.text)) return true;
	return SCAN_ARG_METHODS.has(callee.name.text) && node.arguments.some((arg) => isIdentifierNamed(ts, arg, name));
}

/** True when the body calls a source-scanning string/regex method on the parameter. */
export function bodyScansParam(ts: TsModule, body: TS.Node | undefined, name: string): boolean {
	if (body === undefined) return false;
	let found = false;
	const visit = (node: TS.Node): void => {
		if (found) return;
		if (ts.isCallExpression(node) && isScanCall(ts, node, name)) found = true;
		else ts.forEachChild(node, visit);
	};
	visit(body);
	return found;
}

function containsStringKeyword(ts: TsModule, type: TS.TypeNode): boolean {
	if (type.kind === ts.SyntaxKind.StringKeyword) return true;
	if (ts.isParenthesizedTypeNode(type)) return containsStringKeyword(ts, type.type);
	return ts.isUnionTypeNode(type) && type.types.some((t) => containsStringKeyword(ts, t));
}

function isStringArrayType(ts: TsModule, type: TS.TypeNode): boolean {
	if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) return isStringArrayType(ts, type.type);
	if (ts.isArrayTypeNode(type)) return type.elementType.kind === ts.SyntaxKind.StringKeyword;
	if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return false;
	const arg = type.typeArguments?.[0];
	return (type.typeName.text === "Array" || type.typeName.text === "ReadonlyArray") && arg?.kind === ts.SyntaxKind.StringKeyword;
}

export type CorpusShape = "text" | "lines";

/** How a parameter should be corpus-seeded, or null when it should not be. */
export function corpusParamShape(
	ts: TsModule,
	param: TS.ParameterDeclaration,
	body: TS.Node | undefined,
	name: string,
): CorpusShape | null {
	const type = param.type;
	if (type === undefined) return null;
	if (isStringArrayType(ts, type)) return LINES_NAME.test(name) ? "lines" : null;
	if (!containsStringKeyword(ts, type)) return null;
	return TEXT_NAME.test(name) || bodyScansParam(ts, body, name) ? "text" : null;
}

// ----- edits -----

export const EDIT_OPS = [
	"drop-line",
	"dup-line",
	"swap-lines",
	"delete-token",
	"flip-operator",
	"insert-line",
	"truncate",
	"window",
] as const;
export type EditOp = (typeof EDIT_OPS)[number];

const FLIPS: Record<string, string> = {
	"===": "!==",
	"!==": "===",
	"<=": ">",
	">=": "<",
	"==": "!=",
	"!=": "==",
	"<": ">=",
	">": "<=",
};
const COMPARISON = /===|!==|<=|>=|==|!=|(?<![=-])>(?!>)|<(?!<)/g;
const TOKEN = /[A-Za-z_$][\w$]*|\d+|[^\s\w]/g;
const WINDOW_MAX_LINES = 40;

function pick(index: number, length: number): number {
	return length === 0 ? 0 : index % length;
}

function replaceMatch(text: string, regex: RegExp, index: number, replacement: (m: string) => string): string {
	const all = [...text.matchAll(regex)];
	const hit = all[pick(index, all.length)];
	if (hit === undefined || hit.index === undefined) return text;
	return text.slice(0, hit.index) + replacement(hit[0]) + text.slice(hit.index + hit[0].length);
}

function swapLines(ls: string[], i: number, j: number): string[] {
	return ls.map((l, k) => (k === i ? (ls[j] ?? l) : k === j ? (ls[i] ?? l) : l));
}

function editLines(op: EditOp, ls: string[], donor: string[], p1: number, p2: number): string[] {
	const i = pick(p1, ls.length);
	switch (op) {
		case "drop-line":
			return ls.filter((_, k) => k !== i);
		case "dup-line":
			return [...ls.slice(0, i + 1), ls[i] ?? "", ...ls.slice(i + 1)];
		case "swap-lines":
			return swapLines(ls, i, pick(p2, ls.length));
		case "insert-line": {
			const at = pick(p1, ls.length + 1);
			return [...ls.slice(0, at), donor[pick(p2, donor.length)] ?? "", ...ls.slice(at)];
		}
		case "truncate":
			return ls.slice(0, i);
		case "window":
			return ls.slice(i, i + 1 + pick(p2, WINDOW_MAX_LINES));
		default:
			return ls;
	}
}

/** One pure edit of `text`; `donor` supplies the line for `insert-line`. */
export function applyEdit(op: EditOp, text: string, donor: string, p1: number, p2: number): string {
	if (op === "delete-token") return replaceMatch(text, TOKEN, p1, () => "");
	if (op === "flip-operator") return replaceMatch(text, COMPARISON, p1, (m) => FLIPS[m] ?? m);
	return editLines(op, text.split("\n"), donor.split("\n"), p1, p2).join("\n");
}

// ----- arbitraries -----

/** Seeds, edited seeds, and the plain `fallback` — weighted 3 : 4 : 3. */
export function corpusTextArb(fc: CorpusFc, seeds: readonly string[], fallback: CorpusArb): CorpusArb {
	const seed = fc.constantFrom(...seeds);
	const position = fc.integer({ min: 0, max: POSITION_MAX });
	const op = fc.integer({ min: 0, max: EDIT_OPS.length - 1 });
	const edited = fc
		.tuple(seed, seed, op, position, position, fc.integer({ min: 0, max: 1 }))
		.map(([text, donor, opIndex, p1, p2, twice]: [string, string, number, number, number, number]) => {
			const first = applyEdit(EDIT_OPS[opIndex] ?? "truncate", text, donor, p1, p2);
			if (twice === 0) return first;
			return applyEdit(EDIT_OPS[(opIndex + 3) % EDIT_OPS.length] ?? "window", first, donor, p2, p1);
		});
	return fc.oneof({ weight: 3, arbitrary: seed }, { weight: 4, arbitrary: edited }, { weight: 3, arbitrary: fallback });
}

/** The same, as an array of lines (for `lines: string[]` parameters). */
export function corpusLinesArb(fc: CorpusFc, seeds: readonly string[], fallback: CorpusArb): CorpusArb {
	const asLines = corpusTextArb(fc, seeds, fc.constantFrom("")).map((t: string) => t.split("\n"));
	return fc.oneof({ weight: 7, arbitrary: asLines }, { weight: 3, arbitrary: fallback });
}
