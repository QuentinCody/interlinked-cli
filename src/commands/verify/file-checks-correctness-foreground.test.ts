import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InlineMatch } from "../../harness/check-registry/types.js";
import { CHECK_REGISTRY } from "../../harness/check-registry/index.js";
import * as correctness from "../../harness/checks/agent-safety-js-correctness.js";
import * as asynchronous from "../../harness/checks/agent-safety-async.js";
import * as crypto from "../../harness/checks/agent-safety-crypto.js";
import { runAgentSafetyChecks } from "./file-checks-agent-safety.js";
import { runUbsChecks } from "./file-checks-ubs.js";
import { emptyResults } from "./tool-results-types.js";
import { runCodeQualityChecks } from "./tool-results.js";
import { withVerifyTimings } from "./check-timing.js";
import { outputJson } from "./output-json.js";

const cases = [
	{ id: "nan_comparison", bucket: "nanComparison", runner: runAgentSafetyChecks,
		mock: (matches: InlineMatch[]) => vi.spyOn(correctness, "checkNanComparison").mockReturnValue(matches),
		source: (index: number) => `if (value${index} === NaN) recover();` },
	{ id: "async_promise_executor", bucket: "asyncPromiseExecutor", runner: runAgentSafetyChecks,
		mock: (matches: InlineMatch[]) => vi.spyOn(asynchronous, "checkAsyncPromiseExecutor").mockReturnValue(matches),
		source: (index: number) => `const promise${index} = new Promise(async (resolve) => { resolve(1); });` },
	{ id: "unsafe_optional_chaining", bucket: "unsafeOptionalChaining", runner: runAgentSafetyChecks,
		mock: (matches: InlineMatch[]) => vi.spyOn(correctness, "checkUnsafeOptionalChaining").mockReturnValue(matches),
		source: (index: number) => `const value${index} = (record?.field).name;` },
	{ id: "ubs_tls_verify_disabled", bucket: "tlsVerifyDisabled", runner: runUbsChecks,
		mock: (matches: InlineMatch[]) => vi.spyOn(crypto, "checkTlsVerifyDisabled").mockReturnValue(matches),
		source: (index: number) => `const request${index} = { rejectUnauthorized: false };` },
] as const;

let root: string;
let previousExit: typeof process.exitCode;
beforeEach(() => {
	root = mkdtempSync(join(process.cwd(), "scratch", "verify-correctness-results-"));
	previousExit = process.exitCode;
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = previousExit;
	rmSync(root, { recursive: true, force: true });
});

describe.each(cases)("$id foreground verify collection", entry => {
	it("P1 retains all results above the JavaScript append argument ceiling", () => {
		const matches = Array.from({ length: 150_001 }, (_, index) => ({ line: index + 1, text: "Retained collection observation" }));
		entry.mock(matches);
		const results = emptyResults();
		entry.runner({ file: join(root, "selection.ts"), content: "", relPath: "selection.ts", cwd: root, r: results, piiOpts: {} });
		expect(results[entry.bucket]).toHaveLength(matches.length);
		expect(results[entry.bucket].at(-1)).toMatchObject({ check: entry.id, line: 150_001 });
	});

	it("P2 retains twenty real observations and the tail through public verify and JSON actions", async () => {
		const file = join(root, "selection.ts");
		writeFileSync(file, Array.from({ length: 20 }, (_, index) => entry.source(index)).join("\n"));
		const skipChecks = new Set(CHECK_REGISTRY.filter(check => check.id !== entry.id).map(check => check.id));
		const cq = await withVerifyTimings(root, () => runCodeQualityChecks([file], root), { skipChecks });
		expect(cq[entry.bucket].map(row => row.line)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		outputJson({ tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [], auditResult: null,
			cq, suggestions: null, totalFiles: 1 });
		const report = JSON.parse(stdout.mock.calls.map(call => String(call[0])).join(""));
		const actions = report.actions.actions.filter((action: { evidence: { check: string }[] }) => action.evidence.some(row => row.check === entry.id));
		expect(actions).toHaveLength(20);
		expect(actions.some((action: { line: number }) => action.line === 20)).toBe(true);
	});
});
