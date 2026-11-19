import { dirname } from "node:path";
import { extractInterfaceBodies } from "../project-graph/interface-bodies.js";
import { isTestFile } from "./shared.js";
import type { ProjectCheckEvidence } from "./project-check-evidence.js";

export interface DuplicateHit { name: string; line: number; rel: string; sameDir: boolean; identical: boolean; }
interface IndexedDeclaration { file: string; body: string; }
const indices = new WeakMap<ProjectCheckEvidence, Map<string, IndexedDeclaration[]>>();
const EXPORT_TYPE_DECL_RE = /^export (?:interface|type) (\w+)/;

export function normalizeTypeBody(body: string): string { return body.replace(/\s+/g, " ").trim(); }

/** Existing exported interface/type-alias predicate and declaration locations. */
export function exportedTypeDecls(content: string): Map<string, number> {
	const declarations = new Map<string, number>();
	for (const [index, line] of content.split("\n").entries()) {
		const match = EXPORT_TYPE_DECL_RE.exec(line);
		if (match?.[1]) declarations.set(match[1], index + 1);
	}
	return declarations;
}

function declarationIndex(evidence: ProjectCheckEvidence): Map<string, IndexedDeclaration[]> {
	const cached = indices.get(evidence);
	if (cached) return cached;
	const index = new Map<string, IndexedDeclaration[]>();
	for (const source of evidence.sources()) {
		if (isTestFile(source.file) || source.file.endsWith(".d.ts") || evidence.isExcluded(source.file)) continue;
		const declarations = exportedTypeDecls(source.content);
		if (declarations.size === 0) continue;
		const bodies = extractInterfaceBodies(source.content);
		for (const name of declarations.keys()) {
			const peers = index.get(name) ?? [];
			peers.push({ file: source.file, body: normalizeTypeBody(bodies.get(name) ?? "") });
			index.set(name, peers);
		}
	}
	indices.set(evidence, index);
	return index;
}

/** Preserve the first selected peer per own name and existing move grouping. */
export function projectDuplicateHits(evidence: ProjectCheckEvidence, self: string, ownDecls: ReadonlyMap<string, number>, ownBodies: ReadonlyMap<string, string>): DuplicateHit[] {
	const index = declarationIndex(evidence);
	evidence.reportGaps("duplicate_type_declaration");
	const hits: DuplicateHit[] = [];
	for (const [name, line] of ownDecls) {
		const peer = index.get(name)?.find(declaration => declaration.file !== self && !evidence.isExcluded(declaration.file));
		if (!peer) continue;
		const body = normalizeTypeBody(ownBodies.get(name) ?? "");
		hits.push({ name, line, rel: peer.file, sameDir: dirname(self) === dirname(peer.file), identical: body !== "" && body === peer.body });
	}
	return hits;
}
