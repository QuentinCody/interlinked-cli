// Real-interpreter tests for phase 3, classes 1 and 2 of the broken-imports false positives:
// a directory that sits INSIDE a package (it holds `__init__.py`) is not an import root. Python puts
// a file's own directory on the import path only when that file runs as a script, and a project
// directory that is itself a package is imported from its parent. Each MUST-NOT-FIRE case has a
// MUST-FIRE twin whose layout makes the directory a real root.
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

function scan(files: Record<string, string>): PythonImportScan {
	const root = mkdtempSync(join(tmpdir(), "check-pypkg-"));
	created.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	const result = scanPythonBrokenImports(root);
	expect(result.status).toBe("ok");
	return result;
}

const keys = (result: PythonImportScan): string[] => result.candidates.map((c) => `${c.importer}:${c.line}:${c.kind}${c.name ? `:${c.name}` : ""}`).sort();
const PROJECT = "[project]\nname = \"x\"\n";

describe("class 1: a project directory that is itself a package is not a root", () => {
	const SHELF = {
		"shelf_policy/pyproject.toml": PROJECT,
		"shelf_policy/__init__.py": "",
		"shelf_policy/types.py": "def ok():\n    pass\n",
		"shelf_policy/paperkit/__init__.py": "",
		"shelf_policy/paperkit/config.py": "from paperkit.configs.types import PageType\nfrom types import SimpleNamespace\n",
		"shelf_policy/indexbus/__init__.py": "",
		"shelf_policy/indexbus/client.py": "import indexbus\nfrom indexbus.aio.client import Client\n",
	};

	it("N1: third-party names that equal a nested sub-package, and a stdlib name that equals a module, are not judged", () => {
		const r = scan(SHELF);
		expect(r.candidates).toEqual([]);
		expect(r.importRoots).toEqual(["."]);
	});

	it("F1: twin — the same files in a project directory that is NOT a package make the directory a root", () => {
		const r = scan({
			"proj/pyproject.toml": PROJECT,
			"proj/mylib/__init__.py": "def ok():\n    pass\n",
			"proj/app.py": "from mylib import ok, gone\n",
		});
		expect(keys(r)).toEqual(["proj/app.py:1:missing_name:gone"]);
	});

	it("N1b: a setup.py inside a package is a module (a CLI command), not a build file, so its directory is no root", () => {
		const r = scan({
			"pkg/__init__.py": "",
			"pkg/cli/__init__.py": "",
			"pkg/cli/setup.py": "def run():\n    pass\n",
			"pkg/cli/helpers.py": "def ok():\n    pass\n",
			"pkg/cli/m.py": "from helpers import ok, gone\n",
		});
		expect(r.candidates).toEqual([]);
		expect(r.importRoots).toEqual(["."]);
	});

	it("F2: a real broken import through the package name still fires", () => {
		const r = scan({ ...SHELF, "shelf_policy/paperkit/client.py": "from shelf_policy.types import ok, gone\n" });
		expect(keys(r)).toEqual(["shelf_policy/paperkit/client.py:1:missing_name:gone"]);
	});
});

describe("class 2: a module never resolves an absolute import to itself inside a package", () => {
	const NHX = {
		"src/shelf/__init__.py": "",
		"src/shelf/testing/__init__.py": "",
		"src/shelf/testing/e2e/__init__.py": "",
		"src/shelf/testing/e2e/docklib.py": "from docklib import from_env as docklib_from_env\n",
	};

	it("N2: the file name of an importer in a package does not shadow a third-party package", () => {
		expect(scan(NHX).candidates).toEqual([]);
	});

	it("F3: twin — a test module in a plain directory (no __init__.py) that imports its sibling still fires", () => {
		const r = scan({
			"tests/helper.py": "def ok():\n    pass\n",
			"tests/test_a.py": "from helper import ok, gone\n",
		});
		expect(keys(r)).toEqual(["tests/test_a.py:1:missing_name:gone"]);
	});

	it("N3: a test module in a PACKAGE directory does not get its own directory as a root (pytest uses the parent of the chain)", () => {
		const r = scan({
			"suite/__init__.py": "",
			"suite/paperkit/__init__.py": "",
			"suite/test_a.py": "from paperkit.configs import PageType\n",
		});
		expect(r.candidates).toEqual([]);
	});
});

describe("scripts, examples and docs run by path keep their own directory as a root", () => {
	it("F4: a script with a main guard in a plain directory resolves a sibling and fires", () => {
		const r = scan({
			"scripts/helper.py": "def ok():\n    pass\n",
			"scripts/run.py": "from helper import ok, gone\nif __name__ == \"__main__\":\n    ok()\n",
		});
		expect(keys(r)).toEqual(["scripts/run.py:1:missing_name:gone"]);
	});

	it("F5: an example with a main guard inside a package directory is run by path, so its directory is a root", () => {
		const r = scan({
			"pkg/__init__.py": "",
			"pkg/examples/__init__.py": "",
			"pkg/examples/sibling.py": "def ok():\n    pass\n",
			"pkg/examples/demo.py": "from sibling import ok, gone\nif __name__ == \"__main__\":\n    ok()\n",
		});
		expect(keys(r)).toEqual(["pkg/examples/demo.py:1:missing_name:gone"]);
	});

	it("N4: the same example without a main guard, in a package, is a module: no directory root", () => {
		const r = scan({
			"pkg/__init__.py": "",
			"pkg/examples/__init__.py": "",
			"pkg/examples/sibling.py": "def ok():\n    pass\n",
			"pkg/examples/demo.py": "from sibling import ok, gone\n",
		});
		expect(r.candidates).toEqual([]);
	});

	it("N5: a module with a main guard in a plain package (role other) is run with -m, so no directory root", () => {
		const r = scan({
			"pkg/__init__.py": "",
			"pkg/sibling.py": "def ok():\n    pass\n",
			"pkg/cli.py": "from sibling import ok, gone\nif __name__ == \"__main__\":\n    ok()\n",
		});
		expect(r.candidates).toEqual([]);
	});
});

describe("stdlib names are not first-party through an installed or declared root", () => {
	const TREE = {
		"proj/pyproject.toml": PROJECT,
		"proj/types.py": "def ok():\n    pass\n",
		"proj/app/__init__.py": "",
	};

	it("N6: from types import X inside a project whose root holds types.py is the standard library", () => {
		const r = scan({ ...TREE, "proj/app/m.py": "from types import SimpleNamespace\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips.stdlib_name_not_shadowed ?? 0).toBeGreaterThan(0);
	});

	it("F6: twin — a script that sits in the directory with types.py shadows the standard library, so the name is first-party", () => {
		const r = scan({
			"scripts/types.py": "def ok():\n    pass\n",
			"scripts/run.py": "from types import ok, gone\n",
		});
		expect(keys(r)).toEqual(["scripts/run.py:1:missing_name:gone"]);
	});

	it("F7: a first-party name that is not a stdlib name still resolves through the project root", () => {
		const r = scan({ ...TREE, "proj/helpers.py": "def ok():\n    pass\n", "proj/app/m.py": "from helpers import ok, gone\n" });
		expect(keys(r)).toEqual(["proj/app/m.py:1:missing_name:gone"]);
	});
});
