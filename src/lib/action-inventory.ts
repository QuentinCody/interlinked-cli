import { createHash } from "node:crypto";

/** Supporting source captured by a producer, without a later disk read. */
export interface ActionSourceEvidence {
	file: string;
	sha256: string;
	line: number;
	role: "producer" | "consumer";
}

/** A stateless projection of existing evidence, not a second finding lifecycle. */
export interface ActionObservation {
	check: string;
	file: string;
	line: number;
	/** Positions refer to the producer's captured source, when available. */
	column?: number;
	endLine?: number;
	endColumn?: number;
	startOffset?: number;
	endOffset?: number;
	subject?: string;
	/** Only producers that establish the same underlying action may supply this key. */
	actionKey?: string;
	message: string;
	classification: "measurement" | "candidate" | "policy_violation" | "defect" | "evidence_gap";
	evidence: "proven" | "heuristic";
	sourceHash: string | null;
	policyHash: string | null;
	/** Retained runtime provenance; it does not certify present-day freshness. */
	observedAt?: string;
	detectorHash?: string | null;
	/** Original retained evidence and related locations, when supplied by the producer. */
	evidenceRefs?: readonly string[];
	relatedLocations?: readonly string[];
	sourceEvidence?: readonly ActionSourceEvidence[];
	/** Original report pointers or version identities; never an inferred policy adoption. */
	producerRefs?: readonly string[];
	suppressed?: boolean;
	suppression?: string | null;
	suppressionState?: "known" | "unknown";
	enforcement?: "off" | "report" | "warn" | "block";
	nextStep: string;
	validation: string;
}

export interface InventoryAction {
	id: string;
	evidenceId: string;
	file: string;
	line: number;
	subject: string | null;
	classification: ActionObservation["classification"];
	enforcement: NonNullable<ActionObservation["enforcement"]>;
	/** Snapshot-bound does not claim the file is still current when a consumer reads it. */
	freshness: "snapshot_bound" | "unknown";
	evidence: ActionObservation[];
	nextSteps: string[];
	validation: string[];
	inferenceCostUsd: 0;
}

export interface ActionInventory {
	schema: "interlinked.actions/1";
	modelCalls: 0;
	/** Present when a producer normalizes untyped input rows. Rejected rows are
	 * missing projection evidence, not clean observations. */
	projection?: { supplied: number; accepted: number; rejected: number };
	observations: number;
	actions: InventoryAction[];
	limitations: string[];
}

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function actionIdentity(row: ActionObservation): string {
	const anchor: unknown[] = [row.check, row.subject ?? null, row.line];
	if ([row.column, row.endLine, row.endColumn, row.startOffset, row.endOffset].some(value => value !== undefined)) {
		anchor.push([row.column ?? null, row.endLine ?? null, row.endColumn ?? null, row.startOffset ?? null, row.endOffset ?? null]);
	}
	return hash([row.file.replaceAll("\\", "/"), row.actionKey ?? anchor, row.classification, row.enforcement ?? "report"]);
}

/** A bound snapshot requires agreement across every retained source version.
 * This does not assert that every dependency has been captured. */
function consistentSources(evidence: readonly ActionObservation[]): boolean {
	const versions = new Map<string, string>();
	const retain = (file: string, sha256: string | null): boolean => {
		if (!sha256?.trim()) return false;
		const path = file.replaceAll("\\", "/");
		if (versions.has(path) && versions.get(path) !== sha256) return false;
		versions.set(path, sha256);
		return true;
	};
	for (const row of evidence) {
		if (!retain(row.file, row.sourceHash)) return false;
		for (const source of row.sourceEvidence ?? []) if (!retain(source.file, source.sha256)) return false;
	}
	return true;
}

/** Never truncate the export; renderers may rank or page this complete collection. */
export function buildActionInventory(observations: readonly ActionObservation[], limitations: string[] = []): ActionInventory {
	const groups = new Map<string, Map<string, ActionObservation>>();
	for (const row of observations) {
		const id = actionIdentity(row);
		const evidence = groups.get(id) ?? new Map<string, ActionObservation>();
		evidence.set(hash(row), row);
		groups.set(id, evidence);
	}
	const actions: InventoryAction[] = [];
	for (const [id, group] of groups) {
		const evidence = [...group.entries()]
			.sort(([hashA, a], [hashB, b]) => a.check.localeCompare(b.check) || hashA.localeCompare(hashB))
			.map(([, row]) => row);
		const first = evidence[0];
		if (!first) continue;
		actions.push({
			id, evidenceId: hash(evidence), file: first.file, line: first.line, subject: first.subject ?? null,
			classification: first.classification, enforcement: first.enforcement ?? "report",
			freshness: consistentSources(evidence) ? "snapshot_bound" : "unknown",
			evidence, nextSteps: [...new Set(evidence.map(row => row.nextStep))],
			validation: [...new Set(evidence.map(row => row.validation))], inferenceCostUsd: 0,
		});
	}
	actions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line
		|| (a.evidence[0]?.column ?? 0) - (b.evidence[0]?.column ?? 0)
		|| (a.evidence[0]?.startOffset ?? 0) - (b.evidence[0]?.startOffset ?? 0) || a.id.localeCompare(b.id));
	return { schema: "interlinked.actions/1", modelCalls: 0, observations: observations.length, actions, limitations };
}
