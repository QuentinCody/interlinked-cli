import { expect, it } from "vitest";
import { standardsActions, type StandardsActionInput } from "./actions.js";
import type { StandardsOccurrence } from "./evidence.js";

function input(): StandardsActionInput {
	return { profile: { id: "profile" }, profileHash: "profile-hash", inventory: { root: "/repo", scope: "all", entries: [], gaps: [], issues: [], inputHash: "inputs" },
		occurrences: [], checks: [], syntax: { eligibleFiles: 0, measuredFiles: 0, unknownFiles: 0 }, notMeasured: [], standards: [],
		discovery: { cases: [], files: 0, unresolvedCalls: 0, notMeasured: [], limitations: [] },
		compiler: { state: "measured", version: "compiler-version", configs: [], inputs: [], limitations: [] },
		suppressionPolicy: { state: "read", sha256: "suppression-hash", reason: null }, limitations: [],
		provenance: { finishedAt: "2026-11-12T00:00:00Z", sourceConsistency: { state: "stable_selected_snapshot", selectedFilesChecked: 0,
			changedFiles: [], unavailableFiles: [], addedPaths: [], removedPaths: [], discoveryIssues: [], limitations: [] } } };
}
function occurrence(id: string, startOffset: number, kind: StandardsOccurrence["kind"] = "ast_occurrence"): StandardsOccurrence {
	return { id, rule: "written_type", kind, file: "a.ts", role: "product", sourceHash: "source", unitIds: ["unit"],
		line: 1, column: startOffset + 1, endLine: 1, startOffset, endOffset: startOffset + 3, text: "written source pattern", detail: "Pattern description",
		determinism: kind === "ast_occurrence" ? null : kind === "detector_match" ? "fully_deterministic" : "heuristic", suppressed: false, suppression: null };
}

it("P1 retains supplied kinds, spans, original refs and profile/suppression identities", () => {
	const report = input();
	report.occurrences = [occurrence("left", 5), occurrence("right", 20), occurrence("detector", 40, "detector_match"), occurrence("candidate", 60, "semantic_candidate")];
	report.checks = [{ id: "written_type", determinism: "fully_deterministic", detectorHash: "detector-hash", eligibleFiles: 1, measuredFiles: 1, unknownFiles: 0 }];
	const result = standardsActions(report);
	for (const [index, row] of report.occurrences.entries()) {
		const action = result.actions.find(action => action.evidence.some(evidence => evidence.evidenceRefs?.includes(row.id)));
		expect(action?.classification).toBe(row.kind === "semantic_candidate" ? "candidate" : "measurement");
		expect(action?.evidence).toContainEqual(expect.objectContaining({ sourceHash: "source", policyHash: null, startOffset: row.startOffset,
			endOffset: row.endOffset, column: row.column, endLine: row.endLine, evidenceRefs: [row.id, "unit"],
			producerRefs: expect.arrayContaining([`/occurrences/${index}`, "profileHash:profile-hash", "suppressionPolicy:read:suppression-hash"]) }));
	}
	expect(new Set(result.actions.filter(action => action.evidence.some(row => row.check === "written_type")).map(action => action.id)).size).toBe(4);
	expect(result.actions.every(action => action.enforcement === "report" && !["defect", "policy_violation"].includes(action.classification))).toBe(true);
	expect(result.modelCalls).toBe(0);
});

it("P2 keeps action anchors stable across ordering, source snapshots and suppression metadata", () => {
	const report = input(); report.occurrences = [occurrence("first", 5), occurrence("second", 20, "semantic_candidate")];
	const before = standardsActions(report);
	const changed = standardsActions({ ...report, profileHash: "new-profile", occurrences: [...report.occurrences].reverse().map(row => ({
		...row, id: `${row.id}-new`, sourceHash: "new-source", suppressed: true, suppression: "inline" as const })) });
	const own = (result: ReturnType<typeof standardsActions>) => result.actions.filter(action => action.file === "a.ts");
	expect(own(changed).map(action => action.id)).toEqual(own(before).map(action => action.id));
	expect(own(changed).map(action => action.evidenceId)).not.toEqual(own(before).map(action => action.evidenceId));
	expect(own(changed).every(action => action.evidence.every(row => row.suppressed && row.suppression === "inline"))).toBe(true);
	expect(own(changed).find(action => action.classification === "candidate")?.nextSteps.join(" ")).toMatch(/suppression/i);
});

it("P3 retains every discovery source/reference, missing context and source-less case", () => {
	const report = input();
	report.discovery.cases = [{ id: "case", family: "error_handling", origin: "detector", claim: "Review the failure boundary", missing: ["Caller contract unavailable"],
		sources: [{ id: "implementation", file: "a.ts", startLine: 2, endLine: 4, expectedHash: "source", purpose: "implementation" },
			{ id: "contract", file: "contract.ts", startLine: 3, expectedHash: "contract-source", purpose: "contract" }] },
		{ id: "unanchored", family: "error_handling", origin: "direct", claim: "Retain this unanchored candidate", sources: [], missing: [] }];
	const observations = standardsActions(report).actions.flatMap(action => action.evidence);
	expect(observations).toContainEqual(expect.objectContaining({ classification: "candidate", subject: "case", sourceHash: "source",
		evidenceRefs: expect.arrayContaining(["case", "implementation", "contract"]),
		producerRefs: expect.arrayContaining(["/discovery/cases/0/sources/0", "/discovery/cases/0/sources/1"]), relatedLocations: ["contract.ts:3"] }));
	expect(observations.some(row => row.classification === "evidence_gap" && row.producerRefs?.includes("/discovery/cases/0/missing/0"))).toBe(true);
	expect(observations.some(row => row.classification === "candidate" && row.subject === "unanchored")).toBe(true);
	expect(observations.some(row => row.classification === "evidence_gap" && row.producerRefs?.includes("/discovery/cases/1/sources"))).toBe(true);
});

