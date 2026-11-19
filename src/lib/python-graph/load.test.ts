// Tests for loadPythonGraph: the real interpreter runs on real temp trees (no git, so the analyzer walks).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPythonGraph } from "./load.js";
import type { PythonGraph } from "./types.js";

const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "py-graph-"));
	made.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	return root;
}

function load(files: Record<string, string>, options = {}): PythonGraph {
	const result = loadPythonGraph(tree(files), options);
	if (result.status !== "ok") throw new Error(`graph not loaded: ${result.status} ${result.note}`);
	return result.graph;
}

const edgesFrom = (graph: PythonGraph, from: string): string[] => graph.edges.filter((edge) => edge.from === from).map((edge) => `${edge.to}:${edge.kind}`).sort();
const rootKinds = (graph: PythonGraph, path: string): string[] => graph.roots.filter((root) => root.path === path).map((root) => root.kind);

const LIBRARY = {
	"pyproject.toml": `[project]\nname = "demo"\n[project.scripts]\ndemo = "pkg.cli:main"\n`,
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

describe("loadPythonGraph — nodes and edges", () => {
	it("MUST-FIRE: one node per module, and edges for absolute, relative, submodule and package imports", () => {
		const graph = load(LIBRARY);
		expect([...graph.modules.keys()].sort()).toEqual(["pkg/__init__.py", "pkg/cli.py", "pkg/core.py", "pkg/only_tests.py", "pkg/orphan.py", "pkg/sub/__init__.py", "pkg/sub/leaf.py", "pkg/util.py", "tests/test_core.py", "tool.py"]);
		expect(edgesFrom(graph, "pkg/core.py")).toEqual(["pkg/sub/leaf.py:import", "pkg/util.py:import"]);
		expect(edgesFrom(graph, "pkg/__init__.py")).toEqual(["pkg/core.py:import"]);
		expect(edgesFrom(graph, "pkg/cli.py")).toEqual(["pkg/core.py:import"]);
		expect(edgesFrom(graph, "tool.py")).toEqual(["pkg/__init__.py:import"]);
	});

	it("MUST-NOT-FIRE: a third-party or stdlib import is external, not unresolved", () => {
		const graph = load({ "a.py": `import os\nimport numpy as np\nfrom requests import get\n` });
		expect(graph.unresolved).toEqual([]);
		expect(graph.edges).toEqual([]);
	});

	it("MUST-FIRE: an import of a first-party module that does not exist is unresolved, and listed", () => {
		const graph = load({ "pkg/__init__.py": ``, "pkg/a.py": `from pkg.missing import x\nfrom .gone import y\nfrom pkg import nothere\n`, "pkg/b.py": `X = 1\n` });
		expect(graph.unresolved.map((item) => `${item.file}:${item.module}:${item.name ?? ""}:${item.kind}`).sort()).toEqual([
			"pkg/a.py:.gone::missing_module",
			"pkg/a.py:pkg.missing::missing_module",
			"pkg/a.py:pkg:nothere:missing_name",
		].sort());
	});

	it("MUST-FIRE: a literal import_module is an edge; a computed one marks the module", () => {
		const graph = load({
			"main.py": `import importlib\nm = importlib.import_module("plug.one")\nname = "x"\nn = importlib.import_module(name)\n`,
			"plug/__init__.py": ``,
			"plug/one.py": `def hook(): pass\n`,
		});
		expect(edgesFrom(graph, "main.py")).toEqual(["plug/one.py:dynamic"]);
		expect(graph.modules.get("main.py")?.dynamicComputed).toEqual([4]);
	});

	it("MUST-FIRE: a dotted module path in a string literal is a string edge, not an import", () => {
		const graph = load({ "urls.py": `include("app.urls")\nX = "not.a.module"\n`, "app/__init__.py": ``, "app/urls.py": `urlpatterns = []\n` });
		expect(edgesFrom(graph, "urls.py")).toEqual(["app/urls.py:string"]);
	});

	it("MUST-FIRE: a literal name in setattr, monkeypatch.setattr and patch.object is a read of that module attribute", () => {
		const graph = load({
			"cfg.py": `LIMIT = 1\nWAIT = 2\nOTHER = 3\n`,
			"tests/test_cfg.py": `import cfg\nfrom unittest import mock\ndef test_a(monkeypatch):\n    monkeypatch.setattr(cfg, "LIMIT", 0)\n    with mock.patch.object(cfg, "WAIT", 5):\n        pass\n`,
		});
		expect(Object.keys(graph.consumed["cfg.py"] ?? {}).sort()).toEqual(["LIMIT", "WAIT"]);
	});

	it("MUST-FIRE: dir(module) in an importer reads every name of the module", () => {
		const graph = load({
			"mix.py": `def a(self): pass\ndef b(self): pass\n`,
			"core.py": `import mix\nfor name in dir(mix):\n    getattr(mix, name)\n`,
		});
		expect(graph.consumed["mix.py"]?.["*"]).toEqual(["core.py"]);
	});

	it("records the names an importer reads: attribute reads, imported names and star-imported names it uses", () => {
		const graph = load({
			"lib.py": `def a(): pass\ndef b(): pass\ndef c(): pass\ndef d(): pass\n`,
			"user.py": `import lib\nfrom lib import b\nlib.a()\n`,
			"starry.py": `from lib import *\nc()\n`,
		});
		expect(Object.keys(graph.consumed["lib.py"] ?? {}).sort()).toEqual(["a", "b", "c"]);
		expect(graph.edges.find((edge) => edge.from === "starry.py")?.star).toBe(true);
	});
});

describe("loadPythonGraph — entry roots", () => {
	it("MUST-FIRE: console script, __main__ block, test and conftest roots, each with a kind", () => {
		const graph = load({ ...LIBRARY, "conftest.py": `import pytest\n`, "pkg/__main__.py": `from pkg.cli import main\nmain()\n` });
		expect(rootKinds(graph, "pkg/cli.py")).toEqual(["console-script"]);
		expect(rootKinds(graph, "tool.py")).toEqual(["main-guard"]);
		expect(rootKinds(graph, "tests/test_core.py")).toEqual(["test"]);
		expect(rootKinds(graph, "conftest.py")).toEqual(["conftest"]);
		expect(rootKinds(graph, "pkg/__main__.py")).toEqual(["main-module"]);
		expect(rootKinds(graph, "pkg/orphan.py")).toEqual([]);
	});

	it("MUST-FIRE: Django settings strings make the app, its models file and the URL conf roots", () => {
		const graph = load({
			"manage.py": `import os\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "proj.settings")\n`,
			"proj/__init__.py": ``,
			"proj/settings.py": `INSTALLED_APPS = ["blog"]\nROOT_URLCONF = "proj.urls"\n`,
			"proj/urls.py": `urlpatterns = []\n`,
			"blog/__init__.py": ``,
			"blog/models.py": `class Post: pass\n`,
			"blog/views.py": `def index(): pass\n`,
		});
		expect(rootKinds(graph, "proj/settings.py")).toEqual(["django-settings"]);
		expect(rootKinds(graph, "proj/urls.py")).toEqual(["django-settings"]);
		expect(rootKinds(graph, "blog/models.py")).toEqual(["django-app"]);
		expect(rootKinds(graph, "blog/views.py")).toEqual([]);
	});

	it("MUST-FIRE: a Makefile command names a script by literal path", () => {
		const graph = load({ Makefile: `seed:\n\tpython scripts/seed.py\n`, "scripts/seed.py": `print(1)\n`, "scripts/other.py": `print(2)\n` });
		expect(rootKinds(graph, "scripts/seed.py")).toEqual(["command"]);
		expect(rootKinds(graph, "scripts/other.py")).toEqual([]);
	});
});

describe("loadPythonGraph — status", () => {
	it("reports an empty tree without starting Python", () => {
		const result = loadPythonGraph(tree({ "README.md": "hello" }));
		expect(result).toEqual({ status: "empty", note: "no Python files in the tree" });
	});

	it("leaves a set-aside tree out of the graph", () => {
		const graph = load({ "src/gen/a.py": `X = 1\n`, "src/app.py": `import gen.a\n` }, { exclude: ["src/gen/"] });
		expect([...graph.modules.keys()]).toEqual(["src/app.py"]);
	});
});
