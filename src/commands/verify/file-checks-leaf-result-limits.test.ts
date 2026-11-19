import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as detector from "../../harness/checks/agent-laziness-endpoint.js";
import { getEffectiveSkipChecks } from "./advisory-skips.js";
import { withVerifyTimings } from "./check-timing.js";
import { runEndpointAndLazinessChecks } from "./file-checks-endpoint-laziness.js";
import { outputJson } from "./output-json.js";
import { runCodeQualityChecks } from "./tool-results.js";
import { emptyResults } from "./tool-results-types.js";

let root: string;
let previousExitCode: typeof process.exitCode;
beforeEach(() => {
	root = mkdtempSync(join(process.cwd(), "scratch", "verify-leaf-results-"));
	previousExitCode = process.exitCode;
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = previousExitCode;
	rmSync(root, { recursive: true, force: true });
});

it("P1: retains double-cast results above the JavaScript call-argument ceiling", () => {
	const matches = Array.from({ length: 150_000 }, (_, index) => ({ line: index + 1, text: "collection control" }));
	vi.spyOn(detector, "checkDoubleCastUnknown").mockReturnValue(matches);
	const results = emptyResults();
	runEndpointAndLazinessChecks({ file: join(root, "app.ts"), content: "", relPath: "app.ts", cwd: root, r: results, piiOpts: {} });
	expect(results.doubleCastUnknown).toHaveLength(150_000);
	expect(results.doubleCastUnknown.at(-1)).toMatchObject({ check: "double_cast_unknown", line: 150_000 });
});

it("P2: retains twenty real double-cast observations in public collection, JSON and actions", async () => {
	const file = join(root, "app.ts");
	writeFileSync(file, Array.from({ length: 20 }, (_, index) => `const value${index} = input as unknown as Model;`).join("\n"));
	const results = await withVerifyTimings(root, () => runCodeQualityChecks([file], root), { skipChecks: getEffectiveSkipChecks(undefined, true) });
	expect(results.doubleCastUnknown.map(row => row.line)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	outputJson({ tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [], auditResult: null, cq: results, suggestions: null, totalFiles: 1 });
	const report = JSON.parse(stdout.mock.calls.map(call => String(call[0])).join(""));
	expect(report.double_cast_unknown.issues).toBe(20);
	const actions = report.actions.actions.filter((action: { evidence: { check: string }[] }) => action.evidence.some(evidence => evidence.check === "double_cast_unknown"));
	expect(actions).toHaveLength(20);
	expect(actions.some((action: { line: number }) => action.line === 20)).toBe(true);
});
