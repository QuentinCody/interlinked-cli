// ===========================================
// Project Graph — Export Parser
// ===========================================
// Regex-based parser for TypeScript/JavaScript export statements.
// Extracted from project-graph.ts to keep the main module focused
// on the ProjectGraph class and its indexing logic.

import { nonNull } from "../../lib/non-null.js";
import type { ExportedSymbol } from "../types.js";

/**
 * Public API — consumed by ProjectGraph.indexFile and structural-checks.
 *
 * Parse exports from TypeScript/JavaScript source content using regex.
 * Handles: named exports, default exports, re-exports, type exports.
 * Skips comment-only lines (best-effort).
 */
export function parseExports(content: string): ExportedSymbol[] {
	const exports: ExportedSymbol[] = [];
	const lines = content.split("\n");

	let inBlockComment = false;
	let exportBuffer = "";
	let exportBufferStartLine = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		const trimmed = line.trim();

		// Track block / line comments (mutates inBlockComment via the verdict).
		const comment = commentSkipVerdict(trimmed, inBlockComment);
		inBlockComment = comment.nextInBlock;
		if (comment.skip) continue;

		// Handle multiline export { ... } statements
		if (exportBuffer) {
			exportBuffer += ` ${trimmed}`;
			if (trimmed.includes("}")) {
				// Multiline export complete — process the accumulated buffer
				processExportStatement(exportBuffer, exportBufferStartLine, exports);
				exportBuffer = "";
			}
			continue;
		}

		// Skip lines that don't start with "export"
		if (!trimmed.startsWith("export")) continue;

		// Detect start of multiline export { ... } (opening brace but no closing)
		if (/^export\s+(?:type\s+)?\{/.test(trimmed) && !trimmed.includes("}")) {
			exportBuffer = trimmed;
			exportBufferStartLine = i + 1;
			continue;
		}

		const lineNum = i + 1;

		// Dispatch the single-line export forms through cohesive matchers.
		const reExport = matchReExportOrStar(trimmed, lineNum);
		if (reExport) {
			exports.push(...reExport);
			continue;
		}

		const declaration = matchExportDeclaration(trimmed, lineNum);
		if (declaration) {
			exports.push(...declaration);
		}
	}

	return exports;
}

/**
 * Comment-skip decision for one trimmed source line.
 *
 * Internal helper for {@link parseExports}. The mutable `inBlockComment` flag
 * stays in the orchestrator's loop; this returns whether to skip the line and
 * what the flag should be on the next iteration. Returns `skip: true` for any
 * comment line (in-block continuation, block start, or `//` line comment).
 */
function commentSkipVerdict(
	trimmed: string,
	inBlockComment: boolean,
): { skip: boolean; nextInBlock: boolean } {
	if (inBlockComment) {
		// Inside a block comment — skip; exit the block on the closing `*/`.
		return { skip: true, nextInBlock: !trimmed.includes("*/") };
	}
	if (trimmed.startsWith("/*")) {
		// Block-comment start — skip; enter block only if it doesn't close inline.
		return { skip: true, nextInBlock: !trimmed.includes("*/") };
	}
	if (trimmed.startsWith("//")) {
		return { skip: true, nextInBlock: false };
	}
	return { skip: false, nextInBlock: false };
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
	const typeReExport = trimmed.match(/^export\s+type\s+\{([^}]+)\}/);
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
	const namedReExport = trimmed.match(/^export\s+\{([^}]+)\}/);
	if (namedReExport?.[1] !== undefined) {
		const isReExport = /from\s+['"]/.test(trimmed);
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

	// export * from '...' or export * as ns from '...'
	if (/^export\s+\*\s/.test(trimmed)) {
		const nsMatch = trimmed.match(/^export\s+\*\s+as\s+(\w+)/);
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
function matchExportDeclaration(trimmed: string, lineNum: number): ExportedSymbol[] | null {
	// export default class/function Name
	const defaultClassFn = trimmed.match(/^export\s+default\s+(class|function)\s*(\w*)/);
	if (defaultClassFn) {
		const out: ExportedSymbol[] = [
			{ name: "default", kind: "default", isTypeOnly: false, line: lineNum },
		];
		// Also track the named identifier if present
		if (defaultClassFn[2]) {
			out.push({
				name: defaultClassFn[2],
				kind: defaultClassFn[1] as "class" | "function",
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

	// export async function name(
	const asyncFn = trimmed.match(/^export\s+async\s+function\s+(\w+)/);
	if (asyncFn?.[1] !== undefined) {
		return [{ name: asyncFn[1], kind: "function", isTypeOnly: false, line: lineNum }];
	}

	// export function name(
	const fn = trimmed.match(/^export\s+function\s+(\w+)/);
	if (fn?.[1] !== undefined) {
		return [{ name: fn[1], kind: "function", isTypeOnly: false, line: lineNum }];
	}

	// export const/let/var name
	const variable = trimmed.match(/^export\s+(const|let|var)\s+(\w+)/);
	if (variable?.[2] !== undefined) {
		return [
			{
				name: variable[2],
				kind: variable[1] as "const" | "let" | "var",
				isTypeOnly: false,
				line: lineNum,
			},
		];
	}

	// export class Name
	const cls = trimmed.match(/^export\s+class\s+(\w+)/);
	if (cls) {
		return [{ name: nonNull(cls[1]), kind: "class", isTypeOnly: false, line: lineNum }];
	}

	// export interface Name
	const iface = trimmed.match(/^export\s+interface\s+(\w+)/);
	if (iface) {
		return [{ name: nonNull(iface[1]), kind: "interface", isTypeOnly: true, line: lineNum }];
	}

	// export type Name =
	const typeAlias = trimmed.match(/^export\s+type\s+(\w+)\s*[=<]/);
	if (typeAlias) {
		return [{ name: nonNull(typeAlias[1]), kind: "type", isTypeOnly: true, line: lineNum }];
	}

	// export enum Name
	const enm = trimmed.match(/^export\s+enum\s+(\w+)/);
	if (enm) {
		return [{ name: nonNull(enm[1]), kind: "enum", isTypeOnly: false, line: lineNum }];
	}

	// export abstract class Name
	const abstractCls = trimmed.match(/^export\s+abstract\s+class\s+(\w+)/);
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
