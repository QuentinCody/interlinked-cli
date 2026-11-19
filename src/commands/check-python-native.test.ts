// Real-interpreter tests for phase 3, class 3 of the broken-imports false positives: a build file
// that NAMES a native extension module makes an import of that module a non-candidate (skip
// `declared_native_extension`). A native-build signal alone, on an unnamed module, stays a tag.
// Nothing is executed: the analyzer reads the files as text (setup.py through `ast`).

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
	const root = mkdtempSync(join(tmpdir(), "check-pynative-"));
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
const PKG = { "python/mylib/__init__.py": "" };
const MATURIN = (name: string): string => `[tool.maturin]\nmodule-name = "${name}"\npython-source = "python"\n`;
const SKIP = "declared_native_extension";
const SRC = "[tool.setuptools.package-dir]\n\"\" = \"python\"\n";

describe("maturin module-name", () => {
	it("N1: import mylib._ffi, with module-name naming it, is not a candidate and is counted", () => {
		const r = scan({ ...PKG, "pyproject.toml": MATURIN("mylib._ffi"), "python/mylib/disk.py": "import mylib._ffi as _ffi\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips[SKIP]).toBe(1);
	});

	it("N2: from mylib import _ffi and a relative from . import _ffi are covered too", () => {
		const r = scan({ ...PKG, "pyproject.toml": MATURIN("mylib._ffi"), "python/mylib/a.py": "from mylib import _ffi\n", "python/mylib/b.py": "from . import _ffi\n", "python/mylib/c.py": "from mylib._ffi import Thing\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips[SKIP]).toBe(3);
	});

	it("F1: twin — module-name names a different module, so a missing _ffi still fires", () => {
		const r = scan({ ...PKG, "pyproject.toml": MATURIN("mylib._other"), "python/mylib/disk.py": "import mylib._ffi as _ffi\n" });
		expect(keys(r)).toEqual(["python/mylib/disk.py:1:missing_module"]);
	});

	it("F2: twin — a native-build signal (Cargo.toml) with no module-name keeps the candidate and tags it", () => {
		const r = scan({ ...PKG, "pyproject.toml": "[tool.maturin]\npython-source = \"python\"\n", "Cargo.toml": "[package]\nname = \"x\"\n", "python/mylib/disk.py": "import mylib._ffi as _ffi\n" });
		expect(keys(r)).toEqual(["python/mylib/disk.py:1:missing_module"]);
		expect(r.candidates[0]?.tags.repo_native_build).toBe(true);
	});
});

describe("setuptools extension tables and calls", () => {
	it("N3: [tool.setuptools.ext-modules] names the module", () => {
		const r = scan({ ...PKG, "pyproject.toml": "[[tool.setuptools.ext-modules]]\nname = \"mylib._speed\"\nsources = [\"a.c\"]\n[tool.setuptools.package-dir]\n\"\" = \"python\"\n", "python/mylib/m.py": "from mylib import _speed\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips[SKIP]).toBe(1);
	});

	it("N4: setup.py Extension with a literal name, positional and keyword, and Pybind11Extension", () => {
		const setup = [
			"from setuptools import setup, Extension",
			"setup(package_dir={'': 'python'}, ext_modules=[Extension('mylib._a', ['a.c']), Extension(name='mylib._b', sources=['b.c']), Pybind11Extension('mylib._c', ['c.cpp'])])",
			"",
		].join("\n");
		const r = scan({ ...PKG, "setup.py": setup, "python/mylib/m.py": "import mylib._a\nimport mylib._b\nimport mylib._c\nimport mylib._d\n" });
		expect(keys(r)).toEqual(["python/mylib/m.py:4:missing_module"]);
		expect(r.skips[SKIP]).toBe(3);
	});

	it("F3: twin — a name that is not a literal is not guessed, and setup.py is not run", () => {
		const setup = "from setuptools import setup, Extension\nNAME = 'mylib._a'\nsetup(package_dir={'': 'python'}, ext_modules=[Extension(NAME, ['a.c'])])\nopen('ran.txt', 'w').write('x')\n";
		const r = scan({ ...PKG, "setup.py": setup, "python/mylib/m.py": "import mylib._a\n" });
		expect(keys(r)).toEqual(["python/mylib/m.py:1:missing_module"]);
	});

	it("N5: cffi_modules names a build script whose set_source literal names the module", () => {
		const setup = "from setuptools import setup\nsetup(package_dir={'': 'python'}, cffi_modules=['build_ffi.py:ffibuilder'])\n";
		const build = "from cffi import FFI\nffibuilder = FFI()\nffibuilder.set_source('mylib._cffi', '')\n";
		const r = scan({ ...PKG, "setup.py": setup, "build_ffi.py": build, "python/mylib/m.py": "from mylib._cffi import lib\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips[SKIP]).toBe(1);
	});
});

describe("meson-python and Cython neighbours", () => {
	it("N6: meson.build extension_module with a subdir literal names pkg._name", () => {
		const meson = "py.extension_module(\n  '_core',\n  'core.c',\n  subdir: 'mylib',\n  install: true,\n)\n";
		const r = scan({ ...PKG, "pyproject.toml": SRC, "meson.build": meson, "python/mylib/m.py": "from mylib import _core\n" });
		expect(r.candidates).toEqual([]);
		expect(r.skips[SKIP]).toBe(1);
	});

	it("F4: twin — meson.build that names another module leaves the import a candidate", () => {
		const meson = "py.extension_module('_other', 'core.c', subdir: 'mylib')\n";
		const r = scan({ ...PKG, "pyproject.toml": SRC, "meson.build": meson, "python/mylib/m.py": "from mylib import _core\n" });
		expect(keys(r)).toEqual(["python/mylib/m.py:1:missing_name:_core"]);
	});

	it("N7: a .pyx next to the package is a source of that module; a missing sibling name still fires", () => {
		const base = { "pyproject.toml": "[tool.setuptools.package-dir]\n\"\" = \"python\"\n", ...PKG, "python/mylib/_fast.pyx": "def f(): pass\n" };
		expect(scan({ ...base, "python/mylib/m.py": "import mylib._fast\n" }).candidates).toEqual([]);
		expect(keys(scan({ ...base, "python/mylib/m.py": "import mylib._slow\n" }))).toEqual(["python/mylib/m.py:1:missing_module"]);
	});
});
