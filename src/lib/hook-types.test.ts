// ===========================================
// Hook Types — findProjectRoot filesystem-root fallback
// ===========================================
// `findProjectRoot` walks parent directories looking for `.git`; the rest of
// its behavior is exercised through `hooks.test.ts` / `hook-installers.test.ts`
// callers. This file targets the one branch none of them reach: the
// filesystem-root itself carrying `.git` (the loop's own termination check
// never inspects the root, so there is a dedicated post-loop check for it).

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.resetModules();
	vi.doUnmock("node:fs");
});

describe("findProjectRoot", () => {
	it("returns the filesystem root when only the root itself contains .git", async () => {
		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			return {
				...actual,
				existsSync: (p: string) => p === "/.git",
			};
		});
		const { findProjectRoot } = await import("./hook-types.js");
		expect(findProjectRoot("/a/b/c")).toBe("/");
	});

	it("returns null when neither an ancestor nor the root contains .git", async () => {
		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			return {
				...actual,
				existsSync: () => false,
			};
		});
		const { findProjectRoot } = await import("./hook-types.js");
		expect(findProjectRoot("/a/b/c")).toBeNull();
	});
});
