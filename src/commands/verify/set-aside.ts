// ===========================================
// Verify file population — source roles decide what content checks read
// ===========================================
// A file that source roles classify as generated, vendor or asset (path, tool-path, repository linter exclude, minified
// shape) is not given to the content checks. The role evidence is the one that `metrics score` uses (`decideRole`);
// the self-declared generated markers that verify already honoured (`verifyInputExclusion`) join them as marker evidence.
// Each such file goes into the run's `set_aside` block with its role and evidence, so the output says what was not read.

import { relative } from "node:path";
import { decideRole } from "../../lib/metrics/role-population.js";
import type { SetAsideRow } from "./scan-ledger.js";
import { verifyInputExclusion } from "./input-budget.js";

const SET_ASIDE_ROLES: ReadonlySet<string> = new Set(["generated", "vendor", "asset", "unlinted"]);

/** The set-aside row for a file, or null when its content checks should run. `file` may be absolute or relative to `cwd`. */
export function classifySetAside(cwd: string, file: string, content: string): SetAsideRow | null {
	const rel = relative(cwd, file).replaceAll("\\", "/");
	const decision = decideRole(rel, content, cwd);
	// An `asset` with no evidence is only a file type that no language table lists (html, css, txt, svg): verify has
	// content checks for several of those, so it reads them. Only evidence (path, tool-path, tool-config, shape) sets a file aside.
	if (SET_ASIDE_ROLES.has(decision.role) && decision.evidence !== null) {
		return {
			file: rel,
			role: decision.role,
			evidence_kind: decision.evidence?.kind ?? "path",
			evidence_detail: decision.evidence?.detail ?? decision.role,
			bytes: Buffer.byteLength(content),
		};
	}
	const marker = verifyInputExclusion(content);
	if (marker === null) return null;
	return { file: rel, role: "generated", evidence_kind: "marker", evidence_detail: marker, bytes: Buffer.byteLength(content) };
}
