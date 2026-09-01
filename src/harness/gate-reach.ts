// ===========================================
// Gate reach — measuring the measurement (plan 16 §4)
// ===========================================
// Every ratchet in this repo silently defines its own scope, and until now
// nothing reported what fell OUTSIDE it. Two blind spots found in one day
// (2026-07-29/30), both silent, both in systems that were reporting success:
//
//   - the mutation manifest omitted every mutant outside a function symbol
//     (104 recorded vs 117 live on unchanged source), so those survivors could
//     never be recorded, ratcheted, blocked or annotated;
//   - `per_edit_coverage` was disabled outright for a performance reason nobody
//     revisited, so the per-edit affected-test run everyone assumed was
//     happening was not running at all.
//
// A harness that promises "never worse on any measurable dimension" while
// silently not measuring parts of the tree produces FALSE CONFIDENCE, which is
// strictly worse than a harness that admits its scope. This module is the
// admission: one per-gate figure of the shape
//
//   gate=mutation   eligible_files=1013 measured=679 skipped_no_tests=290 unmeasured=44
//   gate=coverage   eligible_files=1013 measured=0   disabled=true
//
// Everything here is PURE — plain records in, records/strings out. No fs, no
// clock, no config. The fs half (eligible-file enumeration, the ledger under
// `.interlinked/`, the Stop wiring) lives in `gate-reach-collect.ts`, so the
// arithmetic that decides whether a gate is lying can be tested in isolation.
//
// This is REPORTING, not enforcement: nothing here blocks, and nothing here
// runs on a PreToolUse hook.

/** What a gate counts. Most gates count files; the cyclomatic/CRAP family
 *  counts functions, so the rendered key is `eligible_fns` rather than
 *  `eligible_files`. */
type GateReachUnit = "files" | "fns";

/**
 * Why a gate's figure looks the way it does. The three states are deliberately
 * NOT collapsible into "measured N":
 *   - `measured`            — the gate ran; `measured`/`eligible` is its reach.
 *   - `disabled`            — the gate is switched off. Reach is zero AND that
 *                             zero is a policy decision someone made, so it
 *                             must be said out loud rather than rendered as an
 *                             unremarkable 0.
 *   - `source_unavailable`  — the gate may well be running, but the artifact
 *                             this module reads to learn what it measured is
 *                             missing/unreadable. Reporting `measured=0` as
 *                             fact here would invent exactly the false
 *                             confidence the module exists to remove.
 */
type GateReachStatus = "measured" | "disabled" | "source_unavailable";

/** Caller-supplied raw figures for one gate. Every count is validated and
 *  clamped by {@link computeGateReach} — callers may pass whatever their
 *  source gave them. */
export interface GateReachInput {
	/** Stable gate id, e.g. `coverage_ratchet`, `per_edit_coverage`, `mutation`. */
	gate: string;
	/** Default `files`. */
	unit?: GateReachUnit;
	/** Size of the gate's domain, derived from the ONE product-code definition
	 *  (`large-file-policy.ts::isCappableFile`) so gates cannot disagree about
	 *  scope — that disagreement is half the problem this module reports on. */
	eligible: number;
	/** How much of the domain the gate actually has a measurement for. */
	measured: number;
	/** Domain members deliberately not measured, bucketed by REASON
	 *  (`{ no_tests: 290 }`). A named skip is honest; an unnamed one shows up
	 *  as `unmeasured`, which is the number that should worry a reader. */
	skipped?: Record<string, number>;
	/** The gate is switched off. Forces `measured` to 0 and status `disabled`. */
	disabled?: boolean;
	/** The gate's measurement record could not be read. Forces `measured` to 0
	 *  and status `source_unavailable`. */
	sourceUnavailable?: boolean;
	/** Short token explaining `disabled` / `sourceUnavailable`. Whitespace is
	 *  collapsed to `_` so the rendered line stays a parseable `k=v` sequence. */
	reason?: string;
}

/** One gate's validated coverage-of-itself. */
interface GateReach {
	gate: string;
	unit: GateReachUnit;
	status: GateReachStatus;
	eligible: number;
	measured: number;
	skipped: Record<string, number>;
	/** `eligible - measured - Σskipped`, floored at 0. The blind spot. */
	unmeasured: number;
	/** `measured / eligible` in [0,1]. **Zero when `eligible` is zero** — an
	 *  enumerator that found nothing must never read as perfect reach. */
	reach: number;
	reason?: string;
}

/** One session's figures for every gate reported. */
export interface GateReachSnapshot {
	version: 1;
	/** ISO timestamp. */
	at: string;
	session_id: string;
	gates: GateReach[];
}

