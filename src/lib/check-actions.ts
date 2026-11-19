import { buildActionInventory, type ActionInventory, type ActionObservation, type ActionSourceEvidence } from "./action-inventory.js";
import { isJsonObject, type JsonObject } from "./json-types.js";

function sourceEvidence(value: unknown): ActionSourceEvidence[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const sources: ActionSourceEvidence[] = [];
	for (const item of value) {
		if (!isJsonObject(item) || typeof item.file !== "string" || !item.file.trim()
			|| typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256)
			|| typeof item.line !== "number" || !Number.isSafeInteger(item.line) || item.line < 1
			|| (item.role !== "producer" && item.role !== "consumer")) continue;
		sources.push({ file: item.file, sha256: item.sha256, line: item.line, role: item.role });
	}
	return sources;
}

/** Preserve only supplied, well-formed evidence metadata. Never read current disk
 * contents to manufacture a historical source identity. */
function provenance(row: JsonObject): Partial<ActionObservation> {
	const retained: Partial<ActionObservation> = {};
	for (const key of ["sourceHash", "policyHash", "detectorHash", "observedAt", "subject", "actionKey"] as const) {
		if (typeof row[key] === "string" && row[key].trim()) retained[key] = row[key];
	}
	for (const key of ["column", "endLine", "endColumn", "startOffset", "endOffset"] as const) {
		const value = row[key];
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) retained[key] = value;
	}
	for (const key of ["evidenceRefs", "relatedLocations", "producerRefs"] as const) {
		const values = row[key];
		if (Array.isArray(values)) retained[key] = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
	}
	if (typeof row.suppressed === "boolean") retained.suppressed = row.suppressed;
	if (typeof row.suppression === "string" || row.suppression === null) retained.suppression = row.suppression;
	if (row.suppressionState === "known" || row.suppressionState === "unknown") retained.suppressionState = row.suppressionState;
	const sources = sourceEvidence(row.sourceEvidence);
	if (sources) retained.sourceEvidence = sources;
	return retained;
}

/** The same projection accepts verify diagnostics and runtime CheckResultEntry records. */
export function checkActions(rows: readonly unknown[], policyHash: string | null = null): ActionInventory {
	const observations: ActionObservation[] = [];
	for (const row of rows) {
		if (!isJsonObject(row) || typeof row.message !== "string") continue;
		const check = typeof row.check === "string" ? row.check : typeof row.name === "string" ? row.name : typeof row.tool === "string" ? row.tool : null;
		if (!check) continue;
		const unavailable = row.measurementState === "unavailable" || row.status === "unavailable" || row.status === "deferred" || row.status === "not_measured" || row.status === "error";
		const retained = provenance(row);
		observations.push({ ...retained, check, file: typeof row.file === "string" ? row.file : "<project>",
			line: typeof row.line === "number" && Number.isSafeInteger(row.line) && row.line >= 0 ? row.line : 1,
			message: row.message, classification: unavailable ? "evidence_gap" : "candidate",
			evidence: row.determinism === "fully_deterministic" ? "proven" : "heuristic",
			sourceHash: retained.sourceHash ?? null, policyHash: policyHash ?? retained.policyHash ?? null,
			nextStep: typeof row.fix === "string" && row.fix.trim() ? row.fix : unavailable ? `Restore the prerequisites for ${check} and rerun it.` : `Review ${check} at this location against its evidence and applicable project policy before changing behavior.`,
			validation: unavailable ? `Rerun ${check} and inspect its coverage; confirm unavailable inputs were measured or remain explicitly outside supported scope.`
				: `Rerun ${check} and the affected behavioral tests; confirm the original failure is addressed without breaking supported behavior.`,
		});
	}
	const limitations = ["Check observations are candidates, not automatically confirmed defects. Source identity is unknown unless retained by the original check.", "This projection does not change suppression, check selection, or gate decisions. A missing or deferred check is not a pass."];
	if (observations.length !== rows.length) limitations.push(`${rows.length - observations.length} input row(s) lacked a supported check identity or message and could not be projected; inspect the original report for incomplete evidence.`);
	return { ...buildActionInventory(observations, limitations),
		projection: { supplied: rows.length, accepted: observations.length, rejected: rows.length - observations.length } };
}
