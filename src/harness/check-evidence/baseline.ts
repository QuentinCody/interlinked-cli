import { isJsonObject } from "../../lib/json-types.js";
// Check Evidence Contract — the committed grandfather baseline.
//
// Spec: docs/design/verification-density-program.md (Phase 1).
//
// The list records checks that predate the contract and do not yet meet their
// tier's obligation. It is an EXEMPTION list, so the tighten direction is
// SHRINK: removing an entry tightens the gate, adding one loosens it. That
// makes it a baseline-integrity-gate file of the same species as
// `untested-files-baseline.json` — the agent being gated can write it, so
// "just add my check to the exempt list" is the canonical gaming move.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CheckEvidenceBaseline,
	EVIDENCE_DIMENSIONS,
	type EvidenceDimension,
} from "./types.js";

/** Repo-relative path of the committed baseline. */
export const CHECK_EVIDENCE_BASELINE_PATH = ".interlinked/check-evidence-baseline.json";

/** An absent or unreadable baseline means NO exemptions — fail closed. */
export const EMPTY_BASELINE: CheckEvidenceBaseline = { exempt: [] };

/** Narrow the `enforced` field, dropping unrecognized dimension names. */
function parseEnforced(raw: unknown): EvidenceDimension[] | null {
	if (!Array.isArray(raw)) return null;
	const known = new Set<string>(EVIDENCE_DIMENSIONS);
	return raw.filter((d): d is EvidenceDimension => typeof d === "string" && known.has(d));
}

/** Narrow unknown JSON to the baseline shape, discarding anything malformed. */
export function parseBaseline(raw: unknown): CheckEvidenceBaseline {
	if (!isJsonObject(raw)) return EMPTY_BASELINE;
	const exempt = raw.exempt;
	if (!Array.isArray(exempt)) return EMPTY_BASELINE;
	const note = raw.note;
	const enforced = parseEnforced(raw.enforced);
	return {
		exempt: exempt.filter((e): e is string => typeof e === "string"),
		...(enforced ? { enforced } : {}),
		...(typeof note === "string" ? { note } : {}),
	};
}

/**
 * Load the baseline from a repo root.
 *
 * Fails closed (empty exemption list) on a missing or malformed file: a
 * corrupt baseline must not silently exempt every check.
 */
export function loadCheckEvidenceBaseline(repoRoot: string): CheckEvidenceBaseline {
	const path = join(repoRoot, CHECK_EVIDENCE_BASELINE_PATH);
	if (!existsSync(path)) return EMPTY_BASELINE;
	try {
		return parseBaseline(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return EMPTY_BASELINE;
	}
}

/**
 * Dimensions the pin currently fails on.
 *
 * Absent `enforced` means the Phase 1 landing state (`cases` only) rather than
 * "nothing" — a baseline that predates the field must not silently disable the
 * obligation it was written to hold.
 */
export function enforcedDimensions(baseline: CheckEvidenceBaseline): readonly EvidenceDimension[] {
	return baseline.enforced ?? ["cases"];
}

/** The exemption list as a set, for O(1) membership during a sweep. */
export function exemptSet(baseline: CheckEvidenceBaseline): ReadonlySet<string> {
	return new Set(baseline.exempt);
}
