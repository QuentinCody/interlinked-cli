import { describe, expect, it } from "vitest";
import { hashBytes } from "./inventory.js";
import type { InventoryFile } from "./measurement-types.js";
import { parsePythonFacts } from "./python-facts.js";
import { measurePythonFiles, pythonAvailable } from "./python-measure.js";

function file(path: string, content: string): InventoryFile {
	return { path, content, language: "python", role: "product", sha256: hashBytes(content) };
}

function factsOf(content: string) {
	const [row] = measurePythonFiles([file("m.py", content)]);
	if (!row || "error" in row) throw new Error(`analysis failed: ${JSON.stringify(row)}`);
	return row.facts;
}

describe.skipIf(!pythonAvailable())("Python module facts from the isolated analyzer", () => {
	it("counts executable statements at every depth and leaves out definitions, imports, pass, global and docstrings", () => {
		const facts = factsOf('"""Doc."""\nimport os\nfrom a import b\n\n\ndef f(x):\n    """Doc."""\n    global q\n    if x:\n        y = 1\n        pass\n    return x\n\n\nclass C:\n    """Doc."""\n    z = 2\n');
		// if (9), y = 1 (10), return (12), z = 2 (17)
		expect(facts.statements.map(item => item.line)).toEqual([9, 10, 12, 17]);
		expect(facts.statements[0]).toMatchObject({ line: 9, endLine: 11 });
		expect(facts.statements[0]!.end).toBeGreaterThan(facts.statements[0]!.start);
	});

	it("reports module-level declarations with exported, decorated and identifier use counts", () => {
		const facts = factsOf("import functools\n\nLIMIT = 3\n_hidden = 4\n__version__ = '1'\n\n\n@functools.cache\ndef cached():\n    return LIMIT\n\n\ndef used():\n    return used\n\n\nclass Thing:\n    pass\n\n\nvalue: int = 1\nnote: int\npair = other = 5\na, b = 1, 2\n");
		const byName = new Map(facts.declarations.map(item => [item.name, item]));
		expect([...byName.keys()]).toEqual(["LIMIT", "_hidden", "cached", "used", "Thing", "value", "note", "pair", "other"]);
		expect(byName.get("LIMIT")).toMatchObject({ line: 3, exported: true, decorated: false, uses: 2 });
		expect(byName.get("_hidden")).toMatchObject({ exported: false, uses: 1 });
		expect(byName.get("cached")).toMatchObject({ line: 9, exported: true, decorated: true, uses: 1 });
		expect(byName.get("used")).toMatchObject({ uses: 2 });
		expect(byName.get("Thing")).toMatchObject({ uses: 1 });
	});

	it("lets __all__ decide which declarations are exported", () => {
		const facts = factsOf("__all__ = ['kept']\n__all__ += ['more']\n\n\ndef kept():\n    pass\n\n\ndef more():\n    pass\n\n\ndef other():\n    pass\n");
		expect(facts.declarations.map(item => [item.name, item.exported])).toEqual([["kept", true], ["more", true], ["other", false]]);
		expect(facts.exports).toEqual(["kept", "more"]);
	});

	it("counts names that only appear inside string annotations as uses", () => {
		const facts = factsOf("class Node:\n    pass\n\n\ndef make() -> 'Node':\n    return None\n");
		expect(facts.declarations.find(item => item.name === "Node")).toMatchObject({ uses: 2 });
	});

	it("detects the script entry guard and the module's public bound names", () => {
		const facts = factsOf("import os\nfrom .x import y as z\nfrom .w import *\nPUBLIC = 1\n_private = 2\n\n\ndef run():\n    pass\n\n\nif __name__ == '__main__':\n    run()\n");
		expect(facts.mainGuard).toBe(true);
		expect(facts.starImport).toBe(true);
		expect(facts.exports).toEqual(["os", "z", "PUBLIC", "run"]);
		expect(factsOf("if '__main__' == __name__:\n    pass\n").mainGuard).toBe(true);
		expect(factsOf("def f():\n    if __name__ == '__main__':\n        pass\n").mainGuard).toBe(false);
	});
});

describe.skipIf(!pythonAvailable())("dynamic imports", () => {
	it("lists calls that import a module by a computed name, like a non-literal require() in JavaScript", () => {
		const facts = factsOf("import importlib\nfrom importlib import import_module\n\nimportlib.import_module('static_name')\nimportlib.import_module(name)\n__import__(other)\nimport_module(f'pkg.{x}')\nimport_module()\n");
		expect(facts.dynamicImports).toEqual([5, 6, 7, 8]);
	});
});

describe("parsePythonFacts", () => {
	it("rejects a malformed analyzer payload instead of guessing", () => {
		expect(() => parsePythonFacts({ statements: "no" })).toThrow(/Invalid Python analyzer/);
		expect(() => parsePythonFacts(undefined)).toThrow(/Invalid Python analyzer/);
	});

	it("round-trips a well-formed payload", () => {
		const facts = parsePythonFacts({ statements: [[1, 2, 0, 9]], declarations: [{ name: "a", line: 1, exported: true, decorated: false, uses: 1 }], mainGuard: false, exports: ["a"], starImport: false, dynamicImports: [3] });
		expect(facts.statements).toEqual([{ line: 1, endLine: 2, start: 0, end: 9 }]);
		expect(facts.declarations[0]).toEqual({ name: "a", line: 1, exported: true, decorated: false, uses: 1 });
	});
});
