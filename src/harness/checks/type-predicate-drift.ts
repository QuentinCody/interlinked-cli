// ===========================================================================
// Type-predicate drift detector
// ===========================================================================
// Catches the bug class where a hand-rolled type guard
// (`function isFoo(v: unknown): v is Foo`) checks SOME of `Foo`'s required
// properties and silently ignores the rest.
//
// Why this is invisible to the compiler: a `v is T` return annotation is an
// UNCHECKED ASSERTION. TypeScript never verifies the predicate body against
// `T`. Add a required field to `T` and every stale guard keeps returning
// `true` for values that lack it — no compile error, no test failure, and a
// downstream `undefined` that surfaces far from the boundary that admitted it.
//
// Real example (found in this repo, 2026-08-09): `obligations.ts` declared
// `isOpenRow(row): row is OpenTxn` / `isDischargeRow(row): row is DischargeTxn`.
// `OpenTxn.editSeq`, `DischargeTxn.forContentHash` and `DischargeTxn.witness`
// were declared on the types and NEVER checked by the guards. A malformed
// JSONL row carrying a numeric `witness` passed validation unnoticed.
//
// The fix the message steers toward is a parser, not a bigger guard:
// `parseFoo(v: unknown): Foo | null` returning a CONSTRUCTED object literal.
// The literal is checked against `Foo` by the compiler, so adding a required
// field fails to compile at the boundary instead of under-validating at runtime.
//
// Check id: type_predicate_drift
// Phase:    advisory (post-tool) — heuristic, deliberately conservative:
//           same-file types, arrow + function predicates, and ONE-HOP relative
//           imports (R2-5 widening 2026-08-10); only fires when the guard
//           already checks at least one field (a guard that checks none is
//           delegating, not drifting).

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getExtension, type InlineMatch, isGeneratedFile, isTestFile } from "./shared.js";
import { stripCommentsAndStrings } from "./shared-text-utils.js";

/** Max findings reported per file, matching the other inline detectors. */
const MAX_MATCHES = 10;

/**
 * A type/interface declared in the file under analysis, with the names of its
 * REQUIRED properties (optional `foo?:` members are excluded — a guard that
 * skips an optional field is not drifting).
 */
interface DeclaredShape {
	name: string;
	requiredProps: string[];
}

/** One `x is T` predicate found in the file. */
interface PredicateSite {
	/** 1-based line of the signature. */
	line: number;
	/** The parameter the predicate narrows (`v` in `v is Foo`). */
	param: string;
	/** The asserted type name (`Foo`). */
	typeName: string;
	/** Stripped source of the predicate body, braces excluded. */
	body: string;
}

// A `function name(...): <param> is <Type> {` signature. Generic asserted types
// (`v is Foo<Bar>`) are skipped — resolving type arguments needs a type checker.
const PREDICATE_SIG =
	/\bfunction\s+\w+\s*\(([^)]*)\)\s*:\s*([A-Za-z_$][\w$]*)\s+is\s+([A-Za-z_$][\w$]*)\s*\{/;

// Arrow form: `const isFoo = (v: unknown): v is Foo => …`. A bare-param arrow
// cannot carry a return-type annotation, so the parenthesized form is the only
// shape that exists. (R2-5 widening, 2026-08-10 — arrow predicates were a
// documented false-negative lane.)
const ARROW_PREDICATE_SIG =
	/\b(?:const|let|var)\s+\w+\s*=\s*\(([^)]*)\)\s*:\s*([A-Za-z_$][\w$]*)\s+is\s+([A-Za-z_$][\w$]*)\s*=>/;

// Named-import clause. Runs against ORIGINAL source — stripping erases string
// literals, and the specifier is one.
const IMPORT_DECL = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

