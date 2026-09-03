// ===========================================
// Diff-Overlay Pre-Block
// ===========================================
// Runs toolchain linters (biome + tsc) against the *proposed* file content
// before the write lands, compared against the cached diagnostics for the
// on-disk file. The overlay returns the set of findings that are net-new in
// the proposed content so the evaluator can block the write with a targeted
// reason.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { getOrCreateEngine } from "./check-engine/index.js";
import type { CheckResult } from "./check-engine/types.js";

const JS_TS_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;
const TS_OVERLAY_EXT = /\.(tsx?|mts|cts)$/;

export interface DiffOverlayResult {
	/** Findings present in the proposed content but not in the on-disk file. */
	newFindings: CheckResult[];
	/**
	 * The checker's FULL answer for the proposed content — every finding, not
	 * just the new ones — or null when the overlay short-circuited without
	 * running (wrong extension, no disk state, content identical to disk).
	 *
	 * `newFindings` cannot answer "is it still there?": an unchanged, still-
	 * present diagnostic is absent from the diff exactly as a fixed one is. The
	 * transient-debt ledger discharges on the checker no longer seeing a
	 * finding, so it needs the absolute answer — and needs `null` to mean
	 * "don't know", never "clean".
	 */
	proposedFindings?: CheckResult[] | null;
	/** Total wall-clock ms spent running the overlay (for budget/telemetry). */
	elapsedMs: number;
	/** True if latency exceeded the tool-specific budget — caller may demote to warn. */
	exceededBudget: boolean;
	/**
	 * Set (to the reason string) when the checker itself could not run —
	 * sidecar spawn failure, timeout, malformed reply, cooldown. `newFindings`
	 * is then vacuously empty: "unavailable", NOT "checked clean".
	 * Transactional consumers (multi-edit, verify-changeset) must treat this
	 * as a gate failure; advisory consumers should surface it as a warning.
	 */
	checkerUnavailable?: string;
}

/** GateFailure `code` used by consumers when `checkerUnavailable` is set. */
export const TSC_CHECKER_UNAVAILABLE_CODE = "tsc-overlay-unavailable";

/**
 * The live PreToolUse hook's honest-unavailability warning (Grok 2026-08-28
 * issue 7). Sidecar spawn failure / timeout / cooldown yields zero findings
 * WITH `checkerUnavailable` set; the live path used to read that as clean —
 * the fail-open this module's transactional callers (write / multi-edit /
 * verify-changeset) already abort on. Blocking every live edit during a
 * sidecar cooldown would brick the session, so the live path warns LOUDLY
 * instead: the edit proceeds unchecked-by-tsc and SAYS so, and the PostToolUse
 * on-disk tsc pass remains the backstop.
 */
export function tscUnavailableWarning(filePath: string, reason: string): string {
	return `[interlinked:tsc-overlay] NOT CHECKED — the type-checker was unavailable for this edit of ${filePath} (${reason}). Zero findings here means "not looked at", not "clean"; the PostToolUse tsc pass is the backstop.`;
}

/**
 * Budget per tool. Biome's temp-file approach is quick (~200ms typical) on
 * warm caches, but cold `npx biome` is far slower — on fresh CI runners, and
 * especially under the worker-capped full-suite test run, the npx shim plus
 * biome cold-start can overshoot a 2s budget. `spawnSync` then kills biome
 * and the overlay returns empty, silently dropping real findings (a gate
 * false-pass). Tsc LS is slow on first call (warmup 1-3s) but very fast
 * after (~20-100ms). We set a generous budget — a slow-but-correct result is
 * strictly better than a fast-but-empty one from a premature timeout, and
 * the gate only fires on NEW findings, so the latency cost is worth it.
 */
const BIOME_BUDGET_MS = 8_000;
const TSC_BUDGET_MS = 5_000;

