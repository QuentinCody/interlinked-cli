import { describe, expect, it } from "vitest";
import { isLinterConfigName, readLinterConfig, type RawExclude } from "./role-tool-config.js";

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;
const patterns = (rules: readonly RawExclude[]): string[] => rules.map((r) => `${r.tool}:${r.key}:${r.pattern}@${r.line}`);

describe("MUST-FIRE: linter excludes are read with their line", () => {
	it("P1: ruff in pyproject.toml, a multi-line list, extend-exclude and exclude, comments skipped", () => {
		const text = lines("[project]", 'name = "x"', "", "[tool.ruff]", 'extend-exclude = [', '  "src/_api",  # generated', '  "gen/*.py",', "]", "exclude = ['build']");
		expect(patterns(readLinterConfig("pyproject.toml", text).rules)).toEqual([
			"ruff:extend-exclude:src/_api@6", "ruff:extend-exclude:gen/*.py@7", "ruff:exclude:build@9",
		]);
	});
	it("P2: ruff.toml and .ruff.toml read the top level", () => {
		expect(patterns(readLinterConfig("ruff.toml", lines('line-length = 100', 'extend-exclude = ["a"]')).rules)).toEqual(["ruff:extend-exclude:a@2"]);
		expect(readLinterConfig("sub/.ruff.toml", 'exclude = ["b"]').rules).toHaveLength(1);
	});
	it("P3: flake8 in setup.cfg, tox.ini and .flake8: comma lists and indented continuation lines", () => {
		const cfg = lines("[metadata]", "name = x", "[flake8]", "max-line-length = 99", "exclude =", "    .git,", "    legacy/old.py", "extend-exclude = vendor_stuff");
		expect(patterns(readLinterConfig("setup.cfg", cfg).rules)).toEqual(["flake8:exclude:.git@6", "flake8:exclude:legacy/old.py@7", "flake8:extend-exclude:vendor_stuff@8"]);
		expect(readLinterConfig("tox.ini", "[flake8]\nexclude = a,b").rules).toHaveLength(2);
		expect(readLinterConfig(".flake8", "[flake8]\nexclude = a").rules).toHaveLength(1);
	});
	it("P4: pylint ignore (base names) and ignore-paths (regex) from .pylintrc and pyproject", () => {
		const rc = lines("[MASTER]", "ignore=CVS,generated_pb", "ignore-paths=^src/api/.*$,^docs/.*");
		const rules = readLinterConfig(".pylintrc", rc).rules;
		expect(rules.map((r) => `${r.style}:${r.pattern}`)).toEqual(["basename:CVS", "basename:generated_pb", "regex:^src/api/.*$", "regex:^docs/.*"]);
		const toml = lines("[tool.pylint.main]", 'ignore-paths = ["^api/.*"]');
		expect(readLinterConfig("pyproject.toml", toml).rules[0]).toMatchObject({ tool: "pylint", style: "regex", line: 2 });
	});
	it("P5: ESLint flat config: an object with only ignores is global, globalIgnores is global", () => {
		const text = lines("export default [", "  { ignores: ['src/gen/**', \"dist/\"] },", "  { files: ['**/*.ts'], rules: {} },", "];");
		const rules = readLinterConfig("eslint.config.js", text).rules;
		expect(patterns(rules)).toEqual(["eslint:ignores:src/gen/**@2", "eslint:ignores:dist/@2"]);
		expect(rules[0]?.style).toBe("anchored");
		expect(readLinterConfig("eslint.config.mjs", "export default defineConfig([globalIgnores(['a/b'])]);").rules).toHaveLength(1);
	});
	it("P6: .eslintignore, .oxlintignore (any-depth), .eslintrc.json and package.json", () => {
		expect(patterns(readLinterConfig(".eslintignore", lines("# c", "", "build", "!build/keep.js", "*.gen.js")).rules)).toEqual([
			"eslint:.eslintignore:build@3", "eslint:.eslintignore:!build/keep.js@4", "eslint:.eslintignore:*.gen.js@5"]);
		expect(readLinterConfig(".oxlintignore", "gen\n").rules[0]).toMatchObject({ tool: "oxlint", style: "any-depth" });
		expect(patterns(readLinterConfig(".eslintrc.json", lines("{", '  // c', '  "ignorePatterns": ["a/**",', '    "b"]', "}")).rules)).toEqual(["eslint:ignorePatterns:a/**@3", "eslint:ignorePatterns:b@4"]);
		const pkg = lines("{", '  "name": "x",', '  "eslintIgnore": ["out"],', '  "eslintConfig": { "ignorePatterns": ["gen"] }', "}");
		expect(patterns(readLinterConfig("package.json", pkg).rules)).toEqual(["eslint:eslintIgnore:out@3", "eslint:ignorePatterns:gen@4"]);
	});
	it("P7: biome v1 files.ignore and v2 files.includes negations (positive entries never exclude)", () => {
		const v1 = lines("{", '  "files": { "ignore": ["./generated", "src/**/*.pb.ts"] }', "}");
		expect(readLinterConfig("biome.json", v1).rules.map((r) => r.pattern)).toEqual(["./generated", "src/**/*.pb.ts"]);
		const v2 = lines("{", '  "files": { "includes": ["**", "!**/gen", "!!dist", "src/keep"] }', "}");
		const rules = readLinterConfig("biome.jsonc", v2).rules;
		// A negation in `includes` excludes; a positive entry can only re-include, so it is stored negated.
		expect(rules.map((r) => r.pattern)).toEqual(["!**", "**/gen", "dist", "!src/keep"]);
		expect(rules.every((r) => r.key === "files.includes")).toBe(true);
	});
	it("P8: oxlint ignorePatterns", () => {
		expect(patterns(readLinterConfig(".oxlintrc.json", '{ "ignorePatterns": ["vendor/**"] }').rules)).toEqual(["oxlint:ignorePatterns:vendor/**@1"]);
	});
});

