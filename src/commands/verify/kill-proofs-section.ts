// ===========================================
// `interlinked verify` — kill-proof receipts section
// ===========================================
// The receipts `interlinked tests prove-kill` wrote, judged by the SAME freshness
// `interlinked tests kill-proofs --verify` reports (`listKillProofs`: receipt file,
// hashes, runtime, mutant relocation, git status — this module computes none of it
// twice). One row per receipt: verdict, source, test file(s), freshness. Only a
// KILLED receipt carries evidence, so only a STALE or UNREADABLE killed receipt is
// a finding (`kill_proof_stale`, [proven]: hashes and a parser decided it);
// `uncommitted` is reported, never a finding; `survived` / `inconclusive`
// receipts are listed, never findings. No receipt on disk ⇒ no section: the one
// directory probe `listKillProofs` already makes, and no git.

import { classifyDeterminism } from "../../harness/quality-checks/warning-formatter.js";
import type { JsonObject } from "../../lib/json-types.js";
import { type KillProofRow, killProofsTally, listKillProofs, renewCommand } from "../tests-prove-kill.js";

/** Check id of the one finding this section raises. Metadata: `check-metadata/generic.ts` (unregistered, verify-only). */
export const KILL_PROOF_STALE_CHECK = "kill_proof_stale";

export interface KillProofStaleFinding {
	check: typeof KILL_PROOF_STALE_CHECK;
	/** Receipt id. */
	id: string;
	freshness: "stale" | "unreadable";
	/** The test files the receipt named — the files whose certification lapsed. */
	files: string[];
	reasons: string[];
	message: string;
	/** The command that renews the proof. */
	fix: string;
}

export interface KillProofsSection {
	/** False when no receipt exists under `.interlinked/test-runs/kill-proofs/`: the section is absent. */
	present: boolean;
	/** True when at least one finding is open and the check is not skipped (verify exits 1). */
	failed: boolean;
	rows: KillProofRow[];
	findings: KillProofStaleFinding[];
	/** Rendered lines for the streaming section (empty when absent). */
	lines: string[];
	/** The `kill_proofs` JSON value (undefined when absent — the key is then omitted). */
	json: JsonObject | undefined;
}

const ABSENT: KillProofsSection = { present: false, failed: false, rows: [], findings: [], lines: [], json: undefined };

/** A CURRENT killed receipt whose evidence lapsed: stale (bytes, runtime or mutant moved) or unreadable (the file no
 *  longer parses). A superseded receipt is history (review M8): `tests kill-proofs --verify` never fails on it, and
 *  this section applies the same rule (verification af8b93d3 §6: verify's gate was stricter than documented). */
export function staleKillFindings(rows: readonly KillProofRow[]): KillProofStaleFinding[] {
	return rows.flatMap(row => {
		if (row.verdict !== "killed" || row.supersededBy !== undefined || (row.freshness !== "stale" && row.freshness !== "unreadable")) return [];
		const reasons = row.reasons ?? [`receipt ${row.id} is unreadable (it no longer parses as a kill-proof receipt)`];
		return [{
			check: KILL_PROOF_STALE_CHECK,
			id: row.id,
			freshness: row.freshness,
			files: row.tests,
			reasons,
			message: `kill proof ${row.id} is ${row.freshness.toUpperCase()}: ${reasons.join("; ")}`,
			fix: renewCommand(row),
		}];
	});
}

/**
 * Judge every receipt under `.interlinked/test-runs/kill-proofs/`. Zero receipts ⇒ absent
 * (one `existsSync` on the directory inside `listKillProofs`; no readdir twice, no git).
 */
export function killProofsSection(cwd: string, skipChecks: ReadonlySet<string> = new Set()): KillProofsSection {
	const rows = listKillProofs(cwd, true);
	if (rows.length === 0) return ABSENT;
	const skipped = skipChecks.has(KILL_PROOF_STALE_CHECK);
	const findings = skipped ? [] : staleKillFindings(rows);
	const json: JsonObject = {
		issues: findings.length,
		files: [...new Set(findings.flatMap(finding => finding.files))].sort(),
		details: findings.map(finding => ({ ...finding })),
		receipts: rows.map(row => ({ ...row })),
		skipped,
	};
	return { present: true, failed: findings.length > 0, rows, findings, lines: renderKillProofsSection(rows, findings), json };
}

const TAG = `[${classifyDeterminism(KILL_PROOF_STALE_CHECK) ?? "heuristic"}]`;

/** One line per receipt (id, verdict, freshness, source, tests), then each finding's reasons and renew command, then the tally. */
export function renderKillProofsSection(rows: readonly KillProofRow[], findings: readonly KillProofStaleFinding[]): string[] {
	const lines = rows.map(row => `${row.id}  ${row.verdict.toUpperCase().padEnd(12)} ${(row.freshness ?? "unverified").toUpperCase().padEnd(11)} ${row.mutant}  tests: ${row.tests.join(", ") || "—"}`);
	for (const finding of findings) {
		lines.push(`${TAG} ${KILL_PROOF_STALE_CHECK}: ${finding.message}`);
		lines.push(`  fix: ${finding.fix}`);
	}
	const tally = killProofsTally(rows);
	if (tally !== null) lines.push(tally);
	return lines;
}

/** Streams the section to stderr (verify's streaming mode); returns whether it failed so the caller applies verify's exit convention. */
export function streamKillProofsSection(cwd: string, skipChecks: ReadonlySet<string>): boolean {
	const section = killProofsSection(cwd, skipChecks);
	if (!section.present) return false;
	const label = section.failed ? "\x1b[31mkill_proofs\x1b[0m" : "\x1b[32mkill_proofs\x1b[0m";
	process.stderr.write(`\n  ${label} (executed kill-proof receipts; same freshness as interlinked tests kill-proofs --verify)\n`);
	for (const line of section.lines) {
		process.stderr.write(`    ${line}\n`);
	}
	return section.failed;
}
