// Over-extraction per-file check (2026-09-03): the counterweight to the
// complexity caps. A separate module for the same reason as
// `file-checks-type-redundancy.ts` — both of its natural homes are at a cap
// (`runAgentSafetyChecks` is over the function-token cap and
// file-checks-agent-safety.ts is at the file line cap). Called from
// `collectPerFileFindings` alongside `runAgentSafetyChecks`.

import { checkSingleUseTrivialHelper } from "../../harness/checks/over-extraction.js";
import type { FileCheckContext } from "./file-checks-shared.js";
import { toIssues } from "./file-checks-shared.js";

export function runOverExtractionChecks(ctx: FileCheckContext): void {
	const { content, file, relPath, r } = ctx;
	r.singleUseTrivialHelper.push(
		...toIssues("single_use_trivial_helper", relPath, checkSingleUseTrivialHelper(content, file)),
	);
}
