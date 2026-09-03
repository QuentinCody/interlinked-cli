// ===========================================
// Project Graph — Import Parser
// ===========================================
// Regex-based parser for TypeScript/JavaScript import statements.
// Extracted from project-graph.ts to keep the main module focused
// on the ProjectGraph class and its indexing logic.

import { nonNull } from "../../lib/non-null.js";
import type { ImportEdge } from "../types.js";

/**
 * Returns true when `keyword` (`"require("` or `"import("`) at `idx` in `text`
 * is embedded inside a string literal rather than real code. Conservative: only
 * rejects when the count of unescaped quote characters (of the same kind as
 * the most recent quote before `idx`) between that quote and `idx` is odd.
 */
function isInsideStringLiteral(text: string, idx: number): boolean {
	if (idx <= 0) return false;
	const before = text.slice(0, idx);
	const lastQuote = Math.max(
		before.lastIndexOf("'"),
		before.lastIndexOf('"'),
		before.lastIndexOf("`"),
	);
	if (lastQuote < 0) return false;
	const quoteChar = before[lastQuote];
	const between = before.slice(lastQuote);
	let occurrences = 0;
	for (let i = 0; i < between.length; i++) {
		if (between[i] !== quoteChar) continue;
		// Count the run of backslashes immediately preceding this quote.
		// Even count = quote is unescaped.
		let backslashes = 0;
		for (let j = i - 1; j >= 0 && between[j] === "\\"; j--) backslashes++;
		if (backslashes % 2 === 0) occurrences++;
	}
	return occurrences % 2 === 1;
}

/**
 * Count the backticks on `line` that are not backslash-escaped. An odd count
 * toggles whether the following lines sit inside a multi-line template literal.
 */
