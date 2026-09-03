// jsdoc-param-drift — a JSDoc `@param` tag naming a parameter that no longer
// exists on the documented function.
//
// Bug class: a parameter is renamed or removed but its `@param oldName` line
// survives — the highest-frequency structural doc-drift shape and a direct
// cold-agent-clarity cost (the doc actively lies about the signature). The
// semantic `comment_claims_*` family covers behavior claims; nothing covered
// the structural tag↔signature agreement until this check.
//
// Zero-FP bias — a finding fires ONLY when a simple-named `@param` tag matches
// NO actual parameter, and the detector skips every ambiguous shape outright:
//   - functions with ANY destructured parameter (JSDoc conventionally documents
//     the synthetic object name, e.g. `@param options` for `({a, b})`)
//   - functions with ANY rest parameter (variadic doc conventions vary — some
//     document logical args individually)
//   - dotted / qualified tags like `@param options.x` (property documentation)
//   - overload signatures and implementations that have sibling overloads
//     (tags may legitimately describe another overload's parameter names)
//   - bodiless / ambient declarations
//
// Uses the TS compiler API shipped as an optional dependency (same guard as
// `cyclomatic-ast.ts`): when `typescript` is absent the check degrades to
// returning no findings rather than guessing with a regex.
//
// Check id: jsdoc_param_drift

import { createRequire } from "node:module";
import type * as TS from "typescript";
import { parseTsSourceWith } from "./cyclomatic-ast.js";
import { getExtension, type InlineMatch, JS_TS_ALL_EXTS } from "./shared.js";

type TsModule = typeof TS;

// ─── Optional `typescript` loader (mirrors cyclomatic-ast.ts) ───────────────

let tsCache: TsModule | null | undefined;

/** Resolve `typescript` once, synchronously; absence is a non-error (→ null). */
function loadTs(): TsModule | null {
	if (tsCache !== undefined) return tsCache;
	try {
		tsCache = createRequire(import.meta.url)("typescript") as TsModule;
	} catch {
		tsCache = null;
	}
	return tsCache;
}

/** Test-only cache reset so a suite can exercise the absent-dep degrade path. */
export function __resetJsdocParamTsCacheForTesting(): void {
	tsCache = undefined;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const REPORT_LINE_TRUNC = 150;
const MAX_MATCHES_PER_FILE = 10;

// ─── AST helpers ─────────────────────────────────────────────────────────────

/** The function-like kinds we inspect (accessors excluded — set-param docs are rare). */
function isCheckableFunction(ts: TsModule, node: TS.Node): node is TS.FunctionLikeDeclaration {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node)
	);
}

/** Display / overload-key name for a function-like node. */
function functionNameOf(ts: TsModule, node: TS.FunctionLikeDeclaration): string {
	if (ts.isConstructorDeclaration(node)) return "constructor";
	const name = node.name;
	if (name !== undefined && ts.isIdentifier(name)) return name.text;
	return "";
}

/**
 * Actual parameter names of a function, or null when the function must be
 * skipped entirely:
 *   - any destructured parameter — binding-pattern names have no single
 *     canonical JSDoc name, so tag comparison would be guesswork;
 *   - any rest parameter — variadic JSDoc conventions differ (some document
 *     individual logical args by name), so tag comparison would be guesswork.
 */
function simpleParamNames(ts: TsModule, node: TS.FunctionLikeDeclaration): string[] | null {
	const names: string[] = [];
	for (const param of node.parameters) {
		if (!ts.isIdentifier(param.name)) return null; // destructured → skip function
		if (param.dotDotDotToken !== undefined) return null; // rest → skip function
		names.push(param.name.text);
	}
	return names;
}

/**
 * Accepted-name set for tag matching: each param name plus its
 * underscore-stripped form — `@param rawLines` legitimately documents an
 * unused `_rawLines` parameter (dogfood-observed convention).
 */
function acceptedNameSet(names: string[]): Set<string> {
	const set = new Set<string>();
	for (const n of names) {
		set.add(n);
		set.add(n.replace(/^_+/, ""));
	}
	return set;
}

/**
 * True when the tag begins its JSDoc line (only `*` / `/**` before it) — a
 * real block tag. "@param" mentioned mid-prose in a description sentence
 * (dogfood-observed FP: "Detect @param names in JSDoc …") is still parsed as
 * a tag by TS but must not be compared against the signature.
 */
function tagStartsJsdocLine(sf: TS.SourceFile, tag: TS.JSDocParameterTag, rawLines: string[]): boolean {
	const { line, character } = sf.getLineAndCharacterOfPosition(tag.getStart(sf));
	const prefix = (rawLines[line] ?? "").slice(0, character).trim();
	return prefix === "" || prefix === "*" || prefix === "/**";
}

