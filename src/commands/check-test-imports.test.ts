import { describe, expect, it } from "vitest";
import { jsImportRefs, jsReexports, jsSpecifiers, pythonImports } from "./check-test-imports.js";

describe("MUST-FIRE: python imports a test file makes", () => {
	it("P1: import, import-as, several modules on one line", () => {
		const result = pythonImports("import os, pkg.sub.mod as m\nimport a.b\n");
		expect(result.absolute).toEqual([{ module: "os", names: [] }, { module: "pkg.sub.mod", names: [], alias: "m" }, { module: "a.b", names: [] }]);
	});
	it("P2: from-import with names, with a parenthesised multi-line list and a trailing comment", () => {
		const text = "from pkg.sub import (\n    alpha,  # first\n    beta as b,\n)\nfrom pkg import gamma\n";
		expect(pythonImports(text).absolute).toEqual([{ module: "pkg.sub", names: ["alpha", "beta"] }, { module: "pkg", names: ["gamma"] }]);
	});
	it("P3: relative imports keep their level", () => {
		const result = pythonImports("from . import helpers\nfrom ..core.engine import Run\nfrom .x import y\n");
		expect(result.relative).toEqual([{ level: 1, module: "", names: ["helpers"] }, { level: 2, module: "core.engine", names: ["Run"] }, { level: 1, module: "x", names: ["y"] }]);
	});
	it("P4: a mock.patch or import_module string names a module by its dotted path", () => {
		const text = 'with patch("pkg.mod.func"):\n    pass\n@mock.patch(\'pkg.other.Cls.method\')\nimportlib.import_module("pkg.dyn")\n';
		expect(pythonImports(text).dotted).toEqual(["pkg.mod.func", "pkg.other.Cls.method", "pkg.dyn"]);
	});
});

describe("MUST-NOT-FIRE: python imports", () => {
	it("N1: an import inside a comment or a docstring-like string line is not read", () => {
		const result = pythonImports("# import hidden.module\nx = 'from nothing import here'\n");
		expect(result.absolute).toEqual([]);
		expect(result.relative).toEqual([]);
	});
	it("N2: __future__ and star imports yield the module only", () => {
		expect(pythonImports("from __future__ import annotations\nfrom pkg.m import *\n").absolute).toEqual([{ module: "__future__", names: ["annotations"] }, { module: "pkg.m", names: [] }]);
	});
});

describe("js import names and barrel re-exports", () => {
	it("P6: jsImportRefs lists the names a test imports from each specifier, null when the whole module is used", () => {
		const text = [
			'import def, { a, b as c } from "./one";', 'import type { T } from "./two";', 'import * as ns from "./three";', 'import "./four";', "const x = require('./five');",
			'import {\n  m,\n  n,\n} from "./six";',
		].join("\n");
		expect(jsImportRefs(text)).toEqual([
			{ spec: "./one", names: ["default", "a", "b"] }, { spec: "./two", names: ["T"] }, { spec: "./three", names: null }, { spec: "./four", names: null },
			{ spec: "./five", names: null }, { spec: "./six", names: ["m", "n"] },
		]);
	});
	it("P7: jsReexports reads export-star, named and renamed re-exports of a barrel", () => {
		const text = 'export * from "./all";\nexport { a, b as c } from "./some";\nexport * as ns from "./space";\nexport const own = 1;\nexport { local };\n';
		expect(jsReexports(text)).toEqual([{ spec: "./all", exported: "*" }, { spec: "./some", exported: ["a", "c"] }, { spec: "./space", exported: ["ns"] }]);
	});
});

describe("js specifiers", () => {
	it("P5: static, side-effect, export-from, require, dynamic import and mock calls", () => {
		const text = [
			'import a from "./a";', "import { b } from '../b.js';", 'import "./setup";', 'export * from "./re";', "const c = require('./c');",
			'const d = await import("./d");', 'vi.mock("./m");', 'jest.mock("../j", () => ({}));',
		].join("\n");
		expect(jsSpecifiers(text)).toEqual(["./a", "../b.js", "./setup", "./re", "./c", "./d", "./m", "../j"]);
	});
	it("N3: a specifier inside a comment is not read, and a multi-line import is", () => {
		const text = '// import x from "./hidden";\n/* require("./also") */\nimport {\n  one,\n  two,\n} from "./multi";\n';
		expect(jsSpecifiers(text)).toEqual(["./multi"]);
	});
});
