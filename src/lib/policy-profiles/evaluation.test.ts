import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatePolicyProfile } from "./evaluation.js";
import { parsePolicyProfile } from "./profile.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("policy profile evidence collection", () => {
	it("retains all 23 readings and selected detector evidence without adopting policy", () => {
		const root = mkdtempSync(join(tmpdir(), "profile-evaluation-")); roots.push(root);
		writeFileSync(join(root, "index.ts"), "export function invalid(x: number) { return x === NaN; }");
		const profile = parsePolicyProfile({ schemaVersion: 1, id: "team", metrics: { tokens: { mode: "warn", threshold: 1 }, "file.lines": { mode: "block", threshold: 1 } }, rules: { numeric: { check: "nan_comparison", mode: "warn" } } });
		const result = evaluatePolicyProfile(root, profile);
		expect(result.measurements.metrics).toHaveLength(23);
		expect(result.rules[0]?.findings).toHaveLength(1);
		expect(result.metricPolicies.find(row => row.id === "coverage.lines")?.measurementState).toBe("missing");
		expect(result.metricPolicies.find(row => row.id === "file.lines")?.mode).toBe("warn");
		expect(result.actions.actions.every(row => row.enforcement !== "block")).toBe(true);
		expect(result.metricPolicies.find(row => row.id === "contracts.findings")?.status).toBe("not-applicable");
		expect(result.actions.actions.flatMap(row => row.evidence).some(row => row.check === "metric-policy:contracts.findings")).toBe(false);
		expect(result.modelCalls).toBe(0);
		expect(existsSync(join(root, ".interlinked"))).toBe(false);
	});
	it("exports detector coverage gaps through shared actions", () => {
		const root = mkdtempSync(join(tmpdir(), "profile-evaluation-gap-")); roots.push(root);
		writeFileSync(join(root, "worker.py"), "value = 1\n");
		const profile = parsePolicyProfile({ schemaVersion: 1, id: "team", rules: { numeric: { check: "nan_comparison", mode: "report" } } });
		const result = evaluatePolicyProfile(root, profile);
		expect(result.rules[0]?.state).toBe("partial");
		expect(result.actions.actions.some(row => row.classification === "evidence_gap" && row.evidence.some(item => item.check === "profile-rule:numeric"))).toBe(true);
	});
});
