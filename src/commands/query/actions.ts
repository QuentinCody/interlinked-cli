import { isCheckObservation } from "../../harness/check-observation-reader.js";
import { buildActionInventory, type ActionInventory, type ActionObservation } from "../../lib/action-inventory.js";
import { checkActions } from "../../lib/check-actions.js";
import { isJsonObject } from "../../lib/json-types.js";

/** Project selected persisted events only; this neither executes checks nor declares old findings unresolved. */
export function runtimeActions(records: readonly unknown[]): ActionInventory {
	const observations: ActionObservation[] = [];
	const projection = { supplied: 0, accepted: 0, rejected: 0 };
	let unknown = 0, simulated = 0;
	const retain = (rows: readonly unknown[], metadata: Partial<Pick<ActionObservation, "sourceHash" | "observedAt" | "detectorHash" | "policyHash" | "producerRefs">> = {}): void => {
		const projected = checkActions(rows, metadata.policyHash ?? null);
		projection.supplied += rows.length;
		projection.accepted += projected.observations;
		projection.rejected += rows.length - projected.observations;
		for (const action of projected.actions) for (const row of action.evidence) observations.push({ ...row, ...metadata });
	};
	for (const record of records) {
		if (!isJsonObject(record)) { unknown++; continue; }
		if (record.dry_run === true) { simulated++; continue; }
		if (isCheckObservation(record)) {
			const rows = record.executions.flatMap(execution => {
				const findings: unknown[] = execution.findings.map(hit => ({ name: execution.check, file: record.file, line: hit.line,
					...(hit.suppressed !== undefined ? { suppressed: true, suppression: hit.suppressed } : {}),
					message: `${hit.text}${hit.suppressed ? ` (retained suppression: ${hit.suppressed})` : ""}` }));
				if (execution.status === "unavailable") findings.push({ name: execution.check, file: record.file, status: "unavailable", message: execution.reason ?? "Check execution unavailable" });
				return findings;
			});
			retain(rows, { sourceHash: record.input, observedAt: record.ts, detectorHash: record.detector, policyHash: record.configuration,
				producerRefs: [`check-observations.v1:${record.session}:${record.call}`, `scope:${record.scope}`] });
		} else if (record.schema === "check-results.v2" && (Array.isArray(record.finding_details) || Array.isArray(record.execution))) {
			const rows: unknown[] = Array.isArray(record.finding_details) ? [...record.finding_details] : [];
			for (const entry of Array.isArray(record.execution) ? record.execution : []) {
				if (isJsonObject(entry) && (entry.status === "deferred" || entry.status === "error")) rows.push({ name: entry.id, file: record.file, status: "unavailable", message: entry.reason ?? "Check execution unavailable" });
			}
			retain(rows, typeof record.ts === "string" ? { observedAt: record.ts } : {});
		} else unknown++;
	}
	const inventory = buildActionInventory(observations, [
		"These are historical observations in the selected bounded log window, not a current unresolved worklist. Revalidate source, policy and applicable checks before acting.",
		"Runtime checks can be diff-scoped or partial. Empty findings do not certify the whole file or repository; suppressed raw observations remain review evidence.",
		`${unknown} record(s) had no supported detailed evidence; ${simulated} simulated record(s) were excluded. Query limits, byte budgets and omitted rotated history bound coverage.`,
	]);
	if (projection.rejected > 0) inventory.limitations.push(`${projection.rejected} supplied finding row(s) lacked supported check identity or message; inspect their original records before treating this projection as complete.`);
	return { ...inventory, projection };
}

export function renderRuntimeActions(inventory: ActionInventory): string {
	return ["Historical runtime actions — Revalidate before changing code", ...inventory.limitations,
		...inventory.actions.flatMap(action => [
			`${action.file}:${action.line} [${action.classification}] ${action.evidence.map(row => row.message).join("; ")}`,
			...action.nextSteps.map(step => `  Next: ${step}`), ...action.validation.map(step => `  Validate: ${step}`),
		]),
	].join("\n");
}