it("P6 preserves supporting versions and marks primary or dependency disagreement unknown", () => {
	const report = input();
	const original = occurrence("cross-file", 5, "semantic_candidate");
	original.sourceHash = "a".repeat(64);
	original.sourceEvidence = [
		{ file: "a.ts", sha256: original.sourceHash, line: 1, role: "consumer" },
		{ file: "helper.ts", sha256: "b".repeat(64), line: 5, role: "producer" },
	];
	const same = standardsActions({ ...report, occurrences: [original] });
	expect(same.actions[0]?.freshness).toBe("snapshot_bound");
	const conflictingPrimary = { ...original, sourceEvidence: original.sourceEvidence.map(source => ({ ...source,
		sha256: source.file === "a.ts" ? "c".repeat(64) : source.sha256 })) };
	const mixedDependency = { ...original, sourceEvidence: original.sourceEvidence.map(source => ({ ...source,
		sha256: source.file === "helper.ts" ? "d".repeat(64) : source.sha256 })) };
	for (const rows of [[conflictingPrimary], [original, mixedDependency]]) {
		const result = standardsActions({ ...report, occurrences: rows });
		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]?.freshness).toBe("unknown");
		expect(result.actions[0]?.evidence).toHaveLength(rows.length);
		expect(result.actions[0]?.evidence.map(row => row.sourceEvidence)).toEqual(expect.arrayContaining(rows.map(row => row.sourceEvidence)));
	}
});

it("P4 exports concrete gaps from every producer with exact original pointers", () => {
	const report = input();
	report.notMeasured = ["a.ts: optional syntax unavailable", "known_check: Registry detector unavailable"];
	report.checks = [{ id: "known_check", determinism: null, detectorHash: null, eligibleFiles: 1, measuredFiles: 0, unknownFiles: 1 }];
	report.syntax = { eligibleFiles: 1, measuredFiles: 0, unknownFiles: 1 };
	report.inventory.gaps = [{ path: "missing.ts", role: "product", reason: "Unreadable" }];
	report.inventory.issues = ["Directory enumeration failed"];
	report.discovery.unresolvedCalls = 3; report.discovery.notMeasured = ["Typed discovery unavailable"];
	report.compiler.state = "inconclusive";
	report.compiler.configs = [{ file: "tsconfig.json", sha256: "config-source", diagnostics: ["Missing inherited config"], settings: {
		strict: false, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: null, noImplicitOverride: null, noFallthroughCasesInSwitch: null } }];
	report.compiler.inputs = [{ file: "base.json", sha256: "base-source" }];
	report.suppressionPolicy = { state: "invalid", sha256: "invalid-policy", reason: "Invalid suppression JSON" };
	report.standards = [{ id: "s01", unknowns: ["Project context remains unestablished"] }];
	report.provenance.sourceConsistency = { ...report.provenance.sourceConsistency, state: "changed", changedFiles: ["a.ts"], addedPaths: ["new.ts"],
		removedPaths: ["removed.ts"], unavailableFiles: ["lost.ts: read failed"], discoveryIssues: ["Final enumeration failed"] };
	const observations = standardsActions(report).actions.flatMap(action => action.evidence);
	for (const ref of ["/notMeasured/0", "/notMeasured/1", "/checks/0", "/syntax", "/inventory/gaps/0", "/inventory/issues/0", "/discovery/unresolvedCalls",
		"/discovery/notMeasured/0", "/compiler/state", "/compiler/configs/0/diagnostics/0", "/compiler/configs/0/settings/exactOptionalPropertyTypes",
		"/suppressionPolicy", "/standards/0/unknowns/0", "/provenance/sourceConsistency/state", "/provenance/sourceConsistency/changedFiles/0",
		"/provenance/sourceConsistency/addedPaths/0", "/provenance/sourceConsistency/removedPaths/0", "/provenance/sourceConsistency/unavailableFiles/0",
		"/provenance/sourceConsistency/discoveryIssues/0"]) {
		expect(observations.some(row => row.classification === "evidence_gap" && row.producerRefs?.includes(ref)), ref).toBe(true);
	}
	const strict = observations.find(row => row.producerRefs?.includes("/compiler/configs/0/settings/strict"));
	expect(strict).toMatchObject({ classification: "measurement", sourceHash: "config-source", message: expect.stringContaining("false") });
	expect(strict?.producerRefs).toContain("/compiler/inputs/0");
});

it("P5 retains complete supplied occurrence populations without mutating the input", () => {
	const report = input(); report.occurrences = Array.from({ length: 2_001 }, (_, index) => occurrence(`row-${index}`, index * 5));
	const before = JSON.stringify(report), result = standardsActions(report);
	const refs = result.actions.flatMap(action => action.evidence.flatMap(row => row.evidenceRefs ?? []));
	for (const row of report.occurrences) expect(refs).toContain(row.id);
	expect(JSON.stringify(report)).toBe(before);
});

it("N1 treats missing suppression configuration and static method limitations as ordinary scope", () => {
	const report = input(); report.suppressionPolicy = { state: "missing", sha256: null, reason: null };
	report.limitations = ["Only selected readable JS/TS source receives the mapped passes."];
	report.compiler.limitations = ["Compiler metadata does not establish successful compilation."];
	report.discovery.limitations = ["Filename relationships require caller review."];
	const result = standardsActions(report);
	expect(result.actions).toEqual([]);
	expect(result.limitations).toContain(report.limitations[0]);
});
