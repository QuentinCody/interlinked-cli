// ===========================================
// Check Command — what a test file imports
// ===========================================
// Reads import statements with line-anchored patterns on comment-masked text. It never runs or parses a target's code with
// a language runtime. Known gaps: a `from x import y` line inside a triple-quoted string counts as an import; conditional
// and function-local imports count (they name a module the test uses); computed module names are invisible.

import { maskComments } from "../lib/metrics/role-tool-config-text.js";

export interface PythonImports {
	/** `import a.b` and `from a.b import c, d` (names listed; `*` and aliases dropped). */
	absolute: Array<{ module: string; names: string[]; /** The `as` name of a plain `import a.b as c`. */ alias?: string }>;
	/** `from . import x`, `from ..a.b import c`. */
	relative: Array<{ level: number; module: string; names: string[] }>;
	/** Dotted names in a `patch(...)` / `import_module(...)` string argument. */
	dotted: string[];
}

const FROM_IMPORT = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n;]*)/gm;
const PLAIN_IMPORT = /^[ \t]*import[ \t]+([\w., \t]+)/gm;
const DOTTED_STRING = /\b(?:patch|import_module|setattr)\(\s*["']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*){1,12})["']/g;

function importedNames(list: string): string[] {
	return list.replace(/[()]/g, " ").split(",").map((part) => (part.trim().split(/\s+/)[0] ?? "")).filter((name) => /^\w+$/.test(name));
}

/** The imports a Python file makes. */
export function pythonImports(text: string): PythonImports {
	const masked = maskComments(text, "hash");
	const result: PythonImports = { absolute: [], relative: [], dotted: [] };
	const ordered: Array<{ at: number; add: () => void }> = [];
	for (const match of masked.matchAll(FROM_IMPORT)) {
		const level = (match[1] ?? "").length, module = match[2] ?? "", names = importedNames(match[3] ?? "");
		ordered.push({ at: match.index, add: () => { if (level === 0) result.absolute.push({ module, names }); else result.relative.push({ level, module, names }); } });
	}
	for (const match of masked.matchAll(PLAIN_IMPORT)) {
		const items = (match[1] ?? "").split(",").map((part) => part.trim().split(/\s+/)).filter((words) => /^[\w.]+$/.test(words[0] ?? ""));
		ordered.push({ at: match.index, add: () => { for (const [module = "", keyword, alias] of items) result.absolute.push(keyword === "as" && alias !== undefined ? { module, names: [], alias } : { module, names: [] }); } });
	}
	for (const match of masked.matchAll(DOTTED_STRING)) ordered.push({ at: match.index, add: () => result.dotted.push(match[1] ?? "") });
	for (const entry of ordered.sort((a, b) => a.at - b.at)) entry.add();
	return result;
}

const FROM_SPEC = /\bfrom\s+["']([^"']+)["']/g;
const SIDE_EFFECT = /\bimport\s+["']([^"']+)["']/g;
const CALL_SPEC = /\b(?:require|import|(?:vi|jest)\.(?:mock|doMock|requireActual|importActual))\s*\(\s*["']([^"']+)["']/g;

export interface JsImportRef { spec: string; /** Imported names (`default` for a default import), or null when the whole module is used. */ names: string[] | null; }
const IMPORT_CLAUSE = /\bimport\s+(?:type\s+)?([^'";]*?)\s*\bfrom\s+["']([^"']+)["']/g;

function clauseNames(clause: string): string[] | null {
	if (/\*\s*as\b/.test(clause)) return null;
	const open = clause.indexOf("{"), head = (open === -1 ? clause : clause.slice(0, open)).replace(/,\s*$/, "").trim();
	const braces = open === -1 ? "" : clause.slice(open + 1, clause.indexOf("}", open) === -1 ? clause.length : clause.indexOf("}", open));
	const named = braces.split(",").map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0] ?? "").filter((name) => name !== "");
	return [...(head === "" ? [] : ["default"]), ...named];
}

/** Each import, require, dynamic import and mock of a JS or TS file with the names it takes, in source order. */
export function jsImportRefs(text: string): JsImportRef[] {
	const masked = maskComments(text, "js");
	const found: Array<{ at: number; ref: JsImportRef }> = [], clauseRanges: Array<[number, number]> = [];
	for (const match of masked.matchAll(IMPORT_CLAUSE)) {
		clauseRanges.push([match.index, match.index + match[0].length]);
		found.push({ at: match.index, ref: { spec: match[2] ?? "", names: clauseNames(match[1] ?? "") } });
	}
	for (const pattern of [FROM_SPEC, SIDE_EFFECT, CALL_SPEC]) {
		for (const match of masked.matchAll(pattern)) {
			if (clauseRanges.some(([from, to]) => match.index >= from && match.index < to)) continue;
			found.push({ at: match.index, ref: { spec: match[1] ?? "", names: null } });
		}
	}
	return found.sort((a, b) => a.at - b.at).map((entry) => entry.ref);
}

export interface JsReexport { spec: string; /** `*` for export-star, else the exported names. */ exported: string[] | "*"; }
const REEXPORT = /\bexport\s+(?:type\s+)?(?:\*\s+as\s+(\w+)|(\*)|\{([^}]*)\})\s+from\s+["']([^"']+)["']/g;

/** The re-exports of a barrel file: `export * from`, `export { a, b as c } from`, `export * as ns from`. */
export function jsReexports(text: string): JsReexport[] {
	const masked = maskComments(text, "js"), found: JsReexport[] = [];
	for (const match of masked.matchAll(REEXPORT)) {
		const spec = match[4] ?? "";
		if (match[2] !== undefined) found.push({ spec, exported: "*" });
		else if (match[1] !== undefined) found.push({ spec, exported: [match[1]] });
		else found.push({ spec, exported: (match[3] ?? "").split(",").map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop() ?? "").filter((name) => name !== "") });
	}
	return found;
}

/** The module specifiers a JS or TS file imports, requires or mocks, in source order. */
export function jsSpecifiers(text: string): string[] {
	const masked = maskComments(text, "js");
	const found: Array<{ at: number; spec: string }> = [];
	for (const pattern of [FROM_SPEC, SIDE_EFFECT, CALL_SPEC]) {
		for (const match of masked.matchAll(pattern)) found.push({ at: match.index, spec: match[1] ?? "" });
	}
	return found.sort((a, b) => a.at - b.at).map((entry) => entry.spec);
}
