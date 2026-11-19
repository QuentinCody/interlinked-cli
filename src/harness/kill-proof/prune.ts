// ===========================================
// Kill proof — prune orphaned receipts
// ===========================================
// A receipt whose source or test file no longer exists can never be re-proved: before
// `tests kill-proofs --prune` it kept `--verify` at exit 1 forever (decision record UX F1
// residue), and the receipt directory refuses the edit tools. Only those orphans go. A
// stale receipt whose files exist is renewed by re-proving it, never pruned; an unreadable
// receipt stays, because it may be the evidence of a hand edit.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { killProofsDir, listKillProofIds, readKillProof, refreshKillProofIndex } from "./receipt.js";

export interface OrphanedKillProof {
	id: string;
	/** One line per missing file: `source <path> no longer exists` / `test <path> no longer exists`. */
	reasons: string[];
}

export interface PruneResult {
	dryRun: boolean;
	/** The orphans removed (or, on a dry run, that would be removed). */
	removed: OrphanedKillProof[];
}

/** Readable receipts whose source or any named test file is gone from the work tree. */
export function orphanedKillProofs(root: string): OrphanedKillProof[] {
	return listKillProofIds(root).flatMap(id => {
		const receipt = readKillProof(root, id);
		if (receipt === null) return [];
		const files = [{ role: "source", path: receipt.source.path }, ...receipt.tests.map(test => ({ role: "test", path: test.path }))];
		const reasons = files.filter(file => !existsSync(join(root, file.path))).map(file => `${file.role} ${file.path} no longer exists`);
		return reasons.length > 0 ? [{ id, reasons }] : [];
	});
}

/** Remove every orphaned receipt file, then rebuild the index from what remains. A dry run only lists. */
export function pruneKillProofs(root: string, options: { dryRun: boolean }): PruneResult {
	const removed = orphanedKillProofs(root);
	if (options.dryRun || removed.length === 0) return { dryRun: options.dryRun, removed };
	for (const orphan of removed) rmSync(join(killProofsDir(root), `${orphan.id}.json`), { force: true });
	refreshKillProofIndex(root);
	return { dryRun: false, removed };
}
