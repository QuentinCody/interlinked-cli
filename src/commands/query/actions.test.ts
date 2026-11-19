import { expect, it } from "vitest";
import { runtimeActions, renderRuntimeActions } from "./actions.js";

it("projects retained runtime findings and deferred work without treating old findings as current", () => {
	const report = runtimeActions([{ schema: "check-results.v2", ts: "2026-11-11T00:00:00Z", finding_details: [{ name: "empty_catch", file: "index.ts", line: 4, message: "Review error handling", determinism: "heuristic" }], execution: [{ id: "tsc", status: "deferred", reason: "Capacity busy" }] }]);
	expect(report.actions).toHaveLength(2);
	expect(report.actions.find(action => action.file === "index.ts")).toMatchObject({ freshness: "unknown", classification: "candidate" });
	expect(report.actions.some(action => action.classification === "evidence_gap")).toBe(true);
	expect(report.limitations.join(" ")).toContain("historical");
	expect(renderRuntimeActions(report)).toContain("Revalidate");
});

it("retains captured source identity, suppressed raw findings and explicit unavailable executions", () => {
	const report = runtimeActions([{ schema: "check-observations.v1", ts: "2026-11-11T00:00:00Z", session: "session", call: "call", file: "lib.ts", input: "source-hash", detector: "detector-hash", configuration: "config-hash", scope: "partial", executions: [
		{ check: "one", status: "completed", findings: [{ line: 3, text: "source evidence", emitted: false, suppressed: "documented exception" }], emitted: false, duration_ms: 1 },
		{ check: "two", status: "unavailable", findings: [], emitted: null, duration_ms: null, reason: "Parser unavailable" },
	] }]);
	expect(report.actions).toHaveLength(2);
	expect(report.actions.every(action => action.freshness === "snapshot_bound")).toBe(true);
	expect(report.actions[0]?.evidence[0]?.sourceHash).toBe("source-hash");
	expect(report.actions.flatMap(action => action.evidence).some(row => row.message.includes("documented exception"))).toBe(true);
	expect(report.actions.flatMap(action => action.evidence)).toEqual(expect.arrayContaining([expect.objectContaining({ suppressed: true, suppression: "documented exception" })]));
	expect(report.limitations.join(" ")).toContain("partial");
});

it("does not manufacture findings from clean, legacy, simulated or malformed records", () => {
	const report = runtimeActions([{ schema: "check-results.v2", dry_run: true, finding_details: [{ name: "probe", message: "simulated" }] }, { checks: [{ id: "old" }] }, { schema: "check-results.v2", finding_details: [], execution: [{ id: "tsc", status: "completed_no_reported_findings" }] }]);
	expect(report.actions).toEqual([]);
	expect(report.limitations.join(" ")).toContain("1 record(s)");
	expect(report.modelCalls).toBe(0);
});

it("retains deferred-only events whose writer omitted an undefined finding_details field", () => {
	const report = runtimeActions([{ schema: "check-results.v2", execution: [{ id: "tsc", status: "deferred", reason: "Check busy" }] }]);
	expect(report.actions[0]).toMatchObject({ classification: "evidence_gap" });
});

it("keeps nonblocking runtime measurement gaps separate from numeric findings", () => {
	const sourceEvidence = [{ file: "parser.ts", sha256: "a".repeat(64), line: 2, role: "producer" }];
	const report = runtimeActions([{ schema: "check-results.v2", finding_details: [
		{ name: "numeric_zero_default", file: "parser.ts", message: "Review a consumer's zero default", sourceEvidence },
		{ name: "numeric_zero_default", file: "parser.ts", message: "Numeric default evidence NOT MEASURED",
			measurementState: "unavailable", findingCount: 0, severity: "warning" },
	] }]);
	expect(report.actions).toHaveLength(2);
	const gap = report.actions.find(row => row.classification === "evidence_gap");
	expect(gap).toMatchObject({ enforcement: "report", freshness: "unknown" });
	expect(gap?.validation.join(" ")).toContain("coverage");
	expect(report.actions.find(row => row.classification === "candidate")?.evidence[0]?.sourceEvidence).toEqual(sourceEvidence);
});

it("discloses rejected detailed rows rather than turning a malformed supported record into a clean report", () => {
	const report = runtimeActions([{ schema: "check-results.v2", finding_details: [null, { count: 7 }, { check: "known", message: "Retained" }] }]);
	expect(report.projection).toEqual({ supplied: 3, accepted: 1, rejected: 2 });
	expect(report.actions).toHaveLength(1);
	expect(report.limitations.join(" ")).toContain("2 supplied finding row(s)");
});

it("retains a large supplied historical evidence population without an argument-count cutoff", () => {
	const count = 150_001;
	const report = runtimeActions([{ schema: "check-results.v2", finding_details: Array.from({ length: count }, (_, index) => ({
		check: "large", file: "source.ts", line: 1, message: `retained observation ${index}`,
	})) }]);
	expect(report.observations).toBe(count);
	expect(report.actions).toHaveLength(1);
	expect(report.actions[0]?.evidence).toHaveLength(count);
	expect(report.actions[0]?.evidence.some(row => row.message === `retained observation ${count - 1}`)).toBe(true);
});
