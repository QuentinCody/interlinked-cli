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
import { proveKill } from "../harness/kill-proof/run.js";
import { listKillProofIds, mutantLabel, readKillProof, readKillProofIndex, uncommittedPaths, verifyKillProof } from "../harness/kill-proof/receipt.js";
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

	try {
		const root = realpathSync(options.cwd ?? process.cwd());
		const result = await proveKill({ root, spec, tests: options.test ?? [], budgetMs, ...(options.vitestConfig !== undefined ? { vitestConfig: options.vitestConfig } : {}) });
		process.exitCode = exitCodeFor(result);
		output(mode, result, { normal: () => renderProveKill(result) });
	} catch (error) {
		outputError(mode, error instanceof Error ? error.message : "kill proof unavailable");
		process.exitCode = PROVE_KILL_EXIT.undecided;
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
}

/** The command that renews a proof: the nudge's wording (`post-tool-kill-proof.ts`), with the receipt's own id and test files filled in. */
export function renewCommand(row: Pick<KillProofRow, "mutantId" | "tests">): string {
	return `interlinked tests prove-kill --mutant ${row.mutantId ?? "<id>"}${row.tests.map(test => ` --test ${test}`).join("") || " --test <file>"}`;
}

export function listKillProofs(root: string, verify: boolean): KillProofRow[] {
	const index = new Map(readKillProofIndex(root).receipts.map(row => [row.id, row]));
	return listKillProofIds(root).map(id => {
		// The receipt FILE is the record; the index row is only a locator (review K2).
		const indexed = index.get(id), receipt = readKillProof(root, id);
		const base: KillProofRow = receipt
			? { id, verdict: receipt.verdict, provedAt: receipt.provedAt, mutant: mutantLabel(receipt.mutant), ...(receipt.mutant.mutantId !== undefined ? { mutantId: receipt.mutant.mutantId } : {}), tests: receipt.tests.map(test => test.path), killedTests: receipt.killedTests }
			: indexed
				? { id, verdict: indexed.verdict, provedAt: indexed.provedAt, mutant: indexed.mutant, tests: indexed.tests.map(test => test.path), killedTests: [], freshness: "unreadable" }
				: { id, verdict: "inconclusive", provedAt: "", mutant: "unreadable receipt", tests: [], killedTests: [], freshness: "unreadable" };
		if (!verify || base.freshness === "unreadable") return base;
		if (receipt === null) return { ...base, freshness: "unreadable" };
		const freshness = verifyKillProof(root, receipt);
		if (!freshness.fresh) return { ...base, freshness: "stale", reasons: freshness.reasons };
		// The proof certifies WORK-TREE bytes; a commit-time reader must know when those are not the committed ones (review N8).
		const uncommitted = uncommittedPaths(root, [receipt.source.path, ...receipt.tests.map(test => test.path), ...receipt.boundImports.map(file => file.path)]);
		return uncommitted.length ? { ...base, freshness: "uncommitted", reasons: uncommitted.map(path => `${path} differs from HEAD or the index; commit it so the proof covers committed bytes`) } : { ...base, freshness: "fresh" };
	});
}

export function renderKillProofs(rows: readonly KillProofRow[]): string {
	if (rows.length === 0) return "No kill proofs recorded yet. Make one with `interlinked tests prove-kill --help`.";
	const listed = rows.map(row => {
		const head = `${row.id} ${row.verdict.toUpperCase().padEnd(12)} ${row.provedAt} ${row.mutant}`;
		// Name the killing files only when a multi-file receipt did not kill through every named file (review K10).
		const partial = row.tests.length > 1 && row.killedTests.length !== row.tests.length;
		const tests = `  tests: ${row.tests.join(", ")}${partial ? ` — killed through: ${row.killedTests.join(", ") || "none"}` : ""}`;
		const fresh = row.freshness ? `  ${row.freshness.toUpperCase()}${row.reasons ? `: ${row.reasons.join("; ")}` : ""}` : null;
		return [head, tests, ...(fresh ? [fresh] : [])].join("\n");
	}).join("\n");
	const summary = killProofsTally(rows);
	return summary === null ? listed : `${listed}\n${summary}`;
}

/** After --verify: count the KILLED receipts by freshness and say how to renew a stale one. Shared with verify's `kill_proofs` section. */
export function killProofsTally(rows: readonly KillProofRow[]): string | null {
	if (!rows.some(row => row.freshness !== undefined)) return null;
	const killed = rows.filter(row => row.verdict === "killed");
	const count = (state: KillProofRow["freshness"]): number => killed.filter(row => row.freshness === state).length;
	const stale = count("stale") + count("unreadable");
	const tally = `${killed.length} KILLED proof(s): ${count("fresh")} fresh, ${count("uncommitted")} uncommitted, ${stale} stale.`;
	return stale > 0 ? `${tally} Re-run the prove-kill command of each stale proof to renew it.` : `${tally} Only KILLED proofs count as evidence.`;
}

export function testsKillProofsCommand(options: KillProofsCliOptions): void {
	const mode = getOutputMode(options);
	try {
		const rows = listKillProofs(realpathSync(options.cwd ?? process.cwd()), options.verify === true);
		output(mode, { receipts: rows }, { normal: () => renderKillProofs(rows) });
		// Only a KILLED receipt carries evidence, so only a stale or unreadable killed receipt fails the check.
		// `uncommitted` is fresh bytes that are not the committed ones: reported, never a failure.
		process.exitCode = options.verify && rows.some(row => row.verdict === "killed" && (row.freshness === "stale" || row.freshness === "unreadable")) ? 1 : 0;
	} catch (error) {
		outputError(mode, error instanceof Error ? error.message : "kill proofs unavailable");
		process.exitCode = PROVE_KILL_EXIT.undecided;
	}
}
