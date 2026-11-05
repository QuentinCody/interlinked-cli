// ===========================================
// `interlinked tests prove-kill` / `interlinked tests kill-proofs`
// ===========================================
// prove-kill: one mutant (a manifest survivor by id, or an explicit --find/--replace
// fault), the tests that claim to catch it, local execution, a receipt. Exit 0 only
// for `killed`; 1 for `survived` or `not-passing-now`; 2 when nothing could be
// decided (`inconclusive`, `unavailable`, bad arguments).
// kill-proofs: list the receipts and, with --verify, say which still apply to the
// bytes on disk.

import { realpathSync } from "node:fs";
import { proveKill } from "../harness/kill-proof/run.js";
import { listKillProofIds, mutantLabel, readKillProof, readKillProofIndex, verifyKillProof } from "../harness/kill-proof/receipt.js";
import type { KillProofReceipt, MutantSpec, ProveKillResult } from "../harness/kill-proof/types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

export interface ProveKillCliOptions {
	cwd?: string;
	test?: string[];
	mutant?: string;
	file?: string;
	find?: string;
	replace?: string;
	runTimeout?: string;
	json?: boolean;
}

export const PROVE_KILL_EXIT = { proven: 0, failed: 1, undecided: 2 } as const;

export function specFromOptions(options: ProveKillCliOptions): MutantSpec | string {
	const explicit = options.find !== undefined || options.replace !== undefined;
	if (options.mutant !== undefined && explicit) return "pass either --mutant <id> or --file/--find/--replace, not both";
	if (options.mutant !== undefined) {
		if (!/^[0-9a-f]{16}$/.test(options.mutant)) return "--mutant takes a 16-character hex mutant id; list them with `interlinked mutation survivors --file <path>`";
		return { kind: "manifest", mutantId: options.mutant, ...(options.file !== undefined ? { file: options.file } : {}) };
	}
	if (!explicit) return "name the mutant: --mutant <id>, or --file <src> --find <text> --replace <text>; see --help";
	if (options.file === undefined || options.find === undefined || options.replace === undefined) return "an explicit fault needs all three of --file, --find and --replace";
	return { kind: "explicit", file: options.file, find: options.find, replace: options.replace };
}

export function exitCodeFor(result: ProveKillResult): number {
	if (!result.ok) return result.verdict === "not-passing-now" ? PROVE_KILL_EXIT.failed : PROVE_KILL_EXIT.undecided;
	if (result.receipt.verdict === "killed") return PROVE_KILL_EXIT.proven;
	return result.receipt.verdict === "survived" ? PROVE_KILL_EXIT.failed : PROVE_KILL_EXIT.undecided;
}

function nextStep(result: ProveKillResult): string {
	if (!result.ok) {
		return result.verdict === "not-passing-now"
			? "Make the test pass on the current code first. A test that already fails proves nothing about the mutant."
			: "Fix the reason above and re-run. No receipt was written.";
	}
	switch (result.receipt.verdict) {
		case "killed":
			return "Proof recorded. It holds while source, tests and runtime are unchanged; check with `interlinked tests kill-proofs --verify`.";
		case "survived":
			return "These tests still pass with the mutant applied. Strengthen the assertion: check the value the mutant changes, then re-run.";
		default:
			return "Nothing is proven: a crash, load error or timeout is not a kill. Assert on the mutated code's result, or raise --timeout.";
	}
}

export function renderProveKill(result: ProveKillResult): string {
	const lines: string[] = [];
	const mutant = result.ok ? result.receipt.mutant : result.mutant;
	if (mutant) lines.push(`mutant: ${mutantLabel(mutant)}`);
	if (!result.ok) {
		lines.push(`verdict: ${result.verdict.toUpperCase()}`, ...result.reasons.map(reason => `  - ${reason}`), nextStep(result));
		return lines.join("\n");
	}
	const { receipt } = result;
	lines.push(`tests: ${receipt.tests.map(test => test.path).join(", ")} (${receipt.baseline.cases} case(s) pass in the isolated copy, ${receipt.baseline.durationMs} ms)`);
	lines.push(`verdict: ${receipt.verdict.toUpperCase()} (${receipt.underMutant.durationMs} ms under the mutant)`);
	for (const row of receipt.underMutant.cases) lines.push(`  ${row.verdict.padEnd(12)} ${row.test}${row.reason ? ` — ${row.reason}` : ""}`);
	if (result.receiptPath) lines.push(`receipt: ${result.receiptPath}`);
	lines.push(nextStep(result));
	return lines.join("\n");
}

