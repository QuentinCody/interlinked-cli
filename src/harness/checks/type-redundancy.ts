// ===========================================
// Type-level redundancy — duplicate declarations across modules
// ===========================================
// Born from the 2026-09-01 dead-code campaign: the "mentioned elsewhere"
// adjudication bucket decomposed almost entirely into HOMONYMS — the same
// exported type name declared independently in several modules (34 names on
// this tree: three `InlineMatch`s, two `CheckStatus`es, two `GateFailure`s…).
// Each is one of two defects:
//   * identical body   → redundant declaration; one module should re-export
//     the other's (drift risk: a field added to one copy silently misses the
//     other — the type-level twin of `code_clones`)
//   * divergent body   → rename hazard; an agent auto-importing by name gets
//     the wrong shape and a confusing distant type error
// Scope: the EDITED file's exported interface/type-alias names vs every other
// git-visible source module. Test files are exempt on both sides.

import { readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { extractInterfaceBodies } from "../project-graph/interface-bodies.js";
import { getGitSourceFiles } from "./export-ripple.js";
import { type InlineMatch, isTestFile } from "./shared.js";

const EXPORT_TYPE_DECL_RE = /^export (?:interface|type) (\w+)/;

/** Collapse whitespace so formatting differences don't defeat the identical-
 *  body comparison. */
function normalizeBody(body: string): string {
	return body.replace(/\s+/g, " ").trim();
}

/** Exported type/interface names declared in `content`, with their 1-based
 *  declaration lines. */
function exportedTypeDecls(content: string): Map<string, number> {
	const out = new Map<string, number>();
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = EXPORT_TYPE_DECL_RE.exec(lines[i] ?? "");
		if (m?.[1]) out.set(m[1], i + 1);
	}
	return out;
}

/** Best-effort read of a candidate module's source; `null` on any read error
 *  (e.g. a stale git-listed path that no longer exists on disk). */
function readOtherFileOrNull(cwd: string, rel: string): string | null {
	try {
		return readFileSync(resolve(cwd, rel), "utf-8");
	} catch {
		return null;
	}
}

/** Build the finding for one own-declared name that also exists in `other`. */
function buildDuplicateMatch(
	name: string,
	line: number,
	ownBody: string,
	otherBodies: Map<string, string>,
	rel: string,
): InlineMatch {
	const otherBody = normalizeBody(otherBodies.get(name) ?? "");
	const identical = ownBody !== "" && ownBody === otherBody;
	return {
		line,
		text: identical
			? `type '${name}' is also declared in ${basename(rel)} with an IDENTICAL body — keep one declaration and re-export it (duplicate declarations drift)`
			: `type '${name}' is also declared in ${basename(rel)} with a DIFFERENT body — rename one side; same-name different-shape types misroute auto-imports`,
	};
}

/** Compare `ownDecls` against one other module's declarations, appending any
 *  newly-discovered duplicate names to `matches` and `seen`. */
function matchOwnDeclsAgainstOther(
	ownDecls: Map<string, number>,
	ownBodies: Map<string, string>,
	other: string,
	rel: string,
	seen: Set<string>,
	matches: InlineMatch[],
): void {
	const otherDecls = exportedTypeDecls(other);
	let otherBodies: Map<string, string> | null = null;
	for (const [name, line] of ownDecls) {
		if (seen.has(name) || !otherDecls.has(name)) continue;
		seen.add(name);
		otherBodies ??= extractInterfaceBodies(other);
		const ownBody = normalizeBody(ownBodies.get(name) ?? "");
		matches.push(buildDuplicateMatch(name, line, ownBody, otherBodies, rel));
	}
}

/**
 * Flag exported type/interface declarations in the edited file whose NAME is
 * also declared (exported) by a different non-test module. Identical bodies
 * get merge guidance; divergent bodies get rename guidance.
 */
export function checkDuplicateTypeDeclaration(
	content: string,
	filePath: string,
	cwd: string = process.cwd(),
): InlineMatch[] {
	if (isTestFile(filePath) || filePath.endsWith(".d.ts")) return [];
	const ownDecls = exportedTypeDecls(content);
	if (ownDecls.size === 0) return [];
	const selfRel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
	if (selfRel.startsWith("..")) return [];
	const ownBodies = extractInterfaceBodies(content);

	const matches: InlineMatch[] = [];
	const seen = new Set<string>();
	for (const rel of getGitSourceFiles(cwd)) {
		if (rel === selfRel || isTestFile(rel) || rel.endsWith(".d.ts")) continue;
		const other = readOtherFileOrNull(cwd, rel);
		if (other === null) continue;
		matchOwnDeclsAgainstOther(ownDecls, ownBodies, other, rel, seen, matches);
		if (seen.size === ownDecls.size) break;
	}
	return matches;
}
