// ===========================================
// Trajectory LTL — shadow adapter for the trajectory engine
// ===========================================
//
// `evaluateLtlShadow` is the one call `trajectory/index.ts` makes after the
// hand-coded rules. It keeps one `Monitor` per `TrajectoryState` object (a
// WeakMap: the engine owns the state's lifetime and bounds the session count)
// and turns formula violations into `silent_metric` verdicts with an `ltl:`
// prefix, so the capture ledger can be joined against the hand-coded verdict
// for the same event. It never blocks, never nudges, never throws.
//
// A Stop event is not a tool call, so it is not stepped; instead the monitor's
// end-of-trace fold is read (non-destructively — the session may continue) and
// every property whose STRONG obligation is still open is reported `unknown`.

import type { ToolEvent, TrajectoryState, Verdict } from "../types.js";
import { type AtomEvidence, type EndReport, type LtlViolation, Monitor } from "./eval.js";
import { LTL_SHADOW_PROPERTIES } from "./rules.js";

type TrajectoryMonitor = Monitor<TrajectoryState, ToolEvent>;

const monitors = new WeakMap<TrajectoryState, TrajectoryMonitor>();

function monitorFor(state: TrajectoryState): TrajectoryMonitor {
	const existing = monitors.get(state);
	if (existing) return existing;
	const fresh = new Monitor<TrajectoryState, ToolEvent>(LTL_SHADOW_PROPERTIES);
	monitors.set(state, fresh);
	return fresh;
}

function renderEvidence(a: AtomEvidence): string {
	const threw = a.error === undefined ? "" : ` (threw: ${a.error})`;
	return `${a.negated ? "¬" : ""}${a.name}=${a.value}${threw} [reads: ${a.reads.join(", ")}]`;
}

function violationVerdict(v: LtlViolation): Verdict {
	return {
		ruleId: `ltl:${v.property}`,
		action: "silent_metric",
		severity: "low",
		reason: `formula violated — onset #${v.onset}, confirmed #${v.at}; evidence: ${v.evidence.map(renderEvidence).join("; ")}`,
	};
}

function endOfTraceVerdict(r: EndReport): Verdict {
	return {
		ruleId: `ltl:${r.id}`,
		action: "silent_metric",
		severity: "low",
		reason: r.unavailable ? `NOT CHECKED: LTL property unavailable: ${r.unavailable}`
            : `end of trace: ${r.verdict} — a strong obligation (eventually / until / next) is still open; this is unknown, not a pass`,
	};
}

/**
 * Evaluate every shadow property against one engine event. Returns `[]` when
 * nothing fired, when the hook kind carries no tool call, or on any internal
 * error (fail-open — shadow telemetry never disrupts the tool loop).
 */
export function evaluateLtlShadow(state: TrajectoryState, event: ToolEvent): Verdict[] {
	try {
		const monitor = monitorFor(state);
		if (event.hook === "Stop") {
			return monitor
				.end()
				.filter((r) => r.leaning === "unknown")
				.map(endOfTraceVerdict);
		}
		if (event.hook !== "PreToolUse" && event.hook !== "PostToolUse") return [];
		return monitor.step(state, event).flatMap((r) => r.unavailable
            ? [{ ruleId: `ltl:${r.id}`, action: "silent_metric" as const, severity: "low" as const,
                reason: `NOT CHECKED: LTL property unavailable: ${r.unavailable}` }]
            : r.violations.map(violationVerdict));
	} catch (error) {
		return [{ ruleId: "ltl:unavailable", action: "silent_metric", severity: "low",
			reason: `NOT CHECKED: LTL evaluation failed: ${error instanceof Error ? error.message : String(error)}` }];
	}
}