// `interface Foo {` / `interface Foo extends Bar {` — `extends` makes the
// required set incomplete, so those are skipped (see collectDeclaredShapes).
const INTERFACE_DECL = /\binterface\s+([A-Za-z_$][\w$]*)(\s+extends\s+[^{]+)?\s*\{/;

// `type Foo = {` — object-literal aliases only. Unions/intersections/mapped
// types have no single required-property set this detector can trust.
const TYPE_OBJECT_DECL = /\btype\s+([A-Za-z_$][\w$]*)\s*=\s*\{/;

// A required member line: `foo: T`, `readonly foo: T`. Rejects `foo?: T`.
const REQUIRED_MEMBER = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:/;
// An optional member line: `foo?: T`.
const OPTIONAL_MEMBER = /^\s*(?:readonly\s+)?[A-Za-z_$][\w$]*\s*\?\s*:/;

/**
 * Return the index just past the `}` matching the `{` at `openIdx`, or -1 when
 * the braces never balance. Operates on comment/string-stripped source, so a
 * brace inside a literal cannot skew the count.
 */
function matchBrace(src: string, openIdx: number): number {
	let depth = 0;
	for (let i = openIdx; i < src.length; i++) {
		const ch = src[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** 1-based line number of a character offset. */
function lineOf(src: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") line++;
	return line;
}

/**
 * Split an object-type body into member lines and return the REQUIRED property
 * names. Nested object literals are skipped wholesale: a nested brace's members
 * are not properties of the outer type, and treating them as such would invent
 * required fields the guard could never satisfy.
 */
function requiredPropsOf(body: string): string[] {
	const props: string[] = [];
	let depth = 0;
	let buf = "";
	const flush = (): void => {
		const member = buf.trim();
		buf = "";
		// An index signature (`[k: string]: T`) starts with `[`, so the leading
		// identifier match fails and it is correctly ignored. A method signature
		// (`foo(): void`) has `(` where the regex wants `:`, likewise ignored.
		if (member === "" || OPTIONAL_MEMBER.test(member)) return;
		const m = REQUIRED_MEMBER.exec(member);
		if (m?.[1]) props.push(m[1]);
	};
	for (const ch of body) {
		if (ch === "{" || ch === "(" || ch === "[") depth++;
		else if (ch === "}" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
		// Members separate on `;`, `,` or a newline — but only at nesting depth 0,
		// so a nested object literal's own members never leak into the outer type.
		// Splitting on newlines ALONE was wrong: a single-line body
		// (`interface T { a: string; b: string }`) then yielded only its first
		// property, silently under-counting the required set.
		else if (depth === 0 && (ch === ";" || ch === "," || ch === "\n")) {
			flush();
			continue;
		}
		buf += ch;
	}
	flush();
	return props;
}

/**
 * Collect every object-shaped type declared in this file. Interfaces that
 * `extends` another type are skipped: their full required set lives in a parent
 * this detector cannot see, so a guard could look incomplete while being
 * correct — a false positive.
 */
function collectDeclaredShapes(stripped: string): Map<string, DeclaredShape> {
	const shapes = new Map<string, DeclaredShape>();
	for (const re of [INTERFACE_DECL, TYPE_OBJECT_DECL]) {
		const global = new RegExp(re.source, "g");
		let m = global.exec(stripped);
		while (m !== null) {
			const isInterface = re === INTERFACE_DECL;
			const name = m[1];
			const hasExtends = isInterface && m[2] !== undefined;
			const openIdx = stripped.indexOf("{", m.index + m[0].length - 1);
			const closeIdx = openIdx >= 0 ? matchBrace(stripped, openIdx) : -1;
			if (name && !hasExtends && openIdx >= 0 && closeIdx > openIdx) {
				const body = stripped.slice(openIdx + 1, closeIdx);
				shapes.set(name, { name, requiredProps: requiredPropsOf(body) });
			}
			global.lastIndex = m.index + m[0].length;
			m = global.exec(stripped);
		}
	}
	return shapes;
}

/** Collect every `x is T` predicate declaration with its body. */
function collectPredicates(stripped: string): PredicateSite[] {
	const sites: PredicateSite[] = [];
	const global = new RegExp(PREDICATE_SIG.source, "g");
	let m = global.exec(stripped);
	while (m !== null) {
		const param = m[2];
		const typeName = m[3];
		const openIdx = m.index + m[0].length - 1;
		const closeIdx = matchBrace(stripped, openIdx);
		if (param && typeName && closeIdx > openIdx) {
			sites.push({
				line: lineOf(stripped, m.index),
				param,
				typeName,
				body: stripped.slice(openIdx + 1, closeIdx),
			});
		}
		global.lastIndex = m.index + m[0].length;
		m = global.exec(stripped);
	}
	sites.push(...collectArrowPredicates(stripped));
	return sites;
}

/** Slice an arrow's EXPRESSION body: from `start` to the first `;`/newline at
 *  bracket depth 0 (budget-bounded). */
function arrowExpressionBody(stripped: string, start: number): string {
	let depth = 0;
	const end = Math.min(stripped.length, start + 2000);
	for (let i = start; i < end; i++) {
		const ch = stripped.charAt(i);
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (depth <= 0 && (ch === ";" || ch === "\n")) return stripped.slice(start, i);
	}
	return stripped.slice(start, end);
}

/** Arrow-form predicates: block body via brace match, expression body via the
 *  depth-0 statement-end walk. */
function collectArrowPredicates(stripped: string): PredicateSite[] {
	const sites: PredicateSite[] = [];
	const global = new RegExp(ARROW_PREDICATE_SIG.source, "g");
	let m = global.exec(stripped);
	while (m !== null) {
		const param = m[2];
		const typeName = m[3];
		let after = m.index + m[0].length;
		while (after < stripped.length && /\s/.test(stripped.charAt(after))) after++;
		let body: string | null = null;
		if (stripped.charAt(after) === "{") {
			const closeIdx = matchBrace(stripped, after);
			if (closeIdx > after) body = stripped.slice(after + 1, closeIdx);
		} else {
			body = arrowExpressionBody(stripped, after);
		}
		if (param && typeName && body !== null) {
			sites.push({ line: lineOf(stripped, m.index), param, typeName, body });
		}
		global.lastIndex = m.index + m[0].length;
		m = global.exec(stripped);
	}
	return sites;
}

/** A named type import: the local binding, its source-file name, and origin. */
interface ImportedType {
	sourceName: string;
	specifier: string;
}

/** Map local type name → import origin, from ORIGINAL (unstripped) source. */
function collectTypeImports(original: string): Map<string, ImportedType> {
	const imports = new Map<string, ImportedType>();
	IMPORT_DECL.lastIndex = 0;
	let m = IMPORT_DECL.exec(original);
	while (m !== null) {
		const clause = m[1] ?? "";
		const specifier = m[2] ?? "";
		for (const rawItem of clause.split(",")) {
			const item = rawItem.trim().replace(/^type\s+/, "");
			if (item === "") continue;
			const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(item);
			const sourceName = asMatch?.[1] ?? item;
			const localName = asMatch?.[2] ?? item;
			if (/^[A-Za-z_$][\w$]*$/.test(sourceName) && /^[A-Za-z_$][\w$]*$/.test(localName)) {
				imports.set(localName, { sourceName, specifier });
			}
		}
		m = IMPORT_DECL.exec(original);
	}
	return imports;
}

/** Per-process cache of shapes parsed from imported files, invalidated by
 *  mtime. Keeps the one-hop resolution cheap on the hook path. */
const importedShapeCache = new Map<
	string,
	{ mtimeMs: number; shapes: Map<string, DeclaredShape> }
>();
const MAX_IMPORT_FILE_BYTES = 262144;

function shapesFromFile(absPath: string): Map<string, DeclaredShape> | null {
	try {
		const st = statSync(absPath);
		if (st.size > MAX_IMPORT_FILE_BYTES) return null;
		const hit = importedShapeCache.get(absPath);
		if (hit && hit.mtimeMs === st.mtimeMs) return hit.shapes;
		const shapes = collectDeclaredShapes(stripCommentsAndStrings(readFileSync(absPath, "utf-8")));
		importedShapeCache.set(absPath, { mtimeMs: st.mtimeMs, shapes });
		return shapes;
	} catch {
		return null; // unreadable/absent — behave as before the widening
	}
}

/**
 * One-hop cross-file resolution (R2-5): follow a RELATIVE named import to a
 * sibling .ts source and look the asserted type up there. Package specifiers,
 * deep re-export chains, and anything unreadable resolve to null — identical
 * to the pre-widening behavior for those cases.
 */
function resolveImportedShape(
	typeName: string,
	imports: Map<string, ImportedType>,
	filePath: string,
): DeclaredShape | null {
	const imp = imports.get(typeName);
	if (!imp || !imp.specifier.startsWith(".")) return null;
	const base = join(dirname(filePath), imp.specifier);
	const candidates = [
		base.replace(/\.m?js$/, ".ts"),
		base.replace(/\.m?js$/, ".mts"),
		base.endsWith(".ts") ? base : `${base}.ts`,
	];
	for (const candidate of candidates) {
		const shape = shapesFromFile(candidate)?.get(imp.sourceName);
		if (shape) return shape;
	}
	return null;
}

/**
 * Every identifier-ish token in the predicate body. Membership is checked
 * against this set rather than against `param.prop` specifically, so a guard
 * that destructures (`const { a, b } = v`) or renames a local still counts as
 * having inspected the field. That deliberately under-reports drift; a false
 * negative costs nothing, a false positive costs the gate's credibility.
 */
function bodyTokens(body: string): Set<string> {
	return new Set(body.match(/[A-Za-z_$][\w$]*/g) ?? []);
}

/**
 * True when the body performs at least one runtime SHAPE test. A predicate with
 * none is a discriminant or delegation guard, not a field validator, so the
 * "missing field" question does not apply to it.
 */
function looksLikeShapeValidator(body: string): boolean {
	return /\btypeof\b|\bArray\.isArray\b|\binstanceof\b|\bin\b\s/.test(body);
}

/**
 * Evaluate one predicate site against the declared/imported shapes and return
 * a finding when it under-checks required properties, or `null` when it does
 * not qualify (unknown/small shape, no shape validation, or nothing missing).
 * Extracted from `detectTypePredicateDrift` to keep the orchestrator's own
 * branch count low; behavior is unchanged.
 */
function evaluatePredicateSite(
	site: PredicateSite,
	shapes: Map<string, DeclaredShape>,
	typeImports: Map<string, ImportedType>,
	filePath: string,
	originalLines: string[],
): InlineMatch | null {
	const shape =
		shapes.get(site.typeName) ?? resolveImportedShape(site.typeName, typeImports, filePath);
	if (!shape || shape.requiredProps.length < 2) return null;
	if (!looksLikeShapeValidator(site.body)) return null;

	const tokens = bodyTokens(site.body);
	const missing = shape.requiredProps.filter((p) => !tokens.has(p));
	const checked = shape.requiredProps.length - missing.length;
	if (checked === 0 || missing.length === 0) return null;

	const raw = originalLines[site.line - 1] ?? "";
	const detail = `${raw.trim()}  [unchecked: ${missing.join(", ")}]`;
	return { line: site.line, text: detail.slice(0, 150) };
}

/**
 * Detect `value is T` type predicates that fail to check every required
 * property of `T`.
 *
 * Fires only when ALL of the following hold, which is what keeps it advisory-
 * grade rather than noise:
 *   - `T` is declared in the SAME file (no cross-file resolution here)
 *   - `T` has at least two required properties
 *   - the body runs at least one `typeof` / `Array.isArray` / `instanceof` test
 *   - the body mentions at least one required property (so it IS validating
 *     fields — a guard that mentions none is delegating elsewhere)
 *   - at least one required property is never mentioned anywhere in the body
 *
 * Skips test files, generated files, and non-TypeScript files.
 */
export function detectTypePredicateDrift(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".ts" && ext !== ".tsx") return [];
	if (isTestFile(filePath)) return [];
	if (isGeneratedFile(content)) return [];

	const stripped = stripCommentsAndStrings(content);
	if (!stripped.includes(" is ")) return [];

	const shapes = collectDeclaredShapes(stripped);
	const typeImports = collectTypeImports(content);
	if (shapes.size === 0 && typeImports.size === 0) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (const site of collectPredicates(stripped)) {
		if (matches.length >= MAX_MATCHES) break;
		const match = evaluatePredicateSite(site, shapes, typeImports, filePath, originalLines);
		if (match) matches.push(match);
	}
	return matches;
}
