// ===========================================
// `interlinked tests prove-kill` / `interlinked tests kill-proofs`
// ===========================================
// prove-kill: one mutant (a manifest survivor by id, or an explicit --find/--replace
// fault), the tests that claim to catch it, local execution, a receipt. Exit 0 only
// for `killed`; 1 for `survived` or `not-passing-now`; 2 when nothing could be
// decided (`inconclusive`, `unavailable`, bad arguments). `--all-survivors` proves
// every manifest survivor of --file in one command (`tests-prove-kill-batch.ts`).
// kill-proofs: list the receipts and, with --verify, say which still apply to the
// bytes on disk.

import { realpathSync } from "node:fs";
import { ProofInterrupted, proveKill } from "../harness/kill-proof/run.js";
import { listKillProofIds, mutantLabel, newestPerProofKey, proofKey, readKillProof, readKillProofIndex } from "../harness/kill-proof/receipt.js";
import { uncommittedPaths, verifyKillProof } from "../harness/kill-proof/receipt-freshness.js";
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
	/** Whole-command deadline; read and enforced by the CLI supervisor (`harness/resource-cli.ts`), validated here so a typo is a usage error. */
	timeout?: string;
	vitestConfig?: string;
	json?: boolean;
}

/** `--run-timeout` / `--timeout` must be a positive integer count of milliseconds; the message names the flag. */
export function timeoutProblem(options: ProveKillCliOptions): string | null {
	for (const [flag, value] of [["--run-timeout", options.runTimeout], ["--timeout", options.timeout]] as const) {
		if (value === undefined) continue;
		if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) return `${flag} must be a positive number of milliseconds`;
	}
	return null;
}


/** 75 is the CLI supervisor's "interrupted, no verdict" code (`harness/resource-cli.ts`); the child reports the same. */
export const PROVE_KILL_EXIT = { proven: 0, failed: 1, undecided: 2, interrupted: 75 } as const;

/** What the child prints when SIGTERM (the supervisor's `--timeout`, or an operator) stopped the proof (round 5, R5-7). */
export const INTERRUPTED_NOTICE = "[interlinked:kill-proof] interrupted by SIGTERM: copies removed, no verdict, no receipt written";

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
			return inconclusiveStep(result.receipt);
	}
}

/** The next step for an inconclusive proof names its cause: a parse error, a timeout, a non-repeatable kill, or a crash. */
function inconclusiveStep(receipt: KillProofReceipt): string {
	const { underMutant } = receipt;
	if (/does not parse|contains JSX/.test(underMutant.error ?? "")) return "Nothing is proven: the mutated file does not parse. Pick a replacement that compiles, then re-run.";
	if (underMutant.timedOut) return "Nothing is proven: the mutant run timed out. Raise --run-timeout (default 300000), then re-run.";
	if (underMutant.cases.some(row => row.reason?.startsWith("not repeatable") === true)) return "Nothing is proven: the test fails on a second clean run. Make it clean up the state it leaves.";
	return "Nothing is proven: a crash or load error is not a kill. Assert on the mutated code's result instead.";
}

