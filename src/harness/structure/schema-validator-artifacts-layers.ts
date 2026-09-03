// ===========================================
// Layer-rules validator (extracted from schema-validator-artifacts.ts)
// ===========================================
// Validates one `layers.rules[i]` entry: shape + `from` / `cannot_import`
// layer-ID references + `reason` length. Split into its own module so the
// caller's loop body doesn't count toward that file's cognitive complexity
// or push it over the per-file line cap.

import type { JsonObject } from "../../lib/json-types.js";
import type { ValidationError } from "./schema-validator-helpers.js";
import { checkUnknownKeys, err } from "./schema-validator-helpers.js";

export function validateLayerRuleEntry(
	r: JsonObject,
	rp: string,
	layerIds: Set<string>,
	errors: ValidationError[],
): void {
	errors.push(...checkUnknownKeys(r, ["from", "cannot_import", "reason"], rp));

	if (typeof r.from !== "string") errors.push(err(`${rp}.from`, "Must be a string"));
	else if (layerIds.size > 0 && !layerIds.has(r.from)) {
		errors.push(err(`${rp}.from`, `References undeclared layer "${r.from}"`));
	}

	if (!Array.isArray(r.cannot_import)) {
		errors.push(err(`${rp}.cannot_import`, "Must be an array"));
	} else {
		for (const ci of r.cannot_import as string[]) {
			if (layerIds.size > 0 && !layerIds.has(ci)) {
				errors.push(err(`${rp}.cannot_import`, `References undeclared layer "${ci}"`));
			}
		}
	}

	if (typeof r.reason !== "string" || r.reason.length === 0) {
		errors.push(err(`${rp}.reason`, "Must be a non-empty string"));
	} else if (r.reason.length > 160) {
		errors.push(err(`${rp}.reason`, "Should be under 160 characters"));
	}
}
