import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { getNumericZeroDefaultEvidence } from "../checks/numeric-zero-default-evidence.js";
import { runQualityChecks } from "../quality-checks.js";
import type { HarnessEvent } from "../types.js";
import type { HarnessDecision } from "../types.js";
import { collectQualityResultEntries } from "../server/post-tool-file-checks-phases-quality.js";
import { appendCheckResults } from "../check-results-sink.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("retains helper-only numeric facts and partial coverage as nonblocking runtime advice", async () => {
	const root = mkdtempSync(join(process.cwd(), "scratch", "numeric-zero-hook-")); roots.push(root);
	const helper = join(root, "parser.ts"), caller = join(root, "caller.ts");
	writeFileSync(helper, 'export const parseCount = raw => Number(raw);');
	writeFileSync(caller, 'import { parseCount } from "./parser.js";\nconst count = parseCount(raw) || 2;');
	const event: HarnessEvent = { hook_event: "PostToolUse", tool_name: "Edit", tool_input: { file_path: helper }, session_id: "numeric-zero-control", cwd: root, agent_source: "claude", timestamp: "2026-11-12T00:00:00Z" };
	const results = await runQualityChecks(event, {}, root, { numericZeroEvidence: { root, importers: () => ({ files: [caller], complete: false, reason: "maintained candidate index" }), readFile: file => readFileSync(file, "utf8") } });
	expect(results).toContainEqual(expect.objectContaining({ name: "numeric_zero_default", severity: "warning", detail: expect.stringContaining("caller.ts:2") }));
	expect(results).toContainEqual(expect.objectContaining({ name: "numeric_zero_default", severity: "warning", measurementState: "unavailable", findingCount: 0, message: expect.stringContaining("NOT MEASURED"), detail: expect.stringContaining("partial") }));
	expect(getNumericZeroDefaultEvidence()).toBeUndefined();
	const finding = results.find(row => row.name === "numeric_zero_default" && row.measurementState !== "unavailable");
	expect(finding?.sourceEvidence).toEqual(expect.arrayContaining([
		expect.objectContaining({ file: "parser.ts", role: "producer", sha256: createHash("sha256").update(readFileSync(helper, "utf8")).digest("hex") }),
		expect.objectContaining({ file: "caller.ts", role: "consumer", line: 2 }),
	]));
	const decision: HarnessDecision = { decision: "allow", check_results: [] };
	collectQualityResultEntries(results, decision.check_results!);
	appendCheckResults(root, event, decision);
	const retained = JSON.parse(readFileSync(join(root, ".interlinked", "check-results.jsonl"), "utf8").trim());
	expect(retained.schema).toBe("check-results.v2");
	expect(retained.finding_details).toContainEqual(expect.objectContaining({ name: "numeric_zero_default", sourceEvidence: finding?.sourceEvidence }));
	expect(retained.finding_details).toContainEqual(expect.objectContaining({ name: "numeric_zero_default", measurementState: "unavailable", findingCount: 0 }));
});

it("retains local numeric mutation notices without querying unrelated importers", async () => {
	const root = mkdtempSync(join(process.cwd(), "scratch", "numeric-zero-hook-local-")); roots.push(root);
	const file = join(root, "index.ts");
	writeFileSync(file, 'Number.parseInt = other; const count = Number.parseInt(raw, 10) || 2;');
	let queries = 0;
	const event: HarnessEvent = { hook_event: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file }, session_id: "numeric-zero-local-control", cwd: root, agent_source: "claude", timestamp: "2026-11-12T00:00:00Z" };
	const results = await runQualityChecks(event, {}, root, { numericZeroEvidence: { root, importers: () => { queries++; return { files: [], complete: false }; } } });
	expect(results).toContainEqual(expect.objectContaining({ name: "numeric_zero_default", measurementState: "unavailable", findingCount: 0, detail: expect.stringContaining("mutation") }));
	expect(queries).toBe(0);
});
