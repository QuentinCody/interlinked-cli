// ===========================================
// Transient debt — PreToolUse adapter
// ===========================================
// The fs/clock/config half of `transient-debt.ts`: turn one write event plus a
// tsc-overlay result into a ledger round-trip and a verdict. Everything that
// decides anything lives in the pure module; this file only reads the ledger,
// hashes content, resolves the mode, and persists what comes back — the same
// split `coverage-debt-gate.ts` uses for coverage debt.
//
// Wired at ONE call site (`write-content-guards.ts`'s tsc overlay guard), so
// the deferrable-finding lifecycle has a single producer today. A second
// producer (deferrable registry checks, via `pre-block-gate.ts`) folds into the
// same ledger by calling `applyTransientDebt` with its own findings.

import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import type { CheckResult } from "../check-engine/types.js";
import { isTscFindingDeferrable } from "../diff-overlay.js";
import { appendDebtTxn, readOpenTransientDebts } from "../obligation-ledger-io.js";
import {
	type DeferrableFinding,
	type TransientDebtMode,
	decideTransientDebt,
} from "../transient-debt.js";
import type { HarnessDecision } from "../types.js";

/** Env bypass, matching the other ratchets' one-command escape hatch. */
const BYPASS_ENV = "INTERLINKED_DISABLE_TRANSIENT_DEBT";

/** Config read off `quality_checks.transient_debt`. Absent ⇒ defaults. Typed
 *  structurally rather than as `QualityCheckConfig` so the pure module and its
 *  tests never have to satisfy that interface's unrelated required fields. */
interface TransientDebtConfig {
	enabled?: boolean;
	mode?: TransientDebtMode | undefined;
	slack?: number | undefined;
}

interface TransientDebtGuardArgs {
	/** Absolute path of the file being written. */
	filePath: string;
	/** Project root the ledger and relative paths resolve against. */
	projectRoot: string;
	sessionId: string;
	/**
	 * Every deferrable finding the proposed content carries, or null/undefined
	 * when the checker did not run.
	 *
	 * Must be the checker's ABSOLUTE answer for this file, not the introduced-
	 * only subset: discharge means "the checker no longer sees it", and a diff
	 * reports an unchanged still-present finding and a fixed one identically.
	 * `null` must never read as "clean" — see {@link applyTransientDebt}.
	 */
	findings: DeferrableFinding[] | null | undefined;
	/**
	 * True when the event is a SIMULATION (`interlinked harness test --write`),
	 * not a real write. The verdict is still computed and shown — that is the
	 * point of the command — but nothing is persisted. Without this, a dry-run
	 * probe opens a real debt against a file it never touched, and that debt then
	 * blocks the next genuine edit: observed 2026-08-04, when three `harness
	 * test --write` probes left a TS2305 debt on `large-file-policy.ts` that
	 * blocked an unrelated write. A read-only command must not move the gate.
	 */
	dryRun?: boolean;
	/** Proposed content, hashed as the ledger's re-edit reconcile key. */
	content: string;
	config?: TransientDebtConfig | undefined;
}

interface TransientDebtGuardResult {
	/** A block decision, or null. */
	decision: HarnessDecision | null;
	warnings: string[];
}

/** `block` by default: a deferred finding that nothing ever comes back for is
 *  the failure mode the permanent warn-only demotion shipped, and warn-mode
 *  reproduces it exactly. Teams adopting on a legacy tree set `warn`. */
function resolveMode(config: TransientDebtConfig | undefined): TransientDebtMode {
	if (process.env[BYPASS_ENV] === "1") return "off";
	if (config?.enabled === false) return "off";
	return config?.mode ?? "block";
}

/**
 * Narrow a tsc overlay result to its deferrable diagnostics — the tsc
 * producer's adapter into the ledger's vocabulary.
 *
 * Exported because the CALLER owns the mapping: a second producer (deferrable
 * registry checks) speaks a different finding shape and must not be forced
 * through a tsc-code filter that would drop every one of its findings. `null`
 * in, `null` out, so "the checker did not run" survives the conversion.
 */
export function deferrableFromTsc(
	findings: CheckResult[] | null | undefined,
): DeferrableFinding[] | null {
	if (findings == null) return null;
	return findings.filter(isTscFindingDeferrable).map((f) => ({
		detector: f.ruleId ?? "tsc",
		line: f.line ?? 0,
		message: f.message ?? "",
	}));
}

function repoRelative(projectRoot: string, filePath: string): string {
	return relative(projectRoot, resolve(projectRoot, filePath)).replace(/\\/g, "/");
}

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Run the transient-debt lifecycle for one write.
 *
 * Two distinct "no findings" cases, kept apart deliberately:
 *  - the overlay ran and reported nothing deferrable ⇒ `[]`, which DISCHARGES
 *    this file's open debts (the checker re-ran and no longer sees them);
 *  - the overlay did not run at all ⇒ `null`, which discharges nothing. The
 *    write is still measured against OTHER files' debts, because walking away
 *    from a debt is a fact about the path you edited, not about whether tsc
 *    had anything to say when you got there.
 */
export function applyTransientDebt(args: TransientDebtGuardArgs): TransientDebtGuardResult {
	const mode = resolveMode(args.config);
	if (mode === "off") return { decision: null, warnings: [] };

	const editedFile = repoRelative(args.projectRoot, args.filePath);
	const openDebts = readOpenTransientDebts(args.projectRoot, args.sessionId);
	const deferrable = args.findings ?? null;

	// No answer for this file ⇒ hide its own debts from the decision, so the
	// "not reported ⇒ reconciled" rule cannot fire on an absence of evidence.
	const scoped = deferrable === null ? openDebts.filter((d) => d.file !== editedFile) : openDebts;
	if (scoped.length === 0 && (deferrable === null || deferrable.length === 0)) {
		return { decision: null, warnings: [] };
	}

	const outcome = decideTransientDebt({
		editedFile,
		findings: deferrable ?? [],
		openDebts: scoped,
		sessionId: args.sessionId,
		atMs: Date.now(),
		contentHash: hashContent(args.content),
		mode,
		...(args.config?.slack === undefined ? {} : { slack: args.config.slack }),
	});
	if (!args.dryRun) {
		for (const txn of outcome.txns) appendDebtTxn(args.projectRoot, txn);
	}
	return { decision: outcome.decision, warnings: outcome.warnings };
}
