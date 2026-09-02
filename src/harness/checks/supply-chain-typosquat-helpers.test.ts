import { describe, expect, it } from "vitest";
import {
	findTyposquatForDep,
	parsePackageJsonDeps,
} from "./supply-chain-typosquat-helpers.js";

describe("parsePackageJsonDeps — positive (must fire)", () => {
	it("P1: returns null when the file does not exist", () => {
		expect(parsePackageJsonDeps("/does/not/exist/package.json")).toBeNull();
	});
});

describe("parsePackageJsonDeps — negative (must not fire)", () => {
	it("N1: parses merged dependencies + devDependencies from a real file", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "typosquat-helper-test-"));
		const pkgPath = join(dir, "package.json");
		writeFileSync(
			pkgPath,
			JSON.stringify({
				dependencies: { express: "^4.0.0" },
				devDependencies: { vitest: "^1.0.0" },
			}),
		);
		const result = parsePackageJsonDeps(pkgPath);
		expect(result).not.toBeNull();
		expect(result?.allDeps).toEqual({ express: "^4.0.0", vitest: "^1.0.0" });
		expect(result?.content).toContain("express");
	});

	it("N2: returns null on unparsable JSON", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "typosquat-helper-test-"));
		const pkgPath = join(dir, "package.json");
		writeFileSync(pkgPath, "{ not valid json");
		expect(parsePackageJsonDeps(pkgPath)).toBeNull();
	});
});

// Minimal reference Levenshtein for the test double — matches the real
// check's edit-distance semantics closely enough for these fixtures.
function levenshtein(a: string, b: string): number {
	const matrix: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i]![j] = Math.min(
				matrix[i - 1]![j]! + 1,
				matrix[i]![j - 1]! + 1,
				matrix[i - 1]![j - 1]! + cost,
			);
		}
	}
	return matrix[a.length]![b.length]!;
}

const popularPackages = new Set(["express", "react"]);
const scoring = { popularPackages, levenshtein };

describe("findTyposquatForDep — positive (must fire)", () => {
	it("P1: finds a near-miss match against a popular package", () => {
		const result = findTyposquatForDep(
			"expresss",
			['  "expresss": "^1.0.0"'],
			scoring,
		);
		expect(result).not.toBeNull();
		expect(result?.text).toContain("expresss");
		expect(result?.text).toContain("express");
		expect(result?.line).toBe(1);
	});

	it("P2: falls back to line 1 when the dep name is not found in lines", () => {
		const result = findTyposquatForDep("reacx", [], scoring);
		expect(result).not.toBeNull();
		expect(result?.line).toBe(1);
	});
});

describe("findTyposquatForDep — negative (must not fire)", () => {
	it("N1: returns null for an exact popular-package match", () => {
		expect(
			findTyposquatForDep("react", ['"react": "^18.0.0"'], scoring),
		).toBeNull();
	});

	it("N2: returns null when no popular package is within distance 2", () => {
		expect(
			findTyposquatForDep("some-totally-unrelated-name", [], scoring),
		).toBeNull();
	});
});
