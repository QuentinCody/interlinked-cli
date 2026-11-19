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

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { findRepoRoot } from "../../lib/interlinked-root.js";
import { getExtension, JS_TS_EXTS } from "../checks/shared.js";
import { MUTATION_DIRECTED_PATH } from "../checks/test-legitimacy.js";
import { type KnownSurvivors, knownSurvivorsFor, prefersBatch, proveKillCommandFor, type SurvivorsLookup } from "../kill-proof/prove-command.js";
import { readKillProofIndex } from "../kill-proof/receipt.js";
import { type Certification, certifyCases, type EnvironmentCache } from "../kill-proof/receipt-freshness.js";
import type { CaseRequirement } from "../kill-proof/source-cases.js";
import { newCaseRequirements } from "../mutation-kill-evidence-stop-check.js";
import type { HarnessEvent } from "../types.js";
import { editProtectionCommand } from "./post-tool-edit-protection.js";
import { isFileWrite } from "./tool-classifiers.js";
import { readToolString } from "./tool-input-values.js";

export const KILL_PROOF_TAG = "kill-proof";

export interface KillProofNudgeInput {
	root: string;
	/** Repo-relative POSIX path of the written test file. */
	relPath: string;
	/** Cases added since HEAD (review L5/M6: the nudge applies the SAME new-case rule as the Stop check); default: computed from `git show HEAD:<file>`. */
	newCases?: ReadonlyArray<string | CaseRequirement>;
	/** Injected for tests; defaults to the real index + receipt-file certification. */
	readIndex?: typeof readKillProofIndex;
	certify?: (root: string, id: string, relPath: string, requireCases?: ReadonlyArray<string | CaseRequirement>, envCache?: EnvironmentCache) => Certification;
	/** Injected for tests; defaults to the manifest survivors sidecar. Decides only the printed command's form (batch when > 1 survivor is known). */
	knownSurvivors?: SurvivorsLookup;
}

/** Cases present in the written file but not in HEAD's version (an unborn file: every case). Null when git cannot say. */
export function newCasesSinceHead(root: string, relPath: string): CaseRequirement[] | null {
	let current: string;
	try { current = readFileSync(resolve(root, relPath), "utf8"); } catch { return null; }
	let base = "";
	try {
		base = execFileSync("git", ["-C", root, "show", `HEAD:${relPath}`], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		base = "";
	}
	return newCaseRequirements(current, base, resolve(root, relPath));
}

/** The nudge text for one mutation-directed test file, or null when a receipt certifies it now. */
export function killProofNudge(input: KillProofNudgeInput): string | null {
	const readIndex = input.readIndex ?? readKillProofIndex;
	const newCases = input.newCases ?? newCasesSinceHead(input.root, input.relPath) ?? [];
	// Superseded rows are history (review M8): a newer proof of the same source × mutant × test set exists.
	const ids = readIndex(input.root).receipts.filter(row => row.supersededBy === undefined && row.tests.some(test => test.path === input.relPath)).map(row => row.id);
	// Several known survivors of the companion source ⇒ the batch form (one shared baseline); else the single-mutant form.
	// The same lookup anchors certification (review round 3 §d.11): with known survivors, only a manifest mutant of the source counts.
	const known = (input.knownSurvivors ?? knownSurvivorsFor)(input.root, input.relPath);
	// Judged together (round 6, finding 3): each new case needs ONE fresh receipt that killed it, not one receipt killed by every case.
	const cert = certifyCases({ root: input.root, testPath: input.relPath, requireCases: newCases, ids, known, ...(input.certify !== undefined ? { certify: input.certify } : {}) });
	if (cert.certified) return null;
	const results = cert.results;
	const command = proveKillCommandFor(input.relPath, known);
	const idsHint = prefersBatch(known) ? "" : " (ids: interlinked mutation survivors --file <source>)";
	if (cert.fresh.length === 0 && cert.unanchored.length > 0 && known !== null) return unanchoredNudge(input.relPath, cert.unanchored.length, known, command);
	if (cert.fresh.length > 0) {
		return `[interlinked:${KILL_PROOF_TAG}] ${input.relPath}: ${cert.fresh.length} fresh kill proof(s) cover this file, but not the newly added case(s): ${cert.uncovered.join(", ")}. A new case is a claim of its own; prove it: ${command}`;
	}
	// A receipt that once killed through this file but is stale now (its reasons name bytes or runtime).
	const staleKills = results.filter(result => !result.certified && result.receipt?.verdict === "killed" && result.receipt.killedTests.includes(input.relPath));
	if (staleKills.length > 0) {
		return `[interlinked:${KILL_PROOF_TAG}] ${input.relPath}: ${staleKills.length} kill proof(s) went stale (source, test or runtime changed). Check that the edit kept them: ${editProtectionCommand(input.relPath)}. Re-run: ${command}`;
	}
	const noKill = results.filter(result => result.receipt !== null && (result.receipt.verdict !== "killed" || !result.receipt.killedTests.includes(input.relPath)));
	const weak = noKill.length > 0 ? ` ${noKill.length} recorded run(s) did not kill through this file (every case here survived or was inconclusive).` : "";
	return `[interlinked:${KILL_PROOF_TAG}] ${input.relPath}: no executed kill proof covers this mutation-directed test file.${weak} A new case here claims to kill a mutant; prove it: ${command}${idsHint}. Coverage, a test-contract marker or a green run is not proof.`;
}

/** Only explicit-fault kills cover the file while its source has known manifest survivors: they do not tie to the survivors it claims. */
function unanchoredNudge(relPath: string, count: number, known: KnownSurvivors, command: string): string {
	return `[interlinked:${KILL_PROOF_TAG}] ${relPath}: ${count} fresh kill proof(s) use an explicit --find/--replace fault, but ${known.source} has ${known.count} known manifest survivor(s). An explicit fault does not show that this file kills them; prove a survivor: ${command}`;
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
