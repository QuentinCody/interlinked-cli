// ===========================================
// Diff-Overlay Pre-Block
// ===========================================
// Runs toolchain linters (biome + tsc) against the *proposed* file content
// before the write lands, compared against the cached diagnostics for the
// on-disk file. The overlay returns the set of findings that are net-new in
// the proposed content so the evaluator can block the write with a targeted
// reason.

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { getOrCreateEngine } from "./check-engine/index.js";
import type { BiomeOverlayOutcome } from "./check-engine/tool-runners/biome.js";
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
export const BIOME_CHECKER_UNAVAILABLE_CODE = "biome-overlay-unavailable";

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
		proposedFindings: null,
		elapsedMs: 0,
		exceededBudget: false,
	};

	if (!JS_TS_EXT.test(filePath)) return empty;

	const snapshot = diskSnapshotOf(filePath);
	if (snapshot === undefined) return { ...empty, checkerUnavailable: "Biome baseline could not be read" };
	if (unchangedInContext(snapshot, proposedContent, undefined)) return empty;
	const engine = getOrCreateEngine(projectRoot);
	const start = Date.now();
	// Both sides use the same analyzer; a cache miss is not a clean baseline.
	const baseline: BiomeOverlayOutcome = snapshot.existsOnDisk
		? engine.getBiomeDiagnosticsForOverlayTyped(filePath, snapshot.onDisk, BIOME_BUDGET_MS)
		: { status: "ok", findings: [] };
	if (baseline.status !== "ok") return biomeOverlayResult(baseline, [], start);
	const overlay = engine.getBiomeDiagnosticsForOverlayTyped(
		filePath,
		proposedContent,
		BIOME_BUDGET_MS,
	);
	return biomeOverlayResult(overlay, baseline.findings, start);
}

/** Each old occurrence pays for exactly one proposed occurrence. */
function introducedDiagnostics(proposed: CheckResult[], baseline: CheckResult[]): CheckResult[] {
	const allowances = new Map<string, number>();
	for (const finding of baseline) {
		const key = diagKey(finding);
		allowances.set(key, (allowances.get(key) ?? 0) + 1);
	}
	return proposed.filter((finding) => {
		const key = diagKey(finding);
		const remaining = allowances.get(key) ?? 0;
		if (remaining === 0) return true;
		allowances.set(key, remaining - 1);
		return false;
	});
}

function biomeOverlayResult(outcome: BiomeOverlayOutcome, baseline: CheckResult[], start: number): DiffOverlayResult {
	const elapsedMs = Date.now() - start;
	const timing = { elapsedMs, exceededBudget: elapsedMs > BIOME_BUDGET_MS };
	if (outcome.status === "unavailable") {
		return { ...timing, newFindings: [], proposedFindings: null, checkerUnavailable: outcome.reason };
	}
	if (outcome.status === "skipped") return { ...timing, newFindings: [], proposedFindings: null };
	return {
		...timing,
		newFindings: introducedDiagnostics(outcome.findings, baseline),
		proposedFindings: outcome.findings,
	};
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
export function _isRelativeModuleNotFound(f: Pick<CheckResult, "message">): boolean {
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
 * Pre-edit snapshot via LS overlay against disk content, recomputed on EVERY
 * evaluation. It used to be cached by the file's path and mtime, but a
 * dependency can change this file's disk diagnostics without touching either:
 * once a repair landed, reintroducing the same error read as pre-existing
 * (session review r6, finding 1). The baseline must describe the current
 * pre-change tree; the LanguageService behind it is incremental, so the
 * recomputation is cheap.
 */
function preEditTscBaseline(
	engine: ReturnType<typeof getOrCreateEngine>,
	filePath: string,
	onDisk: string,
): PreEditTscBaseline {
	const preOutcome = engine.getTscDiagnosticsForOverlayTyped(filePath, onDisk);
	if (preOutcome.status === "unavailable") {
		return { status: "unavailable", reason: preOutcome.reason };
	}
	// "skipped" (non-TS file / mode off): nothing to diff — the check
	// deliberately does not apply here, distinct from checked-clean.
	if (preOutcome.status === "skipped") return { status: "skipped" };
	return { status: "ok", findings: preOutcome.findings };
}

interface DiskSnapshot {
	readonly existsOnDisk: boolean;
	/** "" when the file is not on disk. */
	readonly onDisk: string;
}

/** The target's disk bytes; undefined when it cannot be read as text (a
 *  directory) — nothing to diff then. */
function diskSnapshotOf(filePath: string): DiskSnapshot | undefined {
	if (!existsSync(filePath)) return { existsOnDisk: false, onDisk: "" };
	try {
		return { existsOnDisk: true, onDisk: readFileSync(filePath, "utf-8") };
	} catch {
		return undefined;
	}
}

/** The unchanged-text shortcut holds only while nothing AROUND the file
 *  changed either: a sibling the batch proposes can break this file's types
 *  with its own bytes untouched (session review r5, finding 2). */
function unchangedInContext(
	snapshot: DiskSnapshot,
	proposedContent: string,
	siblings: ReadonlyArray<unknown> | undefined,
): boolean {
	return (
		snapshot.existsOnDisk &&
		snapshot.onDisk === proposedContent &&
		(siblings === undefined || siblings.length === 0)
	);
}

/**
 * Evaluate whether the proposed overlay content introduces new tsc
 * diagnostics relative to the file on disk.
 *
 * - Uses the TypeScript LanguageService (via tsc-overlay runner) for both
 *   the pre-edit and proposed snapshots to ensure identical diagnostic
 *   semantics on both sides of the diff.
 * - Recomputes the pre-edit baseline on every evaluation: a dependency can
 *   change this file's diagnostics without touching its bytes or mtime
 *   (session review r6, finding 1).
 * - New-file Writes use an empty baseline, so proposed diagnostics are new.
 * - An unchanged file beside CHANGED siblings is still judged, against them
 *   (`unchangedInContext`).
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

	if (!isTscOverlayTarget(filePath)) return empty;

	const snapshot = diskSnapshotOf(filePath);
	if (snapshot === undefined) return { ...empty, checkerUnavailable: "TypeScript baseline could not be read" };
	if (unchangedInContext(snapshot, proposedContent, siblings)) return empty;
	const { existsOnDisk, onDisk } = snapshot;

	const engine = getOrCreateEngine(projectRoot);

	let preEdit: CheckResult[] = [];
	if (existsOnDisk) {
		const baseline = preEditTscBaseline(engine, filePath, onDisk);
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

	const newFindings = introducedDiagnostics(overlay, preEdit);

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

/** The files the tsc overlay judges at all: TypeScript sources. JavaScript and
 *  everything else are outside it, so a "not type-checked" disclosure about
 *  them would describe a check that never applies. */
export function isTscOverlayTarget(filePath: string): boolean {
	return TS_OVERLAY_EXT.test(filePath);
}

/** Exported for tests — strip extension check, used internally. */
export function _isJsTsExt(filePath: string): boolean {
	return JS_TS_EXT.test(extname(filePath) ? filePath : "");
}
