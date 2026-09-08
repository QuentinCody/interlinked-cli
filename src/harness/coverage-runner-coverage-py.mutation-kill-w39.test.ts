import { nonNull } from "../lib/non-null.js";
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCoveragePyJson } from "./coverage-runner-coverage-py.js";

// SUT: src/harness/coverage-runner-coverage-py.ts
// Survivors targeted live in toLineSet / relForKey (both unexported, exercised
// only through parseCoveragePyJson) and parseCoveragePyJson itself.

const dirs: string[] = [];
function makeRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "cov-py-w39-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeReport(root: string, content: unknown): string {
	const p = join(root, "coverage.json");
	writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
	return p;
}

describe("parseCoveragePyJson — non-existent report", () => {
	// test-contract: boundary — missing report path returns null, never throws
	it("P1: returns null when reportPath does not exist", () => {
		const root = makeRoot();
		const missing = join(root, "nope.json");
		expect(() => parseCoveragePyJson(missing, root)).not.toThrow();
		expect(parseCoveragePyJson(missing, root)).toBeNull();
	});
});

describe("parseCoveragePyJson — happy path: toLineSet + relForKey composite", () => {
	function parseFixture(root: string) {
		const path = writeReport(root, {
			files: {
				"good.py": { executed_lines: [1, "5", 2.5, -3, 0, 4], missing_lines: [] },
				"sub\\mod.py": { executed_lines: [2], missing_lines: [3] },
				"../outside.py": { executed_lines: [9], missing_lines: [] },
				".": { executed_lines: [9], missing_lines: [] },
			},
		});
		const result = parseCoveragePyJson(path, root);
		expect(result).not.toBeNull();
		// SAFETY: guarded by the not.toBeNull() assertion immediately above.
		return nonNull(result);
	}

	// test-contract: invariant — a key escaping projectRoot (leading "..") and a
	// key resolving to projectRoot itself (empty relative path) are both excluded
	it("P2a: excludes an outside-root key and a root-resolving key", () => {
		const root = makeRoot();
		const map = parseFixture(root);
		expect(map.size).toBe(2);
		expect(map.has("../outside.py")).toBe(false);
		expect(map.has("")).toBe(false);
	});

	// test-contract: invariant — a backslash-containing key is normalized to a
	// forward-slash relative path, and its line array keeps only positive integers
	it("P2b: normalizes a backslash key and filters its line values", () => {
		const root = makeRoot();
		const map = parseFixture(root);
		const sub = map.get("sub/mod.py");
		expect(sub).toBeDefined();
		expect(sub?.coveredLines).toEqual(new Set([2]));
		expect(sub?.uncoveredLines).toEqual(new Set([3]));
	});

	// test-contract: invariant — non-number, non-integer, and non-positive
	// entries in executed_lines are all dropped, keeping only positive integers
	it("P2c: filters a mixed-validity line array to positive integers only", () => {
		const root = makeRoot();
		const map = parseFixture(root);
		const good = map.get("good.py");
		expect(good).toBeDefined();
		expect(good?.coveredLines).toEqual(new Set([1, 4]));
		expect(good?.uncoveredLines).toEqual(new Set());
	});
});

describe("toLineSet — absent line arrays", () => {
	// test-contract: invariant — a file entry missing executed_lines/missing_lines
	// yields empty sets without throwing (raw is undefined, not an array)
	it("P3: entry with no line arrays parses to empty sets", () => {
		const root = makeRoot();
		const path = writeReport(root, { files: { "empty.py": {} } });
		const result = parseCoveragePyJson(path, root);
		expect(result).not.toBeNull();
		// SAFETY: guarded by the not.toBeNull() assertion immediately above.
		const map = nonNull(result);
		const entry = map.get("empty.py");
		expect(entry).toBeDefined();
		expect(entry?.coveredLines).toEqual(new Set());
		expect(entry?.uncoveredLines).toEqual(new Set());
	});
});

describe("parseCoveragePyJson — top-level raw shape guards", () => {
	// test-contract: boundary — JSON literal `null` must not crash the parser
	it("P4: top-level null returns null without throwing", () => {
		const root = makeRoot();
		const path = writeReport(root, "null");
		expect(() => parseCoveragePyJson(path, root)).not.toThrow();
		expect(parseCoveragePyJson(path, root)).toBeNull();
	});
});

describe("parseCoveragePyJson — files field shape guards", () => {
	// test-contract: boundary — a non-object `files` field is rejected, not
	// coerced into a partial result
	it("P5: files as a string returns null", () => {
		const root = makeRoot();
		const path = writeReport(root, { files: "ab" });
		expect(parseCoveragePyJson(path, root)).toBeNull();
	});

	// test-contract: boundary — `files: null` must not crash the parser
	it("P6: files as null returns null without throwing", () => {
		const root = makeRoot();
		const path = writeReport(root, { files: null });
		expect(() => parseCoveragePyJson(path, root)).not.toThrow();
		expect(parseCoveragePyJson(path, root)).toBeNull();
	});

	// test-contract: boundary — `files: 42` (non-object, non-null) is rejected
	it("P7: files as a number returns null", () => {
		const root = makeRoot();
		const path = writeReport(root, { files: 42 });
		expect(parseCoveragePyJson(path, root)).toBeNull();
	});
});

describe("parseCoveragePyJson — per-entry shape guards", () => {
	// test-contract: boundary — a malformed per-file entry is skipped, not
	// merged into the result map
	it("P8: string entry value is skipped", () => {
		const root = makeRoot();
		const path = writeReport(root, { files: { "a.py": "notobject" } });
		const result = parseCoveragePyJson(path, root);
		expect(result?.size).toBe(0);
	});

	// test-contract: boundary — a null per-file entry is skipped, not dereferenced
	it("P9: null entry value is skipped without throwing", () => {
		const root = makeRoot();
		const path = writeReport(root, { files: { "a.py": null } });
		expect(() => parseCoveragePyJson(path, root)).not.toThrow();
		const result = parseCoveragePyJson(path, root);
		expect(result?.size).toBe(0);
	});

	// test-contract: boundary — a numeric per-file entry is skipped, not merged
	it("P10: numeric entry value is skipped", () => {
		const root = makeRoot();
		const path = writeReport(root, { files: { "a.py": 42 } });
		const result = parseCoveragePyJson(path, root);
		expect(result?.size).toBe(0);
	});
});
