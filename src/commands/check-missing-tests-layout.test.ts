import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeLayout, applyMissingTestsLayout } from "./check-missing-tests-layout.js";

const analyze = (tree: Record<string, string>) => analyzeLayout({ files: Object.keys(tree), read: (path) => tree[path] ?? null, roleOf: () => "product" });

describe("MUST-FIRE: python layout", () => {
	const tree = {
		"pkg/__init__.py": "", "pkg/a.py": "x = 1\n", "pkg/b.py": "y = 2\n", "pkg/c.py": "z = 3\n",
		"tests/test_a.py": "from pkg.a import x\n", "tests/test_misc.py": "import pkg.b\n",
	};
	it("P1: counts modules covered by name mapping and by import separately and lists the rest as candidates", () => {
		const python = analyze(tree).python;
		expect(python).toMatchObject({ status: "ok", product_modules: 3, test_files: 2, tag: "[heuristic]" });
		expect(python?.by_name_mapping).toEqual({ covered: 1, total: 3 });
		expect(python?.imported_by_tests).toEqual({ covered: 2, total: 3 });
		expect(python?.covered_by_either).toBe(2);
		expect(python?.no_test_import_candidates).toEqual(["pkg/c.py"]);
	});
	it("P2: a test in <pkg>/tests, tests/unit/<pkg path> and tests/<name> all count by name", () => {
		const python = analyze({ "pkg/m1.py": "", "pkg/sub/m2.py": "", "other/m3.py": "", "pkg/tests/test_m1.py": "", "tests/unit/pkg/sub/test_m2.py": "", "tests/test_m3.py": "" }).python;
		expect(python?.by_name_mapping).toEqual({ covered: 3, total: 3 });
	});
});

describe("MUST-FIRE: javascript layout", () => {
	const tree = {
		"src/lib/foo.ts": "export const foo = 1;\n", "src/lib/bar.ts": "export const bar = 1;\n", "src/util/baz.ts": "export const baz = 1;\n", "src/util/qux.ts": "export const qux = 1;\n",
		"src/__tests__/foo.test.ts": "import {} from 'vitest';\n", "tests/misc.spec.ts": 'import { bar } from "../src/lib/bar";\n', "src/util/qux.test.ts": "",
	};
	it("P3: name mapping sees __tests__ at an ancestor and a sibling test; the import rule sees a test elsewhere", () => {
		const javascript = analyze(tree).javascript;
		expect(javascript?.by_name_mapping).toEqual({ covered: 2, total: 4 });
		expect(javascript?.imported_by_tests).toEqual({ covered: 1, total: 4 });
		expect(javascript?.covered_by_either).toBe(3);
		expect(javascript?.no_test_import_candidates).toEqual(["src/util/baz.ts"]);
	});
	it("P4: a name qualifier (update.integration.test.ts) and kebab versus camel case still map", () => {
		const javascript = analyze({ "src/user-service.ts": "", "src/update.ts": "", "src/userService.test.ts": "", "src/update.integration.test.ts": "" }).javascript;
		expect(javascript?.by_name_mapping).toEqual({ covered: 2, total: 2 });
	});
	it("P5: the printed rule text names the mapping and the import rule", () => {
		const layout = analyze(tree);
		expect(layout.rule.mapping).toContain("__tests__");
		expect(layout.rule.import).toContain("imports");
	});
});

describe("MUST-NOT-FIRE: the rule says when it cannot judge", () => {
	it("N1: no test file at all is cannot-judge with no candidates", () => {
		const python = analyze({ "pkg/a.py": "", "pkg/b.py": "" }).python;
		expect(python).toMatchObject({ status: "cannot-judge", cannot_judge_reason: "no test files found", no_test_import_candidates: [] });
	});
	it("N2: a test-discovery setting the rule does not support is cannot-judge and names the setting", () => {
		const python = analyze({ "pkg/a.py": "", "tests/test_a.py": "", "pytest.ini": "[pytest]\npython_files = check_*.py\n" }).python;
		expect(python).toMatchObject({ status: "cannot-judge", no_test_import_candidates: [] });
		expect(python?.cannot_judge_reason).toBe("test discovery is configured with a pattern the rule does not support: pytest.ini: python_files = check_*.py");
	});
	it("N3: a language with no files has no block, and index files, declarations and config files are not modules", () => {
		const layout = analyze({ "src/index.ts": "", "src/types.d.ts": "", "vitest.config.ts": "", "src/real.ts": "", "src/real.test.ts": "" });
		expect(layout.python).toBeUndefined();
		expect(layout.javascript?.product_modules).toBe(1);
	});
	it("N4: a path whose role is not product (generated, vendor) is not counted as a module", () => {
		const layout = analyzeLayout({ files: ["gen/a.py", "pkg/b.py", "tests/test_b.py"], read: () => "", roleOf: (path) => (path.startsWith("gen/") ? "generated" : "product") });
		expect(layout.python?.product_modules).toBe(1);
	});
	it("N5: an import of a module that is not in the repository credits nothing", () => {
		const python = analyze({ "pkg/a.py": "", "tests/test_x.py": "import requests\nimport os\n" }).python;
		expect(python?.imported_by_tests.covered).toBe(0);
	});
});

describe("applyMissingTestsLayout", () => {
	const roots: string[] = [];
	afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
	function tree(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), "missing-tests-layout-"));
		roots.push(root);
		for (const [path, text] of Object.entries(files)) { mkdirSync(join(root, dirname(path)), { recursive: true }); writeFileSync(join(root, path), text); }
		return root;
	}
	it("P6: adds a layout block, keeps the old file list untouched and returns a note when it cannot judge", () => {
		const root = tree({ "pkg/a.py": "x = 1\n" });
		const results = [{ name: "missing-tests", files: new Set(["pkg/a.py"]) as Set<string> }];
		const notes = applyMissingTestsLayout(results, root);
		expect([...results[0]?.files ?? []]).toEqual(["pkg/a.py"]);
		expect(results[0]).toHaveProperty("details.layout.python.status", "cannot-judge");
		expect(notes.join("\n")).toContain("cannot judge");
	});
	it("N6: another check's result is left alone", () => {
		const results = [{ name: "cycles", files: new Set<string>() }];
		expect(applyMissingTestsLayout(results, tree({ "a.py": "" }))).toEqual([]);
		expect(results[0]).not.toHaveProperty("details");
	});
});
