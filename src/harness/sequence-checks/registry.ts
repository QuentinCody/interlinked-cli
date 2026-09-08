// Central registry of all sequence detectors. New detectors register here.
// Imported by the dispatcher (this directory's `dispatcher.ts`) and by the
// `interlinked trajectory` inspection commands.
//
// As detectors land, this file stays the single concatenation point. We do
// not split into `entries-warnings.ts` / `entries-errors.ts` yet — sequence
// detectors are dispatched together regardless of severity, and the per-phase
// filter happens at call time, not at registry-construction time.

import { CROSS_AGENT_DETECTORS } from "./cross-agent.js";
import { INJECTION_DETECTORS } from "./injection.js";
import { QUALITY_DETECTORS } from "./quality.js";
import { SECURITY_DETECTORS } from "./security.js";
import type { SequenceDetector } from "./types.js";

/**
 * All registered sequence detectors. Order is not load-bearing; the
 * dispatcher filters by phase and runs each entry independently.
 *
 * To add a detector:
 *   1. Implement under `sequence-checks/<family>/<id>.ts`.
 *   2. Export the `SequenceDetector` literal.
 *   3. Import + append it to this array.
 *   4. Add ≥3 positive + ≥3 negative tests as a sibling `.test.ts`.
 *   5. Run `npx vitest run src/harness/sequence-checks/` to validate.
 */
export const ALL_SEQUENCE_DETECTORS: ReadonlyArray<SequenceDetector> = [
	...QUALITY_DETECTORS,
	...SECURITY_DETECTORS,
	...INJECTION_DETECTORS,
	...CROSS_AGENT_DETECTORS,
];

/** Lookup a detector by id. Returns `undefined` if no detector with that id is registered. */
export function getSequenceDetectorById(id: string): SequenceDetector | undefined {
	return ALL_SEQUENCE_DETECTORS.find((d) => d.id === id);
}
