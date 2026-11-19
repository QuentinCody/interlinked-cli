// Real-interpreter tests for the import roots that static files in the repository declare
// (phase 2, H2). Every case plants `app.py` with `from mylib import ok, gone` (or a
// sibling) and a package `mylib` in a directory that is NOT a root by default. The root is
// known when the scan judges the import (MUST-FIRE: `gone` is a candidate) and unknown
// otherwise (MUST-NOT-FIRE twin: the name is third-party, so no candidate).
// Nothing is executed: the analyzer reads the files as text.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanPythonBrokenImports, type PythonImportScan } from "./check-python-imports.js";

const created: string[] = [];

afterEach(() => {
	for (const r of created.splice(0)) rmSync(r, { recursive: true, force: true });
});

const LIB = { "lib/mylib/__init__.py": "def ok():\n    pass\n", "app.py": "from mylib import ok, gone\n" };

function scan(files: Record<string, string | ((root: string) => string)>): PythonImportScan {
	const root = mkdtempSync(join(tmpdir(), "check-pyroot-"));
	created.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, typeof content === "function" ? content(root) : content, "utf-8");
	}
	const result = scanPythonBrokenImports(root);
	expect(result.status).toBe("ok");
	return result;
}

const keys = (result: PythonImportScan): string[] => result.candidates.map((c) => `${c.importer}:${c.line}:${c.kind}${c.name ? `:${c.name}` : ""}`).sort();
const FIRES = ["app.py:1:missing_name:gone"];

describe("R1 .pth and editable-install layouts", () => {
	it("F1: a .pth file that lists a repository directory makes it a root", () => {
		expect(keys(scan({ ...LIB, "env/site.pth": "# comment\n../lib\n" }))).toEqual(FIRES);
	});

	it("N1: a .pth line that is an import statement, leaves the repository or names no directory is not a root", () => {
		const r = scan({ ...LIB, "site.pth": "import sys; sys.path.insert(0, 'lib')\n../outside\nnodir\n" });
		expect(r.candidates).toEqual([]);
		expect(r.importRoots).toEqual(["."]);
	});

	it("F2: an absolute .pth line inside the repository counts", () => {
		expect(keys(scan({ ...LIB, "site.pth": (root) => `${join(root, "lib")}\n` }))).toEqual(FIRES);
	});

	it("N2: an absolute .pth line outside the repository is ignored", () => {
		expect(scan({ ...LIB, "site.pth": "/definitely/not/here\n" }).candidates).toEqual([]);
	});

	it("F3: an .egg-link file names the source directory of a develop install", () => {
		expect(keys(scan({ ...LIB, "mylib.egg-link": "lib\n.\n" }))).toEqual(FIRES);
	});

	it("F4: a directory that holds a *.egg-info directory is a root (setup.py develop layout)", () => {
		expect(keys(scan({ ...LIB, "lib/mylib.egg-info/PKG-INFO": "Name: mylib\n" }))).toEqual(FIRES);
	});

	it("N3: the twin without any of those files does not judge the import", () => {
		expect(scan(LIB).candidates).toEqual([]);
	});
});

describe("R2 import roots in INI-style files", () => {
	it("F5: pytest.ini [pytest] pythonpath, space and newline separated", () => {
		expect(keys(scan({ ...LIB, "pytest.ini": "[pytest]\npythonpath =\n    lib\n    other\n" }))).toEqual(FIRES);
	});

	it("F6: tox.ini [pytest] pythonpath", () => {
		expect(keys(scan({ ...LIB, "tox.ini": "[tox]\nenvlist = py\n[pytest]\npythonpath = lib\n" }))).toEqual(FIRES);
	});

	it("F7: setup.cfg [tool:pytest] pythonpath", () => {
		expect(keys(scan({ ...LIB, "setup.cfg": "[tool:pytest]\npythonpath = lib\n" }))).toEqual(FIRES);
	});

	it("F8: setup.cfg [options] package_dir with an empty key", () => {
		expect(keys(scan({ ...LIB, "setup.cfg": "[options]\npackage_dir =\n    =lib\n" }))).toEqual(FIRES);
	});

	it("F9: setup.cfg [options.packages.find] where", () => {
		expect(keys(scan({ ...LIB, "setup.cfg": "[options.packages.find]\nwhere = lib\n" }))).toEqual(FIRES);
	});

	it("N4: a pythonpath key in a section pytest does not read is ignored, and a broken file does not stop the scan", () => {
		const r = scan({ ...LIB, "tox.ini": "[other]\npythonpath = lib\n", "setup.cfg": "this is [not ini\n" });
		expect(r.candidates).toEqual([]);
	});

	it("F10: a pythonpath root serves the importers below the file, not a sibling project", () => {
		const r = scan({
			"proj/pytest.ini": "[pytest]\npythonpath = lib\n",
			"proj/lib/mylib/__init__.py": "",
			"proj/app.py": "from mylib import gone\n",
			"other/app2.py": "from mylib import gone\n",
		});
		expect(keys(r)).toEqual(["proj/app.py:1:missing_name:gone"]);
	});
});

