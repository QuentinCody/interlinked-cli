// Type-redundancy per-file checks (2026-09-01 dead-code campaign): dead type
// exports + duplicate type declarations. A separate module because both of its
// natural homes are at a cap — `runAgentSafetyChecks` is over the
// function-token cap and file-checks-agent-safety.ts is at the file line cap.
// Called from `collectPerFileFindings` alongside `runAgentSafetyChecks`.

import { checkDeadTypeExports } from "../../harness/checks/dead-exports-inline.js";
import { checkDuplicateTypeDeclaration } from "../../harness/checks/type-redundancy.js";
import type { FileCheckContext } from "./file-checks-shared.js";
import { toIssues } from "./file-checks-shared.js";

export function runTypeRedundancyChecks(ctx: FileCheckContext): void {
	const { content, file, relPath, cwd, r } = ctx;
	r.deadTypeExports.push(
		...toIssues("dead_type_exports", relPath, checkDeadTypeExports(content, file, cwd)),
	);
	r.duplicateTypeDeclaration.push(
		...toIssues(
			"duplicate_type_declaration",
			relPath,
			checkDuplicateTypeDeclaration(content, file, cwd),
		),
	);
}
