// Real-interpreter tests for check-python-imports.ts (broken-imports on Python).
// Every MUST-NOT-FIRE case is a trap from the pyprobe fixture, with a MUST-FIRE twin.
// The resolution-root cases (script directory, conftest, pyproject) are the ones the
// first probe could not model. No mocks: `python3 -I -S -B` and `git check-ignore` run.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PythonSpawn } from "./check-python-run.js";
import { describePythonScan, scanPythonBrokenImports, type PythonImportScan } from "./check-python-imports.js";

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function project(files: Record<string, string>, opts: { git?: boolean } = {}): string {
	const root = mkdtempSync(join(tmpdir(), "check-pyimp-"));
	roots.push(root);
	if (opts.git) execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	return root;
}

function scan(files: Record<string, string>, opts: { git?: boolean } = {}): PythonImportScan {
	const result = scanPythonBrokenImports(project(files, opts));
	expect(result.status).toBe("ok");
	return result;
}

function keys(result: PythonImportScan): string[] {
	return result.candidates.map((c) => `${c.importer}:${c.line}:${c.kind}${c.name ? `:${c.name}` : ""}`).sort();
}

const PKG = { "pkg/__init__.py": "", "pkg/core.py": "def real():\n    pass\n" };

describe("A1 missing module (MUST-FIRE)", () => {
	it("F1: an absolute import of a missing submodule of a first-party package fires", () => {
		const r = scan({ ...PKG, "app.py": "import pkg.nosuch\n" });
		expect(keys(r)).toEqual(["app.py:1:missing_module"]);
		expect(r.candidates[0]?.statement).toBe("import pkg.nosuch");
		expect(r.candidates[0]?.tried).toContain("pkg/nosuch.py");
	});

	it("F2: a relative import of a missing sibling fires", () => {
		const r = scan({ ...PKG, "pkg/user.py": "from .nosuch import x\n" });
		expect(keys(r)).toEqual(["pkg/user.py:1:missing_module"]);
		expect(r.candidates[0]?.level).toBe(1);
	});

	it("F3: a src layout root counts (src/lib1 is imported as lib1)", () => {
		const r = scan({ "src/lib1/__init__.py": "", "src/lib1/mod.py": "", "src/lib1/user.py": "from lib1.gone import x\n" });
		expect(keys(r)).toEqual(["src/lib1/user.py:1:missing_module"]);
	});

	it("F4: tags mark type-only, in-function and test importers", () => {
		const r = scan({
			...PKG,
			"pkg/t.py": "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    import pkg.ghost1\ndef f():\n    import pkg.ghost2\n",
			"tests/test_x.py": "import pkg.ghost3\n",
		});
		const byLine = Object.fromEntries(r.candidates.map((c) => [c.module, c.tags]));
		expect(byLine["pkg.ghost1"]?.type_only).toBe(true);
		expect(byLine["pkg.ghost2"]?.in_function).toBe(true);
		expect(byLine["pkg.ghost3"]?.importer_role).toBe("test");
	});
});

describe("A2 missing name (MUST-FIRE)", () => {
	it("F5: a name that is not bound at the target top level and is not a submodule fires", () => {
		const r = scan({ ...PKG, "app.py": "from pkg.core import phantom, real\n" });
		expect(keys(r)).toEqual(["app.py:1:missing_name:phantom"]);
		expect(r.candidates[0]?.target_names).toContain("real");
	});

	it("F6: a name that is not bound in a package __init__ fires", () => {
		const r = scan({ ...PKG, "app.py": "from pkg import ghost\n" });
		expect(keys(r)).toEqual(["app.py:1:missing_name:ghost"]);
	});
});

