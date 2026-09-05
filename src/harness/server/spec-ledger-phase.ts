// Spec-ledger PostToolUse phase (docs/design/spec-audit-runtime-checks.md
// §3.2/§3.5): on a markdown edit, refresh the cross-file fact ledger and
// warn about drift the edit is involved in — as the claim site or as the
// registry the sibling claims depend on. Non-blocking guidance, evidence
// only; the ledger never writes a fix.

import { readFileSync, realpathSync } from "node:fs";
import { relative } from "node:path";
import type { SpecDriftFinding } from "../spec/ledger.js";
import { SpecLedger } from "../spec/ledger.js";
import { isSpecEligibleFile } from "../spec/types.js";
import type { Determinism, HarnessDecision, SessionTrajectory } from "../types.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";
import { captureSpecDrift } from "./spec-drift-capture.js";

// Module-level shared handle so PreToolUse guards (pure functions with no
// ServerRuntime access) can consult the ledger — the complexity-pulse
// module-stash precedent. Set whenever the phase builds/refreshes.
let sharedLedger: SpecLedger | null = null;

/** The daemon's current spec ledger, or null before the first markdown edit.
 *  Pre-gates fail open on null (the Post phase builds it lazily). */
export function getSharedSpecLedger(): SpecLedger | null {
	return sharedLedger;
}

/** Test seam: install/clear the shared ledger. */
export function setSharedSpecLedgerForTesting(ledger: SpecLedger | null): void {
	sharedLedger = ledger;
}

/** Max drift warnings surfaced per edit — the rest wait for Stop/verify. */
const MAX_WARNINGS_PER_EVENT = 5;

/** Determinism per finding kind (quality-checks tagging convention):
 *  declared markers and anchor/file existence are exact; count/range drift
 *  rests on heuristic census binding. */
function driftDeterminism(kind: SpecDriftFinding["kind"]): Determinism {
	return kind === "declared_fact_drift" ||
		kind === "xref_missing_anchor" ||
		kind === "xref_missing_file"
		? "fully_deterministic"
		: "partially_deterministic";
}

function driftTag(kind: SpecDriftFinding["kind"]): string {
	return driftDeterminism(kind) === "fully_deterministic"
		? "[proven]"
		: "[heuristic]";
}

