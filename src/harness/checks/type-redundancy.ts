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
//
// Move-in-progress carve-out (2026-09-02): the exporter-first file-split flow
// forced by the 500-line cap writes a NEW sibling module carrying types moved
// VERBATIM out of the parent, one edit before the parent's copy is deleted.
// Observed 5+ times in one campaign (BindSessionSocketOptions, MetricsCoverage,
// seven Survivor* types) — each fired once per type with "unify the
// declarations", which is the wrong remedy for a move. A same-name duplicate
// whose body is byte-identical (whitespace-normalized) AND whose sibling lives
// in the SAME DIRECTORY reads as a split in progress, not a homonym: one
// finding per sibling file names the count and steers at finishing the move.
// A different body (the real homonym class) or a different-directory sibling
// (not a split — see helper-hygiene.ts's identical reasoning for functions)
// still gets the original merge/rename guidance.

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
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

/** One own-declared name found duplicated in a sibling module. */
interface DuplicateHit {
	name: string;
	line: number;
	rel: string;
	/** Same directory as the edited file — the split-in-progress precondition. */
	sameDir: boolean;
	identical: boolean;
}

/** Build the finding for one own-declared name whose body DIFFERS from (or
 *  lives in a different directory than) the sibling copy — the true homonym
 *  class, unaffected by the move-in-progress carve-out. */
function buildDuplicateMatch(hit: DuplicateHit): InlineMatch {
	return {
		line: hit.line,
		text: hit.identical
			? `type '${hit.name}' is also declared in ${basename(hit.rel)} with an IDENTICAL body — keep one declaration and re-export it (duplicate declarations drift)`
			: `type '${hit.name}' is also declared in ${basename(hit.rel)} with a DIFFERENT body — rename one side; same-name different-shape types misroute auto-imports`,
	};
}

/** Compare `ownDecls` against one other module's declarations, appending any
 *  newly-discovered duplicate hits to `hits` and `seen`. */
function matchOwnDeclsAgainstOther(
	ownFilePath: string,
	ownDecls: Map<string, number>,
	ownBodies: Map<string, string>,
	other: string,
	rel: string,
	seen: Set<string>,
	hits: DuplicateHit[],
): void {
	const otherDecls = exportedTypeDecls(other);
	let otherBodies: Map<string, string> | null = null;
	for (const [name, line] of ownDecls) {
		if (seen.has(name) || !otherDecls.has(name)) continue;
		seen.add(name);
		otherBodies ??= extractInterfaceBodies(other);
		const ownBody = normalizeBody(ownBodies.get(name) ?? "");
		const otherBody = normalizeBody(otherBodies.get(name) ?? "");
		hits.push({
			name,
			line,
			rel,
			sameDir: dirname(ownFilePath) === dirname(rel),
			identical: ownBody !== "" && ownBody === otherBody,
		});
	}
}

/** A move-in-progress finding: one per sibling file, naming the count instead
 *  of repeating the same "unify the declarations" remedy once per type. */
function describeMoveGroup(rel: string, group: DuplicateHit[]): InlineMatch {
	const line = Math.min(...group.map((h) => h.line));
	const base = basename(rel);
	return {
		line,
		text: `move in progress: ${group.length} type(s) identical to ${base}; delete the originals from ${base} in the next edit (or import them from here)`,
	};
}

/** Partition raw hits into the move-in-progress group (identical body, same
 *  directory) and the genuine-homonym remainder, then render both. */
function renderHits(hits: DuplicateHit[]): InlineMatch[] {
	const moveGroups = new Map<string, DuplicateHit[]>();
	const remedy: InlineMatch[] = [];
	for (const hit of hits) {
		if (hit.identical && hit.sameDir) {
			const group = moveGroups.get(hit.rel) ?? [];
			group.push(hit);
			moveGroups.set(hit.rel, group);
		} else {
			remedy.push(buildDuplicateMatch(hit));
		}
	}
	return [
		...remedy,
		...Array.from(moveGroups.entries()).map(([rel, group]) => describeMoveGroup(rel, group)),
	];
}

/**
 * Flag exported type/interface declarations in the edited file whose NAME is
 * also declared (exported) by a different non-test module. A same-directory
 * sibling with an identical body reads as a split in progress (one grouped
 * finding per sibling); a different body, or an identical body in a
 * different directory, gets the merge/rename guidance instead.
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

	const hits: DuplicateHit[] = [];
	const seen = new Set<string>();
	for (const rel of getGitSourceFiles(cwd)) {
		if (rel === selfRel || isTestFile(rel) || rel.endsWith(".d.ts")) continue;
		const other = readOtherFileOrNull(cwd, rel);
		if (other === null) continue;
		matchOwnDeclsAgainstOther(selfRel, ownDecls, ownBodies, other, rel, seen, hits);
		if (seen.size === ownDecls.size) break;
	}
	return renderHits(hits);
}
