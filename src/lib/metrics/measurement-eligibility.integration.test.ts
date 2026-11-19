import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { metricsPoliciesEvaluateCommand } from "../../commands/metrics-policies.js";
import { metricsScoreCommand } from "../../commands/metrics-score.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(process.cwd(), "scratch", "measurement-eligibility-"));
	roots.push(root);
	const files = {
		"index.ts": "export function unsafe(value: any) { return value.trim(); }",
		"broken.ts": "export function broken(value: any) { value.trim();",
		"worker.rb": "def worker; 1; end\n",
		"test/smoke.sh": "#!/bin/sh\nprintf ok\n",
		"test/README.md": "# Manual test procedures\n",
		"test/reports/.gitkeep": "",
		"test/input.json": "{}",
		"test/index.test.ts": "declare function test(name: string, callback: () => void): void;\ntest('case', () => {});",
		"package.json": JSON.stringify({ scripts: { test: "touch TARGET_SCRIPT_EXECUTED" } }),
	};
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}
function capture(run: () => void) {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	run();
	expect(error.mock.calls).toEqual([]);
	expect(process.exitCode ?? 0).toBe(0);
	return JSON.parse(String(log.mock.calls[0]?.[0]));
}

describe.each(["score", "policy"])("%s public measurement eligibility", command => {
	// User requirement: report genuine unavailable code without treating test-location docs as executable source.
	it("retains role-bound exclusions, unsupported code and parse gaps in complete JSON", () => {
		const root = fixture();
		const output = capture(() => command === "score"
			? metricsScoreCommand({ cwd: root, json: true })
			: metricsPoliciesEvaluateCommand(undefined, { cwd: root, json: true }));
		const report = command === "score" ? output : output.measurements;
		expect(report.modelCalls).toBe(0);
		expect(report.scope).toMatchObject({ eligibleFiles: 3, measuredFiles: 1, functions: 1, discoveryIssues: [] });
		expect(report.scope.notMeasured.map((gap: { path: string }) => gap.path)).toEqual(["broken.ts", "test/smoke.sh", "worker.rb"]);
		expect(report.scope.exclusions).toEqual([
			expect.objectContaining({ path: "test/README.md", role: "test" }),
			expect.objectContaining({ path: "test/input.json", role: "test" }),
			expect.objectContaining({ path: "test/reports/.gitkeep", role: "test" }),
		]);
		const typed = report.metrics.find((metric: { id: string }) => metric.id === "types.unsafe");
		expect(typed.state).toBe("inconclusive");
		expect(typed.limitations.some((reason: string) => reason.includes("broken.ts") && reason.includes("syntactic"))).toBe(true);
		expect(report.findings.filter((finding: { metric: string }) => finding.metric === "types.unsafe").every((finding: { file: string }) => finding.file === "index.ts")).toBe(true);
		expect(existsSync(join(root, "TARGET_SCRIPT_EXECUTED"))).toBe(false);
		if (command === "policy") {
			expect(output.scope.inputHash).toBe(output.scope.metricInputHash);
			expect(output.scope.files).toBe(9);
		} else {
			expect(output.actions.actions.some((action: { evidence: { check: string; file: string }[] }) =>
				action.evidence.some(row => row.check === "source_measurement" && row.file === "test/README.md"))).toBe(false);
		}
	});
});
