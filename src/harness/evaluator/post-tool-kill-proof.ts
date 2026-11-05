// ===========================================
// PostToolUse — kill-proof nudge for mutation-directed test files
// ===========================================
// The Stop-time `[interlinked:mutation-kill-evidence]` line is stderr-only on every
// runner (docs/reviews/kill-proof-adapter-matrix.md): no agent reads it. PostToolUse
// warnings DO reach the agent as context on Claude Code and Codex. So the
// correction for "you edited a test that claims to kill a mutant" is delivered
// here, right after the write, scoped to the self-declared mutation-directed files
// (`*.mutation-kill.*` / `*.mutation-hardening.*` / `*.survivors?.*`).
//
// Cost: one small index read plus the receipt-file certification of the matching
// receipts (hashes, no TypeScript, no manifest, no test run; review K2: the index
// is only a locator). Warn-only; it names the command that produces executed
// evidence. Paths resolve against the PROJECT root (`findRepoRoot`), not the tool
// call's cwd (review R13).

import { relative, resolve } from "node:path";
import { findRepoRoot } from "../../lib/interlinked-root.js";
import { getExtension, JS_TS_EXTS } from "../checks/shared.js";
import { MUTATION_DIRECTED_PATH } from "../checks/test-legitimacy.js";
import { type Certification, readKillProofIndex, receiptCertifies } from "../kill-proof/receipt.js";
import type { HarnessEvent } from "../types.js";
import { isFileWrite } from "./tool-classifiers.js";
import { readToolString } from "./tool-input-values.js";

export const KILL_PROOF_TAG = "kill-proof";

export interface KillProofNudgeInput {
	root: string;
	/** Repo-relative POSIX path of the written test file. */
	relPath: string;
	/** Injected for tests; defaults to the real index + receipt-file certification. */
	readIndex?: typeof readKillProofIndex;
	certify?: (root: string, id: string, relPath: string) => Certification;
}

/** The nudge text for one mutation-directed test file, or null when a receipt certifies it now. */
export function killProofNudge(input: KillProofNudgeInput): string | null {
	const readIndex = input.readIndex ?? readKillProofIndex, certify = input.certify ?? receiptCertifies;
	const rows = readIndex(input.root).receipts.filter(row => row.tests.some(test => test.path === input.relPath));
	const results = rows.map(row => certify(input.root, row.id, input.relPath));
	if (results.some(result => result.certified)) return null;
	const command = `interlinked tests prove-kill --mutant <id> --test ${input.relPath}`;
	// A receipt that once killed through this file but is stale now (its reasons name bytes or runtime).
	const staleKills = results.filter(result => !result.certified && result.receipt?.verdict === "killed" && result.receipt.killedTests.includes(input.relPath));
	if (staleKills.length > 0) {
		return `[interlinked:${KILL_PROOF_TAG}] ${input.relPath}: ${staleKills.length} kill proof(s) went stale (source, test or runtime changed). Re-run: ${command}`;
	}
	const noKill = results.filter(result => result.receipt !== null && (result.receipt.verdict !== "killed" || !result.receipt.killedTests.includes(input.relPath)));
	const weak = noKill.length > 0 ? ` ${noKill.length} recorded run(s) did not kill through this file (every case here survived or was inconclusive).` : "";
	return `[interlinked:${KILL_PROOF_TAG}] ${input.relPath}: no executed kill proof covers this mutation-directed test file.${weak} A new case here claims to kill a mutant; prove it: ${command} (ids: interlinked mutation survivors --file <source>). Coverage, a test-contract marker or a green run is not proof.`;
}

/** PostToolUse entry: the written file must be a JS/TS mutation-directed test under the project root. */
export function collectKillProofWriteWarning(event: HarnessEvent): string[] {
	if (!isFileWrite(event.tool_name || "")) return [];
	const filePath = readToolString(event.tool_input?.file_path) || readToolString(event.tool_input?.path);
	if (!filePath) return [];
	const cwd = event.cwd || process.cwd();
	const abs = resolve(cwd, filePath);
	if (!JS_TS_EXTS.has(getExtension(abs)) || !MUTATION_DIRECTED_PATH.test(abs.replace(/\\/g, "/"))) return [];
	try {
		const root = findRepoRoot(cwd) ?? cwd;
		const relPath = relative(root, abs).replace(/\\/g, "/");
		if (!relPath || relPath.startsWith("..")) return [];
		const nudge = killProofNudge({ root, relPath });
		return nudge === null ? [] : [nudge];
	} catch {
		return [];
	}
}