/** realpath, falling back to the input for not-yet-existing paths. */
function canonicalPath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** Repo-relative posix path for ledger keys. Realpath-canonicalized so an
 *  edit through an in-root symlink alias resolves to the same key the walk
 *  used (round-2 #13). */
function toLedgerPath(cwd: string, absPath: string): string {
	return relative(canonicalPath(cwd), canonicalPath(absPath)).split("\\").join("/");
}

/**
 * Refresh the ledger for EVERY markdown path in a multi-file event before any
 * per-file drift is computed (deep-round #3): a single apply_patch that
 * changes a fact in A.md and B.md together must not report transient drift
 * from processing A while B still holds the old cached value. Called once by
 * the pipeline before the per-file loop; each file's own refresh in
 * runSpecLedgerPhase is then idempotent.
 */
export function prerefreshSpecLedger(
	ctx: ServerRuntime,
	editedFilePaths: readonly string[],
): void {
	if (ctx.rules.spec_checks?.enabled === false) return;
	const mdPaths = editedFilePaths.filter((p) => p && isSpecEligibleFile(p));
	if (mdPaths.length < 2) return; // single-file events need no pre-pass
	try {
		if (!ctx.specLedger) ctx.specLedger = SpecLedger.build(ctx.cwd);
		for (const abs of mdPaths) {
			const rel = toLedgerPath(ctx.cwd, abs);
			if (rel.startsWith("..")) continue;
			try {
				ctx.specLedger.refreshFile(rel, readFileSync(abs, "utf8"));
			} catch {
				// A path deleted within the same patch — drop it so stale
				// content can't produce phantom drift.
				ctx.specLedger.removeFile(rel);
			}
		}
		sharedLedger = ctx.specLedger;
	} catch (err) {
		ctx.log(
			`Spec-ledger pre-refresh error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Refresh the ledger for the edited markdown file and surface cross-file
 * drift involving it. Mirrors runStructureChecksPhase (same parameter shape
 * by design): mutates decision.warnings / allCheckResults / session in
 * place, never throws. Consumed by runPerFileChecks in
 * post-tool-file-checks.ts.
 */
export function runSpecLedgerPhase(
	ctx: ServerRuntime,
	editedFilePath: string,
	editedFileInRepo: boolean,
	session: SessionTrajectory,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	if (ctx.rules.spec_checks?.enabled === false) return;
	if (!editedFilePath || !editedFileInRepo) return;
	if (!isSpecEligibleFile(editedFilePath)) return;
	try {
		const rel = toLedgerPath(ctx.cwd, editedFilePath);
		if (rel.startsWith("..")) return;
		if (!ctx.specLedger) ctx.specLedger = SpecLedger.build(ctx.cwd);
		ctx.specLedger.refreshFile(rel, readFileSync(editedFilePath, "utf8"));
		sharedLedger = ctx.specLedger;
		// One full pass: per-edit WARNINGS are scoped to this file, but the Stop
		// stash must stay GLOBAL — an unrelated markdown edit must not erase
		// outstanding drift from earlier edits (Codex round-4 #1).
		const all = ctx.specLedger.computeDrift();
		const scoped = all.filter(
			(f) => f.file === rel || f.relatedFiles.includes(rel),
		);
		captureSpecDrift(ctx.cwd, rel, all, session);
		recordFindings({ rel, scoped, decision, acc, session });
	} catch (err) {
		ctx.log(
			`Spec-ledger phase error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

interface RecordFindingsArgs {
	rel: string;
	/** Findings involving the edited file — the per-edit warning set. */
	scoped: SpecDriftFinding[];
	decision: HarnessDecision;
	acc: PerFileCheckCtx;
	session: SessionTrajectory;
}

function recordFindings({ rel, scoped, decision, acc, session }: RecordFindingsArgs): void {
	const findings = scoped;
	acc.checksRan.push("spec_ledger");
	if (findings.length === 0) return;
	if (!decision.warnings) decision.warnings = [];
	for (const f of findings.slice(0, MAX_WARNINGS_PER_EVENT)) {
		decision.warnings.push(
			`[interlinked:spec-drift]${driftTag(f.kind)} ${f.file}:${f.line} — ${f.message}`,
		);
		acc.allCheckResults.push({
			source: "spec",
			name: `spec_${f.kind}`,
			severity: "warning",
			message: f.message,
			file: f.file,
			line: f.line,
			determinism: driftDeterminism(f.kind),
		});
	}
	if (findings.length > MAX_WARNINGS_PER_EVENT) {
		decision.warnings.push(
			`[interlinked:spec-drift] …and ${findings.length - MAX_WARNINGS_PER_EVENT} more cross-file finding(s); they resurface at Stop and in \`interlinked verify\`.`,
		);
	}
	recordSiblingCompletions(rel, findings, session);
}

/** Findings anchored in OTHER files become follow-up obligations: this edit
 *  revealed stale sibling sites; visiting them clears the completion. */
function recordSiblingCompletions(
	rel: string,
	findings: SpecDriftFinding[],
	session: SessionTrajectory,
): void {
	for (const f of findings) {
		if (f.file === rel) continue;
		session.pending_completions.set(`spec:${f.kind}:${f.file}:${f.line}`, {
			source_file: rel,
			affected_files: [f.file],
			resolved_files: new Set<string>(),
			recorded_at_tool_call: session.tool_call_count,
			description: `[spec] ${f.kind}: ${f.file}:${f.line} still states a value this edit may have outdated`,
		});
	}
}
