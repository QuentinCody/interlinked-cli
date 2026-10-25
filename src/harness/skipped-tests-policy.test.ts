// Tests for the skipped-tests water-line policy loader.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	emptySkippedTestsBaseline,
	loadSkippedTestsBaseline,
	maxSkippedFor,
	SKIPPED_TESTS_BASELINE_REL,
} from "./skipped-tests-policy.js";

let root: string | null = null;

function makeRoot(baselineJson?: string): string {
	root = mkdtempSync(join(tmpdir(), "skip-baseline-"));
	if (baselineJson !== undefined) {
		const path = join(root, SKIPPED_TESTS_BASELINE_REL);
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(path, baselineJson, "utf-8");
	}
	return root;
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = null;
});

describe("loadSkippedTestsBaseline", () => {
	it("loads a valid baseline", () => {
		const dir = makeRoot(
			JSON.stringify({ version: 1, max_skipped: 0, files: { "src/legacy.test.ts": 3 } }),
		);
		const baseline = loadSkippedTestsBaseline(dir);
		expect(baseline).toEqual({
			version: 1,
			max_skipped: 0,
			files: { "src/legacy.test.ts": 3 },
		});
	});

	it("returns null when the file is absent", () => {
		expect(loadSkippedTestsBaseline(makeRoot())).toBeNull();
	});

	it("returns null on malformed JSON or wrong version", () => {
		expect(loadSkippedTestsBaseline(makeRoot("{not json"))).toBeNull();
		expect(loadSkippedTestsBaseline(makeRoot(JSON.stringify({ version: 2 })))).toBeNull();
	});

	it("tolerates a missing/invalid files map", () => {
		const dir = makeRoot(JSON.stringify({ version: 1, max_skipped: 1 }));
		expect(loadSkippedTestsBaseline(dir)).toEqual({ version: 1, max_skipped: 1, files: {} });
	});

	it.each(["null", "[]", JSON.stringify({ version: 1, max_skipped: "unlimited", files: { "a.test.ts": 3 } })])(
		"rejects malformed baseline shape or global skip ceiling: %s", raw => {
		const dir = makeRoot(raw);
		const baseline = loadSkippedTestsBaseline(dir);
		expect(baseline).toBeNull();
		expect(maxSkippedFor(baseline, "a.test.ts")).toBe(0);
	});

	it("N1: drops a malformed individual grandfather entry but keeps valid ones", () => {
		// Pre-fix, `raw.files as Record<string, number>` trusted every
		// per-file ceiling unchecked — a non-number ceiling would have reached
		// baseline_integrity_gate's numeric comparison directly instead of
		// being dropped.
		const dir = makeRoot(
			JSON.stringify({
				version: 1,
				max_skipped: 0,
				files: { "src/good.test.ts": 3, "src/bad.test.ts": "not-a-number" },
			}),
		);
		const baseline = loadSkippedTestsBaseline(dir);
		expect(baseline?.files).toEqual({ "src/good.test.ts": 3 });
		expect(baseline?.files["src/bad.test.ts"]).toBeUndefined();
	});

	it("N2: treats an array files field as absent instead of reading fields off it", () => {
		// Pre-fix, `typeof raw.files === "object" && !Array.isArray(raw.files)`
		// already excluded arrays inline — this pins that isJsonObject
		// preserves the same exclusion after the rewrite.
		const dir = makeRoot(
			JSON.stringify({ version: 1, max_skipped: 0, files: ["not", "a", "record"] }),
		);
		expect(loadSkippedTestsBaseline(dir)).toEqual({ version: 1, max_skipped: 0, files: {} });
	});

	it("P1: keeps multiple valid grandfather entries", () => {
		const dir = makeRoot(
			JSON.stringify({
				version: 1,
				max_skipped: 0,
				files: { "a.test.ts": 4, "b.test.ts": 1 },
			}),
		);
		expect(loadSkippedTestsBaseline(dir)).toEqual({
			version: 1,
			max_skipped: 0,
			files: { "a.test.ts": 4, "b.test.ts": 1 },
		});
	});
});

describe("maxSkippedFor", () => {
	const baseline = { version: 1 as const, max_skipped: 0, files: { "a.test.ts": 4 } };

	it("grandfathered file gets its recorded ceiling", () => {
		expect(maxSkippedFor(baseline, "a.test.ts")).toBe(4);
	});

	it("everything else gets the global cap", () => {
		expect(maxSkippedFor(baseline, "b.test.ts")).toBe(0);
	});

	it("no baseline means the empty-baseline floor (0)", () => {
		expect(maxSkippedFor(null, "a.test.ts")).toBe(emptySkippedTestsBaseline().max_skipped);
	});
});
