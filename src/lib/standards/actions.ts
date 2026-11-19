import { buildActionInventory, type ActionObservation } from "../action-inventory.js";
import type { StandardsCompiler } from "./compiler.js";
import type { StandardsDiscovery } from "./discovery.js";
import type { StandardsCheckCoverage, StandardsEvidence, StandardsOccurrence } from "./evidence.js";
import type { compareStandardsSnapshot, StandardsInventory } from "./inventory.js";

export interface StandardsActionInput {
	profile: { id: string };
	profileHash: string;
	inventory: Pick<StandardsInventory, "root" | "scope" | "entries" | "gaps" | "issues" | "inputHash">;
	occurrences: readonly StandardsOccurrence[];
	checks: readonly StandardsCheckCoverage[];
	syntax: StandardsEvidence["syntax"];
	notMeasured: readonly string[];
	standards: readonly { id: string; unknowns: readonly string[] }[];
	discovery: StandardsDiscovery;
	compiler: StandardsCompiler;
	suppressionPolicy: { sha256: string | null; state: "read" | "missing" | "invalid"; reason: string | null; consistency?: string;
		final?: { sha256: string | null; state: "read" | "missing" | "invalid"; reason: string | null } };
	provenance: { finishedAt: string; sourceConsistency: ReturnType<typeof compareStandardsSnapshot> };
	limitations: readonly string[];
}
type Observation = Omit<ActionObservation, "policyHash" | "enforcement" | "observedAt">;
const VALIDATION = "Rerun the same profile and inspect its retained source, scope and method evidence.";

function coordinates(row: StandardsOccurrence): Pick<ActionObservation, "column" | "endLine" | "startOffset" | "endOffset"> {
	const result: Pick<ActionObservation, "column" | "endLine" | "startOffset" | "endOffset"> = {};
	if (row.column !== null) result.column = row.column;
	if (row.endLine !== null) result.endLine = row.endLine;
	if (row.startOffset !== null) result.startOffset = row.startOffset;
	if (row.endOffset !== null) result.endOffset = row.endOffset;
	return result;
}

function suppressionMetadata(row: StandardsOccurrence): Pick<ActionObservation, "suppressed" | "suppression" | "suppressionState"> {
	if (row.suppressionState === "unknown") return { suppression: "unavailable", suppressionState: "unknown" };
	return { suppressed: row.suppressed, suppression: row.suppression, ...(row.suppressionState ? { suppressionState: row.suppressionState } : {}) };
}

function occurrenceNextStep(row: StandardsOccurrence): string {
	if (row.suppressionState === "unknown") return "Restore the captured suppression metadata before interpreting this source observation's suppression state.";
	if (row.suppressed) return "Inspect the retained source observation and existing suppression rationale before proposing any change.";
	if (row.kind === "semantic_candidate") return "Review the declaration, called helpers, callers and applicable contract before deciding on a change.";
	return "Inspect this recorded source pattern in its profile context and determine whether further review is warranted.";
}

function gap(message: string, producerRefs: string[], options: Partial<Pick<Observation, "check" | "file" | "subject" | "sourceHash" | "evidenceRefs" | "nextStep">> = {}): Observation {
	return { check: options.check ?? "standards_measurement", file: options.file ?? "<repository>", line: 0,
		subject: options.subject ?? message, message, classification: "evidence_gap", evidence: "proven", sourceHash: options.sourceHash ?? null,
		producerRefs, evidenceRefs: options.evidenceRefs ?? [],
		nextStep: options.nextStep ?? "Restore or supply the named evidence before interpreting this measurement population.", validation: VALIDATION };
}

function* occurrenceRows(input: StandardsActionInput): Generator<Observation> {
	const detectors = new Map(input.checks.map(row => [row.id, row.detectorHash]));
	for (const [index, row] of input.occurrences.entries()) {
		const semantic = row.kind === "semantic_candidate";
		const positioned = row.startOffset !== null || row.column !== null;
		yield { check: row.rule, file: row.file, line: row.line, subject: positioned ? row.kind : row.text,
			...coordinates(row), ...suppressionMetadata(row),
			...(row.sourceEvidence ? { sourceEvidence: row.sourceEvidence.map(source => ({ ...source })) } : {}),
			message: row.detail ? `${row.text} — ${row.detail}` : row.text,
			classification: semantic ? "candidate" : "measurement", evidence: semantic ? "heuristic" : "proven",
			sourceHash: row.sourceHash, detectorHash: row.determinism === null ? null : detectors.get(row.rule) ?? null,
			evidenceRefs: [row.id, ...row.unitIds], producerRefs: [`/occurrences/${index}`], nextStep: occurrenceNextStep(row),
			validation: "Compare the retained source span and evidence references, then remeasure the same selected scope." };
	}
}

