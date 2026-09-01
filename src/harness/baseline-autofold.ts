// ===========================================
// SessionEnd baseline auto-fold — orchestrator, budget, audit trail
// ===========================================
// WHY THIS EXISTS. Every ratchet in this repo decides by reading a committed
// water-line JSON under `.interlinked/`. Refreshing those water-lines required
// a human remembering to run a full pass, so they DRIFTED: measured 2026-08-16,
// the coverage and untested-files baselines were 49 and 66 days stale, and a
// single `interlinked adopt` dropped 38 exemptions that had been earned weeks
// earlier. A ratchet judging against a two-month-old water-line is not a
// ratchet — it is a memory of one.
//
// The fix is to fold the session's OWN evidence back into the water-lines at
// SessionEnd, continuously, so the bar tracks the tree instead of lagging it.
// Stop-hook data must be fresh: recalculated per session from session-generated
// artifacts, never inherited from an artifact nobody re-ran.
//
// SAFETY PROPERTIES, in order of importance:
//   1. TIGHTEN-ONLY. Each fold moves its baseline in exactly one direction —
//      the direction `docs/design/baseline-integrity-gate.md` §2 marks safe.
//      The loosening direction is refused inside the planners in
//      `baseline-autofold-folds.ts`, not merely avoided here.
//   2. The writes are harness-INTERNAL plain-`fs` ratchet raises, like
//      `coverage-ratchet.ts::saveBaseline`. They do not pass through the
//      PreToolUse baseline-integrity gate (which only inspects Write/Edit tool
//      calls) — that carve-out is by design, and property 1 is what makes it
//      safe: the bypass cannot express a loosening.
//   3. A DRY RUN MUST NOT MOVE THE GATE. `event.dry_run` (set by
//      `interlinked harness test`) suppresses every write, per CLAUDE.md's
//      rule and the transient-debt bug it was written for.
//   4. Never throws into the SessionEnd path, and never spends more than
//      `budget_ms` — a closing session must not hang on a fold.
//
// Config: `baseline_autofold` (default ENABLED; `{"enabled": false}` in
// guard-rules.local.json opts out — classified in rules/merge.ts).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type FoldKind,
	type FoldOutcome,
	foldCoverage,
	foldCoverageEditBaseline,
	foldLargeFiles,
	foldUntestedFiles,
	toRepoRelative,
} from "./baseline-autofold-folds.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "./types.js";

/** Append-only audit of every fold that actually moved a water-line. */
export const BASELINE_FOLD_LOG_REL = ".interlinked/baseline-folds.jsonl";

/** Whole-fold wall-clock budget. SessionEnd is a closing path — the folds are
 *  a few file reads plus one JSON compare, so 2s is generous; anything that
 *  would exceed it is skipped and says so rather than delaying the session. */
export const DEFAULT_AUTOFOLD_BUDGET_MS = 2_000;

interface BaselineAutoFoldResult {
	/** One entry per fold, in run order, including skipped ones. */
	outcomes: FoldOutcome[];
	/** The single `[interlinked:baseline-fold]` line, or null when nothing moved. */
	warning: string | null;
}

/**
 * The session's start as epoch ms, or 0 when unknown/malformed.
 *
 * `Date.parse` returns NaN on a bad string, and NaN in a `>=` comparison reads
 * as false — which would silently make every coverage report look STALE and
 * disable fold A for the session. Guarding with `Number.isFinite` is the
 * `nan_coercion_guard` check's own rule; 0 means "no lower bound", which fails
 * toward folding rather than toward silence.
 */
export function sessionStartMs(session: SessionTrajectory | undefined): number {
	const parsed = Date.parse(session?.started_at ?? "");
	return Number.isFinite(parsed) ? parsed : 0;
}

/** How each fold's movement reads in the one-line summary. */
const FOLD_PHRASE: Record<FoldKind, (n: number) => string> = {
	coverage: (n) => `coverage +${n} raised`,
	coverage_edit: (n) => `edit-baseline +${n} raised`,
	untested_files: (n) => `untested -${n} dropped`,
	large_files: (n) => `large-files -${n} dropped`,
};

/**
 * The ONE stderr line the session transcript shows. Null when no fold moved —
 * a SessionEnd that folded nothing must be silent, not reassuring.
 */
export function formatFoldWarning(outcomes: FoldOutcome[]): string | null {
	const moved = outcomes.filter((o) => o.changed > 0);
	if (moved.length === 0) return null;
	const parts = moved.map((o) => FOLD_PHRASE[o.kind](o.changed));
	return `[interlinked:baseline-fold] ${parts.join(", ")}`;
}

/**
 * Append one JSONL row for a fold that moved. Returns false when the row could
 * not be written: the audit is observability, and a failed audit write must not
 * undo a fold that already landed on disk.
 *
 * `at` is passed in (derived from the injected clock) rather than read here, so
 * the row stays deterministic under a stubbed `now`.
 */
