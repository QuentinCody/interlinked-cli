// ===========================================
// PostToolUse — edit-protection nudge for an edited test
// ===========================================
// Saturation testing's requirement-change path: an agent edits an OLD test. When
// kill-proof receipts recorded that test killing a mutant with its OLD bytes,
// the edit may have dropped that protection. This line names the command that
// re-proves each recorded kill (`interlinked tests edit-protection`); it runs no
// test itself. PostToolUse, because Stop warnings reach no agent.
//
// Cost: the receipt index (a locator) plus the receipts it names for this test,
// and one hash of the written file. Warn-only. Mutation-directed files are left
// to `post-tool-kill-proof.ts`, whose stale-receipt line names the same command.

import { relative, resolve } from "node:path";
import { findRepoRoot } from "../../lib/interlinked-root.js";
import { getExtension, JS_TS_EXTS } from "../checks/shared.js";
import { MUTATION_DIRECTED_PATH } from "../checks/test-legitimacy.js";
import { isTestPath } from "../coverage-test-selector.js";
import { newestKilled, priorKills } from "../kill-proof/edit-protection.js";
import { readKillProof, readKillProofIndex } from "../kill-proof/receipt.js";
import type { HarnessEvent } from "../types.js";
import { isFileWrite } from "./tool-classifiers.js";
import { readToolString } from "./tool-input-values.js";

export const EDIT_PROTECTION_TAG = "edit-protection";

export function editProtectionCommand(relPath: string): string {
	return `interlinked tests edit-protection ${relPath}`;
}

/** The nudge for one edited test file, or null when no killed receipt binds bytes it no longer has. */
export function editProtectionNudge(root: string, relPath: string): string | null {
	const ids = readKillProofIndex(root).receipts.filter(row => row.killedTests.includes(relPath)).map(row => row.id);
	if (ids.length === 0) return null;
	const prior = priorKills(root, relPath, newestKilled(ids.map(id => readKillProof(root, id))));
	if (prior.length === 0) return null;
	return `[interlinked:${EDIT_PROTECTION_TAG}] ${relPath}: ${prior.length} kill proof(s) recorded this test killing a mutant with its previous bytes. Check that the edit kept them: ${editProtectionCommand(relPath)}. A kill lost in code this change did not touch is a finding.`;
}

/** PostToolUse entry: a JS/TS test file (not mutation-directed) under the project root. */
export function collectEditProtectionWriteWarning(event: HarnessEvent): string[] {
	if (!isFileWrite(event.tool_name || "")) return [];
	const filePath = readToolString(event.tool_input?.file_path) || readToolString(event.tool_input?.path);
	if (!filePath) return [];
	const cwd = event.cwd || process.cwd();
	const abs = resolve(cwd, filePath);
	const posix = abs.replace(/\\/g, "/");
	if (!JS_TS_EXTS.has(getExtension(abs)) || !isTestPath(posix) || MUTATION_DIRECTED_PATH.test(posix)) return [];
	try {
		const root = findRepoRoot(cwd) ?? cwd;
		const relPath = relative(root, abs).replace(/\\/g, "/");
		if (!relPath || relPath.startsWith("..")) return [];
		const nudge = editProtectionNudge(root, relPath);
		return nudge === null ? [] : [nudge];
	} catch {
		return [];
	}
}