/** A gate whose reach got WORSE since the previous recorded snapshot. Plan 16
 *  §4 calls for ratcheting the meta-metric itself: "a change that shrinks a
 *  gate's reach is a regression even if every other number improves." Reported,
 *  never blocked — this module is instrumentation. */
interface GateReachRegression {
	gate: string;
	kind: "reach_dropped" | "stopped_measuring";
	previous: number;
	current: number;
	previousStatus: GateReachStatus;
	currentStatus: GateReachStatus;
}

/**
 * How far reach may fall before it counts as a regression (2 percentage
 * points). Not zero: `eligible` grows every time a source file is added, so a
 * strict "may only rise" comparison would fire on every session that created a
 * file the last full coverage run never saw. A gate losing 2pp of the tree is a
 * real loss of reach; one new file is noise. Status transitions
 * (measured → disabled) bypass the band entirely — those are never noise.
 */
export const REACH_REGRESSION_TOLERANCE = 0.02;

const DEFAULT_UNIT: GateReachUnit = "files";

/** Floor a caller-supplied count at 0 and reject NaN/Infinity. Sources here are
 *  file walks and JSON artifacts, both of which can hand back nonsense. */
function safeCount(n: number): number {
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Collapse whitespace so a reason stays one `k=v` token on the rendered line. */
function safeReason(reason: string | undefined): string | undefined {
	if (reason === undefined) return undefined;
	const collapsed = reason.trim().replace(/\s+/g, "_");
	return collapsed === "" ? undefined : collapsed;
}

function statusFor(input: GateReachInput): GateReachStatus {
	// `disabled` wins: "someone turned it off" is a more actionable fact than
	// "its record is missing", and a disabled gate writes no record anyway.
	if (input.disabled === true) return "disabled";
	if (input.sourceUnavailable === true) return "source_unavailable";
	return "measured";
}

/** Drop empty/invalid skip buckets so the rendered line carries only real ones. */
function normalizeSkipped(skipped: Record<string, number> | undefined): Record<string, number> {
	const out: Record<string, number> = {};
	if (!skipped) return out;
	for (const [reason, raw] of Object.entries(skipped)) {
		const count = safeCount(raw);
		if (count > 0) out[reason] = count;
	}
	return out;
}

function sumValues(counts: Record<string, number>): number {
	let total = 0;
	for (const value of Object.values(counts)) total += value;
	return total;
}

/**
 * Validate one gate's raw figures into a `GateReach`.
 *
 * Invariants worth stating, because each one exists to stop a specific way of
 * lying with this number:
 *   - a non-`measured` status forces `measured` to 0 — a gate that is off or
 *     unreadable has measured nothing, whatever the caller passed;
 *   - `measured` is clamped to `eligible` — a gate cannot cover more than its
 *     own domain (a stale record naming deleted files would otherwise inflate
 *     reach past 100%);
 *   - `reach` is 0 when `eligible` is 0 — an enumerator that found no files
 *     must not report as fully covered.
 */
export function computeGateReach(input: GateReachInput): GateReach {
	const status = statusFor(input);
	const eligible = safeCount(input.eligible);
	const measured = status === "measured" ? Math.min(safeCount(input.measured), eligible) : 0;
	const skipped = normalizeSkipped(input.skipped);
	const unmeasured = Math.max(0, eligible - measured - sumValues(skipped));
	const reason = safeReason(input.reason);
	return {
		gate: input.gate,
		unit: input.unit ?? DEFAULT_UNIT,
		status,
		eligible,
		measured,
		skipped,
		unmeasured,
		reach: eligible === 0 ? 0 : measured / eligible,
		...(reason !== undefined ? { reason } : {}),
	};
}

/** Compute every gate and stamp the result with session + time. */
export function buildGateReachSnapshot(args: {
	sessionId: string;
	/** Epoch ms or a Date — the caller owns the clock so this stays pure. */
	at: number | Date;
	inputs: GateReachInput[];
}): GateReachSnapshot {
	return {
		version: 1,
		at: new Date(args.at).toISOString(),
		session_id: args.sessionId,
		gates: args.inputs.map(computeGateReach),
	};
}

function formatPct(fraction: number): string {
	return `${(fraction * 100).toFixed(1)}%`;
}

/** The documented one-line figure for a single gate. */
export function formatGateReachLine(reach: GateReach): string {
	const parts = [
		`gate=${reach.gate}`,
		`eligible_${reach.unit}=${reach.eligible}`,
		`measured=${reach.measured}`,
	];
	// Sorted so two runs with the same buckets render byte-identically.
	for (const bucket of Object.keys(reach.skipped).sort()) {
		parts.push(`skipped_${bucket}=${reach.skipped[bucket]}`);
	}
	parts.push(`unmeasured=${reach.unmeasured}`);
	if (reach.status === "disabled") parts.push("disabled=true");
	else if (reach.status === "source_unavailable") parts.push("measurement_source=unavailable");
	else parts.push(`reach=${formatPct(reach.reach)}`);
	if (reach.reason !== undefined) parts.push(`reason=${reach.reason}`);
	return parts.join(" ");
}

/** One line per gate, in snapshot order. */
export function formatGateReachLines(snapshot: GateReachSnapshot): string[] {
	return snapshot.gates.map(formatGateReachLine);
}

/**
 * Gates whose reach got worse since `previous`. Only gates present in BOTH
 * snapshots are compared: a gate reported for the first time has no water-line
 * to fall below, and a gate that stopped being reported at all is a wiring
 * change, not a reach change (and would otherwise fire on every refactor of
 * this module's own call sites).
 */
export function compareGateReach(
	previous: GateReach[],
	current: GateReach[],
): GateReachRegression[] {
	const before = new Map(previous.map((g) => [g.gate, g]));
	const regressions: GateReachRegression[] = [];
	for (const now of current) {
		const then = before.get(now.gate);
		if (then === undefined) continue;
		const kind = regressionKind(then, now);
		if (kind === null) continue;
		regressions.push({
			gate: now.gate,
			kind,
			previous: then.reach,
			current: now.reach,
			previousStatus: then.status,
			currentStatus: now.status,
		});
	}
	return regressions;
}

/** Which regression (if any) one gate suffered between two snapshots. */
function regressionKind(then: GateReach, now: GateReach): GateReachRegression["kind"] | null {
	if (then.status === "measured" && now.status !== "measured") return "stopped_measuring";
	if (now.reach < then.reach - REACH_REGRESSION_TOLERANCE) return "reach_dropped";
	return null;
}

/** One human line per regression. */
export function formatGateReachRegression(regression: GateReachRegression): string {
	if (regression.kind === "stopped_measuring") {
		return `gate=${regression.gate} STOPPED MEASURING (${regression.previousStatus} -> ${regression.currentStatus})`;
	}
	const deltaPp = ((regression.current - regression.previous) * 100).toFixed(1);
	return `gate=${regression.gate} reach fell ${formatPct(regression.previous)} -> ${formatPct(regression.current)} (${deltaPp}pp)`;
}

/** Headline naming the loudest problem in a snapshot, or null when there is
 *  none. Ordering is severity: a gate that is OFF outranks a gate whose record
 *  is missing, which outranks a gate that merely lost ground. */
function reportHeadline(snapshot: GateReachSnapshot, regressions: GateReachRegression[]): string | null {
	const disabled = snapshot.gates.filter((g) => g.status === "disabled");
	if (disabled.length > 0) {
		const noun = disabled.length === 1 ? "gate" : "gates";
		return `${disabled.length} quality ${noun} measured NOTHING this session — a gate that is off reports success by not looking.`;
	}
	const unavailable = snapshot.gates.filter((g) => g.status === "source_unavailable");
	if (unavailable.length > 0) {
		return `${unavailable.length} quality gate(s) could not be measured — the record of what they covered is missing, so their reach is unknown rather than zero.`;
	}
	if (regressions.length > 0) {
		return `${regressions.length} quality gate(s) shrank their reach since the last recorded session.`;
	}
	return null;
}

/**
 * The agent-facing block, or null when every gate measured and nothing
 * regressed. Silence is only correct in that one case: requirement (3) of plan
 * 16 §4 is that a gate reporting `disabled=true` must be LOUD, never a silent
 * zero.
 *
 * Every gate is listed, not just the failing one — the reach of the gates that
 * DID run is the context that makes a zero legible.
 */
export function formatGateReachReport(args: {
	snapshot: GateReachSnapshot;
	regressions: GateReachRegression[];
}): string | null {
	const headline = reportHeadline(args.snapshot, args.regressions);
	if (headline === null) return null;
	const lines = [`[interlinked:gate-reach] ${headline}`];
	for (const line of formatGateReachLines(args.snapshot)) lines.push(`  ${line}`);
	for (const regression of args.regressions) {
		lines.push(`  ! ${formatGateReachRegression(regression)}`);
	}
	lines.push(
		"  Re-enable the gate, widen its scope, or record why it is off — an unmeasured file is not a passing file.",
	);
	return lines.join("\n");
}