function countUnescapedBackticks(line: string): number {
	return (line.match(/(?<!\\)`/g) || []).length;
}

/**
 * True when the buffered multi-line `import { … }` statement has absorbed its
 * quoted module specifier, so the buffer is a complete collapsed import line.
 */
function bufferHasSpecifier(buffer: string): boolean {
	return /from\s+['"][^'"]+['"]/.test(buffer) || /['"][^'"]+['"]/.test(buffer);
}

/**
 * True when `trimmed` opens a named import whose closing `}` lands on a later
 * line, so the collapse pass must start buffering.
 */
function opensMultiLineNamedImport(trimmed: string): boolean {
	return trimmed.startsWith("import") && /\{/.test(trimmed) && !/\}/.test(trimmed);
}

/**
 * Phase 1 of {@link parseImports}: collapse multi-line `import { … }` statements
 * onto a single line and drop lines that live inside multi-line template
 * literals (codegen that emits `import "./x.js"` as string content must not be
 * mistaken for a real import). Returns the flattened, comment-bearing lines —
 * the parse phase strips comments and matches patterns.
 */
function collapseImportLines(lines: string[]): string[] {
	const collapsed: string[] = [];
	let buffer = "";
	let inTemplateLiteral = false;
	for (const line of lines) {
		const trimmed = line.trim();

		// Track multi-line template literal boundaries. An odd backtick count
		// toggles in/out of the literal; a line that opens one is still processed,
		// because the import may sit before the opening backtick.
		const startedInTemplateLiteral = inTemplateLiteral;
		if (countUnescapedBackticks(trimmed) % 2 === 1) inTemplateLiteral = !inTemplateLiteral;
		if (startedInTemplateLiteral) continue; // Skip lines inside template literals

		if (buffer) {
			buffer += ` ${trimmed}`;
			if (bufferHasSpecifier(buffer)) {
				collapsed.push(buffer);
				buffer = "";
			}
			continue;
		}
		if (opensMultiLineNamedImport(trimmed)) {
			buffer = trimmed;
			continue;
		}
		collapsed.push(trimmed);
	}
	if (buffer) collapsed.push(buffer);
	return collapsed;
}

/**
 * True when a `require(` / `import(` keyword on `trimmed` (a non-`import`-prefixed
 * line) is embedded inside a string literal rather than being real code. Mirrors
 * the guard the parse loop applies before treating the line as a dynamic import.
 */
function isStringEmbeddedKeyword(trimmed: string): boolean {
	const reqIdx = trimmed.indexOf("require(");
	if (reqIdx > 0 && isInsideStringLiteral(trimmed, reqIdx)) return true;
	const dynIdx = trimmed.indexOf("import(");
	if (dynIdx > 0 && isInsideStringLiteral(trimmed, dynIdx)) return true;
	return false;
}

/**
 * Split the `{ a, b as c, type D }` body of a named import into bare export
 * names, stripping `type ` prefixes and `as` aliases (the export surface is what
 * dead-export analysis cares about).
 */
function parseNamedSymbols(rawSymbols: string): string[] {
	return rawSymbols
		.split(",")
		.map((s) =>
			s
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)[0]
				?.trim(),
		)
		.filter((s): s is string => Boolean(s));
}

/**
 * Split the `{ a, b: c }` destructuring body of a dynamic import into export
 * names. Rename targets like `b: c` are recorded as `b` — the export side.
 */
function parseDestructuredSymbols(raw: string): string[] {
	return raw
		.split(",")
		.map((s) =>
			nonNull(
				s
					.trim()
					.split(/\s*:\s*/)[0],
			).trim(),
		)
		.filter(Boolean);
}

/**
 * Match a static `import …` form (named / default / namespace / side-effect) on
 * `trimmed`. Returns the parsed edge, or `null` if no static form matched.
 */
function matchStaticImport(
	trimmed: string,
	fromFile: string,
	isTypeOnly: boolean,
): Omit<ImportEdge, "toFile"> | null {
	// import { a, b } from 'module'
	const namedImport = trimmed.match(
		/^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/,
	);
	if (namedImport) {
		const rawSymbols = namedImport[1];
		const specifier = namedImport[2];
		if (rawSymbols === undefined || specifier === undefined) return null;
		return { fromFile, specifier, symbols: parseNamedSymbols(rawSymbols), isTypeOnly };
	}

	// import DefaultName from 'module'
	const defaultImport = trimmed.match(/^import\s+(?:type\s+)?(\w+)\s+from\s+['"]([^'"]+)['"]/);
	if (defaultImport) {
		return {
			fromFile,
			specifier: nonNull(defaultImport[2]),
			symbols: [nonNull(defaultImport[1])],
			isTypeOnly,
		};
	}

	// import * as name from 'module'
	const nsImport = trimmed.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
	if (nsImport) {
		return { fromFile, specifier: nonNull(nsImport[2]), symbols: [], isTypeOnly };
	}

	// import 'module' (side-effect)
	const sideEffect = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
	if (sideEffect) {
		return { fromFile, specifier: nonNull(sideEffect[1]), symbols: [], isTypeOnly: false };
	}

	return null;
}

/**
 * Match a dynamic / CommonJS import form (`require(…)`, destructured `import()`,
 * namespace `import()`, bare `import()`) on `trimmed`. Returns the parsed edge,
 * or `null` if no dynamic form matched.
 */
function matchDynamicImport(
	trimmed: string,
	fromFile: string,
): Omit<ImportEdge, "toFile"> | null {
	// require('module')
	const req = trimmed.match(/require\(['"]([^'"]+)['"]\)/);
	if (req) {
		return { fromFile, specifier: nonNull(req[1]), symbols: [], isTypeOnly: false };
	}

	// Destructured dynamic import — const/let/var binding of a destructuring
	// pattern on the LHS with an (optionally awaited) import() call on the RHS.
	// Rename targets like `b: c` are recorded as `b`. See parser-imports.test.ts.
	const destructuredDynamic = trimmed.match(
		/^(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:await\s+)?import\(\s*['"]([^'"]+)['"]\s*\)/,
	);
	if (destructuredDynamic) {
		return {
			fromFile,
			specifier: nonNull(destructuredDynamic[2]),
			symbols: parseDestructuredSymbols(nonNull(destructuredDynamic[1])),
			isTypeOnly: false,
		};
	}

	// Namespace-style dynamic import — a const/let/var bound to a single
	// identifier with an (optionally awaited) import() call on the RHS.
	// Equivalent to `import * as mod from 'module'`. See parser-imports.test.ts.
	const namespaceDynamic = trimmed.match(
		/^(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?import\(\s*['"]([^'"]+)['"]\s*\)/,
	);
	if (namespaceDynamic) {
		return { fromFile, specifier: nonNull(namespaceDynamic[1]), symbols: [], isTypeOnly: false };
	}

	// Dynamic import('module')
	const dynamic = trimmed.match(/import\(['"]([^'"]+)['"]\)/);
	if (dynamic) {
		return { fromFile, specifier: nonNull(dynamic[1]), symbols: [], isTypeOnly: false };
	}

	return null;
}

/**
 * Public API — consumed by ProjectGraph.indexFile and structural-checks.
 *
 * Parse imports from TypeScript/JavaScript source content.
 * Returns raw specifiers (not resolved paths).
 */
export function parseImports(content: string, fromFile: string): Omit<ImportEdge, "toFile">[] {
	const imports: Omit<ImportEdge, "toFile">[] = [];
	const collapsed = collapseImportLines(content.split("\n"));

	for (const line of collapsed) {
		// Strip inline comments from collapsed lines (e.g., // MCP Tasks Protocol handlers)
		const trimmed = line
			.trim()
			.replace(/\/\/[^\n]*/g, "")
			.trim();
		if (
			!trimmed.startsWith("import") &&
			!trimmed.includes("require(") &&
			!trimmed.includes("import(")
		)
			continue;
		// Skip comment lines
		if (trimmed.startsWith("//")) continue;

		// Skip lines where import/require appears inside a string literal.
		// If a quote character (' " `) opens an unclosed literal before the
		// keyword, the pattern is embedded in string content (e.g., test
		// fixtures or codegen), not a real import.
		if (!trimmed.startsWith("import") && isStringEmbeddedKeyword(trimmed)) continue;

		const isTypeOnly = /^import\s+type\s/.test(trimmed);

		const staticEdge = matchStaticImport(trimmed, fromFile, isTypeOnly);
		if (staticEdge) {
			imports.push(staticEdge);
			continue;
		}

		const dynamicEdge = matchDynamicImport(trimmed, fromFile);
		if (dynamicEdge) imports.push(dynamicEdge);
	}

	return imports;
}
