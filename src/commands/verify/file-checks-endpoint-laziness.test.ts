// ===========================================
// file-checks endpoint-security / agent-laziness group unit tests
// ===========================================

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { type FileCheckContext, runPerFileChecks } from "./file-checks.js";
import { runEndpointAndLazinessChecks } from "./file-checks-endpoint-laziness.js";
import { type CodeQualityResults, emptyResults } from "./tool-results-types.js";

function ctx(content: string, file = "/tmp/sample.ts"): FileCheckContext {
	return { file, content, relPath: "sample.ts", cwd: "/tmp", r: emptyResults(), piiOpts: {} };
}

function orchestrate(content: string, file = "/tmp/sample.ts"): CodeQualityResults {
	const r = emptyResults();
	runPerFileChecks({
		file,
		content,
		cwd: "/tmp",
		r,
		moduleExportsCache: new Map(),
		allEnvRefs: new Map(),
		piiOpts: {},
	});
	return r;
}

describe("runEndpointAndLazinessChecks", () => {
	it("flags a not-implemented stub throw (stub_not_implemented_throw)", () => {
		const c = ctx('function handler() { throw new Error("not implemented"); }\n');
		runEndpointAndLazinessChecks(c);
		expect(c.r.stubNotImplementedThrow.length).toBeGreaterThan(0);
		expect(nonNull(c.r.stubNotImplementedThrow[0]).check).toBe("stub_not_implemented_throw");
	});

	it("flags a dead branch literal (dead_branch_literal)", () => {
		const c = ctx('if (true) { doThing(); }\n');
		runEndpointAndLazinessChecks(c);
		expect(c.r.deadBranchLiteral.length).toBeGreaterThan(0);
		expect(nonNull(c.r.deadBranchLiteral[0]).check).toBe("dead_branch_literal");
	});

	it("produces the same dead_branch_literal findings as the orchestrator (delegation)", () => {
		const src = 'if (true) { doThing(); }\n';
		const c = ctx(src);
		runEndpointAndLazinessChecks(c);
		// The orchestrator binds each primary-file finding to the sha256 of the content it checked.
		const sourceHash = createHash("sha256").update(src).digest("hex");
		expect(c.r.deadBranchLiteral.length).toBeGreaterThan(0);
		expect(orchestrate(src).deadBranchLiteral).toEqual(c.r.deadBranchLiteral.map(row => ({ ...row, sourceHash })));
	});

	it("populates endpoint-security buckets without throwing", () => {
		const c = ctx('export const value = 1;\n');
		expect(() => runEndpointAndLazinessChecks(c)).not.toThrow();
		expect(Array.isArray(c.r.endpointAuthMissing)).toBe(true);
		expect(Array.isArray(c.r.endpointMassAssignment)).toBe(true);
	});

	it("is a no-op on benign content", () => {
		const c = ctx('export const value = 1;\n');
		runEndpointAndLazinessChecks(c);
		expect(c.r.stubNotImplementedThrow).toHaveLength(0);
		expect(c.r.deadBranchLiteral).toHaveLength(0);
	});

	it("flags a mutation-directed test without a contract marker", () => {
		const c = ctx(
			'import { normalize } from "../../lib/normalization.js";\n\n' +
			'test("normalizes the public value", () => {\n' +
			'\texpect(normalize(" value ")).toBe("value");\n' +
			'});\n',
			"/tmp/normalization.mutation-kill.test.ts",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.testLegitimacy.length).toBeGreaterThan(0);
		expect(nonNull(c.r.testLegitimacy[0]).check).toBe("test_legitimacy");
	});

	it("accepts a mutation-directed test with a directly preceding contract marker", () => {
		const c = ctx(
			'import { normalize } from "../../lib/normalization.js";\n\n' +
			'// test-contract: public-api — exported normalization result\n' +
			'test("normalizes the public value", () => {\n' +
			'\texpect(normalize(" value ")).toBe("value");\n' +
			'});\n',
			"/tmp/normalization.mutation-kill.test.ts",
		);
		runEndpointAndLazinessChecks(c);
		expect(c.r.testLegitimacy).toHaveLength(0);
	});
});