/**
 * The simple name of a `@param` tag, or null when the tag must be skipped:
 * qualified / dotted forms (`options.x`) document properties, not parameters.
 */
function tagSimpleName(ts: TsModule, tag: TS.JSDocParameterTag): string | null {
	if (!ts.isIdentifier(tag.name)) return null; // QualifiedName → property doc
	const text = tag.name.text;
	if (text.length === 0 || text.includes(".")) return null;
	return text;
}

/**
 * Collect an "overload key" (`<parent.pos>:<name>`) for every BODILESS
 * function / method / constructor declaration in the file. An implementation
 * whose key appears here has sibling overload signatures — its JSDoc may
 * legitimately reference another overload's parameter names, so it is skipped.
 */
function collectOverloadKeys(ts: TsModule, sf: TS.SourceFile): Set<string> {
	const keys = new Set<string>();
	const visit = (node: TS.Node): void => {
		if (
			(ts.isFunctionDeclaration(node) ||
				ts.isMethodDeclaration(node) ||
				ts.isConstructorDeclaration(node)) &&
			node.body === undefined
		) {
			keys.add(`${node.parent.pos}:${functionNameOf(ts, node)}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return keys;
}

// ─── Per-function check ──────────────────────────────────────────────────────

/**
 * The drifted parameter name a `@param` tag names, or null when the tag is
 * not a reportable drift: mid-prose "@param" mentions, and tags whose name
 * matches an actual (or underscore-stripped) parameter.
 */
function tagDriftName(
	ts: TsModule,
	sf: TS.SourceFile,
	tag: TS.JSDocParameterTag,
	rawLines: string[],
	nameSet: Set<string>,
): string | null {
	if (!tagStartsJsdocLine(sf, tag, rawLines)) return null; // "@param" mid-prose
	const tagName = tagSimpleName(ts, tag);
	if (tagName === null || nameSet.has(tagName)) return null;
	return tagName;
}

function checkFunctionNode(
	ts: TsModule,
	sf: TS.SourceFile,
	node: TS.FunctionLikeDeclaration,
	overloadKeys: Set<string>,
	rawLines: string[],
	matches: InlineMatch[],
): void {
	// Overload signatures and ambient declarations have no body — skip. An
	// implementation with sibling overload signatures is skipped too (its JSDoc
	// may describe any overload's parameter names).
	if (node.body === undefined) return;
	if (overloadKeys.has(`${node.parent.pos}:${functionNameOf(ts, node)}`)) return;

	// `ts.getJSDocTags` resolves ownership through the standard walk-up shapes,
	// so an arrow function documented on its `const` statement is covered.
	const paramTags = ts.getJSDocTags(node).filter(ts.isJSDocParameterTag);
	if (paramTags.length === 0) return;

	const names = simpleParamNames(ts, node);
	if (names === null) return; // destructured parameter present → skip function
	const nameSet = acceptedNameSet(names);

	for (const tag of paramTags) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		const tagName = tagDriftName(ts, sf, tag, rawLines, nameSet);
		if (tagName === null) continue;

		const lineNo = sf.getLineAndCharacterOfPosition(tag.getStart(sf)).line + 1;
		const fnLabel = functionNameOf(ts, node) || "(anonymous)";
		const paramsLabel = names.length > 0 ? names.join(", ") : "none";
		const rawText = (rawLines[lineNo - 1] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
		matches.push({
			line: lineNo,
			text: `jsdoc_param_drift: @param "${tagName}" matches no parameter of ${fnLabel} (params: ${paramsLabel}) — ${rawText}`,
		});
	}
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Detect JSDoc `@param` tags whose name matches no actual parameter of the
 * documented function (stale doc after a rename / removal).
 *
 * Check id: `jsdoc_param_drift`
 *
 * Only fires on JS/TS source files. Degrades to no findings when the optional
 * `typescript` dependency is unavailable (`--omit=optional` installs).
 */
export function detectJsdocParamDrift(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];
	// Cheap pre-filter: no @param anywhere → skip the parse entirely.
	if (!content.includes("@param")) return [];

	const ts = loadTs();
	if (ts === null) return []; // optional dep absent → degrade silently

	const sf = parseTsSourceWith(ts, content, filePath);
	const overloadKeys = collectOverloadKeys(ts, sf);
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const visit = (node: TS.Node): void => {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		if (isCheckableFunction(ts, node)) {
			checkFunctionNode(ts, sf, node, overloadKeys, rawLines, matches);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);

	return matches;
}
