// ===========================================
// Language Profiles — Multi-language support
// ===========================================
// Covers findProjectRootForLanguage: the ancestor-directory walk that looks
// for a language's project_root_markers, its "reached filesystem root
// without finding one" exit, and its defensive catch around the
// extname/dirname path-manipulation step at the top of the walk.

// `dirname` is wrapped so one test can force it to throw for a specific
// input without changing behavior for every other call in this file.
vi.mock("node:path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:path")>();
	return {
		...actual,
		dirname: vi.fn(actual.dirname),
	};
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LANGUAGE_PROFILES } from "./language-profiles-data.js";
import { findProjectRootForLanguage } from "./language-profiles.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
	vi.mocked(dirname).mockClear();
});

describe("findProjectRootForLanguage", () => {
	it("returns the nearest ancestor directory containing a project-root marker", () => {
		const root = mkdtempSync(join(tmpdir(), "il-lang-root-"));
		cleanups.push(root);
		mkdirSync(join(root, "pkg", "src"), { recursive: true });
		writeFileSync(join(root, "pkg", "package.json"), "{}");

		const found = findProjectRootForLanguage(
			join(root, "pkg", "src", "index.ts"),
			LANGUAGE_PROFILES.typescript,
		);
		expect(found).toBe(join(root, "pkg"));
	});

	it("returns null once the walk reaches the filesystem root with no marker found", () => {
		const root = mkdtempSync(join(tmpdir(), "il-lang-noroot-"));
		cleanups.push(root);

		const found = findProjectRootForLanguage(join(root, "index.ts"), LANGUAGE_PROFILES.typescript);
		expect(found).toBeNull();
	});

	it("bails out to null when the path-manipulation step throws", () => {
		const target = "/il-lang-throw-fixture/file.ts";
		vi.mocked(dirname).mockImplementationOnce(() => {
			throw new Error("simulated dirname failure");
		});

		const found = findProjectRootForLanguage(target, LANGUAGE_PROFILES.typescript);
		expect(found).toBeNull();
	});
});
