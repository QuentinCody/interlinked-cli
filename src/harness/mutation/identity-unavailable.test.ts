import { describe, expect, it, vi } from "vitest";
import { computeSymbolHashes, deriveIdentities, derivePortableIdentities, mutationIdentityAvailable } from "./identity.js";

// Simulate the optional `typescript` dep being absent (--omit=optional): the
// synchronous createRequire load throws, loadTs() caches null, and every entry
// point degrades to "unavailable" rather than crashing. Isolated to this file so
// the other identity tests keep the real compiler.
vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:module")>();
	return {
		...actual,
		createRequire: () => () => {
			throw new Error("typescript not installed");
		},
	};
});

describe("identity derivation without the optional typescript dep", () => {
	it("reports unavailable and returns null instead of crashing", () => {
		expect(mutationIdentityAvailable()).toBe(false);
		expect(deriveIdentities("a.ts", "const x = 1;", [])).toBeNull();
		expect(derivePortableIdentities("a.ts", "const x = 1;", [])).toBeNull();
		expect(computeSymbolHashes("a.ts", "const x = 1;")).toBeNull();
	});
});
