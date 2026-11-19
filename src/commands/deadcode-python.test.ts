// Tests for the Python half of `interlinked deadcode`: real interpreter, real temp trees.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanPythonDeadCode, type PythonDeadCode } from "./deadcode-python.js";

const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scan(files: Record<string, string>): PythonDeadCode {
	const root = mkdtempSync(join(tmpdir(), "py-dead-"));
	made.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	const result = scanPythonDeadCode(root);
	if (result === null) throw new Error("no Python result");
	return result;
}

const exportsOf = (report: PythonDeadCode): string[] => report.deadExports.map((item) => `${item.file}:${item.name}`);

const LIBRARY = {
	"pyproject.toml": `[project.scripts]\ndemo = "pkg.cli:main"\n`,
	"pkg/__init__.py": `from .core import run\n__all__ = ["run"]\n`,
	"pkg/core.py": `from . import util\nfrom .sub import leaf\ndef run():\n    return util.f() + leaf.g()\ndef spare():\n    pass\n`,
	"pkg/util.py": `def f():\n    return 1\n`,
	"pkg/sub/__init__.py": ``,
	"pkg/sub/leaf.py": `def g():\n    return 2\n`,
	"pkg/cli.py": `from pkg.core import run\ndef main():\n    run()\n`,
	"pkg/orphan.py": `def nobody():\n    pass\n`,
	"pkg/only_tests.py": `def helper():\n    pass\n`,
	"tool.py": `from pkg import run\nif __name__ == "__main__":\n    run()\n`,
	"tests/test_core.py": `from pkg.only_tests import helper\nfrom pkg.core import run\n`,
};

describe("scanPythonDeadCode — files", () => {
	it("MUST-FIRE: a module that no root reaches is unreachable, with the same keys as the TypeScript report plus language", () => {
		const report = scan(LIBRARY);
		expect(report.language).toBe("python");
		expect(report.unreachableFiles).toEqual(["pkg/orphan.py"]);
		expect(report.scannedFiles).toBeGreaterThan(0);
		expect(report.scannedPaths).toContain("pkg/core.py");
		expect(report.scannedPaths).not.toContain("tests/test_core.py");
	});

	it("MUST-NOT-FIRE: a console_scripts target, a __main__ block, a relative import chain and a package init are reached", () => {
		const report = scan(LIBRARY);
		for (const path of ["pkg/cli.py", "tool.py", "pkg/core.py", "pkg/util.py", "pkg/sub/leaf.py", "pkg/sub/__init__.py", "pkg/__init__.py"]) {
			expect(report.unreachableFiles).not.toContain(path);
		}
	});

	it("MUST-FIRE: a module that only a test imports is a test-only importer, not unreachable", () => {
		const report = scan(LIBRARY);
		expect(report.testOnlyImporterFiles).toEqual(["pkg/only_tests.py"]);
		expect(report.unreachableFiles).not.toContain("pkg/only_tests.py");
	});

	it("MUST-FIRE: entry roots are listed by kind, with the rule that named each", () => {
		const report = scan(LIBRARY);
		const cli = report.python.entryRoots.find((root) => root.path === "pkg/cli.py");
		expect(cli?.kind).toBe("console-script");
		expect(cli?.evidence).toContain("project.scripts");
		expect(report.python.rootsByKind["main-guard"]).toBe(1);
		expect(report.python.rootsByKind["test"]).toBe(1);
	});
});

describe("scanPythonDeadCode — exports", () => {
	it("MUST-FIRE: a public name no other module imports or reads is an unused export; used names are not", () => {
		const report = scan(LIBRARY);
		expect(exportsOf(report)).toEqual(["pkg/core.py:spare", "pkg/orphan.py:nobody"]);
	});

	it("MUST-NOT-FIRE: a name re-exported through the package init and a name that a test imports are used", () => {
		const report = scan(LIBRARY);
		expect(exportsOf(report)).not.toContain("pkg/core.py:run");
		expect(exportsOf(report)).not.toContain("pkg/only_tests.py:helper");
	});

	it("MUST-FIRE: a star import consumes the names the importer reads and weakens the rest", () => {
		const report = scan({
			"lib.py": `def used():\n    pass\ndef other():\n    pass\n`,
			"app.py": `from lib import *\nused()\nif __name__ == "__main__":\n    pass\n`,
		});
		expect(exportsOf(report)).toEqual(["lib.py:other"]);
		expect(report.deadExports[0]?.weaker).toContain("star_import_of_module");
	});

	it("MUST-FIRE: a literal dynamic import is an edge; a computed one marks the tree and weakens every finding", () => {
		const literal = scan({ "main.py": `import importlib\nimportlib.import_module("plug")\nif __name__ == "__main__":\n    pass\n`, "plug.py": `def hook():\n    pass\n` });
		expect(literal.unreachableFiles).toEqual([]);
		expect(literal.python.dynamicImports.treeHasDynamicImports).toBe(false);
		const computed = scan({ "main.py": `import importlib\nname = "plug"\nimportlib.import_module(name)\nif __name__ == "__main__":\n    pass\n`, "plug.py": `def hook():\n    pass\n` });
		expect(computed.unreachableFiles).toEqual(["plug.py"]);
		expect(computed.python.dynamicImports.treeHasDynamicImports).toBe(true);
		expect(computed.python.unreachable[0]?.weaker).toEqual(["dynamic_import_in_tree"]);
		expect(computed.deadExports[0]?.weaker).toContain("dynamic_import_in_tree");
	});

	it("MUST-NOT-FIRE: a decorated definition and a module that is an entry root are not judged", () => {
		const report = scan({
			"svc.py": `import registry\n@registry.register\ndef handler():\n    pass\n`,
			"registry.py": `def register(f):\n    return f\n`,
			"run.py": `import svc\nif __name__ == "__main__":\n    def only_in_root():\n        pass\n`,
			"cli.py": `def public_in_root():\n    pass\nif __name__ == "__main__":\n    pass\n`,
		});
		expect(exportsOf(report)).toEqual([]);
		expect(report.python.exportScan.decorated).toBe(1);
	});
});

describe("scanPythonDeadCode — unresolved imports and dead bindings", () => {
	it("counts and lists unresolved internal imports", () => {
		const report = scan({ "pkg/__init__.py": ``, "pkg/a.py": `from pkg.missing import x\n`, "run.py": `import pkg.a\nif __name__ == "__main__":\n    pass\n` });
		expect(report.python.unresolvedImports.count).toBe(1);
		expect(report.python.unresolvedImports.items[0]).toMatchObject({ file: "pkg/a.py", module: "pkg.missing" });
	});

	it("lists unused import bindings like the TypeScript report", () => {
		const report = scan({ "m.py": `import os\nimport json\nprint(json.dumps({}))\nif __name__ == "__main__":\n    pass\n` });
		expect(report.deadImportBindings).toEqual([{ file: "m.py", binding: "os" }]);
	});
});

describe("scanPythonDeadCode — no Python", () => {
	it("returns null when the tree holds no Python file", () => {
		const root = mkdtempSync(join(tmpdir(), "py-dead-"));
		made.push(root);
		writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
		expect(scanPythonDeadCode(root)).toBeNull();
	});
});
