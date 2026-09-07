// Covers `loadTs()`'s graceful-degrade path: when `createRequire(...)("typescript")`
// throws (TypeScript not installed in the host project), the cache resolves to
// `null` and every call to `checkTypeSmuggling` no-ops (`[]`) instead of crashing.
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

	it("stays a no-op across repeated calls (cached null, not re-thrown)", () => {
		const code = ["const v = 1 as unknown as string;", "export { v };"].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
		expect(requireTypeScript.mock.calls).toEqual([["typescript"]]);
	});
});
