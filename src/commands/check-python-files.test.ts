// Tests for check-python-files.ts: the project file list (git, or a bounded walk) and the
// path-based role of a Python file. The role rule is a copy of `importer_role` in the embedded
// analyzer; the parity test below fails when the two drift.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listProjectFiles, pythonRole } from "./check-python-files.js";
import { scanPythonBrokenImports } from "./check-python-imports.js";

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tree(files: Record<string, string>, git = false): string {
	const root = mkdtempSync(join(tmpdir(), "check-pyfiles-"));
	roots.push(root);
	if (git) execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	return root;
}

describe("A1 pythonRole", () => {
	it("F1: test, example, docs, script and other", () => {
		expect(pythonRole("tests/helpers.py")).toBe("test");
		expect(pythonRole("pkg/test_a.py")).toBe("test");
		expect(pythonRole("pkg/a_test.py")).toBe("test");
		expect(pythonRole("pkg/conftest.py")).toBe("test");
		expect(pythonRole("examples/a.py")).toBe("example");
		expect(pythonRole("docs/conf.py")).toBe("docs");
		expect(pythonRole("scripts/a.py")).toBe("script");
		expect(pythonRole("setup.py")).toBe("script");
		expect(pythonRole("pkg/core.py")).toBe("other");
	});

	it("F5: a <package>_tests directory, and example or sample words in a hyphenated or underscored directory name", () => {
		expect(pythonRole("libs/dagster_modal_tests/helpers.py")).toBe("test");
		expect(pythonRole("libs/dagster-modal-tests/helpers.py")).toBe("test");
		expect(pythonRole("libs/example-project/definitions.py")).toBe("example");
		expect(pythonRole("res/sample_code/zoom.py")).toBe("example");
		expect(pythonRole("pkg/exampleish/real.py")).toBe("other");
		expect(pythonRole("pkg/contest/real.py")).toBe("other");
	});

	it("F2: parity with the analyzer's importer_role on the same paths", () => {
		const paths = ["tests/a.py", "pkg/test_b.py", "pkg/c_test.py", "pkg/conftest.py", "examples/d.py", "demo/e.py", "docs/f.py", "scripts/g.py", "ci/h.py", "setup.py", "noxfile.py", "pkg/core.py", "src/pkg/Tests/i.py", "libs/pkg_tests/j.py", "libs/example-project/k.py", "res/sample_code/l.py", "pkg/exampleish/m.py", "pkg/contest/n.py"];
		const files: Record<string, string> = { "pkg/__init__.py": "" };
		for (const path of paths) files[path] = "import pkg.gone\n";
		const scan = scanPythonBrokenImports(tree(files));
		const byImporter = new Map(scan.candidates.map((c) => [c.importer, String(c.tags.importer_role)]));
		for (const path of paths) expect([path, byImporter.get(path)]).toEqual([path, pythonRole(path)]);
	});
});

describe("B1 listProjectFiles", () => {
	it("F3: inside a git repository the list is tracked plus untracked files that are not ignored", () => {
		const root = tree({ "a.py": "", "keep/b.py": "", "skip/c.py": "", ".gitignore": "skip/\n" }, true);
		const listed = listProjectFiles(root);
		expect(listed.source).toBe("git");
		expect([...listed.files].sort()).toEqual([".gitignore", "a.py", "keep/b.py"]);
	});

	it("F4: outside git the walk skips dot-directories and dependency directories", () => {
		const root = tree({ "a.py": "", "pkg/b.py": "", ".hidden/c.py": "", "node_modules/d/e.py": "", "x/__pycache__/f.py": "", ".venv/g.py": "" });
		const listed = listProjectFiles(root);
		expect(listed.source).toBe("walk");
		expect([...listed.files].sort()).toEqual(["a.py", "pkg/b.py"]);
	});

	it("N1: a directory that does not exist lists nothing and does not throw", () => {
		expect(listProjectFiles("/definitely/not/a/directory").files).toEqual([]);
	});
});
