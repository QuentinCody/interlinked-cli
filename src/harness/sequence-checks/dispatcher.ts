// Sequence-detector dispatch. The public functions here are the entry
// points consumed by `evaluator/pre-tool.ts` (PreToolUse phase) and
// `server/lifecycle-events.ts::buildStopWarnings` (Stop phase).
//
// Two invariants enforced by this layer:
//
//   1. **Detector failures are swallowed.** A detector that throws must
//      never break the harness. Parity with `quality-checks.ts` and
//      `stop-rescan.ts::appendFileFindings` — `try/catch` per detector,
//      drop the finding, continue.
//   2. **The trajectory passed in is read-only.** Detectors receive
//      `Readonly<SessionTrajectory>` per the type contract, but TypeScript
//      can't enforce that for inner Map/Set members. The dispatcher does
//      not freeze; the convention is documented in `types.ts` and any
//      future detector that mutates is a bug we'll catch in review.
//
// Configuration loading is deferred to the caller — the dispatcher takes a
// pre-resolved `enabled` predicate so the dispatch path is a pure function
// (cheaper to test, no fs I/O on the hot path).

import type { HarnessEvent, SessionTrajectory } from "../types.js";
import { recordUnavailableCheck } from "../check-unavailable.js";
import { ALL_SEQUENCE_DETECTORS } from "./registry.js";
import type {
	SequenceDetector,
	SequenceDetectorPhase,
	SequenceFinding,
} from "./types.js";

/**
 * Predicate that returns whether a detector should run. Defaults to
 * `(d) => d.default_enabled`. Pre-tool / Stop dispatch sites pass a config-
 * aware version that consults the user's `.interlinked` overrides.
 */
export type DetectorEnabledPredicate = (
	detector: SequenceDetector,
) => boolean;

// interlinked: defer code_clones -- false positive vs runSequenceDetectorsForPhase below; the heuristic over-matches on shared SequenceDetector token vocabulary.
/** The default predicate — runs only detectors with `default_enabled: true`. */
export const defaultDetectorEnabledPredicate: DetectorEnabledPredicate = (d) =>
	d.default_enabled;

/**
 * Run every enabled detector for the given phase against the
 * (trajectory, candidate) pair. Returns one `SequenceFinding` per match.
 * Detectors that throw retain unavailable execution evidence and do not block dispatch.
 */
export function runSequenceDetectorsForPhase(args: {
	phase: SequenceDetectorPhase;
	trajectory: Readonly<SessionTrajectory>;
	candidate: Readonly<HarnessEvent>;
	isEnabled?: DetectorEnabledPredicate;
}): SequenceFinding[] {
	const { phase, trajectory, candidate } = args;
	const isEnabled = args.isEnabled ?? defaultDetectorEnabledPredicate;
	const out: SequenceFinding[] = [];
	for (const detector of ALL_SEQUENCE_DETECTORS) {
		if (detector.phase !== phase) continue;
		if (!isEnabled(detector)) continue;
		let matches: ReturnType<SequenceDetector["fn"]>;
		try {
			matches = detector.fn(trajectory, candidate);
		} catch (error) {
			recordUnavailableCheck({ cwd: candidate.cwd ?? trajectory.project_root ?? process.cwd(), event: candidate, check: detector.id, error });
			// Per the invariant above — a buggy detector cannot break dispatch.
			continue;
		}
		for (const match of matches) {
			out.push({
				detector_id: detector.id,
				family: detector.family,
				phase: detector.phase,
				match,
			});
		}
	}
	return out;
}

/**
 * Format a SequenceFinding into the agent-visible warning string the
 * harness sends back over the socket. Mirror of how the per-file content
 * detectors render — leading `[interlinked:sequence]` tag plus a
 * deterministic-tag (`[proven]`) because sequence detectors are always
 * `fully_deterministic`. Evidence snippets, when present, render on
 * separate lines.
 */
export function formatSequenceFinding(finding: SequenceFinding): string {
	const { detector_id, match } = finding;
	const tag = "[interlinked:sequence]";
	const prove = "[proven]";
	const lines: string[] = [`${tag} ${prove} ${detector_id}: ${match.message}`];
	if (match.prior_summary) {
		lines.push(`  context: ${match.prior_summary}`);
	}
	if (match.evidence?.length) {
		for (const e of match.evidence) {
			lines.push(`  evidence: ${e}`);
		}
	}
	return lines.join("\n");
}
