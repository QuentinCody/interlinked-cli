// Warnings and project-specific rules: mix of pre_warn (fully-deterministic
// or low-FP) and post (heuristic) phases. A handful of severity=error entries
// (focused_tests, migration_ordering, and several Plan 04 D.1 UBS entries)
// live here because they sit alongside related project rules rather than the
// pure correctness checks in entries-errors.ts.
//
// The entry definitions are split across cohesive submodules under
// `entries-warnings/` to keep each file well under the 1500-line cap. This
// file concatenates them in their original declaration order so `WARNING_ENTRIES`
// — and therefore `CHECK_REGISTRY` — is byte-for-byte equivalent to the
// pre-split single-file version. The submodule arrays are re-exported below so
// consumers can import either the combined array or a focused subset.

import { AGENT_CLARITY_ENTRIES } from "./entries-warnings/agent-clarity.js";
import { AGENT_LAZINESS_ENTRIES } from "./entries-warnings/agent-laziness.js";
import { BOUNDARY_CONTRACT_ENTRIES } from "./entries-warnings/boundary-contracts.js";
import { CODE_QUALITY_ENTRIES } from "./entries-warnings/code-quality.js";
import { ENDPOINT_SECURITY_ENTRIES } from "./entries-warnings/endpoint-security.js";
import { HTML_ENTRIES } from "./entries-warnings/html.js";
import { PORTABILITY_ENTRIES } from "./entries-warnings/portability.js";
import { QUALITY_FRONTIER_ENTRIES } from "./entries-warnings/quality-frontier.js";
import { SPEC_STRUCTURE_ENTRIES } from "./entries-warnings/spec-structure.js";
import { TEST_AND_DEMO_ENTRIES } from "./entries-warnings/test-and-demo.js";
import { TEST_DISCRIMINATION_ENTRIES } from "./entries-warnings/test-discrimination.js";
import { TYPE_DISCIPLINE_ENTRIES } from "./entries-warnings/type-discipline.js";
import { UBS_ENTRIES } from "./entries-warnings/ubs-checks.js";
import type { CheckRegistration } from "./types.js";

export {
	AGENT_CLARITY_ENTRIES,
	AGENT_LAZINESS_ENTRIES,
	BOUNDARY_CONTRACT_ENTRIES,
	CODE_QUALITY_ENTRIES,
	ENDPOINT_SECURITY_ENTRIES,
    HTML_ENTRIES,
	PORTABILITY_ENTRIES,
	QUALITY_FRONTIER_ENTRIES,
	SPEC_STRUCTURE_ENTRIES,
	TEST_AND_DEMO_ENTRIES,
	TEST_DISCRIMINATION_ENTRIES,
	TYPE_DISCIPLINE_ENTRIES,
	UBS_ENTRIES,
};

export const WARNING_ENTRIES: CheckRegistration[] = [
	...AGENT_CLARITY_ENTRIES,
	...CODE_QUALITY_ENTRIES,
	...UBS_ENTRIES,
	...AGENT_LAZINESS_ENTRIES,
	...TEST_AND_DEMO_ENTRIES,
	...TEST_DISCRIMINATION_ENTRIES,
	...ENDPOINT_SECURITY_ENTRIES,
    ...HTML_ENTRIES,
	...QUALITY_FRONTIER_ENTRIES,
	...SPEC_STRUCTURE_ENTRIES,
	...TYPE_DISCIPLINE_ENTRIES,
	...PORTABILITY_ENTRIES,
	...BOUNDARY_CONTRACT_ENTRIES,
];
