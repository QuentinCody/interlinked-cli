import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCheckPolicy } from "./check-policy.js";
import { loadCoverageFinal, loadCoverageFinalSummary } from "./coverage-final-reader.js";
import { loadCoverageSummary } from "./coverage-ratchet.js";
import { loadFileSuppressions, loadSuppressionFile } from "./suppressions.js";

let root: string;
let configDir: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-parser-boundaries-"));
	configDir = join(root, ".interlinked");
	mkdirSync(configDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("coverage report boundaries", () => {
	it("retains valid partial metrics beside malformed file entries", () => {
		const report = join(root, "summary.json");
		writeFileSync(report, JSON.stringify({
			"good.ts": { lines: { pct: 75, covered: 3, total: 4 } },
			"wrong-pct.ts": { lines: { pct: "75" } },
			"wrong-count.ts": { branches: { pct: 50, total: [] } },
			"null.ts": null,
		}));
		expect(loadCoverageSummary(report)).toEqual({ "good.ts": { lines: { pct: 75, covered: 3, total: 4 } } });
	});

	it.each([
		{ fnMap: { "0": null } },
		{ statementMap: { "0": { start: { line: "1" } } } },
		{ s: { "0": "1" } },
		{ b: "invalid branch map" },
	])("skips malformed nested Istanbul data without losing valid neighbors: %j", (invalid) => {
		const report = join(root, "final.json");
		const good = {
			statementMap: { "0": { start: { line: 1 }, end: { line: 2 } } },
			s: { "0": 0 },
		};
		writeFileSync(report, JSON.stringify({ "good.ts": good, "bad.ts": { ...good, ...invalid } }));
		expect([...loadCoverageFinal(report, root) ?? []].map(([file]) => file)).toEqual(["good.ts"]);
		expect(loadCoverageFinalSummary(report, root)).toEqual({
			"good.ts": { lines: { pct: 0, covered: 0, total: 1 }, branches: { pct: 100, covered: 0, total: 0 } },
		});
	});

	it("rejects a non-finite line endpoint before expanding an uncovered range", () => {
		const report = join(root, "final.json");
		writeFileSync(report, '{"bad.ts":{"statementMap":{"0":{"start":{"line":1},"end":{"line":1e999}}},"s":{"0":0}}}');
		expect(loadCoverageFinal(report, root)?.size).toBe(0);
		expect(loadCoverageFinalSummary(report, root)).toBeNull();
	});
});

describe("policy and suppression boundaries", () => {
	it.each([
		{ defaults: { action: "unexpected" } },
		{ checks: { check: { when: { paths: [5] } } } },
		{ overrides: { check: { escalate: { after_warnings_gte: "2", then: "ask" } } } },
		{ coverage_ratchet: { enabled: "false" } },
		{ mutation_gate: { schedule: "on_edit" } },
	])("ignores malformed local policy while retaining the team policy: %j", (invalid) => {
		writeFileSync(join(configDir, "check-policy.json"), JSON.stringify({ defaults: { action: "ask", scope: "project" } }));
		writeFileSync(join(configDir, "check-policy.local.json"), JSON.stringify(invalid));
		expect(loadCheckPolicy(root).defaults).toEqual({ action: "ask", scope: "project" });
	});

	it("keeps valid suppressions beside malformed records", () => {
		const entry = { reason: "reviewed", by: "cli", at: "2026-09-08" };
		writeFileSync(join(configDir, "verify-suppressions.json"), JSON.stringify({
			"src/a.ts": { valid: entry, malformed: { ...entry, reason: false }, missing: {} },
			"src/b.ts": [entry],
		}));
		expect([...loadFileSuppressions(configDir, "src/a.ts")]).toEqual(["valid"]);
		expect(loadSuppressionFile(configDir)).toEqual({ "src/a.ts": { valid: entry } });
	});
});