/**
 * Key a CheckResult for set-diffing. We deliberately ignore column and
 * line so that a renumbered diagnostic (e.g. the line shifted) still
 * counts as the same pre-existing finding. Rule + file is the stable
 * identity. Message is included for tsc only, because the same TS code can
 * appear multiple times in a file with different subject text.
 */
function diagKey(r: CheckResult): string {
	if (r.tool === "tsc") {
		// For tsc, include message (normalized) so multiple distinct
		// type-errors with the same code (e.g. two different TS2345) aren't
		// collapsed.
		const normalized = (r.message || "").replace(/\s+/g, " ").trim().slice(0, 140);
		return `${r.file}:${r.ruleId ?? ""}:${r.severity}:${normalized}`;
	}
	return `${r.file}:${r.ruleId ?? ""}:${r.severity}`;
}

/**
 * Evaluate whether the proposed overlay content introduces new biome
 * findings relative to the file on disk.
 *
 * - If biome isn't configured for this project → returns empty (no gate).
 * - If extension isn't JS/TS family → returns empty.
 * - If the file doesn't yet exist, the baseline is empty: every proposed
 *   diagnostic is introduced by the write and is therefore new.
 */
export function evaluateBiomeDiffOverlay(
	filePath: string,
	proposedContent: string,
	projectRoot: string,
): DiffOverlayResult {
	const empty: DiffOverlayResult = {
		newFindings: [],
		elapsedMs: 0,
		exceededBudget: false,
	};

	if (!JS_TS_EXT.test(filePath)) return empty;

	const engine = getOrCreateEngine(projectRoot);

	// Confirm an existing path is readable text before asking the engine for its
	// cached diagnostics. Directories and transiently unreadable files are not
	// valid overlay targets and must short-circuit without touching the cache.
	const existsOnDisk = existsSync(filePath);
	if (existsOnDisk) {
		let onDisk = "";
		try {
			onDisk = readFileSync(filePath, "utf-8");
		} catch {
			return empty;
		}
		if (onDisk === proposedContent) return empty;
	}

	// A new file has an empty baseline, so every proposed diagnostic is new.
	const preEdit = existsOnDisk
		? engine.getCachedDiagnostics(filePath).filter((r) => r.tool === "biome")
		: [];

	const start = Date.now();
	const overlay = engine.getBiomeDiagnosticsForOverlay(
		filePath,
		proposedContent,
		BIOME_BUDGET_MS,
	);
	const elapsedMs = Date.now() - start;
	const exceededBudget = elapsedMs > BIOME_BUDGET_MS;

	const preKeys = new Set(preEdit.map(diagKey));
	const newFindings = overlay.filter((r) => !preKeys.has(diagKey(r)));

	return { newFindings, elapsedMs, exceededBudget };
}

// -------------------------------------------
// TSC LanguageService diff-overlay
// -------------------------------------------

/**
 * TS diagnostic codes that should DEMOTE to warning rather than block.
 * These are common during work-in-progress edits and routinely fixed by
 * the next edit — blocking on them makes iterative development painful.
 *
 * Everything else → block. (Conservative default: new type errors are
 * usually real.)
 */
const TSC_WARN_ONLY_CODES = new Set([
	"TS6133", // 'X' is declared but its value is never read
	"TS6196", // 'X' is declared but never used
	"TS6192", // All imports in import declaration are unused
	"TS6138", // Property 'X' is declared but its value is never read
	"TS2531", // Object is possibly 'null'
	"TS2532", // Object is possibly 'undefined'
	"TS18048", // 'X' is possibly 'undefined'
	"TS18047", // 'X' is possibly 'null'
	// Unresolved-symbol codes. These are the signature of a coordinated change
	// whose halves cannot land in one Edit — adding a helper at the bottom of a
	// file and its import at the top are non-contiguous, so an agent with no
	// atomic multi-edit tool MUST produce a transiently-broken file. Blocking
	// here made the only path forward a batch-write workaround, for an error
	// the very next edit resolves.
	//
	// Demoting costs little: a genuine typo still WARNS here, then fails the
	// PostToolUse tsc run, `interlinked verify`, and the Stop-event
	// unverified-code nudge. It is never silent — it just no longer bricks a
	// half-landed refactor.
	"TS2304", // Cannot find name 'X'
	"TS2305", // Module 'Y' has no exported member 'X'
]);

