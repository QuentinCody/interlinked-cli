// Real-interpreter tests for check-python-blast.ts (blast-radius on Python). Same definition as
// the TypeScript side: a file that at least BLAST_RADIUS_MIN_DEPENDENTS other files import.
// Importers are counted once per file, over every static import form and every context
// (function bodies and TYPE_CHECKING included), over the first-party import graph that the
// broken-imports scan builds. Each MUST-NOT-FIRE case has a MUST-FIRE twin.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describePythonBlastRadius, scanPythonBlastRadius, type PythonBlastScan } from "./check-python-blast.js";
import { BLAST_RADIUS_MIN_DEPENDENTS, runPythonAnalysis } from "./check-python-run.js";

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function scan(files: Record<string, string>): PythonBlastScan {
	const root = mkdtempSync(join(tmpdir(), "check-pyblast-"));
	roots.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	const result = scanPythonBlastRadius(root, runPythonAnalysis(root));
	expect(result.status).toBe("ok");
	return result;
}

const PKG = { "pkg/__init__.py": "", "pkg/core.py": "def real():\n    pass\n" };
const importers = (count: number, line: string): Record<string, string> => Object.fromEntries(Array.from({ length: count }, (_, i) => [`user${i}.py`, `${line}\n`]));
const flagged = (r: PythonBlastScan): string[] => [...r.files].sort();

describe("A1 blast-radius (MUST-FIRE)", () => {
	it("F1: the threshold is the TypeScript one, and a module with exactly that many importers is listed", () => {
		expect(BLAST_RADIUS_MIN_DEPENDENTS).toBe(5);
		const r = scan({ ...PKG, ...importers(5, "import pkg.core") });
		expect(flagged(r)).toEqual(["pkg/core.py"]);
		expect(r.entries[0]).toMatchObject({ path: "pkg/core.py", dependents: 5 });
		expect(r.entries[0]?.importers).toEqual(["user0.py", "user1.py", "user2.py", "user3.py", "user4.py"]);
	});

	it("F2: every import form counts: absolute, from-import of the module, of a name, relative, submodule by name", () => {
		const r = scan({
			...PKG,
			"a.py": "import pkg.core\n",
			"b.py": "from pkg.core import real\n",
			"c.py": "from pkg import core\n",
			"pkg/d.py": "from .core import real\n",
			"pkg/e.py": "from . import core\n",
		});
		expect(flagged(r)).toEqual(["pkg/core.py"]);
		expect(r.entries[0]?.dependents).toBe(5);
	});

	it("F3: imports inside functions and under TYPE_CHECKING count", () => {
		const r = scan({
			...PKG,
			"a.py": "def f():\n    import pkg.core\n",
			"b.py": "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    import pkg.core\n",
			...importers(3, "import pkg.core"),
		});
		expect(r.entries[0]?.dependents).toBe(5);
	});

	it("F4: test files count as importers (the TypeScript graph includes them)", () => {
		const r = scan({ ...PKG, ...importers(3, "import pkg.core"), "tests/test_a.py": "import pkg.core\n", "tests/test_b.py": "import pkg.core\n" });
		expect(flagged(r)).toEqual(["pkg/core.py"]);
	});

	it("F5: a package __init__ is a dependent target when a name that it binds is imported from it", () => {
		const r = scan({ "pkg/__init__.py": "VALUE = 1\n", ...importers(5, "from pkg import VALUE") });
		expect(flagged(r)).toEqual(["pkg/__init__.py"]);
	});

	it("F6: the entries are ordered by dependents, most first", () => {
		const r = scan({
			...PKG,
			"pkg/other.py": "",
			...importers(6, "import pkg.core\nimport pkg.other"),
			"extra.py": "import pkg.core\n",
		});
		expect(r.entries.map((e) => [e.path, e.dependents])).toEqual([
			["pkg/core.py", 7],
			["pkg/other.py", 6],
		]);
	});
});

describe("B1 not listed (MUST-NOT-FIRE twins)", () => {
	it("N1: one importer fewer than the threshold", () => {
		expect(scan({ ...PKG, ...importers(4, "import pkg.core") }).files.size).toBe(0);
	});

	it("N2: a file that imports the module twice counts once, and a self import does not count", () => {
		const r = scan({ ...PKG, ...importers(3, "import pkg.core\nfrom pkg.core import real"), "pkg/core.py": "import pkg.core\n" });
		expect(r.files.size).toBe(0);
	});

	it("N3: standard-library and third-party imports build no dependents", () => {
		expect(scan({ ...PKG, ...importers(8, "import os\nimport numpy") }).files.size).toBe(0);
	});

	it("N4: importers that do not parse are not counted", () => {
		const bad = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`bad${i}.py`, "import pkg.core\ndef (:\n"]));
		expect(scan({ ...PKG, ...bad }).files.size).toBe(0);
	});

	it("N5: a name that exists in two roots is ambiguous and builds no dependent", () => {
		const r = scan({
			"a/shared/__init__.py": "",
			"src/shared/__init__.py": "",
			"pyproject.toml": '[tool.pytest.ini_options]\npythonpath = ["a"]\n',
			...importers(6, "import shared"),
		});
		expect(r.files.size).toBe(0);
	});
});

describe("C1 description", () => {
	it("C1: a tree without Python adds nothing to the output", () => {
		const root = mkdtempSync(join(tmpdir(), "check-pyblast-"));
		roots.push(root);
		writeFileSync(join(root, "a.ts"), "export {};\n");
		const r = scanPythonBlastRadius(root, runPythonAnalysis(root));
		expect(describePythonBlastRadius(r)).toEqual({ details: null, notes: [] });
	});

	it("C2: the details carry the threshold, the counts and the importers", () => {
		const python = describePythonBlastRadius(scan({ ...PKG, ...importers(5, "import pkg.core") })).details?.python as Record<string, unknown>;
		expect(python).toMatchObject({ status: "ok", threshold: 5, file_count: 1, python_files: 7 });
		expect(python.files).toEqual([{ path: "pkg/core.py", dependents: 5, importers: ["user0.py", "user1.py", "user2.py", "user3.py", "user4.py"] }]);
	});
});
