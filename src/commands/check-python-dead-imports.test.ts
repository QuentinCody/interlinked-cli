// Real-interpreter tests for check-python-dead-imports.ts (dead-imports on Python): an imported
// name that the module never uses. A use is a name read anywhere in the module (any scope), a
// name inside a string annotation, a `cast("X", ...)` or `TypeVar(bound="X")` string, a
// `# type:` comment, or an entry of `__all__`. Docstrings and comments do not count as use.
// Not reported: `__init__.py` (re-exports), `conftest.py`, `__future__`, star imports, dunder
// names, `import x as x` (explicit re-export), `# noqa: F401`, a try/except ImportError guard,
// a name that another first-party module imports from this one, a module that reads its own
// namespace dynamically. Each MUST-NOT-FIRE case has a MUST-FIRE twin.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describePythonDeadImports, scanPythonDeadImports, type PythonDeadImportsScan } from "./check-python-dead-imports.js";
import { runPythonAnalysis } from "./check-python-run.js";

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function scan(files: Record<string, string>, opts: { git?: boolean } = {}): PythonDeadImportsScan {
	const root = mkdtempSync(join(tmpdir(), "check-pydead-"));
	roots.push(root);
	if (opts.git) execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	const result = scanPythonDeadImports(root, runPythonAnalysis(root));
	expect(result.status).toBe("ok");
	return result;
}

/** `path:line:name` for every dead import found. */
function dead(result: PythonDeadImportsScan): string[] {
	return result.entries.flatMap((entry) => entry.imports.map((item) => `${entry.path}:${item.line}:${item.name}`)).sort();
}

describe("A1 dead imports (MUST-FIRE)", () => {
	it("F1: a module that is imported and never used", () => {
		const r = scan({ "a.py": "import os\nimport sys\nprint(sys.argv)\n" });
		expect(dead(r)).toEqual(["a.py:1:os"]);
		expect(r.entries[0]?.imports[0]).toMatchObject({ statement: "import os", bare_import: true, type_only: false, in_function: false });
	});

	it("F2: a from-import of which one name is unused", () => {
		const r = scan({ "a.py": "from typing import List, Dict\nx: List[int] = []\n" });
		expect(dead(r)).toEqual(["a.py:1:Dict"]);
		expect(r.entries[0]?.imports[0]).toMatchObject({ module: "typing", bare_import: false });
	});

	it("F3: a dotted import binds its first component; an alias binds the alias", () => {
		const r = scan({ "a.py": "import a1.b.c\nimport numpy as np\nfrom m import x as y\n" });
		expect(dead(r)).toEqual(["a.py:1:a1", "a.py:2:np", "a.py:3:y"]);
	});

	it("F4: an import under TYPE_CHECKING that nothing uses, and an unused import in a function", () => {
		const r = scan({ "a.py": "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    import decimal\ndef f():\n    import json\n    return 1\n" });
		expect(dead(r)).toEqual(["a.py:3:decimal", "a.py:5:json"]);
		const byName = Object.fromEntries((r.entries[0]?.imports ?? []).map((i) => [i.name, i]));
		expect(byName.decimal).toMatchObject({ type_only: true, in_function: false });
		expect(byName.json).toMatchObject({ type_only: false, in_function: true });
	});

	it("F5: unused imports in test modules are reported (the TypeScript scan reads tests)", () => {
		expect(dead(scan({ "tests/test_a.py": "import os\n\ndef test_x():\n    assert True\n" }))).toEqual(["tests/test_a.py:1:os"]);
	});

	it("F6: a name that only a docstring or a comment mentions is dead", () => {
		const r = scan({ "a.py": 'import os\n"""uses os somewhere"""\n# os.getcwd()\ndef f():\n    """os.path"""\n' });
		expect(dead(r)).toEqual(["a.py:1:os"]);
	});

	it("F7: a name that is not in __all__ and not used is dead; the __all__ twin is N2", () => {
		expect(dead(scan({ "a.py": "import os\nimport sys\n__all__ = ['sys']\n" }))).toEqual(["a.py:1:os"]);
	});

	it("F8: noqa codes that do not name F401 do not silence it (twin of N3)", () => {
		const r = scan({ "a.py": "import os  # noqa: E501\nimport sys  # noqa: E402, W291\nimport re  # type: ignore\n" });
		expect(dead(r)).toEqual(["a.py:1:os", "a.py:2:sys", "a.py:3:re"]);
	});

	it("F9: a function parameter named like the import does not use it outside tests (twin of N9)", () => {
		expect(dead(scan({ "a.py": "from fix import my_fixture\ndef f(my_fixture):\n    return 1\n" }))).toEqual(["a.py:1:my_fixture"]);
	});

	it("F10: an import that nobody imports from this module, in a module that is not a package __init__ (twin of N10)", () => {
		const r = scan({ "pkg/__init__.py": "", "pkg/core.py": "def helper():\n    pass\n", "pkg/api.py": "from pkg.core import helper\n" });
		expect(dead(r)).toEqual(["pkg/api.py:1:helper"]);
	});

	it("F11: a module that has no dynamic namespace access is judged (twin of N11)", () => {
		expect(dead(scan({ "a.py": "import os\nx = 1\n" }))).toEqual(["a.py:1:os"]);
	});

	it("F12: a method called eval or exec is not a dynamic namespace access", () => {
		expect(dead(scan({ "a.py": "import os\nmodel.eval()\nrunner.exec('x')\n" }))).toEqual(["a.py:1:os"]);
	});
});

