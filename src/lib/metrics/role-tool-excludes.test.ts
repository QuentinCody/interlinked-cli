import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyByPath } from "./role-evidence.js";
import { applyToolExclude, buildToolExcludes, clearToolExcludeCache, loadToolExcludes } from "./role-tool-excludes.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); clearToolExcludeCache(); });

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "role-tool-excludes-"));
	dirs.push(root);
	for (const [path, text] of Object.entries(files)) { mkdirSync(join(root, dirname(path)), { recursive: true }); writeFileSync(join(root, path), text); }
	return root;
}
const role = (set: ReturnType<typeof buildToolExcludes>, path: string): string => applyToolExclude(set, path, classifyByPath(path)).role;
const RUFF = (...rows: string[]) => ({ file: "pyproject.toml", text: `[tool.ruff]\n${rows.join("\n")}\n` });

describe("MUST-FIRE: a linter exclude sets a tracked product path aside", () => {
	it("P1: ruff extend-exclude: the decision is unlinted (not generated), evidence tool-config, detail names tool, key, pattern, file and line", () => {
		const set = buildToolExcludes([RUFF('target-version = "py311"', 'extend-exclude = ["src/_api"]')]);
		const decision = applyToolExclude(set, "src/_api/client.py", classifyByPath("src/_api/client.py"));
		expect(decision).toEqual({ role: "unlinted", from: "product",
			evidence: { kind: "tool-config", detail: "ruff extend-exclude `src/_api` (pyproject.toml:3)" } });
		expect(role(set, "src/other/client.py")).toBe("product");
	});
	it("P2: flake8, pylint ignore, pylint ignore-paths and ESLint flat ignores", () => {
		const set = buildToolExcludes([
			{ file: "setup.cfg", text: "[flake8]\nexclude = legacy\n" },
			{ file: ".pylintrc", text: "[MASTER]\nignore=generated_pb\nignore-paths=^proto/.*$\n" },
			{ file: "web/eslint.config.js", text: "export default [{ ignores: ['src/gen/**'] }];" },
		]);
		expect(role(set, "legacy/a.py")).toBe("unlinted");
		expect(role(set, "pkg/generated_pb/a.py")).toBe("unlinted");
		expect(role(set, "proto/a.py")).toBe("unlinted");
		expect(role(set, "web/src/gen/a.ts")).toBe("unlinted");
		expect(role(set, "web/src/real/a.ts")).toBe("product");
	});
	it("P3: biome v1 files.ignore and a v2 includes negation, oxlint ignorePatterns, .eslintignore with a negation", () => {
		const set = buildToolExcludes([
			{ file: "a/biome.json", text: '{ "files": { "ignore": ["generated"] } }' },
			{ file: "b/biome.json", text: '{ "files": { "includes": ["**", "!**/gen"] } }' },
			{ file: "c/.oxlintrc.json", text: '{ "ignorePatterns": ["vendor_js"] }' },
			{ file: "d/.eslintignore", text: "out\n!out/keep.ts\n" },
		]);
		expect(role(set, "a/generated/x.ts")).toBe("generated");
		expect(role(set, "b/src/gen/x.ts")).toBe("unlinted");
		expect(role(set, "b/src/x.ts")).toBe("product");
		expect(role(set, "c/vendor_js/x.js")).toBe("unlinted");
		expect(role(set, "d/out/x.ts")).toBe("unlinted");
		expect(role(set, "d/out/keep.ts")).toBe("product");
	});
	it("P4: a nested config applies to its own sub-tree only", () => {
		const set = buildToolExcludes([{ file: "pkg/a/ruff.toml", text: 'exclude = ["gen"]\n' }]);
		expect(role(set, "pkg/a/gen/x.py")).toBe("unlinted");
		expect(role(set, "pkg/a/src/gen/x.py")).toBe("unlinted");
		expect(role(set, "pkg/b/gen/x.py")).toBe("product");
		expect(role(set, "gen/x.py")).toBe("product");
	});
});

