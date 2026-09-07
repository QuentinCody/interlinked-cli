// Covers `loadTs()`'s graceful-degrade path in jsdoc-param-drift.ts: when
// `createRequire(...)("typescript")` throws (TypeScript not installed in the
// host project), the cache resolves to `null` and `detectJsdocParamDrift`
// no-ops (`[]`) instead of crashing. Isolated in its own file because the
// `node:module` mock below applies to the whole file — mixing it with the
// happy-path suite in `jsdoc-param-drift.test.ts` would break every other
// case there. Mirrors `type-smuggling-ts-unavailable.test.ts`.

import { describe, expect, it, vi } from "vitest";

const { requireTypeScript } = vi.hoisted(() => ({
	requireTypeScript: vi.fn(() => { throw new Error("Cannot find module 'typescript'"); }),
}));

vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:module")>();
	return {
		...actual,
		createRequire: () => requireTypeScript,
	};
});

import { detectJsdocParamDrift } from "../jsdoc-param-drift.js";

const TS_FILE = "src/lib/foo.ts";

describe("detectJsdocParamDrift — TypeScript not installed", () => {
	it("returns [] instead of throwing when `typescript` cannot be resolved", () => {
		const code = [
			"/**",
			" * @param stale not checkable without the optional dep",
			" */",
			"function f(fresh) { return fresh; }",
		].join("\n");
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	it("stays a no-op across repeated calls (cached null, not re-thrown)", () => {
		const code = [
			"/**",
			" * @param stale not checkable without the optional dep",
			" */",
			"function f(fresh) { return fresh; }",
		].join("\n");
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
		expect(requireTypeScript.mock.calls).toEqual([["typescript"]]);
	});
});
