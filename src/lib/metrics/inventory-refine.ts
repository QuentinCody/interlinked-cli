import type { ExcludedFile, InventoryFile, RepositoryInventory } from "./measurement-types.js";
import { isScoreInput } from "./inventory-roles.js";
import { classifyByPath, countLines, excludedEntry, refineByContent } from "./role-evidence.js";
import { markerEvidence } from "./role-evidence-content.js";
import { applyRepoEvidence, loadRepoEvidence, type RepoEvidence } from "./role-repo-evidence.js";

/**
 * v5 = the v4 path roles plus evidence: tool-path vendor, generator names, `mocks/`, and content (header, minified shape).
 * Applied by the score report only. The shared census (`inventory.ts`, still v4) feeds the gates, the coverage index, test
 * planning and evidence identity, and keeps path-only roles.
 */
export const SCORE_ROLES_VERSION = "interlinked-source-roles-v5";

function refineFile(file: InventoryFile, evidence: RepoEvidence): { file: InventoryFile } | { excluded: ExcludedFile } {
	const byPath = applyRepoEvidence(evidence, file.path, classifyByPath(file.path)), decision = refineByContent(byPath, file.content);
	if (decision.evidence === null || decision.from === null) return { file: withCandidate(withDeclaration(file), decision.candidate) };
	if (!isScoreInput(decision.role)) return { excluded: excludedEntry(file.path, decision, countLines(file.content)) };
	return { file: { ...file, role: decision.role, moved: { from: decision.from, evidence: decision.evidence } } };
}

/** Uniform structure alone never sets a file aside; it labels the file so the report can list the directory. */
function withCandidate(file: InventoryFile, candidate: { dir: string; detail: string } | undefined): InventoryFile {
	return candidate === undefined ? file : { ...file, candidateGenerated: candidate };
}

/** A header never sets a file aside; it labels a product file so the report can show it. */
function withDeclaration(file: InventoryFile): InventoryFile {
	const declared = file.role === "product" ? markerEvidence(file.content) : null;
	return declared === null ? file : { ...file, declaredGenerated: { detail: declared.detail } };
}

/**
 * The inventory as the score report measures it. A product or test file that evidence moves out of the authored set leaves
 * `files` and appears in `excluded` with its evidence; nothing is dropped silently. The census hashes and `gaps` are the raw
 * census's, so saved coverage and mutation evidence still match the files it was recorded against.
 */
export function refineInventory(raw: RepositoryInventory): RepositoryInventory {
	const files: InventoryFile[] = [], setAside: ExcludedFile[] = [];
	const excludes = loadRepoEvidence(raw.root, [...raw.files.map((file) => file.path), ...raw.excluded.map((entry) => entry.path)]);
	for (const file of raw.files) {
		if (file.role !== "product" && file.role !== "test") { files.push(file); continue; }
		const result = refineFile(file, excludes);
		if ("file" in result) files.push(result.file);
		else setAside.push(result.excluded);
	}
	const excluded = [...raw.excluded, ...setAside].sort((a, b) => a.path.localeCompare(b.path));
	return { ...raw, version: SCORE_ROLES_VERSION, files, excluded };
}