function location(source: StandardsDiscovery["cases"][number]["sources"][number]): string {
	return source.startLine === undefined ? source.file : `${source.file}:${source.startLine}`;
}

function* discoveryRows(input: StandardsActionInput): Generator<Observation> {
	for (const [index, row] of input.discovery.cases.entries()) {
		const source = row.sources[0], pointer = `/discovery/cases/${index}`;
		const producerRefs = [pointer];
		for (const [sourceIndex, evidence] of row.sources.entries()) {
			producerRefs.push(`${pointer}/sources/${sourceIndex}`);
			if (evidence.expectedHash !== undefined) producerRefs.push(`sourceHash:${evidence.id}:${evidence.expectedHash}`);
		}
		yield { check: row.family, file: source?.file ?? "<repository>", line: source?.startLine ?? 0, subject: row.id, message: row.claim,
			...(source?.endLine === undefined ? {} : { endLine: source.endLine }),
			classification: "candidate", evidence: "heuristic", sourceHash: source?.expectedHash ?? null,
			evidenceRefs: [row.id, ...row.sources.map(evidence => evidence.id)], producerRefs, relatedLocations: row.sources.slice(1).map(location),
			nextStep: "Review the retained finding case with its complete source selection, missing context and explicit contract in metrics decisions findings prepare.",
			validation: "Review callers, ownership and source identities before accepting or rejecting the candidate." };
		if (!source) yield gap("Discovery candidate has no selected source evidence", [`${pointer}/sources`], { check: row.family,
			subject: `${row.id}:sources`, evidenceRefs: [row.id] });
		for (const [missingIndex, reason] of row.missing.entries()) yield gap(reason, [`${pointer}/missing/${missingIndex}`], {
			check: row.family, file: source?.file ?? "<repository>", sourceHash: source?.expectedHash ?? null, subject: `${row.id}:${reason}`, evidenceRefs: [row.id] });
	}
	for (const [index, reason] of input.discovery.notMeasured.entries()) yield gap(reason, [`/discovery/notMeasured/${index}`], { check: "standards_discovery" });
	if (input.discovery.unresolvedCalls > 0) yield gap(`${input.discovery.unresolvedCalls} discarded calls have unresolved any/unknown return types in the selected discovery population`,
		["/discovery/unresolvedCalls"], { check: "standards_discovery", subject: "unresolved_calls" });
}

function* compilerRows(input: StandardsActionInput): Generator<Observation> {
	if (input.compiler.state !== "measured") yield gap(`Compiler metadata is ${input.compiler.state}`, ["/compiler/state"], { check: "standards_compiler", subject: "state" });
	const inputRefs = input.compiler.inputs.flatMap((row, index) => [`/compiler/inputs/${index}`, `sourceHash:${row.file}:${row.sha256}`]);
	for (const [index, config] of input.compiler.configs.entries()) {
		const pointer = `/compiler/configs/${index}`;
		for (const [flag, value] of Object.entries(config.settings)) {
			const refs = [`${pointer}/settings/${flag}`, ...inputRefs];
			if (value === null) yield gap(`Compiler setting ${flag} remains unknown`, refs, { check: "standards_compiler_setting", file: config.file,
				sourceHash: config.sha256, subject: flag });
			else yield { check: "standards_compiler_setting", file: config.file, line: 0, subject: flag, message: `${flag} = ${value}`,
				classification: "measurement", evidence: "proven", sourceHash: config.sha256, producerRefs: refs,
				nextStep: "Review the recorded compiler setting against the project's explicit requirements and retained inherited configuration.", validation: VALIDATION };
		}
		for (const [diagnosticIndex, message] of config.diagnostics.entries()) yield gap(message, [`${pointer}/diagnostics/${diagnosticIndex}`, ...inputRefs], {
			check: "standards_compiler", file: config.file, sourceHash: config.sha256 });
	}
}

function noticeSource(input: StandardsActionInput, message: string): string | undefined {
	return input.inventory.entries.find(entry => message.startsWith(`${entry.path}:`))?.path;
}

