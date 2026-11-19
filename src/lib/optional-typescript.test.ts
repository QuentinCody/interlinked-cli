import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { optionalTypescript } from "./optional-typescript.js";

vi.mock("node:module", () => ({ createRequire: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("remembers a missing compiler in one consumer until explicitly reset", () => {
	const first = optionalTypescript("/first/package.json");
	const second = optionalTypescript("/second/package.json");
	vi.mocked(createRequire).mockImplementation(() => { throw new Error("missing"); });
	expect(first.load()).toBeNull();
	expect(first.load()).toBeNull();
	expect(second.load()).toBeNull();
	expect(vi.mocked(createRequire).mock.calls).toEqual([["/first/package.json"], ["/second/package.json"]]);
	first.set(undefined);
	expect(first.load()).toBeNull();
	expect(vi.mocked(createRequire).mock.calls).toHaveLength(3);
});
