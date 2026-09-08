// ===========================================
// tool-results mutation-kill suite (wave 40)
// ===========================================
// Targets survivors in the private helpers of tool-results.ts:
//   - buildUndocumentedEnvIssues: outer (var-name) and inner (file/line) sort
//   - collectModuleExports: ext-case matching, .d.ts skip, export-name mapping
//   - applyParityFindings: files_without_test issue construction
//   - applyPersistedSuppressions: filtering persisted file suppressions
//   - runCodeQualityChecks: piiOpts conditional-spread construction

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCodeQualityChecks } from "./tool-results.js";

let tempDir: string;
let counter = 0;
const savedInterlinkedHome = process.env.INTERLINKED_HOME;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), `tool-results-w40-${process.pid}-${++counter}-`));
	delete process.env.INTERLINKED_HOME;
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	if (savedInterlinkedHome === undefined) delete process.env.INTERLINKED_HOME;
	else process.env.INTERLINKED_HOME = savedInterlinkedHome;
});

function fixture(relPath: string, content: string): string {
	const abs = join(tempDir, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
	return abs;
}

describe("buildUndocumentedEnvIssues — sort comparators (via runCodeQualityChecks)", () => {
	// test-contract: invariant — the inner per-var sort must actually reorder
	// out-of-order refs so `firstRef` is the lexicographically-earliest file.
	it("sorts multi-file refs for the same var by filename regardless of encounter order", () => {
		const v = `UNDOC_ORDER_${process.pid}_${counter}`;
		// Processed in files-array order c, a, b — a real comparator must pull
		// "a.ts" to the front; a no-op/always-equal/always-swap comparator won't.
		const c = fixture("c.ts", `export const cc = process.env.${v};\n`);
		const a = fixture("a.ts", `export const aa = process.env.${v};\n`);
		const b = fixture("b.ts", `export const bb = process.env.${v};\n`);
		const r = runCodeQualityChecks([c, a, b], tempDir);
		const issue = r.undocumentedEnvVars.find((i) => i.message.includes(v));
		expect(issue).toBeDefined();
		expect(issue?.file).toBe("a.ts");
	});

	// test-contract: invariant — the outer sort over env-var names must order
	// the emitted issues alphabetically, not by first-encounter order.
	it("sorts issues alphabetically by env var name regardless of encounter order", () => {
		const zVar = `ZVAR_ORDER_${process.pid}_${counter}`;
		const aVar = `AVAR_ORDER_${process.pid}_${counter}`;
		// z is referenced before a in source order (and thus Map insertion order).
		const f = fixture(
			"envs.ts",
			`export const z = process.env.${zVar};\nexport const a = process.env.${aVar};\n`,
		);
		const r = runCodeQualityChecks([f], tempDir);
		const idxZ = r.undocumentedEnvVars.findIndex((i) => i.message.includes(zVar));
		const idxA = r.undocumentedEnvVars.findIndex((i) => i.message.includes(aVar));
		expect(idxZ).toBeGreaterThan(-1);
		expect(idxA).toBeGreaterThan(-1);
		expect(idxA).toBeLessThan(idxZ);
	});
});

describe("collectModuleExports — via mock_drift integration (runCodeQualityChecks)", () => {
	// test-contract: public-api — a normal .ts module's exports must be cached
	// (case-insensitive extension match) so an undeclared mock name is flagged.
	it("caches exports for a normal .ts module and flags an undeclared mocked name", () => {
		const mod = fixture("real-module.ts", "export function present() {}\n");
		const spec = fixture(
			"subject.test.ts",
			'vi.mock("./real-module.js", () => ({ ghost: vi.fn() }));\n',
		);
		const r = runCodeQualityChecks([mod, spec], tempDir);
		expect(r.mockDrift.length).toBe(1);
		expect(r.mockDrift[0]?.message).toContain('mock references "ghost"');
	});

	// test-contract: public-api — the cached export list must contain the real
	// export NAME (not `undefined`), so a mock of an actually-exported symbol
	// is not flagged as drift.
	it("does not flag a mocked name that is a real export", () => {
		const mod = fixture("real-module.ts", "export function present() {}\n");
		const spec = fixture(
			"subject-ok.test.ts",
			'vi.mock("./real-module.js", () => ({ present: vi.fn() }));\n',
		);
		const r = runCodeQualityChecks([mod, spec], tempDir);
		expect(r.mockDrift.length).toBe(0);
	});

	// test-contract: boundary — `.d.ts` declaration files must NOT be cached
	// as module exports; a mock of an undeclared name in a `.d.ts` module
	// must stay silent (no cache entry -> the `continue` guard fires).
	it("does not cache exports declared in a .d.ts file", () => {
		fixture("types.d.ts", "export declare const ghostVal: number;\n");
		// Exact-match specifier so resolution doesn't depend on .js->.ts mapping.
		const spec = fixture(
			"subject-dts.test.ts",
			'vi.mock("./types.d.ts", () => ({ ghostBad: vi.fn() }));\n',
		);
		const r = runCodeQualityChecks([join(tempDir, "types.d.ts"), spec], tempDir);
		expect(r.mockDrift.length).toBe(0);
	});
});

describe("applyParityFindings — files_without_test issue shape", () => {
	// test-contract: public-api — every field of the pushed issue (check id,
	// relativized file, line, and rendered message) must match exactly.
	it("emits a fully-populated files_without_test issue for an orphan source file", () => {
		const f = fixture("orphan.ts", "export function orphan() { return 1; }\n");
		const r = runCodeQualityChecks([f], tempDir);
		expect(r.filesWithoutTest.length).toBe(1);
		const issue = r.filesWithoutTest[0];
		expect(issue?.check).toBe("files_without_test");
		expect(issue?.file).toBe("orphan.ts");
		expect(issue?.line).toBe(0);
		expect(issue?.message).toBe("No test file on disk (expected orphan.test.ts).");
	});
});

describe("applyPersistedSuppressions — filtering", () => {
	// test-contract: public-api — a persisted suppression entry for a file+check
	// must remove that issue from the corresponding result bucket.
	it("filters a flagged issue when a matching suppression entry is on disk", () => {
		fixture(
			".interlinked/verify-suppressions.json",
			JSON.stringify({ "bad.ts": { strong_typing: { reason: "reviewed boundary fixture", by: "reviewer", at: "2026-09-08T12:00:00Z" } } }),
		);
		const f = fixture("bad.ts", "export function foo(x: any): any { return x; }\n");
		const r = runCodeQualityChecks([f], tempDir);
		expect(r.strongTyping).toEqual([]);
	});

});

describe("runCodeQualityChecks — piiOpts conditional-spread construction", () => {
	// test-contract: public-api — pii_opt_in from shared config must actually
	// activate the named opt-in PII pattern (email), not be dropped silently.
	it("activates the opt-in email PII pattern from .interlinked/config.json", () => {
		fixture(".interlinked/config.json", JSON.stringify({ pii_opt_in: ["email"] }));
		const f = fixture("svc.ts", "export const contact = 'someone@company.org';\n");
		const r = runCodeQualityChecks([f], tempDir);
		expect(r.piiDetection.some((i) => i.message.toLowerCase().includes("email"))).toBe(true);
	});
});
