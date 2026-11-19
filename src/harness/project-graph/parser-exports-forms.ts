// ===========================================
// Project Graph — Export Parser: extra forms
// ===========================================
// Export forms that parser-exports.ts reads line by line but did not match:
// `export namespace X`, `export module X`, `export declare <anything>`, and a
// minified `export{...}` list that ends a long line after other code.

import type { ExportedSymbol } from "../types.js";

type LineMatcher = (trimmed: string, lineNum: number) => ExportedSymbol[] | null;

const NAMESPACE_EXPORT_RE = /^export\s+(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$]*)/;
const DECLARE_EXPORT_RE = /^export\s+declare\s+(\S.*)$/;
/** A statement-final `export{...}` that follows code on the same line (minified bundles). */
const TRAILING_EXPORT_LIST_RE = /[;}]\s*(export\s*\{[^{}]*\}\s*(?:from\s*['"][^'"]*['"])?)\s*;?\s*$/;

/**
 * Match `export namespace X`, `export module X` and `export declare ...` on a
 * trimmed line. A dotted namespace exports its first segment; an ambient
 * `module "x"` exports nothing. `declare` is erased and the rest re-read by
 * `matchDeclaration`, so `declare function/class/const/enum/...` follow the
 * rules of their non-ambient twins.
 */
export function matchNamespaceOrDeclareExport(
	trimmed: string,
	lineNum: number,
	matchDeclaration: LineMatcher,
): ExportedSymbol[] | null {
	const namespace = NAMESPACE_EXPORT_RE.exec(trimmed);
	if (namespace?.[1] !== undefined) {
		return [{ name: namespace[1], kind: "namespace", isTypeOnly: false, line: lineNum }];
	}
	const declared = DECLARE_EXPORT_RE.exec(trimmed);
	if (declared?.[1] === undefined) return null;
	return matchDeclaration(`export ${declared[1]}`, lineNum);
}

/**
 * The trailing `export{...}` of a line that does not start with `export`, as
 * the text from the `export` keyword on; null when the line has none.
 */
export function trailingExportList(trimmed: string): string | null {
	if (!trimmed.includes("export")) return null;
	return TRAILING_EXPORT_LIST_RE.exec(trimmed)?.[1] ?? null;
}
