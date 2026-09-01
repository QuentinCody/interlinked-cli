// ===========================================
// Transient-debt expiry — a cured debt must stop warning
// ===========================================
// A transient debt is discharged by exactly one event: its OWN session edits the
// same file again and the checker re-runs clean. Nothing else clears it. So a
// debt on a file nobody happens to touch again outlives the diagnostic that
// opened it, and keeps warning on every unrelated write.
//
// Measured 2026-08-16: `spec-pre-gates.mutation-kill.test.ts` carried [TS18048]
// on every write for over an hour while `tsgo --noEmit` reported ZERO errors
// across three verified-clean whole-project runs. A warning that survives the
// fix teaches the agent to ignore the warning, which costs more than the debt
// ever did.
//
// The project-wide sweep already re-runs tsc over the WHOLE tree, so it is the
// authoritative "does this still reproduce?" evidence — the one signal strong
// enough to retire a debt no edit will reach. Two safety rules keep it
// conservative:
//
//  1. Only the CALLER may decide the evidence is authoritative. This module
//     takes a diagnostic list and trusts it; it is the caller's job never to
//     pass an empty list that merely means "tsc did not run". Absence of
//     evidence is not evidence of a fix.
//  2. A debt is retired only when ITS OWN diagnostic is gone. A file that still
//     reports a DIFFERENT code keeps every debt whose code is still reported,
//     and a debt with no recorded code is retired only when its file is wholly
//     clean.

import { relative, resolve } from "node:path";
import type { Obligation } from "./obligations.js";
import { appendDebtTxn, readOpenTransientDebts } from "./obligation-ledger-io.js";

/** One finding as the project-wide sweep reported it. The TS code lives inside
 *  the free-text message, which is the only shape the sweep exposes. */
interface SweptDiagnostic {
	/** Absolute or repo-relative; normalized here. Absent ⇒ the finding is
	 *  un-attributable and cannot keep any file's debt alive. */
	file?: string | undefined;
	message: string;
}

/** `TS18048`, `TS2304`, … — the detector id `deferrableFromTsc` records. */
const TS_CODE_RE = /\bTS\d{4,5}\b/;

function repoRelative(projectRoot: string, filePath: string): string {
	return relative(projectRoot, resolve(projectRoot, filePath)).replace(/\\/g, "/");
}

/**
 * Fold sweep findings into "which codes does each file STILL report?".
 *
 * A file present with an empty set is meaningful and different from an absent
 * file: it reported something the code regex could not name (a lint finding),
 * so a debt with no recorded detector must not be retired on its evidence.
 */
export function diagnosticCodesByFile(
	projectRoot: string,
	diagnostics: SweptDiagnostic[],
): Map<string, Set<string>> {
	const byFile = new Map<string, Set<string>>();
	for (const diag of diagnostics) {
		if (!diag.file) continue;
		const key = repoRelative(projectRoot, diag.file);
		const codes = byFile.get(key) ?? new Set<string>();
		const match = TS_CODE_RE.exec(diag.message);
		if (match) codes.add(match[0]);
		byFile.set(key, codes);
	}
	return byFile;
}

/** True when this debt's own diagnostic no longer appears in the sweep. */
function noLongerReproduces(debt: Obligation, byFile: Map<string, Set<string>>): boolean {
	const codes = byFile.get(debt.file);
	if (codes === undefined) return true; // the file reported nothing at all
	if (debt.detector === undefined) return false; // unnamed debt, file still dirty
	return !codes.has(debt.detector);
}

/**
 * The open transient debts an authoritative sweep has retired.
 *
 * Pure — the caller owns both the evidence and the persistence, so this is
 * unit-testable without a ledger and reusable by any future producer (a verify
 * run, a pre-push gate) that can supply whole-project diagnostics.
 */
export function expiredTransientDebts(
	debts: Obligation[],
	byFile: Map<string, Set<string>>,
): Obligation[] {
	return debts.filter((d) => d.status === "open" && noLongerReproduces(d, byFile));
}

interface DebtExpiryOptions {
	atMs?: number;
	/** A simulated event must not discharge real debts. */
	dryRun?: boolean;
	/** Restrict the sweep to one session's debts. Omitted ⇒ every open debt,
	 *  which is correct here: whole-project evidence is not session-scoped, and a
	 *  debt another session can no longer discharge is exactly the stuck kind. */
	sessionId?: string;
}

/**
 * Retire every open transient debt whose diagnostic the sweep no longer sees.
 *
 * WARNING: call this only with diagnostics from a run that actually covered the
 * whole project. An empty list from a sweep where tsc did not run reads here as
 * "everything is clean" and would discharge every debt at once.
 */
export function sweepExpiredTransientDebts(
	projectRoot: string,
	diagnostics: SweptDiagnostic[],
	opts: DebtExpiryOptions = {},
): Obligation[] {
	const open = readOpenTransientDebts(projectRoot, opts.sessionId);
	if (open.length === 0) return [];
	const expired = expiredTransientDebts(open, diagnosticCodesByFile(projectRoot, diagnostics));
	if (opts.dryRun === true) return expired;
	const atMs = opts.atMs ?? Date.now();
	for (const debt of expired) {
		appendDebtTxn(projectRoot, { op: "discharge", id: debt.id, source: "observed", atMs });
	}
	return expired;
}
