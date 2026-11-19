// ===========================================
// Edit protection — did a test edit keep the kills its old bytes proved?
// ===========================================
// Saturation testing (every expression covered, every mutant killed) gives
// "semantic stability" only while agents change the RIGHT old tests. When a
// requirement changes, an agent edits tests; an edit that weakens a test of
// UNRELATED code turns the stability guarantee off while every metric stays
// green. This module answers one narrow question with local execution:
//
//   For each mutant that a kill-proof receipt proved this test file killed,
//   with the test's OLD bytes, does the test's CURRENT version still kill it?
//
// The "before" evidence is the receipts themselves: a test edit makes them
// stale (the recorded test sha256 no longer matches), and that staleness is
// exactly the trigger. Each stale kill is re-proved through the ONE verdict
// path (`openProofContext` + `proveResolved`) with persist OFF: a re-proof that
// survived must never supersede the killed receipt, or a second run would
// forget the loss.
//
// Row verdicts:
//   kept      — the current test still kills the mutant.
//   lost      — the current test no longer kills it (or the file was deleted).
//   retired   — the mutant's anchor is gone from the source (the source changed
//               under it): the old proof no longer names a fault, nothing to judge.
//   undecided — the re-proof was inconclusive or unavailable; no claim.
// A FINDING is a `lost` row that is COLLATERAL (its source is outside the
// change-set, so no requirement change there explains it) and that no other
// test file still protects with a fresh killed receipt.
//
// Deterministic and execution-based; never a model. Surfaces: `interlinked
// tests edit-protection` (commands/tests-edit-protection.ts).

import { realpathSync } from "node:fs";
import { isTestPath } from "../coverage-test-selector.js";
import type { VitestRun } from "../fail-before-fix/index.js";
import { hashFile, listKillProofIds, mutantLabel, newestPerProofKey, readKillProof } from "./receipt.js";
import { bytesFresh } from "./receipt-freshness.js";
import { relocate } from "./resolve.js";
import { openProofContext, type ProofContext, proveResolved } from "./run.js";
import type { KillProofReceipt, ProveKillResult, ResolvedMutant } from "./types.js";

export type ProtectionVerdict = "kept" | "lost" | "retired" | "undecided";

export interface ProtectionRow {
	test: string;
	/** The killed receipt that recorded the old protection. */
	receiptId: string;
	/** The mutant as recorded, or re-located in the current source when it still resolves. */
	mutant: ResolvedMutant;
	label: string;
	verdict: ProtectionVerdict;
	/** The mutated source is outside the change-set. */
	collateral: boolean;
	/** Other test files with a FRESH killed receipt for the same mutant. */
	otherKillers: string[];
	reasons: string[];
}

export interface EditProtectionSummary {
	kept: number;
	lost: number;
	collateralLost: number;
	retired: number;
	undecided: number;
}

export interface EditProtectionResult {
	rows: ProtectionRow[];
	findings: ProtectionRow[];
	/** Prior kills not judged because of `max`. */
	skipped: number;
	summary: EditProtectionSummary;
}

export interface EditProtectionOptions {
	root: string;
	/** Edited (or deleted) test files, repo-relative. */
	tests: readonly string[];
	/** Repo-relative source paths the change-set touched; a loss there is requirement-linked. */
	changedSources: ReadonlySet<string>;
	/** Budget for EACH vitest run. */
	budgetMs: number;
	vitestConfig?: string;
	/** At most this many prior kills are re-proved (default 50); the rest are counted in `skipped`. */
	max?: number;
	now?: () => Date;
	runner?: (dir: string, files: readonly string[], budgetMs: number, vitestArgs: readonly string[]) => Promise<VitestRun>;
	signal?: AbortSignal;
}

export const DEFAULT_EDIT_PROTECTION_MAX = 50;

/** The newest KILLED receipt per proof key. Not the newest receipt: re-proving a weakened test writes a `survived`
 *  receipt that supersedes the killed one, and judging by the newest would erase the very loss this module reports. */
