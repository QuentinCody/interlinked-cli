import { describe, expect, it } from "vitest";
import { checkActions } from "./check-actions.js";

describe("runtime and verify action projection", () => {
	it("honors producer identity precedence and retains the suggested fix on unavailable rows", () => {
		const result = checkActions([
			{ check: "chosen", name: "alternate", tool: "fallback", message: "pending", status: "not_measured", fix: "Restore input", policyHash: "captured" },
			{ check: 4, name: "alternate", tool: "fallback", message: "observed" },
			{ check: "", name: "alternate", message: "invalid explicit identity" },
		], "override");
		expect(result.projection).toEqual({ supplied: 3, accepted: 2, rejected: 1 });
		const evidence = result.actions.flatMap(action => action.evidence);
		expect(evidence.map(row => row.check).sort()).toEqual(["alternate", "chosen"]);
		expect(evidence.find(row => row.check === "chosen")).toMatchObject({ classification: "evidence_gap", nextStep: "Restore input", policyHash: "override" });
	});

	it("preserves every diagnostic without inferring a defect from severity alone", () => {
		const result = checkActions([
			{ check: "floating_promises", file: "index.ts", line: 4, message: "Inspect this unhandled result" },
			{ name: "floating_promises", file: "index.ts", line: 4, message: "Inspect this unhandled result", severity: "error", determinism: "heuristic" },
		]);
		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({ classification: "candidate", enforcement: "report", freshness: "unknown" });
		expect(result.actions[0]?.nextSteps[0]).toContain("floating_promises");
	});

	it("retains unavailable check results as evidence gaps, without manufacturing source identity", () => {
		const result = checkActions([{ name: "typescript", file: "index.ts", message: "Compiler unavailable", status: "unavailable" }]);
		expect(result.actions[0]?.classification).toBe("evidence_gap");
		expect(result.actions[0]?.evidence[0]?.sourceHash).toBeNull();
	});

	it("does not turn unrelated or malformed output into an actionable finding", () => {
		const report = checkActions([{ count: 5 }, null, "failure"]);
		expect(report.actions).toEqual([]);
		expect(report.projection).toEqual({ supplied: 3, accepted: 0, rejected: 3 });
		expect(report.limitations.join(" ")).toContain("3 input row(s)");
	});

	it("retains supplied provenance, distinct spans and suppression without trusting requested enforcement", () => {
		const row = { check: "example", file: "index.ts", line: 4, column: 2, endLine: 4, endColumn: 8,
			startOffset: 21, endOffset: 27, message: "Observed pattern", sourceHash: "captured-source",
			policyHash: "captured-policy", detectorHash: "detector", observedAt: "2026-11-12T00:00:00Z",
			evidenceRefs: ["original-row"], relatedLocations: ["helper.ts:8"], producerRefs: ["report:one"],
			suppressed: true, suppression: "accepted exception", suppressionState: "known", classification: "defect", enforcement: "block" };
		const report = checkActions([row, { ...row, column: 14, startOffset: 33, endOffset: 39 }]);
		expect(report.actions).toHaveLength(2);
		expect(report.actions.every(action => action.classification === "candidate" && action.enforcement === "report" && action.freshness === "snapshot_bound")).toBe(true);
		expect(report.actions.flatMap(action => action.evidence)).toEqual(expect.arrayContaining([expect.objectContaining({
			sourceHash: "captured-source", policyHash: "captured-policy", detectorHash: "detector", column: 2,
			evidenceRefs: ["original-row"], relatedLocations: ["helper.ts:8"], producerRefs: ["report:one"],
			suppressed: true, suppression: "accepted exception", suppressionState: "known", observedAt: "2026-11-12T00:00:00Z",
		})]));
	});

	it("retains execution errors as gaps and ignores malformed optional provenance", () => {
		const report = checkActions([{ check: "example", message: "Parser failed", status: "error", line: 0,
			sourceHash: "", column: -1, endOffset: Number.NaN, evidenceRefs: [1, "kept"], detectorHash: {}, suppressed: "yes" }]);
		expect(report.actions[0]).toMatchObject({ line: 0, classification: "evidence_gap", freshness: "unknown" });
		expect(report.actions[0]?.evidence[0]).toMatchObject({ sourceHash: null, evidenceRefs: ["kept"] });
		expect(report.actions[0]?.evidence[0]).not.toHaveProperty("column");
		expect(report.actions[0]?.evidence[0]).not.toHaveProperty("detectorHash");
	});

	it("keeps unknown suppression state distinct from an established unsuppressed finding", () => {
		const report = checkActions([{ check: "rule", message: "Raw match", suppressed: false, suppressionState: "unknown" }]);
		expect(report.actions[0]?.evidence[0]).toMatchObject({ suppressed: false, suppressionState: "unknown" });
		expect(report.actions[0]?.classification).toBe("candidate");
	});
	it("retains captured cross-file source evidence without changing existing string references", () => {
		const source = { file: "parser.ts", sha256: "a".repeat(64), line: 2, role: "producer" };
		const result = checkActions([{ check: "numeric_zero_default", file: "caller.ts", line: 5,
			message: "Inspect zero/default contract", sourceHash: "caller-source", evidenceRefs: ["original-record"],
			sourceEvidence: [source, { ...source, sha256: "" }, { ...source, role: "unrecognized" }, { ...source, line: -1 }, null] }]);
		expect(result.actions[0]?.evidence[0]).toMatchObject({ evidenceRefs: ["original-record"], sourceEvidence: [source] });
		expect(result.actions[0]?.classification).toBe("candidate");
		expect(result.actions[0]?.freshness).toBe("snapshot_bound");
	});
});