/** Pre-edit LS-diagnostic cache keyed by `${filePath}:${mtimeMs}` */
const preEditTscCache = new Map<string, CheckResult[]>();

function tscCacheKey(filePath: string): string {
	try {
		return `${filePath}:${statSync(filePath).mtimeMs}`;
	} catch {
		return `${filePath}:missing`;
	}
}

/**
 * Returns whether a new finding should block (true) or only warn (false).
 * Warn-only codes are returned from the check but surfaced as warnings
 * in the evaluator — the caller applies the policy.
 */
export function isTscFindingBlocking(f: CheckResult): boolean {
	return !TSC_WARN_ONLY_CODES.has(f.ruleId ?? "");
}

/**
 * True for a diagnostic whose wrongness is DEFERRABLE — a property of a
 * not-yet-complete tree that the coordinated change's other half resolves.
 *
 * Today this is exactly the demotion set, which is the point: the codes above
 * were already judged "routinely fixed by the next edit", and the only thing
 * wrong with that judgement was its conclusion. Demotion answers "should this
 * block NOW?" with a permanent no; the transient ledger answers "by WHEN?"
 * (`transient-debt.ts`). The predicate is named separately from
 * `isTscFindingBlocking` so the two questions can diverge later — a code can be
 * non-blocking and non-deferrable (a pure advisory that nobody owes work on).
 */
export function isTscFindingDeferrable(f: CheckResult): boolean {
	return TSC_WARN_ONLY_CODES.has(f.ruleId ?? "");
}

/** A relative-import module-not-found (TS2307 for `./` or `../`). Its presence
 *  in a proposed file's diagnostics marks the TDD red step: the file references
 *  a sibling module not yet written (a test before its impl). `_`-prefixed so a
 *  unit test can pin it. */