describe("R3 import roots in setup.py", () => {
	it("F11: package_dir={'': 'lib'} as a literal dict", () => {
		const files = { ...LIB, "setup.py": "from setuptools import setup\nsetup(name='x', package_dir={'': 'lib'})\n" };
		expect(keys(scan(files))).toEqual(FIRES);
	});

	it("F12: packages=find_packages(where='lib') and a positional where", () => {
		expect(keys(scan({ ...LIB, "setup.py": "from setuptools import setup, find_packages\nsetup(packages=find_packages(where='lib'))\n" }))).toEqual(FIRES);
		expect(keys(scan({ ...LIB, "setup.py": "import setuptools\nsetuptools.setup(packages=setuptools.find_namespace_packages('lib'))\n" }))).toEqual(FIRES);
	});

	it("N5: a value that is not a literal is not guessed, and setup.py is never executed", () => {
		const marker = "executed.txt";
		const r = scan({
			...LIB,
			"setup.py": `from setuptools import setup\nPD = {'': 'lib'}\nopen('${marker}', 'w').write('x')\nsetup(package_dir=PD)\n`,
		});
		expect(r.candidates).toEqual([]);
	});
});

describe("R4 import roots in pyproject.toml build sections", () => {
	const pyproject = (body: string): Record<string, string> => ({ ...LIB, "pyproject.toml": body });

	it("F13: [tool.hatch.build.targets.wheel] packages names a package directory; the parent is the root", () => {
		expect(keys(scan(pyproject('[tool.hatch.build.targets.wheel]\npackages = ["lib/mylib"]\n')))).toEqual(FIRES);
	});

	it("F14: [tool.hatch.build] sources as a list, and as a table of prefixes", () => {
		expect(keys(scan(pyproject('[tool.hatch.build]\nsources = ["lib"]\n')))).toEqual(FIRES);
		expect(keys(scan(pyproject('[tool.hatch.build.sources]\n"lib" = ""\n')))).toEqual(FIRES);
	});

	it("F15: [tool.pdm.build] package-dir and includes", () => {
		expect(keys(scan(pyproject('[tool.pdm.build]\npackage-dir = "lib"\n')))).toEqual(FIRES);
		expect(keys(scan(pyproject('[tool.pdm.build]\nincludes = ["lib/mylib"]\n')))).toEqual(FIRES);
	});

	it("F16: [tool.uv.build-backend] module-root", () => {
		expect(keys(scan(pyproject('[tool.uv.build-backend]\nmodule-root = "lib"\n')))).toEqual(FIRES);
	});

	it("F17: [tool.maturin] python-source", () => {
		expect(keys(scan(pyproject('[tool.maturin]\npython-source = "lib"\n')))).toEqual(FIRES);
	});

	it("F18: [tool.poetry] packages with from", () => {
		expect(keys(scan(pyproject('[tool.poetry]\npackages = [{ include = "mylib", from = "lib" }]\n')))).toEqual(FIRES);
	});

	it("F19: [tool.setuptools.package-dir] name = directory: the parent of a directory that carries the name is the root", () => {
		expect(keys(scan(pyproject('[tool.setuptools.package-dir]\nmylib = "lib/mylib"\n')))).toEqual(FIRES);
	});

	it("N6: a package-dir alias to a differently named directory is not judged (no guess)", () => {
		const r = scan({
			"pyproject.toml": '[tool.setuptools.package-dir]\nfoo = "lib/impl"\n',
			"lib/impl/__init__.py": "",
			"lib/impl/mod.py": "",
			"app.py": "import foo.gone\n",
		});
		expect(r.candidates).toEqual([]);
		expect(r.skips.package_dir_alias).toBe(1);
	});

	it("N7: a section that names a directory which does not exist or leaves the repository adds no root", () => {
		const r = scan(pyproject('[tool.hatch.build]\nsources = ["../outside", "nodir"]\n[tool.uv.build-backend]\nmodule-root = "nodir"\n'));
		expect(r.candidates).toEqual([]);
		expect(r.importRoots).toEqual(["."]);
	});
});

describe("R5 pytest base directory applies to the modules pytest collects", () => {
	const TREE = {
		"sim/pk/__init__.py": "",
		"sim/pk/tests/__init__.py": "",
	};

	it("N8: a helper script in a tests package, which pytest does not collect, does not get the package parent as a root", () => {
		const r = scan({ ...TREE, "sim/pk/tests/script.py": "import pk.evaluation\nif __name__ == '__main__':\n    pass\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips.owner_ignore_comment).toBeUndefined();
	});

	it("F20: twin — a collected test module in the same package does get it, and the missing submodule fires", () => {
		const r = scan({ ...TREE, "sim/pk/tests/test_x.py": "import pk.evaluation\n" });
		expect(keys(r)).toEqual(["sim/pk/tests/test_x.py:1:missing_module"]);
	});

	it("F21: twin — conftest.py and *_test.py are collected too", () => {
		const r = scan({ ...TREE, "sim/pk/tests/conftest.py": "import pk.one\n", "sim/pk/tests/y_test.py": "import pk.two\n" });
		expect(keys(r)).toEqual(["sim/pk/tests/conftest.py:1:missing_module", "sim/pk/tests/y_test.py:1:missing_module"]);
	});
});
