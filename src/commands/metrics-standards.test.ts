import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { metricsStandardsCommand } from "./metrics-standards.js";
import type { StandardsReport } from "../lib/standards/census.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "standards-command-"))); roots.push(root);
	writeFileSync(join(root, "source.ts"), "/** The boundary. */\nexport function parse(input: string) { return JSON.parse(input) as any; }");
	return root;
}

it.each(["json", "full"] as const)("retains every standard, occurrence and source unit in %s output", mode => {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	metricsStandardsCommand({ cwd: fixture(), [mode]: true });
	const report: StandardsReport = JSON.parse(String(log.mock.calls[0]?.[0]));
	expect(report.standards).toHaveLength(35);
	expect(report.occurrences.length).toBeGreaterThan(0);
	for (const row of report.occurrences) expect(report.actions.actions.some(action => action.evidence.some(evidence => evidence.evidenceRefs?.includes(row.id)))).toBe(true);
	expect(report.units[0]?.comment).toBe("/** The boundary. */");
	expect(report.units[0]?.context.callers).toBe("not_collected");
	expect(report.modelCalls).toBe(0);
});

it("renders every standard in normal output and one bounded summary in short output", () => {
	const log = vi.spyOn(console, "log").mockImplementation(() => {}), cwd = fixture();
	metricsStandardsCommand({ cwd });
	const normal = String(log.mock.calls[0]?.[0]);
	for (let index = 1; index <= 35; index++) expect(normal).toContain(`s${String(index).padStart(2, "0")} `);
	expect(normal).toContain("measurements");
	expect(normal).toContain("review candidates");
	expect(normal).toContain("evidence gaps");
	metricsStandardsCommand({ cwd, short: true });
	const short = String(log.mock.calls[1]?.[0]);
	expect(short).not.toContain("\n");
	expect(short.length).toBeLessThan(400);
	expect(short).toContain("35 standards");
});

it.each([{ profile: "absent" }, { scope: "absent" }])("rejects invalid selection before source access %j", options => {
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	metricsStandardsCommand({ ...options, cwd: "/does-not-exist", json: true });
	expect(JSON.parse(String(error.mock.calls[0]?.[0])).error).toMatch(/Unknown standards profile|Standards scope/);
	expect(process.exitCode).toBe(1);
});
