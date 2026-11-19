// Real-interpreter tests for check-python-cycles.ts (cycles on Python). Only load-time
// edges count: a top-level import that resolves to a first-party module. Imports inside
// a function, under `if TYPE_CHECKING:` and the implicit parent-package edge are not edges.
// Each MUST-NOT-FIRE case has a MUST-FIRE twin.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPythonAnalysis } from "./check-python-run.js";
import { describePythonCycles, scanPythonCycles, type PythonCycleScan } from "./check-python-cycles.js";

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function scan(files: Record<string, string>, opts: { git?: boolean } = {}): PythonCycleScan {
	const root = mkdtempSync(join(tmpdir(), "check-pycyc-"));
	roots.push(root);
	if (opts.git) execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	const result = scanPythonCycles(root, runPythonAnalysis(root));
	expect(result.status).toBe("ok");
	return result;
}

const sorted = (result: PythonCycleScan): string[] => [...result.files].sort();

describe("A1 cycles (MUST-FIRE)", () => {
	it("F1: two modules that import each other at the top level form a cycle", () => {
		const r = scan({ "a.py": "import b\n", "b.py": "from a import x\n" });
		expect(sorted(r)).toEqual(["a.py", "b.py"]);
		expect(r.groups).toHaveLength(1);
		expect(r.groups[0]?.through_package_init).toBe(false);
		expect(r.groups[0]?.edges).toEqual(expect.arrayContaining([{ from: "a.py", to: "b.py", line: 1 }]));
	});

	it("F2: a three-module cycle inside a package, through relative imports", () => {
		const r = scan({
			"pkg/__init__.py": "",
			"pkg/a.py": "from .b import y\n",
			"pkg/b.py": "from .c import z\n",
			"pkg/c.py": "from .a import w\n",
		});
		expect(sorted(r)).toEqual(["pkg/a.py", "pkg/b.py", "pkg/c.py"]);
	});

	it("F3: a module that imports a bound name from its own package __init__, which imports the module, is a cycle", () => {
		const r = scan({
			"pkg/__init__.py": "from .a import A\nhelper = 1\n",
			"pkg/a.py": "from pkg import helper\nA = 1\n",
		});
		expect(sorted(r)).toEqual(["pkg/__init__.py", "pkg/a.py"]);
		expect(r.groups[0]?.through_package_init).toBe(true);
	});
});

describe("B1 not a cycle (MUST-NOT-FIRE twins)", () => {
	it("N1: an import inside a function body is not a load-time edge", () => {
		expect(scan({ "a.py": "import b\n", "b.py": "def f():\n    import a\n" }).files.size).toBe(0);
	});

	it("N2: an import under if TYPE_CHECKING is not an edge", () => {
		const r = scan({ "a.py": "import b\n", "b.py": "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    import a\n" });
		expect(r.files.size).toBe(0);
	});

	it("N3: a package __init__ that imports its submodule, which imports a sibling submodule by name, is not a cycle", () => {
		const r = scan({
			"pkg/__init__.py": "from .a import A\n",
			"pkg/a.py": "from . import b\nA = 1\n",
			"pkg/b.py": "B = 1\n",
		});
		expect(r.files.size).toBe(0);
	});

	it("N4: an acyclic chain and standard-library imports give nothing", () => {
		const r = scan({ "a.py": "import os\nimport b\n", "b.py": "import json\nimport c\n", "c.py": "x = 1\n" });
		expect(r.files.size).toBe(0);
	});

	it("N5: a module does not form a cycle with itself", () => {
		expect(scan({ "a.py": "import a\n" }).files.size).toBe(0);
	});

	it("N6: a name that resolves in several roots has no edge", () => {
		const r = scan({
			"pyproject.toml": '[tool.pytest.ini_options]\npythonpath = ["lib"]\n',
			"lib/shared.py": "import app\n",
			"shared.py": "import app\n",
			"app.py": "import shared\n",
		});
		expect(r.files.size).toBe(0);
	});

	it("N7: a cycle that has a git-ignored member is not reported", () => {
		const r = scan({ ".gitignore": "b.py\n", "a.py": "import b\n", "b.py": "import a\n" }, { git: true });
		expect(r.files.size).toBe(0);
		// The ignored module is not in the git file list, so the edge to it never exists.
		expect(r.skips.cycle_gitignored_member).toBeUndefined();
	});
});

describe("C1 output description", () => {
	it("C1: a cycle is described as a candidate with its files and edges", () => {
		const extras = describePythonCycles(scan({ "a.py": "import b\n", "b.py": "import a\n" }));
		const python = extras.details?.python as { cycle_count: number; groups: { files: string[] }[] };
		expect(python.cycle_count).toBe(1);
		expect(python.groups[0]?.files).toEqual(["a.py", "b.py"]);
		expect(extras.notes.join("\n")).toMatch(/candidates/);
	});

	it("C2: a tree without Python adds nothing", () => {
		const root = mkdtempSync(join(tmpdir(), "check-pycyc-"));
		roots.push(root);
		writeFileSync(join(root, "a.ts"), "export {};\n");
		const result = scanPythonCycles(root, runPythonAnalysis(root));
		expect(describePythonCycles(result)).toEqual({ details: null, notes: [] });
	});

	it("C3: an unavailable interpreter says so and reports no cycle", () => {
		const root = mkdtempSync(join(tmpdir(), "check-pycyc-"));
		roots.push(root);
		writeFileSync(join(root, "a.py"), "import b\n");
		const result = scanPythonCycles(root, { status: "unavailable", note: "python3 was not found on PATH; Python files were not analysed" });
		expect(result.status).toBe("unavailable");
		expect(describePythonCycles(result).notes[0]).toMatch(/python3/);
	});
});
