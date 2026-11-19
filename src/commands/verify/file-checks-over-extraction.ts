// Over-extraction per-file check (2026-09-03): the counterweight to the
// complexity caps. A separate module for the same reason as
// `file-checks-type-redundancy.ts` — both of its natural homes are at a cap
// (`runAgentSafetyChecks` is over the function-token cap and
// file-checks-agent-safety.ts is at the file line cap). Called from
// `collectPerFileFindings` alongside `runAgentSafetyChecks`.

import { findDeadLiteralStores } from "../../harness/checks/dead-literal-store.js";
import { checkSingleUseTrivialHelper } from "../../harness/checks/over-extraction.js";
import { checkPythonSimplification } from "../../harness/checks/python-simplification.js";
import { checkRepeatedImplementation } from "../../harness/generic-checks.js";
import type { FileCheckContext } from "./file-checks-shared.js";
import { toIssues } from "./file-checks-shared.js";
import { checkExistingPartialOverlap } from "./partial-overlap-audit.js";
import { getActiveSkipChecks } from "./streaming-output.js";

export function runOverExtractionChecks(ctx: FileCheckContext): void {
	const { content, file, relPath, r } = ctx;
	if (!getActiveSkipChecks().has("extracted_helper_duplicate")) {
		r.extractedHelperDuplicate.push(...toIssues("extracted_helper_duplicate", relPath, checkExistingPartialOverlap, content, file, ctx.cwd));
	}
    r.pythonSimplification.push(...toIssues("python_simplification", relPath, checkPythonSimplification, content, file));
	if (ctx.repeatedImplementation !== undefined) r.repeatedImplementation.push(...toIssues("repeated_implementation", relPath, ctx.repeatedImplementation));
	else r.repeatedImplementation.push(...toIssues("repeated_implementation", relPath, checkRepeatedImplementation, content, file));
	r.singleUseTrivialHelper.push(
		...toIssues("single_use_trivial_helper", relPath, checkSingleUseTrivialHelper, content, file),
	);
	// dead_literal_store: judgment of metric redundancy.dead_stores (default gate, pre_warn).
	r.deadLiteralStore.push(...toIssues("dead_literal_store", relPath, findDeadLiteralStores, content, file));
}
