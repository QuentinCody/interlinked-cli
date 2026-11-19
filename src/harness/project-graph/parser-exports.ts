// ===========================================
// Project Graph — Export Parser
// ===========================================
// Regex-based parser for TypeScript/JavaScript export statements.
// Extracted from project-graph.ts to keep the main module focused
// on the ProjectGraph class and its indexing logic.

import { nonNull } from "../../lib/non-null.js";
import type { ExportedSymbol } from "../types.js";
import { maskCommentsAndTemplates } from "./mask-templates.js";
import {
	bracketDepth,
	destructuredExports,
	matchDestructuredOrConstEnumExport,
	startsDestructuredExport,
} from "./parser-exports-destructure.js";
import { matchNamespaceOrDeclareExport, trailingExportList } from "./parser-exports-forms.js";

/**
 * Public API — consumed by ProjectGraph.indexFile and structural-checks.
 *
 * Parse exports from TypeScript/JavaScript source content using regex.
 * Handles: named exports, default exports, re-exports, type exports.
 * Skips comment-only lines (best-effort).
 */
export function parseExports(content: string): ExportedSymbol[] {
	const exports: ExportedSymbol[] = [];
	const lines = (content.includes("`") ? maskCommentsAndTemplates(content) : content).split("\n");

	let inBlockComment = false;
	let exportBuffer = "";
	let exportBufferStartLine = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;

		// Drop leading comments; code after a comment that closes on this line
		// (`*/ export function f(`) stays. Mutates inBlockComment via the verdict.
		const comment = stripLeadingComments(line.trim(), inBlockComment);
		inBlockComment = comment.nextInBlock;
		const trimmed = comment.code;
		if (trimmed === "") continue;

		// Handle multiline export { ... } statements
		if (exportBuffer) {
			exportBuffer = continueMultilineExport(
				exportBuffer,
				trimmed,
				exportBufferStartLine,
				exports,
			);
			continue;
		}

		// A minified bundle ends with `;export{...}` on a line of other code.
		if (!trimmed.startsWith("export")) {
			exports.push(...matchTrailingExportList(trimmed, i + 1));
			continue;
		}

		// Detect start of multiline export { ... } (opening brace but no closing)
		if (opensMultilineExport(trimmed)) {
			exportBuffer = trimmed;
			exportBufferStartLine = i + 1;
			continue;
		}

		const lineNum = i + 1;

		// Dispatch the single-line export forms through cohesive matchers.
		const symbols = matchSingleLineExport(trimmed, lineNum);
		if (symbols) {
			exports.push(...symbols);
		}
	}

	return exports;
}

/** The names of an `export{...}` that ends a line of other code (minified bundles). */
function matchTrailingExportList(trimmed: string, lineNum: number): ExportedSymbol[] {
	const trailing = trailingExportList(trimmed);
	return (trailing === null ? null : matchReExportOrStar(trailing, lineNum)) ?? [];
}

/**
 * True when `trimmed` starts an export statement that closes on a later line:
 * `export { ...` with no `}` yet, or a destructured export whose pattern is open.
 */