function appendFoldAudit(args: {
	cwd: string;
	sessionId: string;
	at: string;
	outcome: FoldOutcome;
}): boolean {
	const { outcome } = args;
	try {
		const path = join(args.cwd, BASELINE_FOLD_LOG_REL);
		mkdirSync(dirname(path), { recursive: true });
		const row = {
			at: args.at,
			session: args.sessionId,
			kind: outcome.kind,
			changed: outcome.changed,
			refused: outcome.refused,
			details: outcome.details,
		};
		appendFileSync(path, `${JSON.stringify(row)}\n`, "utf-8");
		return true;
	} catch {
		return false;
	}
}

/** Run one fold, converting any throw into a `no-change` skip. One broken fold
 *  must not cost the other two — see `[[feedback_safety_continuity]]`. */
function runOneFold(kind: FoldKind, run: () => FoldOutcome): FoldOutcome {
	try {
		return run();
	} catch {
		return { kind, changed: 0, refused: 0, skipped: "no-change", details: [], dryRun: false };
	}
}

/** A fold the budget did not reach — recorded, never silently dropped. */
function budgetedOutcome(kind: FoldKind): FoldOutcome {
	return { kind, changed: 0, refused: 0, skipped: "budget", details: [], dryRun: false };
}

/**
 * Run the three folds under one wall-clock budget, then record what moved.
 *
 * Each fold is independent and individually skippable: a fold that finds no
 * input, a stale report, or no baseline returns a skip reason and the others
 * still run. When the deadline passes, the remaining folds are skipped with
 * reason `budget` rather than being silently dropped.
 */
export function runBaselineAutoFold(opts: {
	cwd: string;
	sessionId: string;
	touched: string[];
	sessionStartMs: number;
	dryRun: boolean;
	budgetMs?: number;
	now?: () => number;
}): BaselineAutoFoldResult {
	const now = opts.now ?? Date.now;
	const startedMs = now();
	const deadline = startedMs + (opts.budgetMs ?? DEFAULT_AUTOFOLD_BUDGET_MS);
	const interlinkedDir = join(opts.cwd, ".interlinked");
	const plan: Array<[FoldKind, () => FoldOutcome]> = [
		[
			"coverage",
			() =>
				foldCoverage({
					cwd: opts.cwd,
					interlinkedDir,
					sessionStartMs: opts.sessionStartMs,
					dryRun: opts.dryRun,
				}),
		],
		[
			"coverage_edit",
			() => foldCoverageEditBaseline({ interlinkedDir, dryRun: opts.dryRun }),
		],
		[
			"untested_files",
			() => foldUntestedFiles({ cwd: opts.cwd, touched: opts.touched, dryRun: opts.dryRun }),
		],
		[
			"large_files",
			() => foldLargeFiles({ cwd: opts.cwd, touched: opts.touched, dryRun: opts.dryRun }),
		],
	];

	const outcomes: FoldOutcome[] = [];
	for (const [kind, run] of plan) {
		outcomes.push(now() >= deadline ? budgetedOutcome(kind) : runOneFold(kind, run));
	}
	// A dry run reports what it WOULD have folded but records nothing — the
	// audit log is state, and a read-only probe must not mutate state.
	if (!opts.dryRun) {
		const at = new Date(startedMs).toISOString();
		for (const outcome of outcomes) {
			if (outcome.changed > 0) {
				appendFoldAudit({ cwd: opts.cwd, sessionId: opts.sessionId, at, outcome });
			}
		}
	}
	return { outcomes, warning: formatFoldWarning(outcomes) };
}

/**
 * SessionEnd wiring: config gate + dry-run gate + never-throw wrapper.
 * Returns the warning lines to attach to the SessionEnd decision (at most one).
 *
 * Mirrors `scratchpad-archive.ts::runSessionEndScratchpadArchive`, the sibling
 * SessionEnd sweep — same narrow opts (no `ServerRuntime` import), same
 * enabled-check-then-try shape.
 */
export function runSessionEndBaselineAutoFold(opts: {
	cwd: string;
	rules: GuardRulesConfig;
	log: (msg: string) => void;
	event: HarnessEvent;
	session: SessionTrajectory | undefined;
}): string[] {
	if (opts.rules.baseline_autofold?.enabled === false) return [];
	if (opts.event.dry_run === true) return [];
	try {
		const touched = toRepoRelative(opts.cwd, opts.session?.files_written ?? []);
		const result = runBaselineAutoFold({
			cwd: opts.cwd,
			sessionId: opts.event.session_id || "unknown",
			touched,
			sessionStartMs: sessionStartMs(opts.session),
			dryRun: false,
		});
		if (result.warning === null) return [];
		opts.log(result.warning);
		return [result.warning];
	} catch (err) {
		opts.log(
			`Baseline auto-fold failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
		return [];
	}
}