describe("MUST-NOT-FIRE: not linter excludes", () => {
	it("N1: a type checker or coverage exclude is not role evidence (mypy, pyright, coverage omit in pyproject)", () => {
		const text = lines("[tool.mypy]", 'exclude = ["^src/api/"]', "[tool.pyright]", 'exclude = ["src/api"]', "[tool.coverage.run]", 'omit = ["src/api/*"]', "[tool.hatch.build]", 'exclude = ["/ui"]');
		expect(readLinterConfig("pyproject.toml", text).rules).toEqual([]);
	});
	it("N2: tsconfig, mypy.ini, pyrightconfig and .coveragerc are not linter configs", () => {
		for (const name of ["tsconfig.json", "tsconfig.build.json", "mypy.ini", "pyrightconfig.json", ".coveragerc", ".prettierignore", ".gitignore", "jest.config.js"]) expect(isLinterConfigName(name)).toBe(false);
	});
	it("N3: a section other than the linter's own is not read, and ruff lint.exclude is not applied", () => {
		expect(readLinterConfig("pyproject.toml", lines("[tool.other]", 'exclude = ["a"]', "[tool.ruff.lint]", 'exclude = ["b"]', "[tool.ruff.format]", 'exclude = ["c"]')).rules).toEqual([]);
		expect(readLinterConfig("setup.cfg", lines("[mypy]", "exclude = a", "[coverage:run]", "omit = b")).rules).toEqual([]);
	});
	it("N4: default excludes the config does not write are not invented", () => {
		expect(readLinterConfig("pyproject.toml", lines("[tool.ruff]", "line-length = 100")).rules).toEqual([]);
		expect(readLinterConfig("eslint.config.js", "export default [{ rules: {} }];").rules).toEqual([]);
	});
	it("N5: an ESLint config object with other keys scopes its ignores; it is not a global ignore and is counted", () => {
		const text = "export default [{ files: ['**/*.js'], ignores: ['**/*.test.js'], rules: {} }];";
		const reading = readLinterConfig("eslint.config.js", text);
		expect(reading.rules).toEqual([]);
		expect(reading.skipped).toEqual([{ reason: "scoped-ignores", pattern: "**/*.test.js", line: 1, tool: "eslint" }]);
	});
	it("N6: a non-literal entry is skipped and counted, never guessed", () => {
		const reading = readLinterConfig("eslint.config.js", "export default [{ ignores: ['a/**', ...extra, `x/${dir}`] }];");
		expect(patterns(reading.rules)).toEqual(["eslint:ignores:a/**@1"]);
		expect(reading.skipped.map((s) => s.reason)).toContain("non-literal-entry");
	});
	it("N8: includeIgnoreFile(.gitignore) is counted as not applied, never read", () => {
		const text = "export default defineConfig(includeIgnoreFile(gitignorePath), js.configs.recommended);";
		const reading = readLinterConfig("apps/dashboard/eslint.config.js", text);
		expect(reading.rules).toEqual([]);
		expect(reading.skipped).toEqual([{ reason: "ignore-file-include", line: 1, tool: "eslint" }]);
	});
	it("N7: pylint ignore with a glob is not a base name and is skipped; package.json without eslint keys reads nothing", () => {
		const reading = readLinterConfig(".pylintrc", "[MASTER]\nignore=*.pb2.py,ok\n");
		expect(reading.rules.map((r) => r.pattern)).toEqual(["ok"]);
		expect(reading.skipped[0]?.reason).toBe("not-a-basename");
		expect(readLinterConfig("package.json", '{ "name": "x", "files": ["dist"] }').rules).toEqual([]);
	});
});
