import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCheckPolicy } from "./check-policy.js";
import { loadStructuralMetricPolicy } from "./metric-policy-config.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function project(team?: unknown, local?: unknown, globalMode?: string): string {
	const root = mkdtempSync(join(tmpdir(), "metric-policy-config-"));
	roots.push(root);
	mkdirSync(join(root, ".interlinked"));
	if (team !== undefined) writeFileSync(join(root, ".interlinked/check-policy.json"), JSON.stringify(team));
	if (local !== undefined) writeFileSync(join(root, ".interlinked/check-policy.local.json"), JSON.stringify(local));
	if (globalMode !== undefined) writeFileSync(join(root, ".interlinked/config.json"), JSON.stringify({ harness: { edit_metrics: { mode: globalMode } } }));
	return root;
}

describe("existing check policy metric extension", () => {
	it("keeps check actions when one metric entry is malformed", () => {
		const root = project({ checks: { floating_promises: { action: "warn_before" } }, metrics: { cyclomatic: { mode: "invalid" }, cognitive: { mode: "warn", threshold: 18 } } });
		const policy = loadCheckPolicy(root);
		expect(policy.checks.floating_promises?.action).toBe("warn_before");
		expect(policy.metrics?.cognitive).toEqual({ mode: "warn", threshold: 18 });
		expect(policy.metric_policy_issues).toHaveLength(1);
	});
	it("preserves team scope fields when a local entry adds another filter", () => {
		const root = project({ metrics: { cyclomatic: { scope: { paths: ["src/**"] } } } }, { metrics: { cyclomatic: { scope: { roles: ["product"] } } } });
		expect(loadCheckPolicy(root).metrics?.cyclomatic?.scope).toEqual({ paths: ["src/**"], roles: ["product"] });
	});
});

describe("structural metric compatibility", () => {
	it("preserves inherited advisory and enforced behavior", () => {
		expect(loadStructuralMetricPolicy(project(), "cyclomatic").mode).toBe("warn");
		expect(loadStructuralMetricPolicy(project(undefined, undefined, "enforced"), "cyclomatic").mode).toBe("block");
	});
	it("fails toward existing enforcement on an invalid legacy posture", () => {
		const policy = loadStructuralMetricPolicy(project(undefined, undefined, "invalid"), "cyclomatic");
		expect(policy.mode).toBe("block");
		expect(policy.issues.join(" ")).toContain("Invalid edit_metrics");
	});
	it("uses canonical cap overrides and a distinct reporting target", () => {
		const root = project({ metrics: { cyclomatic: { mode: "warn", threshold: 40 } } });
		writeFileSync(join(root, ".interlinked/metric-caps.json"), JSON.stringify({ max_cyclomatic: 12 }));
		expect(loadStructuralMetricPolicy(root, "cyclomatic").threshold).toBe(40);
		expect(loadStructuralMetricPolicy(root, "cyclomatic").thresholdKind).toBe("reporting-target");
	});
	it("keeps local overrides from weakening an adopted team block", () => {
		const root = project({ metrics: { cyclomatic: { mode: "block", threshold: 10 } } }, { metrics: { cyclomatic: { mode: "off", threshold: 50 } } });
		const policy = loadStructuralMetricPolicy(root, "cyclomatic");
		expect(policy.mode).toBe("block");
		expect(policy.threshold).toBe(10);
		expect(policy.issues.join(" ")).toContain("local");
	});
	it("keeps a newly created local off from disabling inherited enforcement", () => {
		const root = project(undefined, { metrics: { cyclomatic: { mode: "off" } } }, "enforced");
		expect(loadStructuralMetricPolicy(root, "cyclomatic").mode).toBe("block");
	});
	it("allows a local tightening and an explicit user-owned team mode", () => {
		const tightened = project({ metrics: { cyclomatic: { mode: "block", threshold: 15 } } }, { metrics: { cyclomatic: { threshold: 10 } } });
		expect(loadStructuralMetricPolicy(tightened, "cyclomatic").threshold).toBe(10);
		const userMode = project({ metrics: { cyclomatic: { mode: "off" } } }, undefined, "enforced");
		expect(loadStructuralMetricPolicy(userMode, "cyclomatic").mode).toBe("off");
	});
});
