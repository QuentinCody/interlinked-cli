// api-surface — detects an exported declaration whose signature references a
// same-file type that is NOT exported.
//
// Bug class: a public function/const/interface/type whose signature names an
// internal type produces `error TS4023` ("exported variable ... cannot be
// named") under declaration emit, and even without emit, consumers cannot
// spell the type to annotate their own bindings. The fix is one keyword:
// export the referenced type, or stop leaking it.
//
// Effect-TS lessons port (docs/design/effect-ts-harness-additions.md §10):
// approximates Effect's custom oxlint rule `effect/no-unused-internal`
// (packages/tools/oxc/src/oxlint/rules/no-unused-internal.ts), which does the
// same identifier-text matching over public signatures — deep type resolution
// is deliberately NOT required to match their precision level.
//
// Scope guards that keep this honest:
//   * Only COLUMN-0 `interface`/`type`/`enum`/`class` declarations count as
//     internal candidates — function-local types cannot appear in an exported
//     signature, and nested/member positions are not module declarations.
//   * A name later exported via `export { X }` / `export type { X }` is public.
//   * Only the SIGNATURE window is scanned (params + return type + heritage +
//     type-alias RHS), never a function body — internal types used privately
//     inside a body are the normal, correct pattern.
//
// check id: `public_api_leaks_internal_type`. Advisory: app code with no
// declaration consumers only pays this cost at refactor time.

import { getExtension, type InlineMatch, isTestFile, stripCommentsAndStrings } from "./shared.js";

const MAX_MATCHES = 5;
/** Lines an export declaration's signature window may span. */
const SIGNATURE_WINDOW_LINES = 12;

/** TS-only: type annotations are the whole subject. */
const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/** Column-0 non-exported type-ish declaration. */
const INTERNAL_DECL_RE =
	/^(?:declare\s+)?(?:abstract\s+)?(?:interface|type|enum|class)\s+([A-Z][\w$]*)/;

/** Column-0 export declaration opener (the ones with a signature to scan). */
const EXPORT_DECL_RE =
	/^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type)\b/;

/** Re-export statements that make a locally-declared name public after all. */
const REEXPORT_RE = /^export\s+(?:type\s+)?\{([^}]*)\}/;

/** Collect names re-exported via `export { A, B as C }` (the LOCAL name). */
function collectReexportedNames(lines: string[]): Set<string> {
	const names = new Set<string>();
	for (const line of lines) {
		const m = REEXPORT_RE.exec(line);
		if (m === null) continue;
		for (const entry of (m[1] ?? "").split(",")) {
			const local = entry.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0]?.trim();
			if (local) names.add(local);
		}
	}
	return names;
}

/** Collect internal (declared, never exported) type-ish names. */
function collectInternalTypeNames(lines: string[]): Set<string> {
	const reexported = collectReexportedNames(lines);
	const names = new Set<string>();
	for (const line of lines) {
		const m = INTERNAL_DECL_RE.exec(line);
		const name = m?.[1];
		if (name && !reexported.has(name)) names.add(name);
	}
	return names;
}

/**
 * Slice the signature window for the export declaration starting at `startIdx`:
 * lines up to (excluding) the body-opening `{` at paren depth 0, a `;` for a
 * type alias RHS, or the line budget. Body lines never enter the window.
 */
function signatureWindow(lines: string[], startIdx: number): string {
	const first = lines[startIdx] ?? "";
	if (/^export\s+type\b/.test(first)) return aliasWindow(lines, startIdx);

	const collected: string[] = [];
	let parenDepth = 0;
	const end = Math.min(lines.length, startIdx + SIGNATURE_WINDOW_LINES);
	for (let i = startIdx; i < end; i++) {
		const line = lines[i] ?? "";
		const { cut, depth } = bodyBraceCut(line, parenDepth);
		parenDepth = depth;
		if (cut !== -1) {
			collected.push(line.slice(0, cut));
			break;
		}
		collected.push(line);
	}
	return collected.join("\n");
}

/** Type-alias RHS window: lines until the terminating `;`, budget-bounded. */
function aliasWindow(lines: string[], startIdx: number): string {
	const collected: string[] = [];
	const end = Math.min(lines.length, startIdx + SIGNATURE_WINDOW_LINES);
	for (let i = startIdx; i < end; i++) {
		const line = lines[i] ?? "";
		collected.push(line);
		if (line.includes(";")) break;
	}
	return collected.join("\n");
}

/**
 * Find the body-opening `{` on `line`: the first `{` at paren depth 0, so a
 * `{` inside a parameter's object-type stays in the window. Returns the cut
 * index (-1 when none) and the paren depth carried to the next line.
 */
function bodyBraceCut(line: string, startDepth: number): { cut: number; depth: number } {
	let depth = startDepth;
	for (let j = 0; j < line.length; j++) {
		const ch = line.charAt(j);
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === "{" && depth === 0) return { cut: j, depth };
	}
	return { cut: -1, depth };
}

/** Paren depth at each index of `window`, so a match inside a parameter list
 *  can be told apart from one in return-type / heritage / alias position. */
function parenDepthMap(window: string): number[] {
	const depthAt = new Array<number>(window.length);
	let depth = 0;
	for (let i = 0; i < window.length; i++) {
		const ch = window.charAt(i);
		if (ch === "(") depth++;
		depthAt[i] = depth;
		if (ch === ")") depth--;
	}
	return depthAt;
}

/** True when `name` occurs in `window` at paren depth 0 and not as `new X(`. */
function referencedAtTopLevel(window: string, depthAt: number[], name: string): boolean {
	const re = new RegExp(`(?<!new\\s)\\b${name}\\b`, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(window)) !== null) {
		if ((depthAt[m.index] ?? 0) === 0) return true;
	}
	return false;
}

/**
 * First internal name referenced in the window as a type — EXCLUDING
 * parameter-position references (any occurrence inside parens) and `new X(...)`.
 *
 * Parameter position is exempt by measurement, not principle: the options-bag
 * idiom (`export function cmd(opts: LocalOpts)`) is pervasive and deliberate
 * in app code (182 fires on this tree unrefined; callers pass object literals
 * structurally without ever naming the type). Return types, variable
 * annotations, heritage clauses, and alias RHS remain — those are the
 * "consumer cannot store/extend the result" cases.
 */
function leakedNameIn(window: string, internalNames: Set<string>): string | null {
	const depthAt = parenDepthMap(window);
	for (const name of internalNames) {
		if (referencedAtTopLevel(window, depthAt, name)) return name;
	}
	return null;
}

/**
 * Detect exported declarations whose signature references a non-exported
 * same-file type.
 *
 * check id: `public_api_leaks_internal_type`
 */
export function checkPublicApiLeaksInternalType(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath) || filePath.endsWith(".d.ts")) return [];

	// Stripped view: a type name inside a string or comment must not count,
	// and the paren/brace walk in signatureWindow needs honest brackets.
	const lines = stripCommentsAndStrings(content).split("\n");
	const internalNames = collectInternalTypeNames(lines);
	if (internalNames.size === 0) return [];

	const matches: InlineMatch[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		if (!EXPORT_DECL_RE.test(lines[i] ?? "")) continue;
		const leaked = leakedNameIn(signatureWindow(lines, i), internalNames);
		if (leaked === null) continue;
		matches.push({
			line: i + 1,
			text: `exported signature references non-exported type '${leaked}' — consumers cannot name it (TS4023 under declaration emit); export the type or remove it from the public signature`,
		});
	}
	return matches;
}
