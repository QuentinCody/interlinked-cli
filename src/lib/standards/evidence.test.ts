import { expect, it } from "vitest";
import { reportNotMeasured } from "../../harness/checks/check-root.js";
import type { CheckRegistration } from "../../harness/check-registry/types.js";
import { hashBytes } from "../metrics/inventory.js";
import { scanStandardsEvidence } from "./evidence.js";
import { standardsActions } from "./actions.js";

const content = "// interlinked-ignore: literal — deliberate fixture\nthrow 'failure';";
const file = { path: "source.ts", role: "product" as const, language: "typescript", content, sha256: hashBytes(content) };
const detector: CheckRegistration = { id: "literal", name: "Literal", description: "test", tier: 1, determinism: "fully_deterministic", severity: "warning", pipeline: "agent_safety", phase: "post", fix_instruction: "Review", resultsPropName: "literal", fn: () => [{ line: 2, text: "throw 'failure';" }] };

it("retains raw deterministic matches and suppression evidence beside exact AST facts", () => {
	const report = scanStandardsEvidence("/repo", [file], ["literal", "missing"], [detector]);
	expect(report.occurrences.find(row => row.rule === "throw_statement")).toMatchObject({ kind: "ast_occurrence", sourceHash: file.sha256, file: "source.ts" });
	expect(report.occurrences.find(row => row.rule === "literal")).toMatchObject({ kind: "detector_match", suppressed: true, suppression: "inline", line: 2 });
	expect(report.checks.find(row => row.id === "missing")).toMatchObject({ measuredFiles: 0, unknownFiles: 1 });
});

it("keeps heuristic matches as candidates and unavailable checks unknown", () => {
	const heuristic = { ...detector, id: "candidate", determinism: "heuristic" as const };
	const unavailable = { ...detector, id: "unavailable", fn: () => { reportNotMeasured("unavailable", "no parser"); return []; } };
	const report = scanStandardsEvidence("/repo", [file], ["candidate", "unavailable"], [heuristic, unavailable]);
	expect(report.occurrences.find(row => row.rule === "candidate")).toMatchObject({ kind: "semantic_candidate", determinism: "heuristic" });
	expect(report.checks.find(row => row.id === "unavailable")).toMatchObject({ measuredFiles: 0, unknownFiles: 1 });
	expect(report.notMeasured).toContain("source.ts: [interlinked:unavailable] NOT MEASURED: no parser");
});

it("retains detector execution failures without interpreting them as zero matches", () => {
	const broken = { ...detector, fn: () => { throw new Error("fixture failure"); } };
	const report = scanStandardsEvidence("/repo", [file], ["literal"], [broken]);
	expect(report.checks[0]).toMatchObject({ measuredFiles: 0, unknownFiles: 1 });
	expect(report.notMeasured).toContain("source.ts: literal: fixture failure");
});

it("counts a file once when a completed detector has unreadable suppression evidence", () => {
	const capture = { state: "read" as const, forFile() { throw new Error("suppression read failed"); } };
	const report = scanStandardsEvidence("/repo", [file], ["literal"], [detector], capture);
	expect(report.checks[0]).toMatchObject({ eligibleFiles: 1, measuredFiles: 0, unknownFiles: 1 });
	expect(report.notMeasured).toContain("source.ts: literal: suppression read failed");
});

it("P1 retains supplied cross-file snapshots through raw occurrences and actions without reading supporting files", () => {
	const sourceEvidence = [
		{ file: "missing-helper.ts", sha256: "a".repeat(64), line: 7, role: "producer" as const },
		{ file: file.path, sha256: file.sha256, line: 2, role: "consumer" as const },
	];
	const expected = sourceEvidence.map(source => ({ ...source }));
	const crossFile = { ...detector, fn: () => [{ line: 2, text: "supplied cross-file observation", sourceEvidence }] };
	const report = scanStandardsEvidence("/nonexistent-standards-snapshot", [file], ["literal"], [crossFile], {
		state: "missing", forFile: () => new Set(),
	});
	const occurrence = report.occurrences.find(row => row.rule === "literal")!;
	expect(Reflect.get(occurrence, "sourceEvidence")).toEqual(expected);
	sourceEvidence[0]!.sha256 = "b".repeat(64);
	expect(Reflect.get(occurrence, "sourceEvidence")).toEqual(expected);
	const result = standardsActions({ ...report,
		profile: { id: "supplied-evidence" }, profileHash: "profile", standards: [], limitations: [],
		inventory: { root: "/nonexistent-standards-snapshot", scope: "all", entries: [], gaps: [], issues: [], inputHash: "inputs" },
		discovery: { cases: [], files: 0, unresolvedCalls: 0, notMeasured: [], limitations: [] },
		compiler: { state: "measured", version: "version", configs: [], inputs: [], limitations: [] },
		suppressionPolicy: { state: "missing", sha256: null, reason: null },
		provenance: { finishedAt: "2026-11-12T00:00:00Z", sourceConsistency: { state: "stable_selected_snapshot", selectedFilesChecked: 0,
			changedFiles: [], unavailableFiles: [], addedPaths: [], removedPaths: [], discoveryIssues: [], limitations: [] } },
	});
	const action = result.actions.find(action => action.evidence.some(row => row.check === "literal"))!;
	expect(action.evidence[0]?.sourceEvidence).toEqual(expected);
	expect(action.freshness).toBe("snapshot_bound");
});

it.each([
	["throw_literal", (index: number) => `function fail${index}() {\nthrow "failure";\n}`],
	["unvalidated_json_boundary", (index: number) => `const data${index} = JSON.parse(raw);\nuse(data${index}.field);`],
	["json_stringify_error", (index: number) => `try { work(); } catch (error${index}) { JSON.stringify(error${index}); }`],
	["catch_rewrap_loses_cause", (index: number) => `try { work(); } catch (error${index}) { throw new Error(String(error${index})); }`],
	["resource_handle_leak", (index: number) => `const fd${index} = fs.openSync("input", "r");`],
])("retains all twenty %s candidates beyond the runtime result cap", (id, source) => {
	const content = Array.from({ length: 20 }, (_, index) => source(index)).join("\n");
	const input = { ...file, content, sha256: hashBytes(content) };
	const report = scanStandardsEvidence("/repo", [input], [id]);
	expect(report.occurrences.filter(row => row.rule === id)).toHaveLength(20);
	expect(report.checks[0]).toMatchObject({ measuredFiles: 1, unknownFiles: 0 });
});