const RELATIVE_MODULE_NOT_FOUND = /Cannot find module ['"]\.\.?\//;
export function _isRelativeModuleNotFound(f: CheckResult): boolean {
	return RELATIVE_MODULE_NOT_FOUND.test(f.message);
}

/**
 * The pre-edit tsc baseline for a file that exists on disk: either the
 * diagnostics to diff against, or the reason there is nothing to diff.
 */
type PreEditTscBaseline =
	| { status: "ok"; findings: CheckResult[] }
	| { status: "skipped" }
	| { status: "unavailable"; reason: string };

/**
 * Pre-edit snapshot via LS overlay against disk content. Cached so we
 * don't re-run for every edit to the same file.
 */
function preEditTscBaseline(
	engine: ReturnType<typeof getOrCreateEngine>,
	filePath: string,
	onDisk: string,
	cacheKey: string,
): PreEditTscBaseline {
	const cached = preEditTscCache.get(cacheKey);
	if (cached) return { status: "ok", findings: cached };

	const preOutcome = engine.getTscDiagnosticsForOverlayTyped(filePath, onDisk);
	if (preOutcome.status === "unavailable") {
		// Never cache an unavailable run as "no diagnostics" — that would
		// poison the baseline for the cooldown window. Report honestly.
		return { status: "unavailable", reason: preOutcome.reason };
	}
	// "skipped" (non-TS file / mode off): nothing to diff — the check
	// deliberately does not apply here, distinct from checked-clean.
	if (preOutcome.status === "skipped") return { status: "skipped" };

	preEditTscCache.set(cacheKey, preOutcome.findings);
	return { status: "ok", findings: preOutcome.findings };
}

/**
 * Evaluate whether the proposed overlay content introduces new tsc
 * diagnostics relative to the file on disk.
 *
 * - Uses the TypeScript LanguageService (via tsc-overlay runner) for both
 *   the pre-edit and proposed snapshots to ensure identical diagnostic
 *   semantics on both sides of the diff.
 * - Caches the pre-edit result by `(filePath, mtime)` so unchanged files
 *   don't re-run semantic analysis on every overlay call.
 * - New-file Writes use an empty baseline, so proposed diagnostics are new.
 */
export function evaluateTscDiffOverlay(
	filePath: string,
	proposedContent: string,
	projectRoot: string,
	siblings?: ReadonlyArray<{ filePath: string; content: string }>,
): DiffOverlayResult {
	const empty: DiffOverlayResult = {
		newFindings: [],
		proposedFindings: null,
		elapsedMs: 0,
		exceededBudget: false,
	};

	if (!TS_OVERLAY_EXT.test(filePath)) return empty;

	let onDisk = "";
	const existsOnDisk = existsSync(filePath);
	if (existsOnDisk) {
		try {
			onDisk = readFileSync(filePath, "utf-8");
		} catch {
			return empty;
		}
		if (onDisk === proposedContent) return empty;
	}

	const engine = getOrCreateEngine(projectRoot);

	const cacheKey = tscCacheKey(filePath);
	let preEdit: CheckResult[] = [];
	if (existsOnDisk) {
		const baseline = preEditTscBaseline(engine, filePath, onDisk, cacheKey);
		if (baseline.status === "unavailable") {
			return { ...empty, checkerUnavailable: baseline.reason };
		}
		if (baseline.status === "skipped") return empty;
		preEdit = baseline.findings;
	}

	const start = Date.now();
	// Overlay the other in-flight batch files (siblings) so a transactional
	// multi-file edit's cross-file references resolve against the proposed
	// combined state. The pre-edit baseline above stays disk-only, so new
	// findings are correctly attributed to the batch, not pre-existing state.
	const overlayOutcome = engine.getTscDiagnosticsForOverlayTyped(
		filePath,
		proposedContent,
		siblings,
	);
	const elapsedMs = Date.now() - start;
	const exceededBudget = elapsedMs > TSC_BUDGET_MS;
	if (overlayOutcome.status === "unavailable") {
		// proposedFindings null = "don't know" (per the field doc) — the
		// transient-debt ledger must not discharge on an unavailable run.
		return {
			newFindings: [],
			proposedFindings: null,
			elapsedMs,
			exceededBudget,
			checkerUnavailable: overlayOutcome.reason,
		};
	}
	// "skipped": the check does not apply (non-TS / mode off) — nothing to
	// diff, and NOT the same as checked-clean (proposedFindings stays null).
	if (overlayOutcome.status === "skipped") {
		return { newFindings: [], proposedFindings: null, elapsedMs, exceededBudget };
	}
	const overlay = overlayOutcome.findings;

	const preKeys = new Set(preEdit.map(diagKey));
	const newFindings = overlay.filter((r) => !preKeys.has(diagKey(r)));

	// TDD red-step tolerance: if the proposed content references a sibling
	// module that doesn't resolve yet (a test written before its impl), every
	// symbol from that import is `any`, cascading into spurious implicit-any /
	// unknown errors. Blocking here punishes the exact test-first step the TDD
	// gate requires — the friction that forces agents into `write --batch`.
	// Suppress this file's introduced findings; the next edit (the impl, or a
	// batch overlaying it) resolves the import and re-validates everything.
	if (overlay.some(_isRelativeModuleNotFound)) {
		return { newFindings: [], proposedFindings: overlay, elapsedMs, exceededBudget };
	}

	return { newFindings, proposedFindings: overlay, elapsedMs, exceededBudget };
}

/** Test-only reset of the underlying engine cache, not the overlay itself. */
export function _resetEngineCacheForTest(): void {
	// Helpful for unit tests that rebuild file state between cases.
	const eng = getOrCreateEngine(process.cwd());
	eng.clearCache();
}

/** Exported for tests — strip extension check, used internally. */
export function _isJsTsExt(filePath: string): boolean {
	return JS_TS_EXT.test(extname(filePath) ? filePath : "");
}