export function newestKilled(receipts: ReadonlyArray<KillProofReceipt | null>): KillProofReceipt[] {
	const killed = receipts.filter((r): r is KillProofReceipt => r !== null && r.verdict === "killed");
	return [...newestPerProofKey(killed).values()];
}

function newestReceipts(root: string): KillProofReceipt[] {
	return newestKilled(listKillProofIds(root).map(id => readKillProof(root, id)));
}

/** True when the test's own bytes, or a helper only tests import, differ from what the receipt bound. */
function testSideChanged(root: string, receipt: KillProofReceipt, test: string): boolean {
	const recorded = receipt.tests.find(file => file.path === test);
	if (recorded === undefined) return false;
	if (hashFile(root, test)?.sha256 !== recorded.sha256) return true;
	return receipt.boundImports.some(file => file.path !== receipt.source.path && file.importedBy.includes(test) && hashFile(root, file.path)?.sha256 !== file.sha256);
}

/** The killed receipts naming `test` whose test-side bytes changed since the proof, oldest proof first. */
export function priorKills(root: string, test: string, receipts: readonly KillProofReceipt[] = newestReceipts(root)): KillProofReceipt[] {
	return receipts
		.filter(r => r.verdict === "killed" && r.killedTests.includes(test) && testSideChanged(root, r, test))
		.sort((a, b) => a.provedAt.localeCompare(b.provedAt) || a.id.localeCompare(b.id));
}

/** The paths among `paths` that are test files with at least one killed receipt. */
export function changedTestsWithKills(root: string, paths: readonly string[], receipts: readonly KillProofReceipt[] = newestReceipts(root)): string[] {
	const killers = new Set(receipts.filter(r => r.verdict === "killed").flatMap(r => r.killedTests));
	return paths.filter(path => isTestPath(path) && killers.has(path));
}

function sameMutant(a: ResolvedMutant, b: ResolvedMutant): boolean {
	if (a.file !== b.file || a.source !== b.source) return false;
	return a.mutantId !== undefined ? a.mutantId === b.mutantId : a.originalLexeme === b.originalLexeme && a.replacement === b.replacement;
}

function otherKillersOf(root: string, receipts: readonly KillProofReceipt[], prior: KillProofReceipt, test: string): string[] {
	const out = new Set<string>();
	for (const r of receipts) {
		if (r.verdict !== "killed" || !sameMutant(r.mutant, prior.mutant) || bytesFresh(root, r).length > 0) continue;
		for (const file of r.killedTests) if (file !== test) out.add(file);
	}
	return [...out].sort();
}

function verdictOf(result: ProveKillResult): { verdict: ProtectionVerdict; reasons: string[] } {
	if (!result.ok) return { verdict: "undecided", reasons: [`${result.verdict}: ${result.reasons.join("; ")}`] };
	const { verdict, reasons } = result.receipt;
	if (verdict === "killed") return { verdict: "kept", reasons: [] };
	if (verdict === "survived") return { verdict: "lost", reasons: ["every case of the current test passes under the mutant"] };
	return { verdict: "undecided", reasons: [`inconclusive: ${reasons.join("; ")}`] };
}

/** Cases vitest reports but does not run (the same set run.ts treats as no evidence). */
const NOT_RUN = new Set(["skipped", "todo", "pending", "disabled"]);

/** True when the unmutated run completed, reported cases of `test`, and every one of them is not run.
 *  The proof path calls that "ran no test case" (unavailable, as a config problem may hide the file); here the
 *  cases ARE reported, so the file demonstrably runs nothing that could fail. A file missing from the report stays undecided. */
async function everyCaseInert(context: ProofContext, test: string): Promise<boolean> {
	const run = await context.baseline();
	if (run.error !== undefined || run.timedOut) return false;
	const rows = run.cases.filter(row => row.file === test);
	return rows.length > 0 && rows.every(row => NOT_RUN.has(row.status));
}

