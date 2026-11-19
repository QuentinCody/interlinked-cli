import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectMetricPolicyLoosening } from "./metric-policy-integrity.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(globalMode?: string): string {
	const root = mkdtempSync(join(tmpdir(), "metric-policy-integrity-"));
	roots.push(root); mkdirSync(join(root, ".interlinked"));
	if (globalMode) writeFileSync(join(root, ".interlinked/config.json"), JSON.stringify({ harness: { edit_metrics: { mode: globalMode } } }));
	return root;
}
const document = (entry: unknown) => JSON.stringify({ metrics: { cyclomatic: entry } });
const findings = (root: string, before: string | null, after: string | null, file = "check-policy.json") =>
	detectMetricPolicyLoosening(join(root, ".interlinked", file), before, after, { root });

describe("adopted metric policy integrity", () => {
	it.each([null, "{broken", "{}"])("protects inherited adoption when shared config is removed or malformed %s", after => {
		const root = project("enforced");
		writeFileSync(join(root, ".interlinked/check-policy.json"), document({ threshold: 10 }));
		const before = JSON.stringify({ harness: { edit_metrics: { mode: "enforced" } } });
		expect(findings(root, before, after, "config.json").map(row => row.rule)).toContain("metric-policy:cyclomatic:mode");
	});
	it.each(["off", "warn", "report"])("detects team block weakened to %s", mode => {
		expect(findings(project(), document({ mode: "block" }), document({ mode }))).toEqual([
			expect.objectContaining({ rule: "metric-policy:cyclomatic:mode" }),
		]);
	});
	it("compares effective thresholds against the same canonical cap", () => {
		const root = project();
		writeFileSync(join(root, ".interlinked/metric-caps.json"), JSON.stringify({ max_cyclomatic: 12 }));
		expect(findings(root, document({ mode: "block", threshold: 20 }), document({ mode: "block", threshold: 50 }))).toEqual([]);
		expect(findings(root, document({ mode: "block", threshold: 5 }), document({ mode: "block", threshold: 20 }))).toEqual([
			expect.objectContaining({ rule: "metric-policy:cyclomatic:threshold" }),
		]);
	});
	it("protects an existing target when the team file is malformed or removed", () => {
		const root = project();
		for (const after of ["{broken", null]) expect(findings(root, document({ mode: "block", threshold: 5 }), after).map(row => row.rule)).toContain("metric-policy:cyclomatic:mode");
	});
	it("does not turn unrelated historical check changes into water-lines", () => {
		const root = project("enforced");
		const before = JSON.stringify({ checks: { test_without_description: { action: "warn_after" } } });
		expect(findings(root, before, JSON.stringify({ checks: { test_without_description: { action: "silent" } } }))).toEqual([]);
		expect(findings(root, before, null)).toEqual([]);
	});
	it("protects inherited enforcement against a newly created team override", () => {
		expect(findings(project("enforced"), null, document({ mode: "off" })).map(row => row.rule)).toContain("metric-policy:cyclomatic:mode");
	});
	it("keeps a newly created personal off inert under inherited enforcement", () => {
		expect(findings(project("enforced"), null, document({ mode: "off" }), "check-policy.local.json")).toEqual([]);
	});
	it("protects a locally tightened target against removal", () => {
		const root = project();
		writeFileSync(join(root, ".interlinked/check-policy.json"), document({ mode: "block", threshold: 20 }));
		expect(findings(root, document({ threshold: 5 }), null, "check-policy.local.json").map(row => row.rule)).toContain("metric-policy:cyclomatic:threshold");
	});
	it("proves a scope union and a broader replacement without guessing overlap", () => {
		const root = project();
		const before = document({ mode: "block", scope: { paths: ["src/*.ts"] } });
		expect(findings(root, before, document({ mode: "block", scope: { paths: ["src/**", "scripts/**"] } }))).toEqual([]);
		expect(findings(root, document({ mode: "block", scope: { paths: ["src/**"] } }), document({ mode: "block", scope: { paths: ["src/a.ts"] } })).map(row => row.rule)).toContain("metric-policy:cyclomatic:scope");
	});
	it("retains unresolved adopted-scope comparisons explicitly", () => {
		const root = project();
		expect(findings(root, document({ mode: "block", scope: { paths: ["src/*.ts"] } }), document({ mode: "block", scope: { paths: ["src/!(test).ts"] } })).map(row => row.rule)).toContain("metric-policy:cyclomatic:scope-unproven");
	});
	it("uses before and after companion documents for a multi-file tightening", () => {
		const root = project();
		const file = join(root, ".interlinked/check-policy.local.json");
		const result = detectMetricPolicyLoosening(file, document({ threshold: 5 }), null, {
			root,
			readBefore: path => path === ".interlinked/check-policy.json" ? document({ mode: "block", threshold: 20 }) : null,
			readAfter: path => path === ".interlinked/check-policy.json" ? document({ mode: "block", threshold: 4 }) : null,
		});
		expect(result).toEqual([]);
	});
});
