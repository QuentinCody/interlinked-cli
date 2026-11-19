import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkActions } from "../../lib/check-actions.js";
import { runQualityChecks } from "../../harness/quality-checks.js";
import type { HarnessEvent } from "../../harness/types.js";
import { getEffectiveSkipChecks } from "./advisory-skips.js";
import { timingSnapshot, withVerifyTimings, type VerifyCheckTiming } from "./check-timing.js";
import { runCodeQualityChecks } from "./tool-results.js";

let root: string;
let exitCode: typeof process.exitCode;
beforeEach(() => {
	root = mkdtempSync(join(process.cwd(), "scratch", "api-boundary-independent-"));
	exitCode = process.exitCode;
});
afterEach(() => {
	process.exitCode = exitCode;
	rmSync(root, { recursive: true, force: true });
});

async function collect(sources: Record<string, string>, allChecks = true) {
	const files = Object.entries(sources).map(([name, source]) => {
		const file = join(root, name);
		writeFileSync(file, source);
		return file;
	});
	let coverage: VerifyCheckTiming[] = [];
	const results = await withVerifyTimings(root, () => runCodeQualityChecks(files, root), {
		skipChecks: getEffectiveSkipChecks(undefined, allChecks),
		onFinish: run => { coverage = timingSnapshot(run); },
	});
	return { results, coverage };
}

describe("independent existing advisory producer integration", () => {
	it("reports an omitted private input on a consumer edit and in an explicit audit; the default audit skips it", async () => {
		const source = 'function label(text, width = 80) { return text.slice(0, width); }\nexport const heading = label("hello");';
		const files = { "labels.mjs": source };
		const { results } = await collect(files);
		expect(results.omittedPrivateParameter).toEqual([expect.objectContaining({ file: "labels.mjs", line: 1, message: expect.stringContaining("width") })]);
		expect((await collect(files, false)).results.omittedPrivateParameter).toEqual([]);
		const file = join(root, "labels.mjs");
		const event: HarnessEvent = {
			hook_event: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file },
			session_id: "private-input", cwd: root, agent_source: "claude", timestamp: "2026-11-18T12:00:00.000Z",
		};
		const warnings = await runQualityChecks(event, {}, root);
		expect(warnings).toContainEqual(expect.objectContaining({ name: "omitted_private_parameter", severity: "warning", detail: expect.stringContaining("width") }));
	});
	it("P1 retains both same-line boundary shapes as original action evidence", async () => {
		const content = "export async function read(response) { const data = await response.json(); return [data, process.argv[2]]; }";
		const { results } = await collect({ "service.ts": content });
		const rows = results.unvalidatedInputBoundary;
		expect(rows).toHaveLength(2);
		expect(rows.map(row => row.line)).toEqual([1, 1]);
		expect(rows.some(row => row.message.includes(".json()"))).toBe(true);
		expect(rows.some(row => row.message.includes("process.argv"))).toBe(true);
		const actions = checkActions(rows);
		expect(actions.observations).toBe(2);
		expect(actions.actions.flatMap(action => action.evidence)).toHaveLength(2);
		for (const row of actions.actions.flatMap(action => action.evidence)) {
			expect(row).toMatchObject({ classification: "candidate", file: "service.ts", line: 1,
				sourceHash: createHash("sha256").update(content).digest("hex"), policyHash: null });
		}
	});

	it("N1 leaves JSDoc overload, destructured and rest parameters outside its established comparison", async () => {
		const { results } = await collect({ "documented.ts": [
			"/** @param obsolete retained external documentation */",
			"export function overload(current: string): string;",
			"export function overload(current: string) { return current; }",
			"/** @param obsolete object contract */",
			"export function destructured({ current }: { current: string }) { return current; }",
			"/** @param obsolete variadic contract */",
			"export function variadic(...current: string[]) { return current; }",
		].join("\n") });
		expect(results.jsdocParamDrift).toEqual([]);
	});

	it("P2 keeps a valid sibling candidate beside actual JSDoc parse recovery", async () => {
		const { results, coverage } = await collect({
			"broken.ts": "/** @param previous old name */\nexport function broken(current: string) { return current; }\nfunction unfinished( {",
			"valid.ts": "interface Hidden { value: string }\nexport function reveal(): Hidden { return { value: 'ok' }; }",
		});
		expect(results.jsdocParamDrift).toEqual([]);
		expect(results.publicApiLeaksInternalType).toEqual(expect.arrayContaining([expect.objectContaining({ file: "valid.ts" })]));
		expect(coverage.find(row => row.check === "jsdoc_param_drift")).toMatchObject({ skipped: 1,
			unavailable_inputs: [expect.objectContaining({ file: "broken.ts", reason: expect.stringContaining("recovery") })] });
		expect(process.exitCode).toBe(75);
	});

	it("N2 keeps default advisory selection from creating unavailable parser claims", async () => {
		const { results, coverage } = await collect({ "broken.ts": "/** @param old description */\nfunction unfinished( {" }, false);
		expect(results.jsdocParamDrift).toEqual([]);
		for (const check of ["public_api_leaks_internal_type", "jsdoc_param_drift", "unvalidated_input_boundary"]) {
			expect(coverage.some(row => row.check === check)).toBe(false);
		}
	});

	it("N3 suppresses both same-line boundary shapes through the normal rationale filter", async () => {
		const { results } = await collect({ "service.ts": [
			"// interlinked-ignore: unvalidated_input_boundary — this adapter intentionally returns raw inputs",
			"export async function read(response) { return [await response.json(), process.argv[2]]; }",
		].join("\n") });
		expect(results.unvalidatedInputBoundary).toEqual([]);
	});
});
