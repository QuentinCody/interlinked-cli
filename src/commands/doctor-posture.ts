import { isJsonObject } from "../lib/json-types.js";
// ===========================================
// doctor — posture-enum configuration findings
// ===========================================
// Split from doctor-hook-drift.ts (review 2026-08-30 final pass: the combined
// module coupled the installer-safety commit bundle to the mode/config bundle
// through one import). This file belongs WITH the mode/config feature.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { postureEnumViolationsIn } from "../harness/rules/merge.js";
import type { CheckResult } from "./doctor-checks.js";

/** Invalid posture-enum values, per guard-rules file. Examines the RAW file
 *  section via the ONE shared validator (review 2026-08-30 third pass: an
 *  earlier version ran the file through mergeTeamRules first, which DROPS
 *  invalid values — so three bad team enums produced zero findings). The
 *  loader replaces each invalid value with its built-in default; this check
 *  is where the user learns which file, field, and value were bad. */
export function postureEnumChecks(cwd: string): CheckResult[] {
	const out: CheckResult[] = [];
	for (const file of ["guard-rules.json", "guard-rules.local.json"] as const) {
		const path = join(cwd, ".interlinked", file);
		if (!existsSync(path)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			continue; // malformed files have their own findings elsewhere
		}
		const structural =
			isJsonObject(parsed)
				? parsed.structural_checks
				: undefined;
		for (const violation of postureEnumViolationsIn(structural)) {
			out.push({
				name: "Posture enum",
				status: "warn",
				// violation.value is already JSON-rendered by the validator.
				message: `${path}: structural_checks.${violation.field} = ${violation.value} is not a valid value — the built-in default applies until it is fixed`,
			});
		}
	}
	return out;
}