export async function testsProveKillCommand(options: ProveKillCliOptions): Promise<void> {
	const mode = getOutputMode(options);
	const spec = specFromOptions(options);
	if (typeof spec === "string") { outputError(mode, spec); process.exitCode = PROVE_KILL_EXIT.undecided; return; }
	const budgetMs = Number(options.runTimeout ?? "300000");
	if (!Number.isFinite(budgetMs) || budgetMs <= 0) { outputError(mode, "--run-timeout must be a positive number of milliseconds"); process.exitCode = PROVE_KILL_EXIT.undecided; return; }
	try {
		const root = realpathSync(options.cwd ?? process.cwd());
		const result = await proveKill({ root, spec, tests: options.test ?? [], budgetMs });
		process.exitCode = exitCodeFor(result);
		output(mode, result, { normal: () => renderProveKill(result) });
	} catch (error) {
		outputError(mode, error instanceof Error ? error.message : "kill proof unavailable");
		process.exitCode = PROVE_KILL_EXIT.undecided;
	}
}

export interface KillProofsCliOptions { cwd?: string; verify?: boolean; json?: boolean; }

export interface KillProofRow { id: string; verdict: KillProofReceipt["verdict"]; provedAt: string; mutant: string; tests: string[]; killedTests: string[]; freshness?: "fresh" | "stale" | "unreadable"; reasons?: string[]; }

export function listKillProofs(root: string, verify: boolean): KillProofRow[] {
	const index = new Map(readKillProofIndex(root).receipts.map(row => [row.id, row]));
	return listKillProofIds(root).map(id => {
		// The receipt FILE is the record; the index row is only a locator (review K2).
		const indexed = index.get(id), receipt = readKillProof(root, id);
		const base: KillProofRow = receipt
			? { id, verdict: receipt.verdict, provedAt: receipt.provedAt, mutant: mutantLabel(receipt.mutant), tests: receipt.tests.map(test => test.path), killedTests: receipt.killedTests }
			: indexed
				? { id, verdict: indexed.verdict, provedAt: indexed.provedAt, mutant: indexed.mutant, tests: indexed.tests.map(test => test.path), killedTests: [], freshness: "unreadable" }
				: { id, verdict: "inconclusive", provedAt: "", mutant: "unreadable receipt", tests: [], killedTests: [], freshness: "unreadable" };
		if (!verify || base.freshness === "unreadable") return base;
		if (receipt === null) return { ...base, freshness: "unreadable" };
		const freshness = verifyKillProof(root, receipt);
		return freshness.fresh ? { ...base, freshness: "fresh" } : { ...base, freshness: "stale", reasons: freshness.reasons };
	});
}

export function renderKillProofs(rows: readonly KillProofRow[]): string {
	if (rows.length === 0) return "No kill proofs recorded yet. Make one with `interlinked tests prove-kill --help`.";
	return rows.map(row => {
		const head = `${row.id} ${row.verdict.toUpperCase().padEnd(12)} ${row.provedAt} ${row.mutant}`;
		const tests = `  tests: ${row.tests.join(", ")}${row.killedTests.length ? ` — killed through: ${row.killedTests.join(", ")}` : ""}`;
		const fresh = row.freshness ? `  ${row.freshness.toUpperCase()}${row.reasons ? `: ${row.reasons.join("; ")}` : ""}` : null;
		return [head, tests, ...(fresh ? [fresh] : [])].join("\n");
	}).join("\n");
}

export function testsKillProofsCommand(options: KillProofsCliOptions): void {
	const mode = getOutputMode(options);
	try {
		const rows = listKillProofs(realpathSync(options.cwd ?? process.cwd()), options.verify === true);
		output(mode, { receipts: rows }, { normal: () => renderKillProofs(rows) });
		// Only a KILLED receipt carries evidence, so only a stale or unreadable killed receipt fails the check.
		process.exitCode = options.verify && rows.some(row => row.verdict === "killed" && row.freshness !== "fresh") ? 1 : 0;
	} catch (error) {
		outputError(mode, error instanceof Error ? error.message : "kill proofs unavailable");
		process.exitCode = PROVE_KILL_EXIT.undecided;
	}
}