interface Pending {
	test: string;
	prior: KillProofReceipt;
}

interface Judged {
	item: Pending;
	mutant: ResolvedMutant;
	verdict: ProtectionVerdict;
	reasons: string[];
}

/** Re-prove each located mutant against the current test, in one shared proof context. */
async function reprove(options: EditProtectionOptions, root: string, test: string, runnable: ReadonlyArray<{ item: Pending; mutant: ResolvedMutant }>): Promise<Judged[]> {
	const opened = openProofContext({ ...options, root, tests: [test], persist: false });
	if (!opened.ok) return runnable.map(row => ({ ...row, verdict: "undecided", reasons: opened.reasons }));
	const out: Judged[] = [];
	try {
		const inert = await everyCaseInert(opened.context, test);
		for (const row of runnable) {
			const judged = inert ? { verdict: "lost" as const, reasons: [`every case of ${test} is skipped or todo now; none can fail`] } : verdictOf(await proveResolved(opened.context, row.mutant));
			out.push({ ...row, ...judged });
		}
	} finally {
		await opened.context.close();
	}
	return out;
}

async function judgeTest(options: EditProtectionOptions, root: string, test: string, items: readonly Pending[]): Promise<Judged[]> {
	if (hashFile(root, test) === null) return items.map(item => ({ item, mutant: item.prior.mutant, verdict: "lost", reasons: [`${test} was deleted`] }));
	const retired: Judged[] = [];
	const runnable: Array<{ item: Pending; mutant: ResolvedMutant }> = [];
	for (const item of items) {
		const at = relocate(root, item.prior.mutant);
		if (at.ok) runnable.push({ item, mutant: at.mutant });
		else retired.push({ item, mutant: item.prior.mutant, verdict: "retired", reasons: [`the source no longer holds the mutant: ${at.reason}`] });
	}
	return runnable.length === 0 ? retired : [...retired, ...(await reprove(options, root, test, runnable))];
}

function summarize(rows: readonly ProtectionRow[]): EditProtectionSummary {
	const count = (v: ProtectionVerdict): number => rows.filter(row => row.verdict === v).length;
	return { kept: count("kept"), lost: count("lost"), collateralLost: rows.filter(row => row.verdict === "lost" && row.collateral).length, retired: count("retired"), undecided: count("undecided") };
}

/** Re-prove every prior kill of the named tests against their current bytes and classify each. */
export async function assessEditProtection(options: EditProtectionOptions): Promise<EditProtectionResult> {
	const root = realpathSync(options.root);
	const receipts = newestReceipts(root);
	const pending: Pending[] = options.tests.flatMap(test => priorKills(root, test, receipts).map(prior => ({ test, prior })));
	const chosen = pending.slice(0, options.max ?? DEFAULT_EDIT_PROTECTION_MAX);
	const rows: ProtectionRow[] = [];
	for (const test of options.tests) {
		const judged = await judgeTest(options, root, test, chosen.filter(item => item.test === test));
		for (const { item, mutant, verdict, reasons } of judged) {
			rows.push({
				test, receiptId: item.prior.id, mutant, label: mutantLabel(mutant), verdict, reasons,
				collateral: !options.changedSources.has(mutant.file),
				otherKillers: verdict === "lost" ? otherKillersOf(root, receipts, item.prior, test) : [],
			});
		}
	}
	const findings = rows.filter(row => row.verdict === "lost" && row.collateral && row.otherKillers.length === 0);
	return { rows, findings, skipped: pending.length - chosen.length, summary: summarize(rows) };
}

/** 1 when a finding exists; else 2 when any prior kill went undecided; else 0. */
export function editProtectionExitCode(result: EditProtectionResult): 0 | 1 | 2 {
	if (result.findings.length > 0) return 1;
	return result.summary.undecided > 0 ? 2 : 0;
}
