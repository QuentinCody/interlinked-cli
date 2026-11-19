// interlinked-tdd: exempt
// ===========================================
// Coverage SCOPE — which files the project's coverage tool measures at all
// ===========================================
// Authored here (gated, searchable) and copied to
// ~/interlinked-cli/src/harness/evaluator/coverage-scope.ts, which lives
// outside this repo root and so cannot be written directly.
//
// The commit gate blocks a changed source that is ABSENT from the coverage
// report ("no test exercised it"). That reading is only true for a file the
// coverage tool actually MEASURES. A vitest config with an explicit
// `coverage.include` reports every in-scope file (vitest 4 removed
// `coverage.all`: an untested in-scope file appears at 0%), and reports a file
// OUTSIDE that scope only when a test happens to load it. So an absent
// out-of-scope file is NOT evidence of a missing test — it is evidence of
// nothing, and the gate must say "not measured" instead of blocking
// (mcp-client-bio, 2026-11-12: every `servers/**` change blocked although that
// server's own suite was green).
//
// Direction rule, as everywhere else in the harness: a reading that cannot be
// decided keeps the STRICTER outcome.
//   - `include` must be wholly literal, or this module abstains (null) and the
//     caller blocks exactly as before. A missed include member would otherwise
//     turn a real coverage gap into a warning.
//   - `exclude` members that cannot be read are SKIPPED. A missed exclude member
//     can only keep a file in scope, which blocks — the safe direction.

import type * as TS from "typescript";
import { parseTsSource, type TsModule } from "../checks/cyclomatic-ast.js";

/** The literal file scope of one coverage configuration. */
export interface CoverageScope {
	/** Patterns that put a file IN scope. Never empty (an empty include abstains). */
	include: string[];
	/** Patterns that take a file back OUT. Partial by design (see the header). */
	exclude: string[];
}

/** Root config basenames vitest reads, most specific first. */
const CONFIG_BASENAMES = [
	"vitest.config.ts",
	"vitest.config.mts",
	"vitest.config.cts",
	"vitest.config.js",
	"vitest.config.mjs",
	"vitest.config.cjs",
	"vite.config.ts",
	"vite.config.mts",
	"vite.config.cts",
	"vite.config.js",
	"vite.config.mjs",
	"vite.config.cjs",
];

/** Glob → anchored RegExp, or null for syntax this matcher does not decide
 *  (negation, character classes, extglobs). Supports `**`, `*`, `?` and `{a,b}`. */
export function globToRegExp(pattern: string): RegExp | null {
	if (/[!()[\]\\]/.test(pattern)) return null;
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i] ?? "";
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				i++;
				if (pattern[i + 1] === "/") {
					i++;
					out += "(?:.*/)?";
				} else out += ".*";
			} else out += "[^/]*";
			continue;
		}
		if (ch === "?") out += "[^/]";
		else if (ch === "{") out += "(?:";
		else if (ch === "}") out += ")";
		else if (ch === ",") out += "|";
		else if (/[.+^$|]/.test(ch)) out += `\\${ch}`;
		else out += ch;
	}
	try {
		return new RegExp(`^${out}$`);
	} catch {
		return null;
	}
}

/** True when `relPath` matches any pattern. An unreadable pattern never matches. */
function matchesAny(relPath: string, patterns: readonly string[]): boolean {
	for (const pattern of patterns) {
		const re = globToRegExp(pattern);
		if (re?.test(relPath)) return true;
	}
	return false;
}

/**
 * True when the coverage tool never measures `relPath`: no include pattern
 * claims it, or an exclude pattern takes it back out. Paths are repo-relative
 * and forward-slashed — the frame both the config globs and the gate's
 * changed-file list use.
 */
export function isOutsideCoverageScope(relPath: string, scope: CoverageScope): boolean {
	const path = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!matchesAny(path, scope.include)) return true;
	return matchesAny(path, scope.exclude);
}

/** String-literal members of an array literal. `strict` fails the whole read on a
 *  member it cannot evaluate; otherwise such a member is skipped. */
function arrayMembers(ts: TsModule, node: TS.Expression, strict: boolean): string[] | null {
	if (!ts.isArrayLiteralExpression(node)) return null;
	const members: string[] = [];
	for (const element of node.elements) {
		if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
			members.push(element.text);
			continue;
		}
		if (strict) return null;
	}
	return members;
}

/** The name of a property assignment, or null when it is computed or not one. */
function propName(ts: TsModule, sf: TS.SourceFile, prop: TS.ObjectLiteralElementLike): string | null {
	if (!ts.isPropertyAssignment(prop) || ts.isComputedPropertyName(prop.name)) return null;
	return prop.name.getText(sf).replace(/['"]/g, "");
}

/** Every `coverage: { … }` object literal in the file. */
function coverageObjects(ts: TsModule, sf: TS.SourceFile): TS.ObjectLiteralExpression[] {
	const found: TS.ObjectLiteralExpression[] = [];
	const visit = (node: TS.Node): void => {
		if (
			ts.isPropertyAssignment(node) &&
			propName(ts, sf, node) === "coverage" &&
			ts.isObjectLiteralExpression(node.initializer)
		) {
			found.push(node.initializer);
		}
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(sf, visit);
	return found;
}

/** The literal `include`/`exclude` of the file's single coverage object, or null
 *  when the file has no coverage object, has more than one, or its `include` is
 *  absent / not wholly literal (vitest then measures what the tests load). */
export function extractCoverageScope(content: string, filePath: string): CoverageScope | null {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return null;
	const { ts, sf } = parsed;
	const objects = coverageObjects(ts, sf);
	const object = objects.length === 1 ? objects[0] : undefined;
	if (!object) return null;
	let include: string[] | null = null;
	let exclude: string[] = [];
	for (const prop of object.properties) {
		const name = propName(ts, sf, prop);
		if (!name || !ts.isPropertyAssignment(prop)) continue;
		if (name === "include") include = arrayMembers(ts, prop.initializer, true);
		else if (name === "exclude") exclude = arrayMembers(ts, prop.initializer, false) ?? [];
	}
	if (!include || include.length === 0) return null;
	return { include, exclude };
}

/**
 * The coverage scope of a project root's vitest configuration, or null when
 * there is no readable one (the caller then keeps its stricter behavior).
 * Reads the first config basename that exists.
 */
export function readCoverageScope(
	projectRoot: string,
	readFile: (absPath: string) => string | null,
): CoverageScope | null {
	for (const basename of CONFIG_BASENAMES) {
		const content = readFile(`${projectRoot}/${basename}`);
		if (content === null) continue;
		return extractCoverageScope(content, basename);
	}
	return null;
}
