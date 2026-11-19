// Real-interpreter tests for check-python-any.ts (any-types on Python: an explicit
// `typing.Any` in an annotation). MUST-NOT-FIRE twins cover a name that is not
// typing.Any, text that is not an annotation, test modules and git-ignored files.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describePythonAnyTypes, scanPythonAnyTypes, type PythonAnyScan } from "./check-python-any.js";
import { runPythonAnalysis } from "./check-python-run.js";

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function scan(files: Record<string, string>, opts: { git?: boolean } = {}): PythonAnyScan {
	const root = mkdtempSync(join(tmpdir(), "check-pyany-"));
	roots.push(root);
	if (opts.git) execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	return scanPythonAnyTypes(root, runPythonAnalysis(root));
}

const names = (r: PythonAnyScan): string[] => [...r.files].sort();

describe("A1 explicit Any in an annotation (MUST-FIRE)", () => {
	it("F1: a parameter, a return type and an annotated assignment", () => {
		const r = scan({ "a.py": "from typing import Any\ndef f(x: Any) -> Any:\n    y: Any = 1\n    return y\n" });
		expect(names(r)).toEqual(["a.py"]);
		expect(r.entries[0]).toEqual({ path: "a.py", count: 3, lines: [2, 3] });
	});

	it("F2: Any nested in a generic, a union and a keyword-only or variadic argument", () => {
		const src = "from typing import Any, Optional\ndef f(*args: Any, k: dict[str, Any] = {}, **kw: Optional[Any]) -> list[Any]:\n    pass\n";
		expect(names(scan({ "a.py": src }))).toEqual(["a.py"]);
	});

	it("F3: typing.Any through the module, an alias of the module and an alias of the name", () => {
		expect(names(scan({ "a.py": "import typing\nx: typing.Any = 1\n" }))).toEqual(["a.py"]);
		expect(names(scan({ "a.py": "import typing as t\nx: t.Any = 1\n" }))).toEqual(["a.py"]);
		expect(names(scan({ "a.py": "from typing import Any as AnyType\nx: AnyType = 1\n" }))).toEqual(["a.py"]);
		expect(names(scan({ "a.py": "from typing_extensions import Any\nx: Any = 1\n" }))).toEqual(["a.py"]);
	});
});

describe("B1 not a finding (MUST-NOT-FIRE twins)", () => {
	it("N1: a class named Any that is not imported from typing", () => {
		expect(scan({ "a.py": "class Any: pass\nx: Any = Any()\n" }).files.size).toBe(0);
		expect(scan({ "a.py": "from mylib import Any\nx: Any = 1\n" }).files.size).toBe(0);
	});

	it("N2: Any imported but used only outside an annotation", () => {
		expect(scan({ "a.py": "from typing import Any\nT = Any\nprint(Any)\n" }).files.size).toBe(0);
	});

	it("N3: the word Any in a comment, a docstring or a string annotation", () => {
		const src = 'from typing import Any\ndef f(x: "Any") -> None:\n    """Any thing."""  # Any\n';
		expect(scan({ "a.py": src }).files.size).toBe(0);
	});

	it("N4: a test module is outside the population", () => {
		const src = "from typing import Any\nx: Any = 1\n";
		const r = scan({ "tests/test_a.py": src, "b_test.py": src, "conftest.py": src });
		expect(r.files.size).toBe(0);
	});

	it("N5: a git-ignored file is skipped and counted", () => {
		const r = scan({ ".gitignore": "gen.py\n", "gen.py": "from typing import Any\nx: Any = 1\n" }, { git: true });
		expect(r.files.size).toBe(0);
		expect(r.skips.gitignored).toBeUndefined(); // an ignored file is never listed by git, so it never reaches the analyzer
	});

	it("N6: a file that does not parse is skipped, its neighbour is judged", () => {
		const r = scan({ "bad.py": "def (:\n", "a.py": "from typing import Any\nx: Any = 1\n" });
		expect(names(r)).toEqual(["a.py"]);
	});
});

describe("C1 output description", () => {
	it("C1: the occurrences are listed per file", () => {
		const extras = describePythonAnyTypes(scan({ "a.py": "from typing import Any\nx: Any = 1\n" }));
		const python = extras.details?.python as { file_count: number; occurrences: number; files: { path: string }[] };
		expect(python.file_count).toBe(1);
		expect(python.occurrences).toBe(1);
		expect(python.files[0]?.path).toBe("a.py");
	});

	it("C2: a tree without Python adds nothing", () => {
		const root = mkdtempSync(join(tmpdir(), "check-pyany-"));
		roots.push(root);
		writeFileSync(join(root, "a.ts"), "export {};\n");
		expect(describePythonAnyTypes(scanPythonAnyTypes(root, runPythonAnalysis(root)))).toEqual({ details: null, notes: [] });
	});

	it("C3: an unavailable interpreter is described by its reason", () => {
		const root = mkdtempSync(join(tmpdir(), "check-pyany-"));
		roots.push(root);
		writeFileSync(join(root, "a.py"), "x = 1\n");
		const result = scanPythonAnyTypes(root, { status: "failed", note: "boom" });
		expect(describePythonAnyTypes(result).notes[0]).toContain("boom");
	});
});
