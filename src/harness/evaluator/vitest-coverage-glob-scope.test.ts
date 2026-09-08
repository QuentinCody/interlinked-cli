import { describe, expect, it } from "vitest";
import { decideVitestCoverageWaterLine, evaluateVitestCoverageWaterLine } from "./vitest-coverage-water-line.js";

function config(include: string[], exclude: string[]): string {
	return `export default { test: { coverage: { include: ${JSON.stringify(include)}, exclude: ${JSON.stringify(exclude)} } } };`;
}

describe("coverage glob scope at the config gate", () => {
	it("compares glob scope when coverage configuration keys are quoted", () => {
		const narrower = config(["src/**/*.ts"], []);
		const broader = `export default ${JSON.stringify({ test: { coverage: { include: ["src/**/*.{ts,tsx}"], exclude: [] } } })};`;
		expect(decideVitestCoverageWaterLine("vitest.config.ts", narrower, broader)).toEqual({ kind: "allow" });
		expect(decideVitestCoverageWaterLine("vitest.config.ts", broader, narrower)).toEqual({
			kind: "block",
			reason: expect.stringContaining('Path example "src/coverage-file.tsx"'),
		});
	});

	it.each([
		{ name: "widens includes with brace alternatives", before: config(["src/**/*.ts"], []), after: config(["src/**/*.{ts,tsx}"], []) },
		{ name: "narrows exclusions with brace alternatives", before: config(["src/**/*.ts"], ["**/*.{test,spec}.ts"]), after: config(["src/**/*.ts"], ["**/*.test.ts"]) },
		{ name: "narrows an excluded directory", before: config(["src/**/*.ts"], ["src/legacy/**"]), after: config(["src/**/*.ts"], ["src/legacy/generated/**"]) },
		{ name: "removes an include already covered by a broader include", before: config(["src/**", "src/**/*.ts"], []), after: config(["src/**"], []) },
		{ name: "adds an exclude already covered by a broader exclude", before: config(["src/**/*.ts"], ["src/legacy/**"]), after: config(["src/**/*.ts"], ["src/legacy/**", "src/legacy/generated/**"]) },
		{ name: "replaces a direct-child include with a recursive include", before: config(["src/*.ts"], []), after: config(["src/**/*.ts"], []) },
		{ name: "expands independent directory and extension alternatives", before: config(["src/**/*.ts", "lib/**/*.tsx"], []), after: config(["{src,lib}/**/*.{ts,tsx}"], []) },
	])("allows a proven nondecreasing scope: $name", ({ before, after }) => {
		expect(decideVitestCoverageWaterLine("vitest.config.ts", before, after)).toEqual({ kind: "allow" });
	});

	it.each([
		{ name: "drops a brace extension", before: config(["src/**/*.{ts,tsx}"], []), after: config(["src/**/*.ts"], []), witness: "src/coverage-file.tsx" },
		{ name: "widens an excluded directory", before: config(["src/**/*.ts"], ["src/legacy/generated/**"]), after: config(["src/**/*.ts"], ["src/legacy/**"]), witness: "src/legacy/coverage-file.ts" },
		{ name: "narrows a recursive include to direct children", before: config(["src/**/*.ts"], []), after: config(["src/*.ts"], []), witness: "src/coverage-directory/coverage-file.ts" },
		{ name: "removes an explicit source file", before: config(["src/one.ts", "src/two.ts"], []), after: config(["src/one.ts"], []), witness: "src/two.ts" },
	])("blocks a proven scope reduction: $name", ({ before, after, witness }) => {
		expect(decideVitestCoverageWaterLine("vitest.config.ts", before, after)).toEqual({ kind: "block", reason: expect.stringContaining(`Path example "${witness}"`) });
	});

	it.each([
		{ name: "an exclusion outside the include scope", before: config(["src/**/*.ts"], []), after: config(["src/**/*.ts"], ["scripts/**"]) },
		{ name: "removing an already excluded include", before: config(["src/**/*.ts", "src/**/*.tsx"], ["**/*.tsx"]), after: config(["src/**/*.ts"], ["**/*.tsx"]) },
	])("abstains when no effective scope loss is proved: $name", ({ before, after }) => {
		expect(decideVitestCoverageWaterLine("vitest.config.ts", before, after)).toEqual({ kind: "allow", warning: expect.stringContaining("no scope reduction was proved") });
	});

	it.each(["!src/keep/**", "src/**/!(*.test).ts", "src/[a-z]*/**", "src/*/nested.ts", "src/**/nested/**", "src/*.{1..5}", "src/{broken", "src/" + "{a,b}".repeat(7) + "/**"])("warns instead of guessing about unsupported syntax: %s", pattern => {
		const before = config(["src/**/*.ts"], []);
		const after = config(["src/**/*.ts"], [pattern]);
		const warnings: string[] = [];
		expect(evaluateVitestCoverageWaterLine("vitest.config.ts", before, after, warnings)).toBeNull();
		expect(warnings).toEqual([expect.stringContaining("unsupported glob syntax")]);
	});

	it("does not compare a scope reduction against unknown default exclusions", () => {
		const before = 'export default { test: { coverage: { include: ["src/**/*.{ts,tsx}"] } } };';
		const after = 'export default { test: { coverage: { include: ["src/**/*.ts"] } } };';
		expect(decideVitestCoverageWaterLine("vitest.config.ts", before, after)).toEqual({ kind: "allow", warning: expect.stringContaining("Vitest defaults") });
	});

	it("allows an unchanged unsupported pattern without a spurious warning", () => {
		const text = config(["src/**/*.ts"], ["src/**/!(*.test).ts"]);
		expect(decideVitestCoverageWaterLine("vitest.config.ts", text, text)).toEqual({ kind: "allow" });
	});
});