describe("B1 used or exempt (MUST-NOT-FIRE twins)", () => {
	it("N1: read as an attribute root, a call, a decorator, a base class, a default, in an f-string and in a comprehension", () => {
		const body = [
			"import os, abc, enum, json, re, sys, time, math",
			"@abc.abstractmethod",
			"def f(x=time.time):",
			"    return [math.pi for _ in range(3)]",
			"class K(enum.Enum):",
			"    pass",
			"print(f'{json.dumps({})}', os.getcwd(), re, sys)",
		].join("\n");
		expect(dead(scan({ "a.py": `${body}\n` }))).toEqual([]);
	});

	it("N2: listed in __all__ as a list, a tuple, with +=, or with extend", () => {
		const files = {
			"a.py": "import os\n__all__ = ['os']\n",
			"b.py": "import os\n__all__ = ('os',)\n",
			"c.py": "import os\n__all__ = []\n__all__ += ['os']\n",
			"d.py": "import os\n__all__ = []\n__all__.extend(['os'])\n",
		};
		expect(dead(scan(files))).toEqual([]);
	});

	it("N3: a noqa that covers F401, bare, with several codes, on the last line of a multi-line import", () => {
		const files = {
			"a.py": "import os  # noqa\nimport sys  # noqa: F401\nimport re  # noqa: E402, F401\nimport json  # NOQA:F401\nimport abc  # noqa: F\n",
			"b.py": "from typing import (\n    List,\n    Dict,\n)  # noqa: F401\n",
			"c.py": "import os  # pylint: disable=unused-import\n",
			"d.py": "# ruff: noqa: F401\nimport os\nimport sys\n",
		};
		expect(dead(scan(files))).toEqual([]);
	});

	it("N4: __init__.py imports are re-exports; the same import in another module is judged (twin F1)", () => {
		const r = scan({ "pkg/__init__.py": "from .core import helper\nimport os\n", "pkg/core.py": "def helper():\n    pass\n" });
		expect(dead(r)).toEqual([]);
		expect(r.deadSkips.package_init).toBe(2);
	});

	it("N5: used only in a string annotation, a nested string, cast, TypeVar bound or a type comment", () => {
		const body = [
			"from typing import List, TypeVar, cast",
			"from m import A, B, C, D, E",
			"def f(x: 'A') -> List['B']:",
			"    y = cast('C', x)",
			"    z = []  # type: List[E]",
			"    return y",
			"T = TypeVar('T', bound='D')",
			"v: 'List[T]' = []",
		].join("\n");
		expect(dead(scan({ "a.py": `${body}\n` }))).toEqual([]);
	});

	it("N6: an explicit re-export alias", () => {
		expect(dead(scan({ "a.py": "from m import x as x\nimport os as os\n" }))).toEqual([]);
	});

	it("N7: __future__, a star import and a dunder binding", () => {
		const r = scan({ "a.py": "from __future__ import annotations\nfrom m import *\nfrom ._version import version as __version__\n" });
		expect(dead(r)).toEqual([]);
	});

	it("N8: an import under try/except ImportError is an availability probe", () => {
		const r = scan({ "a.py": "try:\n    import numpy\nexcept ImportError:\n    numpy = None\ntry:\n    import yaml\nexcept Exception:\n    pass\n" });
		expect(dead(r)).toEqual([]);
		expect(r.deadSkips.try_importerror_guard).toBe(2);
	});

	it("N9: conftest.py imports fixtures; a test module that takes a fixture as a parameter uses it", () => {
		const files = {
			"conftest.py": "from fixtures import my_fixture\n",
			"tests/test_a.py": "from fixtures import other\ndef test_x(other):\n    assert other\n",
		};
		const r = scan(files);
		expect(dead(r)).toEqual([]);
		expect(r.deadSkips.conftest).toBe(1);
	});

	it("N10: another first-party module imports the name from this one (a facade module)", () => {
		const r = scan({
			"pkg/__init__.py": "",
			"pkg/core.py": "def helper():\n    pass\n",
			"pkg/api.py": "from pkg.core import helper\n",
			"app.py": "from pkg.api import helper\nhelper()\n",
		});
		expect(dead(r)).toEqual([]);
		expect(r.deadSkips.imported_by_other_module).toBe(1);
	});

	it("N11: a module that reads its own namespace dynamically is skipped and counted", () => {
		for (const call of ["globals()['x']", "locals()", "eval('os')", "exec('import os')"]) {
			const r = scan({ "a.py": `import os\nx = ${call}\n` });
			expect(dead(r)).toEqual([]);
			expect(r.deadSkips.dynamic_namespace).toBe(1);
		}
	});

	it("N12: del counts as a use, and a nested function or lambda reads an outer import", () => {
		const r = scan({ "a.py": "import os, sys\nimport re\ndef f():\n    return lambda: sys.argv\ndel os\nprint(re)\n" });
		expect(dead(r)).toEqual([]);
	});

	it("N15: an augmented assignment reads the name (settings.py shape: MIDDLEWARE += [...])", () => {
		const r = scan({ "base.py": "MIDDLEWARE = []\n", "local.py": "from .base import MIDDLEWARE\nMIDDLEWARE += ['x']\n" });
		expect(dead(r)).toEqual([]);
	});

	it("F13: twin of N15 — a plain re-assignment does not read the name", () => {
		const r = scan({ "base.py": "MIDDLEWARE = []\n", "local.py": "from .base import MIDDLEWARE\nMIDDLEWARE = ['x']\n" });
		expect(dead(r)).toEqual(["local.py:1:MIDDLEWARE"]);
	});

	it("N16: a forward-reference string inside a subscript of a type alias reads the name", () => {
		const body = "from typing import TYPE_CHECKING, Callable\nif TYPE_CHECKING:\n    from m import Foo\nAlias = Callable[['Foo'], 'Foo | None']\n";
		expect(dead(scan({ "a.py": body }))).toEqual([]);
	});

	it("F14: twin of N16 — a name that only appears in a plain string is not read", () => {
		const body = "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from m import Foo\nlabel = 'Foo'\n";
		expect(dead(scan({ "a.py": body }))).toEqual(["a.py:3:Foo"]);
	});

	it("N13: a git-ignored module is not read and not reported (twin: b.py)", () => {
		const r = scan({ ".gitignore": "gen.py\n", "gen.py": "import os\n", "b.py": "import os\n" }, { git: true });
		expect(dead(r)).toEqual(["b.py:1:os"]);
	});

	it("N14: a module that does not parse is not judged", () => {
		expect(dead(scan({ "a.py": "import os\ndef (:\n" }))).toEqual([]);
	});
});

describe("C1 description", () => {
	it("C1: a tree without Python adds nothing to the output", () => {
		const root = mkdtempSync(join(tmpdir(), "check-pydead-"));
		roots.push(root);
		writeFileSync(join(root, "a.ts"), "export {};\n");
		expect(describePythonDeadImports(scanPythonDeadImports(root, runPythonAnalysis(root)))).toEqual({ details: null, notes: [] });
	});

	it("C2: the details count files and imports and name the exempt classes", () => {
		const python = describePythonDeadImports(scan({ "a.py": "import os\nimport sys\n", "pkg/__init__.py": "import re\n" })).details?.python as Record<string, unknown>;
		expect(python).toMatchObject({ status: "ok", file_count: 1, import_count: 2, python_files: 2, dead_skips: { package_init: 1 } });
	});
});
