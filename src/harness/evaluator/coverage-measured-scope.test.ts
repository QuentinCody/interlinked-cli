// Authored here (gated, searchable) and copied to
// ~/interlinked-cli/src/harness/evaluator/coverage-scope.test.ts.
//
// The direction rule is the contract under test: an undecidable reading keeps
// the STRICTER outcome (abstain → the caller blocks as before).
import { describe, expect, it } from "vitest";
import { extractCoverageScope, globToRegExp, isOutsideCoverageScope, readCoverageScope } from "./coverage-measured-scope.js";

/** The shape mcp-client-bio's root config has: a literal include, an exclude
 *  whose first member is a spread of vitest's defaults. */
const REAL_CONFIG = `
import { coverageConfigDefaults, defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		exclude: ["evals/**"],
		coverage: {
			provider: "v8",
			include: ["lib/**/*.{ts,tsx}", "packages/mcp-shared/src/**/*.ts", "workers/**/src/**/*.ts"],
			exclude: [...coverageConfigDefaults.exclude, "**/*.d.ts", "servers/**"],
		},
	},
});
`;

describe("globToRegExp", () => {
	it("matches a globstar at any depth and a brace alternative", () => {
		expect(globToRegExp("lib/**/*.{ts,tsx}")?.test("lib/a/b/c.tsx")).toBe(true);
		expect(globToRegExp("lib/**/*.{ts,tsx}")?.test("lib/c.ts")).toBe(true);
		expect(globToRegExp("lib/**/*.{ts,tsx}")?.test("other/c.ts")).toBe(false);
	});

	it("keeps `*` inside one path segment", () => {
		expect(globToRegExp("src/*.ts")?.test("src/a.ts")).toBe(true);
		expect(globToRegExp("src/*.ts")?.test("src/a/b.ts")).toBe(false);
	});

	it("abstains on syntax it cannot decide", () => {
		expect(globToRegExp("!(a|b).ts")).toBeNull();
		expect(globToRegExp("src/[ab].ts")).toBeNull();
	});
});

describe("extractCoverageScope", () => {
	it("reads a literal include and skips an unreadable exclude member", () => {
		const scope = extractCoverageScope(REAL_CONFIG, "vitest.config.mts");
		expect(scope?.include).toEqual([
			"lib/**/*.{ts,tsx}",
			"packages/mcp-shared/src/**/*.ts",
			"workers/**/src/**/*.ts",
		]);
		// The `...coverageConfigDefaults.exclude` spread is dropped, the literals stay.
		expect(scope?.exclude).toEqual(["**/*.d.ts", "servers/**"]);
	});

	it("abstains when include is absent, empty, or not wholly literal", () => {
		const absent = "export default { test: { coverage: { provider: 'v8' } } };";
		expect(extractCoverageScope(absent, "vitest.config.ts")).toBeNull();
		const empty = "export default { test: { coverage: { include: [] } } };";
		expect(extractCoverageScope(empty, "vitest.config.ts")).toBeNull();
		const computed = "export default { test: { coverage: { include: [...BASE, 'lib/**'] } } };";
		expect(extractCoverageScope(computed, "vitest.config.ts")).toBeNull();
	});

	it("abstains when the file has no coverage object, or more than one", () => {
		expect(extractCoverageScope("export default {};", "vitest.config.ts")).toBeNull();
		const two = `export default { a: { coverage: { include: ['x/**'] } }, b: { coverage: { include: ['y/**'] } } };`;
		expect(extractCoverageScope(two, "vitest.config.ts")).toBeNull();
	});
});

describe("isOutsideCoverageScope", () => {
	const scope = { include: ["lib/**/*.ts", "workers/**/src/**/*.ts"], exclude: ["**/*.d.ts", "servers/**"] };

	it("puts an included path in scope and anything else out", () => {
		expect(isOutsideCoverageScope("lib/a/b.ts", scope)).toBe(false);
		expect(isOutsideCoverageScope("servers/bio-orchestrator/src/index.ts", scope)).toBe(true);
		expect(isOutsideCoverageScope("scripts/cf-portal/lib.ts", scope)).toBe(true);
	});

	it("an exclude pattern takes an included path back out", () => {
		expect(isOutsideCoverageScope("lib/types.d.ts", scope)).toBe(true);
	});

	it("normalizes a leading ./ and backslashes", () => {
		expect(isOutsideCoverageScope("./lib/a/b.ts", scope)).toBe(false);
		expect(isOutsideCoverageScope("lib\\a\\b.ts", scope)).toBe(false);
	});
});

describe("readCoverageScope", () => {
	it("reads the first config basename that exists", () => {
		const scope = readCoverageScope("/repo", (abs) => (abs === "/repo/vitest.config.mts" ? REAL_CONFIG : null));
		expect(scope?.include).toHaveLength(3);
	});

	it("returns null when the root has no vitest config", () => {
		expect(readCoverageScope("/repo", () => null)).toBeNull();
	});
});