function opensMultilineExport(trimmed: string): boolean {
	if (/^export\s*(?:type\s*)?\{/.test(trimmed)) return !trimmed.includes("}");
	return startsDestructuredExport(trimmed) && bracketDepth(trimmed) > 0;
}

/**
 * Accumulate one more line of an in-progress multiline `export { ... }`.
 *
 * Internal helper for {@link parseExports}. Appends the line to the buffer and,
 * once the closing brace arrives, processes the completed statement into
 * `exports`. Returns the buffer to carry into the next line — `""` once the
 * statement is complete.
 */
function continueMultilineExport(
	buffer: string,
	trimmed: string,
	startLine: number,
	exports: ExportedSymbol[],
): string {
	const next = `${buffer} ${trimmed}`;
	const stillOpen = startsDestructuredExport(buffer) ? bracketDepth(next) > 0 : !trimmed.includes("}");
	if (stillOpen) return next;
	// Multiline export complete — process the accumulated buffer
	processExportStatement(next, startLine, exports);
	return "";
}

/**
 * Match any single-line export form on a trimmed line.
 *
 * Internal helper for {@link parseExports}. Tries the brace / star re-export
 * family first, then the single-symbol declaration forms. Returns `null` when
 * the line is neither.
 */
function matchSingleLineExport(trimmed: string, lineNum: number): ExportedSymbol[] | null {
	const reExport = matchReExportOrStar(trimmed, lineNum);
	if (reExport) return reExport;
	return (
		matchExportDeclaration(trimmed, lineNum) ??
		matchNamespaceOrDeclareExport(trimmed, lineNum, matchExportDeclaration)
	);
}

/**
 * The code that remains on one trimmed source line once the comments in front
 * of it are dropped.
 *
 * Internal helper for {@link parseExports}. The mutable `inBlockComment` flag
 * stays in the orchestrator's loop; this returns the remaining code (`""` for a
 * line that is all comment) and the flag for the next line. A block comment
 * that closes on the line leaves the text after its closing marker as code, so
 * an `export` that follows the close of a doc comment is read. A line comment
 * ends the line.
 */
function stripLeadingComments(
	trimmed: string,
	inBlockComment: boolean,
): { code: string; nextInBlock: boolean } {
	let rest = trimmed;
	let inBlock = inBlockComment;
	for (;;) {
		if (inBlock) {
			const close = rest.indexOf("*/");
			if (close === -1) return { code: "", nextInBlock: true };
			rest = rest.slice(close + 2).trim();
			inBlock = false;
		} else if (rest.startsWith("/*")) {
			rest = rest.slice(2);
			inBlock = true;
		} else {
			return { code: rest.startsWith("//") ? "" : rest, nextInBlock: false };
		}
	}
}

/**
 * Match the brace / star re-export family on a single trimmed export line:
 * `export type { ... }`, `export { ... }` (re-export or local), `export * ...`.
 *
 * Internal helper for {@link parseExports}. Returns the extracted symbols, or
 * `null` when the line is not one of these forms (caller keeps dispatching).
 */
function matchReExportOrStar(trimmed: string, lineNum: number): ExportedSymbol[] | null {
	// export type { Foo, Bar } from '...' or export type { Foo, Bar }
	const typeReExport = trimmed.match(/^export\s+type\s*\{([^}]+)\}/);
	if (typeReExport?.[1] !== undefined) {
		const names = typeReExport[1]
			.split(",")
			.map((n) =>
				n
					.trim()
					.split(/\s+as\s+/)
					.pop()!
					.trim(),
			)
			.filter(Boolean);
		return names.map((name) => ({ name, kind: "type", isTypeOnly: true, line: lineNum }));
	}

	// export { foo, bar as baz } or export { foo } from '...'
	// An inline `type` specifier (`export { type Foo }`) is a TYPE-ONLY export
	// of that one name — record it as such, per-entry, so type surfaces are not
	// misread as value exports (mixed clauses keep each entry's own flag).
	const namedReExport = trimmed.match(/^export\s*\{([^}]+)\}/);
	if (namedReExport?.[1] !== undefined) {
		const isReExport = /from\s*['"]/.test(trimmed);
		const entries = namedReExport[1]
			.split(",")
			.map((raw) => {
				const trimmedEntry = raw.trim();
				// `type Foo` / `type Foo as Bar` — keyword, type-only. But in
				// `type as Bar` the word `type` is an IDENTIFIER being aliased
				// (a value export), so a `type` followed directly by the `as`
				// alias form is not the keyword.
				const typeOnly = /^type\s+(?!\s*as(?:\s|$))/.test(trimmedEntry);
				const name = trimmedEntry
					.replace(/^type\s+/, "")
					.split(/\s+as\s+/)
					.pop()!
					.trim();
				return { name, typeOnly };
			})
			.filter((entry) => entry.name !== "");
		return entries.map(({ name, typeOnly }) => ({
			name,
			kind: typeOnly ? "type" : isReExport ? "re-export" : "const",
			isTypeOnly: typeOnly,
			line: lineNum,
		}));
	}

	// export * from '...', export * as ns from '...', and the TS 5 `export type *` forms
	if (/^export\s+(?:type\s+)?\*\s/.test(trimmed)) {
		const nsMatch = trimmed.match(/^export\s+(?:type\s+)?\*\s+as\s+([\w$]+)/);
		return [{ name: nsMatch?.[1] ?? "*", kind: "namespace", isTypeOnly: false, line: lineNum }];
	}

	return null;
}

/**
 * Match a single-symbol export *declaration* on a trimmed line: default
 * class/function/expression, (async) function, const/let/var, class, interface,
 * type alias, enum, abstract class.
 *
 * Internal helper for {@link parseExports}. Returns the extracted symbols, or
 * `null` when the line is not a recognised declaration form.
 */
