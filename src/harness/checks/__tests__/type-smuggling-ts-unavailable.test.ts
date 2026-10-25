// Covers `loadTs()`'s graceful-degrade path: when `createRequire(...)("typescript")`
// throws from every base (TypeScript resolves neither from the harness
// installation nor from the check root), every call to `checkTypeSmuggling`
// no-ops (`[]`) instead of crashing, and reports the standard NOT MEASURED line.
// A failed resolution is never cached (check-typescript.ts): each call tries
// both bases again, so a later install is found without a reset.
// Isolated in its own file because the `node:module` mock below applies to the
// whole file — mixing it with the happy-path suite in `type-smuggling.test.ts`
// would break every other case there.

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

import { withCheckRoot } from "../check-root.js";
import { checkTypeSmuggling } from "../type-smuggling.js";

const TS = "src/lib/foo.ts";

describe("checkTypeSmuggling — TypeScript not installed", () => {
	it("returns [] instead of throwing when `typescript` cannot be resolved", () => {
		const code = [
			'const x = "hello" as { id: number };',
			"export { x };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("stays a no-op across repeated calls and re-attempts both bases each time (a failure is not cached)", () => {
		requireTypeScript.mockClear();
		const code = ["const v = 1 as unknown as string;", "export { v };"].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
		// Two calls x two bases (harness installation, then the check root).
		expect(requireTypeScript.mock.calls).toEqual([["typescript"], ["typescript"], ["typescript"], ["typescript"]]);
	});

	it("reports one NOT MEASURED line that names type_smuggling and the check root", () => {
		const code = ['const x = "hello" as { id: number };', "export { x };"].join("\n");
		const run = withCheckRoot("/scan/no-typescript", () => [
			...checkTypeSmuggling(code, TS),
			...checkTypeSmuggling(code, "src/lib/bar.ts"),
		]);
		expect(run.result).toEqual([]);
		expect(run.notMeasured).toHaveLength(1);
		expect(run.notMeasured[0]).toMatch(/^\[interlinked:type_smuggling\] NOT MEASURED: /);
		expect(run.notMeasured[0]).toContain("/scan/no-typescript");
	});
});