describe("MUST-NOT-FIRE: not evidence", () => {
	it("N1: a test file that a linter excludes stays a test; an already-vendor or generated path keeps its own evidence", () => {
		const set = buildToolExcludes([RUFF('exclude = ["tests", "dist", "node_modules"]')]);
		expect(role(set, "tests/test_a.py")).toBe("test");
		expect(role(set, "src/foo_test.py")).toBe("test");
		const vendor = applyToolExclude(set, "node_modules/x/a.py", classifyByPath("node_modules/x/a.py"));
		expect(vendor.evidence?.kind).toBe("path");
	});
	it("N2: a pattern that matches nothing tracked is a no-op", () => {
		const set = buildToolExcludes([RUFF('exclude = [".git", ".venv", "__pycache__", "*.egg-info", "build", "dist"]')]);
		expect(role(set, "src/app.py")).toBe("product");
	});
	it("N3: a tool excludes only the languages it lints (ruff `frontend` leaves .ts product, eslint ignores leave .py product)", () => {
		const set = buildToolExcludes([RUFF('extend-exclude = ["frontend"]'), { file: "eslint.config.js", text: "export default [{ ignores: ['scripts/**'] }];" }]);
		expect(role(set, "frontend/app.ts")).toBe("product");
		expect(role(set, "frontend/helper.py")).toBe("unlinted");
		expect(role(set, "scripts/tool.py")).toBe("product");
		expect(role(set, "scripts/tool.ts")).toBe("unlinted");
	});
	it("N4: a path outside the config directory is untouched, a re-included path is untouched", () => {
		const set = buildToolExcludes([{ file: "svc/.flake8", text: "[flake8]\nexclude = gen\n" }]);
		expect(role(set, "other/gen/x.py")).toBe("product");
	});
	it("N5: an unsupported pattern is skipped and counted, never guessed", () => {
		const set = buildToolExcludes([{ file: "eslint.config.js", text: "export default [{ ignores: ['src/@(a|b)/**', 'ok/**', ...more] }];" }]);
		expect(role(set, "src/a/x.ts")).toBe("product");
		expect(role(set, "ok/x.ts")).toBe("unlinted");
		expect(set.skipped).toMatchObject({ "eslint:extglob": 1, "eslint:non-literal-entry": 1 });
	});
	it("N7: an extension-only pattern (*.js, **/*.cjs, *.{js,mjs}) says the linter is scoped to a language, not that the files are unmaintained", () => {
		const set = buildToolExcludes([{ file: ".oxlintrc.json", text: '{ "ignorePatterns": ["*.js", "**/*.cjs", "*.{mjs,jsx}", "gen/**"] }' }]);
		expect(role(set, "scripts/build.js")).toBe("product");
		expect(role(set, "a/b/tool.cjs")).toBe("product");
		expect(role(set, "gen/a.ts")).toBe("unlinted");
		expect(set.skipped["oxlint:extension-only"]).toBe(3);
	});
	it("N6: tsconfig exclude, mypy exclude and coverage omit on disk do not move any file", () => {
		const root = tree({
			"tsconfig.json": '{ "exclude": ["src/gen"] }', "mypy.ini": "[mypy]\nexclude = src/gen\n", ".coveragerc": "[run]\nomit = src/gen/*\n",
			"pyproject.toml": '[tool.mypy]\nexclude = ["src/gen"]\n[tool.coverage.run]\nomit = ["src/gen/*"]\n', "src/gen/a.py": "x = 1\n", "src/gen/a.ts": "export {}\n",
		});
		const set = loadToolExcludes(root);
		expect(set.ruleCount).toBe(0);
		expect(role(set, "src/gen/a.py")).toBe("product");
		expect(role(set, "src/gen/a.ts")).toBe("product");
	});
});

describe("loading from disk", () => {
	it("P5: loadToolExcludes finds nested configs, keeps their directory, and is cached per root", () => {
		const root = tree({ "pkg/pyproject.toml": '[tool.ruff]\nextend-exclude = ["gen"]\n', "pkg/gen/a.py": "x = 1\n", "node_modules/z/ruff.toml": 'exclude = ["src"]\n' });
		const set = loadToolExcludes(root);
		expect(set.configFiles).toEqual(["pkg/pyproject.toml"]);
		expect(role(set, "pkg/gen/a.py")).toBe("unlinted");
		expect(loadToolExcludes(root)).toBe(set);
	});
});