function variableKind(capture: string | undefined): "const" | "let" | "var" {
	if (capture === "const" || capture === "let") return capture;
	return "var";
}

function matchExportDeclaration(trimmed: string, lineNum: number): ExportedSymbol[] | null {
	// export const { a, b: c } = x;  /  export const [a, b] = y;  /  export const enum E
	// (before the const/let/var form, which would read "enum" as the name)
	const extra = matchDestructuredOrConstEnumExport(trimmed, lineNum);
	if (extra) return extra;

	// export default class/function Name
	const defaultClassFn = trimmed.match(/^export\s+default\s+(class|function)\s*([\w$]*)/);
	if (defaultClassFn) {
		const out: ExportedSymbol[] = [
			{ name: "default", kind: "default", isTypeOnly: false, line: lineNum },
		];
		// Also track the named identifier if present
		if (defaultClassFn[2]) {
			out.push({
				name: defaultClassFn[2],
				kind: defaultClassFn[1] === "class" ? "class" : "function",
				isTypeOnly: false,
				line: lineNum,
			});
		}
		return out;
	}

	// export default <expression>
	if (/^export\s+default\s/.test(trimmed)) {
		return [{ name: "default", kind: "default", isTypeOnly: false, line: lineNum }];
	}

	// export function name( / export async function name( / export function* name(
	const fn = trimmed.match(/^export\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/);
	if (fn?.[1] !== undefined) {
		return [{ name: fn[1], kind: "function", isTypeOnly: false, line: lineNum }];
	}

	// export const/let/var name
	const variable = trimmed.match(/^export\s+(const|let|var)\s+([\w$]+)/);
	if (variable?.[2] !== undefined) {
		return [
			{
				name: variable[2],
				kind: variableKind(variable[1]),
				isTypeOnly: false,
				line: lineNum,
			},
		];
	}

	// export class Name
	const cls = trimmed.match(/^export\s+class\s+([\w$]+)/);
	if (cls) {
		return [{ name: nonNull(cls[1]), kind: "class", isTypeOnly: false, line: lineNum }];
	}

	// export interface Name
	const iface = trimmed.match(/^export\s+interface\s+([\w$]+)/);
	if (iface) {
		return [{ name: nonNull(iface[1]), kind: "interface", isTypeOnly: true, line: lineNum }];
	}

	// export type Name =
	// (the `=` may sit on the next line, so a bare end of line also qualifies)
	const typeAlias = trimmed.match(/^export\s+type\s+([\w$]+)\s*(?:[=<]|$)/);
	if (typeAlias) {
		return [{ name: nonNull(typeAlias[1]), kind: "type", isTypeOnly: true, line: lineNum }];
	}

	// export enum Name
	const enm = trimmed.match(/^export\s+enum\s+([\w$]+)/);
	if (enm) {
		return [{ name: nonNull(enm[1]), kind: "enum", isTypeOnly: false, line: lineNum }];
	}

	// export abstract class Name
	const abstractCls = trimmed.match(/^export\s+abstract\s+class\s+([\w$]+)/);
	if (abstractCls) {
		return [{ name: nonNull(abstractCls[1]), kind: "class", isTypeOnly: false, line: lineNum }];
	}

	return null;
}

/**
 * Process a complete (possibly multiline) export statement.
 *
 * Internal helper used by parseExports when it detects an `export { ... }`
 * block that spans multiple lines and must be accumulated before extraction.
 */
function processExportStatement(
	statement: string,
	lineNum: number,
	exports: ExportedSymbol[],
): void {
	if (startsDestructuredExport(statement)) {
		exports.push(...destructuredExports(statement, lineNum));
		return;
	}
	const isTypeExport = /^export\s+type\s+\{/.test(statement);
	const match = statement.match(/\{([^}]+)\}/);
	if (!match) return;

	const names = nonNull(match[1])
		.split(",")
		.map((n) =>
			n
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)
				.pop()!
				.trim(),
		)
		.filter(Boolean);
	const isReExport = /from\s+['"]/.test(statement);

	let exportKind: "type" | "re-export" | "const";
	if (isTypeExport) {
		exportKind = "type";
	} else if (isReExport) {
		exportKind = "re-export";
	} else {
		exportKind = "const";
	}
	for (const name of names) {
		exports.push({
			name,
			kind: exportKind,
			isTypeOnly: isTypeExport,
			line: lineNum,
		});
	}
}
