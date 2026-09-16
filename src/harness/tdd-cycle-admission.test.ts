// Tests for TDD cycle admission + key normalization.
//
// Labeled per the Check Evidence Contract. The negatives are the load-bearing
// half here: admission is a filter, so the cases that must NOT be admitted are
// the whole point — each one is a junk cycle that would otherwise become a
// fan-out target for a whole-suite red.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	canTrackCycle,
	normalizeCycleKey,
	TDD_SOURCE_EXT_RE,
	TDD_TEST_FILE_RE,
} from "./tdd-cycle-admission.js";

describe("canTrackCycle — positive (must be admitted)", () => {
	it("P1: admits an ordinary TypeScript source file", () => {
		expect(canTrackCycle("/repo/src/harness/checks/control-bytes.ts")).toBe(true);
	});

	it("P2: admits a relative source path", () => {
		expect(canTrackCycle("src/lib/config.ts")).toBe(true);
	});

	it("P3: admits the other tracked languages", () => {
		for (const p of ["/repo/a.py", "/repo/a.rs", "/repo/a.go", "/repo/a.swift", "/repo/a.tsx"]) {
			expect(canTrackCycle(p), p).toBe(true);
		}
	});

	it("P4: admits a source file that does not exist on disk", () => {
		// Admission is about the KIND of path. A file deleted later in the
		// session is a report-time concern, not an admission-time one.
		expect(canTrackCycle("/repo/src/never-created.ts")).toBe(true);
	});
});

describe("canTrackCycle — negative (must NOT be admitted)", () => {
    it.each(["test_api.py", "api_test.py", "tests/helper.py", "conftest.py", "setup.py"])("does not create implementation cycles for Python test/configuration path %s", path => {
        expect(canTrackCycle(path)).toBe(false);
    });
	it("N1: rejects a config file with no companion test", () => {
		// The real junk cycle from the 2026-07-26 session — it was stuck red
		// after the file had already been deleted.
		expect(canTrackCycle("/repo/vitest.config.mjs")).toBe(false);
	});

	it("N1b: rejects the other build/tool config shapes", () => {
		for (const p of [
			"/repo/tsup.config.ts",
			"/repo/vitest.stryker.config.ts",
			"/repo/eslint.config.js",
			"/repo/.prettierrc.cjs",
		]) {
			expect(canTrackCycle(p), p).toBe(false);
		}
	});

	it("P5: still admits a source file whose name merely contains 'config'", () => {
		// `config.ts` is a real module with real behavior — only the
		// `<name>.config.<ext>` convention is excluded.
		expect(canTrackCycle("/repo/src/lib/config.ts")).toBe(true);
		expect(canTrackCycle("/repo/src/lib/config-loader.ts")).toBe(true);
	});

	it("N2: rejects a file literally named test.mjs / test.ts", () => {
		expect(canTrackCycle("/repo/test.mjs")).toBe(false);
		expect(canTrackCycle("/repo/test.ts")).toBe(false);
	});

	it("N3: rejects ordinary test files", () => {
		expect(canTrackCycle("/repo/src/a.test.ts")).toBe(false);
		expect(canTrackCycle("/repo/src/a.spec.ts")).toBe(false);
		expect(canTrackCycle("/repo/src/__tests__/a.ts")).toBe(false);
	});

	it("N4: rejects non-code files", () => {
		for (const p of ["/repo/README.md", "/repo/data.json", "/repo/a.yaml", "/repo/a.patch"]) {
			expect(canTrackCycle(p), p).toBe(false);
		}
	});

	it("N5: rejects exempt paths", () => {
		expect(canTrackCycle("/repo/dist/bundle.js")).toBe(false);
		expect(canTrackCycle("/repo/node_modules/pkg/index.js")).toBe(false);
	});

	it("N6: rejects an empty path", () => {
		expect(canTrackCycle("")).toBe(false);
	});

	it("N7: rejects an extensionless path", () => {
		expect(canTrackCycle("/repo/Makefile")).toBe(false);
	});
});

describe("normalizeCycleKey", () => {
	it("P1: collapses an absolute path to one canonical form", () => {
		expect(normalizeCycleKey("/repo/src/../src/a.ts")).toBe(resolve("/repo/src/a.ts"));
	});

	it("P2: resolves a relative path against the supplied cwd", () => {
		expect(normalizeCycleKey("src/a.ts", "/repo")).toBe(resolve("/repo/src/a.ts"));
	});

	it("P3: maps the relative and absolute forms of one file to the SAME key", () => {
		// The exact duplicate seen live: the map held both
		// /Users/.../src/harness/checks/control-bytes.ts and
		// src/harness/checks/control-bytes.ts as independent cycles.
		const rel = "src/harness/checks/control-bytes.ts";
		const abs = "/repo/src/harness/checks/control-bytes.ts";
		expect(normalizeCycleKey(rel, "/repo")).toBe(normalizeCycleKey(abs, "/repo"));
	});

	it("P4: is idempotent", () => {
		const once = normalizeCycleKey("src/a.ts", "/repo");
		expect(normalizeCycleKey(once, "/repo")).toBe(once);
	});

	it("N1: ignores cwd for an already-absolute path", () => {
		expect(normalizeCycleKey("/other/a.ts", "/repo")).toBe(resolve("/other/a.ts"));
	});

	it("N2: passes an empty path through untouched", () => {
		expect(normalizeCycleKey("")).toBe("");
	});

	it("N3: falls back to process.cwd() when no cwd is given", () => {
		expect(normalizeCycleKey("a.ts")).toBe(resolve(process.cwd(), "a.ts"));
	});
});

describe("policy constants", () => {
	it("the source-extension policy has exactly one definition", () => {
		// Guards against the duplicated_policy_constant class: this module is the
		// canonical home, and behavioral-checks-tdd.ts imports it rather than
		// keeping a second copy that can drift.
		expect(TDD_SOURCE_EXT_RE.test("a.ts")).toBe(true);
		expect(TDD_SOURCE_EXT_RE.test("a.md")).toBe(false);
	});

	it("the test-file pattern covers both infix and bare forms", () => {
		expect(TDD_TEST_FILE_RE.test("a.test.ts")).toBe(true);
		expect(TDD_TEST_FILE_RE.test("test.ts")).toBe(true);
		expect(TDD_TEST_FILE_RE.test("a.ts")).toBe(false);
	});
});