describe("B1 never fires (MUST-NOT-FIRE twins)", () => {
	it("N1: a name that is a submodule is fine", () => {
		expect(scan({ ...PKG, "app.py": "from pkg import core\n" }).candidates).toEqual([]);
	});

	it("N2: names bound by def, class, assignment, import, for, with and __all__ are fine", () => {
		const target = [
			"import os as _os",
			"from collections import OrderedDict",
			"A = 1",
			"class K: pass",
			"def f(): pass",
			"for loopvar in []: pass",
			"with open('x') as handle: pass",
			"__all__ = ['listed']",
		].join("\n");
		const names = "_os, OrderedDict, A, K, f, loopvar, handle, listed";
		const r = scan({ "pkg/__init__.py": "", "pkg/t.py": `${target}\n`, "app.py": `from pkg.t import ${names}\n` });
		expect(r.candidates).toEqual([]);
	});

	it("N3: an import under try/except ImportError is a guard and is skipped", () => {
		const r = scan({ ...PKG, "app.py": "try:\n    import pkg.nosuch\nexcept ImportError:\n    pass\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips.try_importerror_guard).toBe(1);
	});

	it("N4: a target with module __getattr__ is skipped", () => {
		const r = scan({ "pkg/__init__.py": "def __getattr__(name):\n    return 1\n", "app.py": "from pkg import anything\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips.target_getattr).toBe(1);
	});

	it("N5: a target with a star import is skipped", () => {
		const r = scan({ "pkg/__init__.py": "from .core import *\n", "pkg/core.py": "x = 1\n", "app.py": "from pkg import anything\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips.target_star_import).toBe(1);
	});

	it("N6: a target with a dynamic module surface is skipped", () => {
		const r = scan({ "pkg/__init__.py": "globals().update({'a': 1})\n", "app.py": "from pkg import a\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips.target_dynamic_surface).toBe(1);
	});

	it("N7: a missing module under a package that edits __path__ or sys.modules is skipped", () => {
		const r = scan({ "pkg/__init__.py": "import sys\nsys.modules['pkg.virt'] = None\n", "app.py": "import pkg.virt\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips.parent_dynamic).toBe(1);
	});

	it("N8: generated names (_pb2, version) are skipped", () => {
		const r = scan({ ...PKG, "app.py": "import pkg.msg_pb2\nfrom pkg.core import version\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips.generated_name).toBe(2);
	});

	it("N9: a .pyi stub or a compiled extension source is not judged", () => {
		const r = scan({ ...PKG, "pkg/only.pyi": "x: int\n", "pkg/fast.pyx": "", "app.py": "import pkg.only\nimport pkg.fast\nfrom pkg.only import y\n" });
		expect(r.candidates).toEqual([]);
	});

	it("N10: a namespace package target is skipped", () => {
		const r = scan({ "ns/mod.py": "x = 1\n", "app.py": "from ns import nothing\nimport ns.absent\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips.namespace_target).toBeGreaterThanOrEqual(1);
	});

	it("N11: standard-library and third-party imports are never reported", () => {
		const r = scan({ ...PKG, "app.py": "import os, json\nimport numpy\nfrom requests import get\nimport pkg.core\n" });
		expect(r.candidates).toEqual([]);
		expect(r.stats.absolute_not_first_party).toBe(4);
	});

	it("N12: a relative import above the repository root is skipped", () => {
		const r = scan({ ...PKG, "a.py": "from ... import x\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips.above_root).toBe(1);
	});

	it("N13: a git-ignored importer and a git-ignored target are skipped", () => {
		const r = scan(
			{ ".gitignore": "ignored_dir/\npkg/generated_mod.py\n", ...PKG, "ignored_dir/imp.py": "import pkg.nosuch\n", "app.py": "import pkg.generated_mod\n" },
			{ git: true },
		);
		expect(r.candidates).toEqual([]);
		expect(r.skips.importer_gitignored).toBeUndefined(); // never listed by git, never parsed
		expect(r.skips.target_gitignored).toBe(1);
	});

	it("N14: outside a git repository nothing is treated as ignored and the run still reports", () => {
		const r = scan({ ...PKG, "app.py": "import pkg.nosuch\n" });
		expect(r.candidates).toHaveLength(1);
	});

	it("N15: an importer that edits sys.path may reach modules the scan cannot see and is skipped", () => {
		const r = scan({ ...PKG, "app.py": "import sys\nsys.path.insert(0, 'elsewhere')\nimport pkg.nosuch\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips.importer_sys_path_edit).toBe(1);
	});

	it("N16: the unparsed file is listed, its neighbours are still judged", () => {
		const r = scan({ ...PKG, "bad.py": "def (:\n", "app.py": "import pkg.nosuch\n" });
		expect(r.candidates).toHaveLength(1);
		expect(r.unparsed.map((u) => u.path)).toEqual(["bad.py"]);
	});
});

describe("C1 resolution roots the first probe could not model", () => {
	it("C1: a script resolves a sibling module through its own directory (MUST-FIRE twin: missing name)", () => {
		const files = { "scripts/helper.py": "def real_fn():\n    pass\n", "scripts/run.py": "from helper import real_fn\nfrom helper import gone_fn\nif __name__ == '__main__':\n    pass\n" };
		const r = scan(files);
		expect(keys(r)).toEqual(["scripts/run.py:2:missing_name:gone_fn"]);
		expect(r.stats.absolute_first_party_checked).toBe(2);
	});

	it("C9: a name that exists only in a directory that is not a root is counted as found elsewhere, not judged", () => {
		const r = scan({ "helpers/shared_util.py": "x = 1\n", "rules/r.py": "from shared_util import gone\nimport numpy\n" });
		expect(r.candidates).toEqual([]);
		expect(r.stats.absolute_found_elsewhere).toBe(1);
		expect(r.stats.absolute_not_first_party).toBe(2);
	});

	it("C2: a plain module that is not script-like does not get its own directory as a root", () => {
		const r = scan({ "lib/__init__.py": "", "lib/helper.py": "x = 1\n", "lib/user.py": "import helper\n" });
		expect(r.candidates).toEqual([]);
		expect(r.stats.absolute_first_party_checked).toBe(0);
	});

	it("C3: a directory that holds conftest.py is a root for the files below it", () => {
		const files = { "tests/conftest.py": "", "tests/util.py": "def real():\n    pass\n", "tests/sub/test_a.py": "from util import real\nfrom util import nope\n" };
		const r = scan(files);
		expect(keys(r)).toEqual(["tests/sub/test_a.py:2:missing_name:nope"]);
	});

	it("C4: pyproject [tool.pytest.ini_options] pythonpath adds roots", () => {
		const files = {
			"pyproject.toml": '[tool.pytest.ini_options]\npythonpath = ["lib", "."]\n',
			"lib/mylib/__init__.py": "def ok():\n    pass\n",
			"app.py": "from mylib import ok, gone\n",
		};
		const r = scan(files);
		expect(keys(r)).toEqual(["app.py:1:missing_name:gone"]);
		expect(r.importRoots).toContain("lib");
	});

	it("C5: [tool.setuptools] package-dir and packages.find where add roots", () => {
		const a = scan({
			"pyproject.toml": '[tool.setuptools.package-dir]\n"" = "python"\n',
			"python/thing/__init__.py": "",
			"app.py": "import thing.gone\n",
		});
		expect(keys(a)).toEqual(["app.py:1:missing_module"]);
		const b = scan({
			"pyproject.toml": '[tool.setuptools.packages.find]\nwhere = ["code"]\n',
			"code/other/__init__.py": "",
			"app.py": "import other.gone\n",
		});
		expect(keys(b)).toEqual(["app.py:1:missing_module"]);
	});

	it("C6: a pyproject path that leaves the repository or does not exist is ignored", () => {
		const r = scan({ "pyproject.toml": '[tool.pytest.ini_options]\npythonpath = ["../outside", "nodir"]\n', "app.py": "x = 1\n" });
		expect(r.importRoots).toEqual(["."]);
	});

	it("C7: a package present in two roots that resolves in one is not reported", () => {
		const files = { "a/shared/__init__.py": "", "a/shared/mod.py": "", "src/shared/__init__.py": "", "x/tests/conftest.py": "", "app.py": "import shared.mod\n" };
		const r = scan({ ...files, "pyproject.toml": '[tool.pytest.ini_options]\npythonpath = ["a"]\n' });
		expect(r.candidates).toEqual([]);
	});

	it("C8: a package present in two roots that fails in both is skipped as ambiguous", () => {
		const files = { "a/shared/__init__.py": "", "src/shared/__init__.py": "", "app.py": "import shared.gone\n", "pyproject.toml": '[tool.pytest.ini_options]\npythonpath = ["a"]\n' };
		const r = scan(files);
		expect(r.candidates).toEqual([]);
		expect(r.skips.ambiguous_root).toBe(1);
	});
});

describe("import resolution across project roots", () => {
	it("G1: an importer in project A is never resolved against a root of sibling project B", () => {
		const r = scan({
			"integrations/booksvc-v2/pyproject.toml": "[project]\nname = 'books_next'\n",
			"integrations/booksvc-v2/booksvc/__init__.py": "class Other: pass\n",
			"integrations/booksvc/pyproject.toml": "[project]\nname = 'books'\n",
			"integrations/booksvc/core/fetch.py": "import booksvc.exceptions\nfrom booksvc import BookService\nfrom booksvc.v4.objects import Project\n",
		});
		expect(r.candidates).toEqual([]);
		expect(r.stats.absolute_not_first_party).toBe(3);
	});

	it("G2: twin — inside its own project the same package IS judged", () => {
		const r = scan({
			"integrations/booksvc-v2/pyproject.toml": "[project]\nname = 'books_next'\n",
			"integrations/booksvc-v2/booksvc/__init__.py": "class Other: pass\n",
			"integrations/booksvc-v2/core/fetch.py": "from booksvc import BookService\n",
		});
		expect(keys(r)).toEqual(["integrations/booksvc-v2/core/fetch.py:1:missing_name:BookService"]);
	});

	it("G3: the repository root does not serve an importer that sits in a nested project", () => {
		const r = scan({
			"toppkg/__init__.py": "",
			"tools/x/pyproject.toml": "[project]\nname = 'x'\n",
			"tools/x/run.py": "import toppkg.gone\n",
			"app.py": "import toppkg.gone\n",
		});
		expect(keys(r)).toEqual(["app.py:1:missing_module"]);
	});

	it("G4: a statement that carries a pyright or type ignore comment is skipped and counted", () => {
		const r = scan({
			...PKG,
			"a.py": "from pkg.core import (  # pyright: ignore[reportMissingImports]\n    phantom,\n)\n",
			"b.py": "import pkg.gone  # type: ignore\n",
			"c.py": "import pkg.gone2\n",
		});
		expect(keys(r)).toEqual(["c.py:1:missing_module"]);
		expect(r.skips.owner_ignore_comment).toBe(2);
	});

	it("G5: a sub-package of a regular package does not serve as a top-level package through an ancestor root", () => {
		const r = scan({
			"proj/__init__.py": "",
			"proj/sim/__init__.py": "",
			"proj/sim/shelfmodel/__init__.py": "",
			"proj/sim/shelfmodel/conftest.py": "",
			"proj/sim/shelfmodel/tests/parity.py": "from shelfmodel.evaluation import schema\n",
		});
		expect(r.candidates).toEqual([]);
	});

	it("G7: a src directory that holds only sub-directories is still a root when files come from git", () => {
		const r = scan(
			{ "proj/pyproject.toml": "[project]\nname='p'\n", "proj/src/mypkg/__init__.py": "", "proj/other/use.py": "import mypkg.gone\n" },
			{ git: true },
		);
		expect(keys(r)).toEqual(["proj/other/use.py:1:missing_module"]);
	});

	it("G6: twin — a top-level package under a conftest directory is still judged", () => {
		const r = scan({ "tests/conftest.py": "", "tests/helpers/__init__.py": "", "tests/sub/test_a.py": "import helpers.gone\n" });
		expect(keys(r)).toEqual(["tests/sub/test_a.py:1:missing_module"]);
	});
});

describe("D1 availability", () => {
	it("D1: with no python3 the scan says so and reports no candidates", () => {
		const spawn = (() => ({ error: Object.assign(new Error("x"), { code: "ENOENT" }) })) as unknown as PythonSpawn;
		const r = scanPythonBrokenImports(project({ "a.py": "import x\n" }), spawn);
		expect(r.status).toBe("unavailable");
		expect(r.note).toMatch(/python3/);
		expect(r.candidates).toEqual([]);
	});

	it("D2: with no python3 and no Python file the scan stays silent (a TypeScript repo)", () => {
		const spawn = (() => ({ error: Object.assign(new Error("x"), { code: "ENOENT" }) })) as unknown as PythonSpawn;
		const r = scanPythonBrokenImports(project({ "a.ts": "export {};\n" }), spawn);
		expect(r.status).toBe("no-python-files");
	});

	it("D3: a tree with no Python file is no-python-files", () => {
		expect(scanPythonBrokenImports(project({ "a.ts": "export {};\n" })).status).toBe("no-python-files");
	});
});

describe("E1 output description", () => {
	it("E1: a TypeScript-only tree adds nothing to the output", () => {
		const extras = describePythonScan(scanPythonBrokenImports(project({ "a.ts": "export {};\n" })));
		expect(extras).toEqual({ details: null, notes: [] });
	});

	it("E2: candidates are described as candidates, with the evidence a label pass needs", () => {
		const extras = describePythonScan(scan({ ...PKG, "app.py": "import pkg.nosuch\n" }));
		const python = extras.details?.python as { status: string; candidates: Record<string, unknown>[]; candidate_count: number };
		expect(python.status).toBe("ok");
		expect(python.candidate_count).toBe(1);
		const first = python.candidates[0] ?? {};
		expect(Object.keys(first)).toEqual(expect.arrayContaining(["importer", "line", "statement", "kind", "tags", "tried", "module", "level"]));
		expect(first).not.toHaveProperty("ignore_paths");
		expect(extras.notes.join("\n")).toMatch(/candidates/);
		expect(extras.notes.join("\n")).not.toMatch(/defect/i);
	});

	it("E3: an unavailable interpreter is described with its reason and no candidates", () => {
		const spawn = (() => ({ error: Object.assign(new Error("x"), { code: "ENOENT" }) })) as unknown as PythonSpawn;
		const extras = describePythonScan(scanPythonBrokenImports(project({ "a.py": "import x\n" }), spawn));
		expect(extras.details?.python).toMatchObject({ status: "unavailable" });
		expect(extras.notes[0]).toMatch(/python3/);
	});

	it("E4: the in-scope share counts relative and first-party imports over all import targets", () => {
		const extras = describePythonScan(scan({ ...PKG, "app.py": "import os\nimport pkg.core\nfrom . import x\n" }));
		const python = extras.details?.python as { in_scope_share: number; import_targets: number };
		expect(python.import_targets).toBe(3);
		expect(python.in_scope_share).toBeCloseTo(2 / 3, 5);
	});
});
