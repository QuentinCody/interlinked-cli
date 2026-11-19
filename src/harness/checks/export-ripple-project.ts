import { dirname, resolve } from "node:path";
import type { InlineMatch } from "./shared.js";
import type { ProjectCheckEvidence } from "./project-check-evidence.js";

interface RippleReference { file: string; line: number; modulePath: string; names: string[]; baseName: string; typeOnlyNames: Set<string>; }
const indices = new WeakMap<ProjectCheckEvidence, Map<string, RippleReference[]>>();

/** Existing line-level predicate shared by live edits and full-project scans.
 * Multiline/default/namespace imports and module-resolution aliases need other evidence. */
export function parseRippleImportLine(importerLine: string, file: string, lineIndex: number, cwd: string): RippleReference | null {
	const trimmed = importerLine.trim();
	const match = trimmed.match(/^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/);
	if (!match?.[1] || !match[2]) return null;
	const specifier = match[2];
	if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
	const specBase = specifier.replace(/\.(js|ts|tsx|jsx|mjs|cjs)$/, "");
	const names: string[] = [];
	const typeOnlyNames = new Set<string>();
	const typeOnlyClause = /^import\s+type\s/.test(trimmed);
	for (const clause of match[1].split(",")) {
		const name = (clause.trim().split(/\s+as\s+/)[0] ?? "").trim().replace(/^type\s+/, "");
		if (!name) continue;
		names.push(name);
		if (typeOnlyClause || /^type\s/.test(clause.trim())) typeOnlyNames.add(name);
	}
	return { file, line: lineIndex + 1, modulePath: resolve(dirname(resolve(cwd, file)), specBase), baseName: specBase.split("/").pop() ?? "", names, typeOnlyNames };
}

function projectReferences(evidence: ProjectCheckEvidence): Map<string, RippleReference[]> {
	let index = indices.get(evidence);
	if (index) return index;
	index = new Map();
	for (const source of evidence.sources()) {
		if (evidence.isExcluded(source.file)) continue;
		for (const [lineIndex, line] of source.content.split("\n").entries()) {
			const reference = parseRippleImportLine(line, source.file, lineIndex, evidence.root);
			if (!reference) continue;
			const references = index.get(reference.modulePath) ?? [];
			references.push(reference);
			index.set(reference.modulePath, references);
		}
	}
	indices.set(evidence, index);
	return index;
}

/** JSDoc-only declarations have no ordinary JavaScript runtime export. Their
 * use by a TypeScript importer requires namespace evidence this predicate lacks. */
function possibleJsDocTypes(content: string, file: string): Set<string> {
	const names = new Set<string>();
	if (!/\.[cm]?jsx?$/.test(file)) return names;
	for (const block of content.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
		for (const tag of block[0].matchAll(/@(?:typedef|callback)\s+(?:\{[^}]*\}\s*)?([\w$]+)/g)) {
			if (tag[1]) names.add(tag[1]);
		}
	}
	return names;
}

export function projectExportRipple(evidence: ProjectCheckEvidence, selfRel: string, noExt: string, currentExports: ReadonlySet<string>, content: string): InlineMatch[] {
	const index = projectReferences(evidence);
	evidence.reportGaps("export_ripple");
	const jsDocTypes = possibleJsDocTypes(content, selfRel);
	const findings: InlineMatch[] = [];
	for (const reference of index.get(resolve(evidence.root, noExt)) ?? []) {
		if (reference.file === selfRel || evidence.isExcluded(reference.file)) continue;
		for (const name of reference.names) {
			if (currentExports.has(name)) continue;
			if (jsDocTypes.has(name) && (/\.[cm]?tsx?$/.test(reference.file) || reference.typeOnlyNames.has(name))) {
				evidence.reportUnavailable("export_ripple", reference.file, `Line ${reference.line} imports JSDoc name "${name}" from ${selfRel}. Type/value namespace is unresolved`);
				continue;
			}
			findings.push({ line: 0, text: `${reference.file}:${reference.line} imports "${name}" which no longer exists in exports` });
		}
	}
	return findings;
}