function* measurementGaps(input: StandardsActionInput): Generator<Observation> {
	for (const [index, message] of input.notMeasured.entries()) yield gap(message, [`/notMeasured/${index}`], { file: noticeSource(input, message) ?? "<repository>" });
	for (const [index, row] of input.checks.entries()) {
		if (row.unknownFiles > 0) yield gap(`${row.unknownFiles}/${row.eligibleFiles} selected inputs remain unknown for ${row.id}`, [`/checks/${index}`], {
			check: row.id, subject: "coverage" });
	}
	if (input.syntax.unknownFiles > 0) yield gap(`${input.syntax.unknownFiles}/${input.syntax.eligibleFiles} selected syntax inputs remain unknown`, ["/syntax"], { check: "standards_syntax" });
	for (const [index, row] of input.inventory.gaps.entries()) yield gap(row.reason, [`/inventory/gaps/${index}`], { check: "standards_input", file: row.path });
	for (const [index, message] of input.inventory.issues.entries()) yield gap(message, [`/inventory/issues/${index}`], { check: "standards_inventory" });
	if (input.suppressionPolicy.state === "invalid") yield gap(input.suppressionPolicy.reason ?? "Suppression policy is unreadable or invalid", ["/suppressionPolicy"], {
		check: "standards_suppression", file: ".interlinked/verify-suppressions.json", sourceHash: input.suppressionPolicy.sha256 });
	if (input.suppressionPolicy.consistency && input.suppressionPolicy.consistency !== "stable_capture") yield gap(`Suppression policy comparison is ${input.suppressionPolicy.consistency}; observations retain the initial captured policy`,
		["/suppressionPolicy/consistency"], { check: "standards_suppression", file: ".interlinked/verify-suppressions.json", subject: "consistency" });
	for (const [index, standard] of input.standards.entries()) {
		for (const [unknownIndex, message] of standard.unknowns.entries()) yield gap(message, [`/standards/${index}/unknowns/${unknownIndex}`], {
			check: "standards_context", subject: `${standard.id}:${message}`,
			nextStep: "Supply the stated project contract, policy, ownership or caller context when reviewing this guidance." });
	}
}

function* consistencyRows(input: StandardsActionInput): Generator<Observation> {
	const consistency = input.provenance.sourceConsistency, pointer = "/provenance/sourceConsistency";
	if (consistency.state !== "stable_selected_snapshot") yield gap(`Selected source snapshot is ${consistency.state}`, [`${pointer}/state`], {
		check: "standards_source_consistency", subject: "state" });
	for (const key of ["changedFiles", "addedPaths", "removedPaths"] as const) {
		for (const [index, file] of consistency[key].entries()) yield gap(`${key}: ${file}`, [`${pointer}/${key}/${index}`], {
			check: "standards_source_consistency", file, subject: key });
	}
	for (const key of ["unavailableFiles", "discoveryIssues"] as const) {
		for (const [index, message] of consistency[key].entries()) yield gap(message, [`${pointer}/${key}/${index}`], { check: "standards_source_consistency" });
	}
}

/** Project only the captured report. Measurements and evidence gaps retain their producer identity and advisory scope. */
export function standardsActions(input: StandardsActionInput) {
	const observations: ActionObservation[] = [];
	const provenance = [`profile:${input.profile.id}`, `profileHash:${input.profileHash}`,
		`suppressionPolicy:${input.suppressionPolicy.state}:${input.suppressionPolicy.sha256 ?? "none"}`, `inventoryHash:${input.inventory.inputHash}`];
	if (input.suppressionPolicy.final) provenance.push(`finalSuppressionPolicy:${input.suppressionPolicy.final.state}:${input.suppressionPolicy.final.sha256 ?? "none"}`);
	const producers = [occurrenceRows(input), discoveryRows(input), compilerRows(input), measurementGaps(input), consistencyRows(input)];
	for (const rows of producers) {
		for (const row of rows) observations.push({ ...row, policyHash: null, enforcement: "report", observedAt: input.provenance.finishedAt,
			producerRefs: [...provenance, ...(row.producerRefs ?? [])] });
	}
	return buildActionInventory(observations, [...input.limitations,
		"Action measurements retain source patterns and compiler settings. Candidate review and unavailable evidence remain separate classifications.",
		"Profile and suppression identities are provenance references. This projection adopts no policy and runs no analyzer or model."]);
}