export function renderProveKill(result: ProveKillResult): string {
	const lines: string[] = [];
	const mutant = result.ok ? result.receipt.mutant : result.mutant;
	if (mutant) lines.push(`mutant: ${mutantLabel(mutant)}`);
	for (const warning of result.warnings ?? []) lines.push(`warning: ${warning}`);

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

export async function testsProveKillCommand(options: ProveKillCliOptions & { allSurvivors?: boolean; max?: string }): Promise<void> {
	// The batch loop (every manifest survivor of --file, one shared baseline) lives in its own module; a lazy import keeps the two from importing each other.
	if (options.allSurvivors === true || options.max !== undefined) {
		const { testsProveKillBatchCommand } = await import("./tests-prove-kill-batch.js");
		await testsProveKillBatchCommand(options);
		return;
	}
	const mode = getOutputMode(options);
	const spec = specFromOptions(options);
	if (typeof spec === "string") { outputError(mode, spec); process.exitCode = PROVE_KILL_EXIT.undecided; return; }
	const badTimeout = timeoutProblem(options);
	if (badTimeout !== null) { outputError(mode, badTimeout); process.exitCode = PROVE_KILL_EXIT.undecided; return; }
	const budgetMs = Number(options.runTimeout ?? "300000");

	// Round 5, R5-7: the supervisor's `--timeout` SIGTERMs this process. Handled, the signal aborts the proof instead
	// of killing it mid-copy: the overlay runner's own guard has already SIGKILLed the vitest group (it re-raises only
	// when no other listener owns the signal), every copy's `finally` removes it, and the command exits 75.
	const controller = new AbortController();
	const onTerm = (): void => controller.abort();
	process.on("SIGTERM", onTerm); // `on`, not `once`: the overlay runner re-raises the signal when no other listener remains
	try {
		const root = realpathSync(options.cwd ?? process.cwd());
		const result = await proveKill({ root, spec, tests: options.test ?? [], budgetMs, signal: controller.signal, ...(options.vitestConfig !== undefined ? { vitestConfig: options.vitestConfig } : {}) });
		process.exitCode = exitCodeFor(result);
		output(mode, result, { normal: () => renderProveKill(result) });
	} catch (error) {
		if (error instanceof ProofInterrupted || controller.signal.aborted) {
			process.stderr.write(`${INTERRUPTED_NOTICE}\n`);
			process.exitCode = PROVE_KILL_EXIT.interrupted;
			return;
		}
		outputError(mode, error instanceof Error ? error.message : "kill proof unavailable");
		process.exitCode = PROVE_KILL_EXIT.undecided;
	} finally {
		process.removeListener("SIGTERM", onTerm);
	}
}

export interface KillProofsCliOptions { cwd?: string; verify?: boolean; json?: boolean; }

export type KillProofFreshness = "fresh" | "uncommitted" | "stale" | "unreadable";

export interface KillProofRow {
	id: string;
	verdict: KillProofReceipt["verdict"];
	provedAt: string;
	mutant: string;
	/** Manifest mutant id, when the receipt resolved one (absent for an explicit fault or an unreadable receipt). */
	mutantId?: string;
	tests: string[];
	killedTests: string[];
	freshness?: KillProofFreshness;
	reasons?: string[];
	/** Review M8: the newer receipt that proves the same source × mutant × test set. History; never fails `--verify`. */
	supersededBy?: string;
}

/** The command that renews a proof: the nudge's wording (`post-tool-kill-proof.ts`), with the receipt's own id and test files filled in. */
export function renewCommand(row: Pick<KillProofRow, "mutantId" | "tests">): string {
	return `interlinked tests prove-kill --mutant ${row.mutantId ?? "<id>"}${row.tests.map(test => ` --test ${test}`).join("") || " --test <file>"}`;
}

/** The human listing shows at most this many rows (review M11); `--json` stays complete. */
export const KILL_PROOFS_LIST_CAP = 200;

interface ReceiptEntry { id: string; receipt: KillProofReceipt | null }

const receiptEntries = (root: string): ReceiptEntry[] => listKillProofIds(root).map(id => ({ id, receipt: readKillProof(root, id) }));

function freshnessOf(root: string, receipt: KillProofReceipt): Pick<KillProofRow, "freshness" | "reasons"> {
	const freshness = verifyKillProof(root, receipt);
	if (!freshness.fresh) return { freshness: "stale", reasons: freshness.reasons };
	// The proof certifies WORK-TREE bytes; a commit-time reader must know when those are not the committed ones (review N8).
	const uncommitted = uncommittedPaths(root, [receipt.source, ...receipt.tests, ...receipt.boundImports]);
	return uncommitted.length ? { freshness: "uncommitted", reasons: uncommitted.map(path => `${path} differs from HEAD or the index; commit it so the proof covers committed bytes`) } : { freshness: "fresh" };
}

/** Every receipt, newest `provedAt` first (review M11); superseded ones carry `supersededBy`. */
export function listKillProofs(root: string, verify: boolean): KillProofRow[] {
	const index = new Map(readKillProofIndex(root).receipts.map(row => [row.id, row]));
	const entries = receiptEntries(root);
	const newest = newestPerProofKey(entries.flatMap(entry => (entry.receipt === null ? [] : [entry.receipt])));
	const rows = entries.map(({ id, receipt }): KillProofRow => {
		// The receipt FILE is the record; the index row is only a locator (review K2).
		const indexed = index.get(id);
		const base: KillProofRow = receipt
			? { id, verdict: receipt.verdict, provedAt: receipt.provedAt, mutant: mutantLabel(receipt.mutant), ...(receipt.mutant.mutantId !== undefined ? { mutantId: receipt.mutant.mutantId } : {}), tests: receipt.tests.map(test => test.path), killedTests: receipt.killedTests }
			: indexed
				? { id, verdict: indexed.verdict, provedAt: indexed.provedAt, mutant: indexed.mutant, tests: indexed.tests.map(test => test.path), killedTests: [], freshness: "unreadable" }
				: { id, verdict: "inconclusive", provedAt: "", mutant: "unreadable receipt", tests: [], killedTests: [], freshness: "unreadable" };
		if (receipt !== null) {
			const current = newest.get(proofKey(receipt));
			if (current !== undefined && current.id !== id) base.supersededBy = current.id;
		}
		if (!verify || base.freshness === "unreadable") return base;
		if (receipt === null) return { ...base, freshness: "unreadable" };
		return { ...base, ...freshnessOf(root, receipt) };
	});
	return rows.sort((a, b) => (a.provedAt === b.provedAt ? a.id.localeCompare(b.id) : a.provedAt > b.provedAt ? -1 : 1));
}

export function renderKillProofs(rows: readonly KillProofRow[]): string {
	if (rows.length === 0) return "No kill proofs recorded yet. Make one with `interlinked tests prove-kill --help`.";
	const shown = rows.slice(0, KILL_PROOFS_LIST_CAP);
	const lines = shown.map(row => {
		const head = `${row.id} ${row.verdict.toUpperCase().padEnd(12)} ${row.provedAt} ${row.mutant}`;
		// Name the killing files only when a multi-file receipt did not kill through every named file (review K10).
		const partial = row.tests.length > 1 && row.killedTests.length !== row.tests.length;
		const tests = `  tests: ${row.tests.join(", ")}${partial ? ` — killed through: ${row.killedTests.join(", ") || "none"}` : ""}`;
		const superseded = row.supersededBy === undefined ? null : `  SUPERSEDED by ${row.supersededBy}`;
		const fresh = row.freshness ? `  ${row.freshness.toUpperCase()}${row.reasons ? `: ${row.reasons.join("; ")}` : ""}` : null;
		return [head, tests, ...(superseded ? [superseded] : []), ...(fresh ? [fresh] : [])].join("\n");
	});
	if (rows.length > shown.length) lines.push(`… and ${rows.length - shown.length} more (--json lists every receipt)`);
	const listed = lines.join("\n");
	const summary = killProofsTally(rows);
	return summary === null ? listed : `${listed}\n${summary}`;
}

/**
 * After --verify: count the KILLED receipts by freshness and say how to renew a stale one. Shared with verify's
 * `kill_proofs` section. A superseded receipt is history (review M8): it is counted as `superseded`, never in the
 * freshness buckets, so the tally and the exit decision agree (verification af8b93d3 §6).
 */
export function killProofsTally(rows: readonly KillProofRow[]): string | null {
	if (!rows.some(row => row.freshness !== undefined)) return null;
	const killed = rows.filter(row => row.verdict === "killed");
	const current = killed.filter(row => row.supersededBy === undefined), superseded = killed.length - current.length;
	const count = (state: KillProofRow["freshness"]): number => current.filter(row => row.freshness === state).length;
	const stale = count("stale") + count("unreadable");
	const tally = `${killed.length} KILLED proof(s): ${count("fresh")} fresh, ${count("uncommitted")} uncommitted, ${stale} stale${superseded > 0 ? `, ${superseded} superseded` : ""}.`;
	return stale > 0 ? `${tally} Re-run the prove-kill command of each stale proof to renew it.` : `${tally} Only KILLED proofs count as evidence.`;
}

export function testsKillProofsCommand(options: KillProofsCliOptions): void {
	const mode = getOutputMode(options);
	try {
		const rows = listKillProofs(realpathSync(options.cwd ?? process.cwd()), options.verify === true);
		output(mode, { receipts: rows }, { normal: () => renderKillProofs(rows) });
		// Only a KILLED, CURRENT receipt carries evidence, so only a stale or unreadable one fails the check; a
		// superseded receipt is history (review M8). `uncommitted` is fresh bytes that are not the committed ones:
		// reported, never a failure.
		process.exitCode = options.verify && rows.some(row => row.verdict === "killed" && row.supersededBy === undefined && (row.freshness === "stale" || row.freshness === "unreadable")) ? 1 : 0;
	} catch (error) {
		outputError(mode, error instanceof Error ? error.message : "kill proofs unavailable");
		process.exitCode = PROVE_KILL_EXIT.undecided;
	}
}
