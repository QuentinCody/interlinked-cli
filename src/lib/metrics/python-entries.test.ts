import { describe, expect, it } from "vitest";
import { analyzeRepository } from "./analysis.js";
import { hashBytes, inventoryHash } from "./inventory.js";
import { sourceLanguage, sourceRole } from "./inventory-roles.js";
import type { RepositoryInventory } from "./measurement-types.js";
import { moduleFile, pythonScoringEntries, scriptEntries, scriptTargets } from "./python-entries.js";
import { pythonAvailable } from "./python-measure.js";

function inventory(sources: Record<string, string>): RepositoryInventory {
	const files = Object.entries(sources).map(([path, content]) => ({ path, content, language: sourceLanguage(path), role: sourceRole(path), sha256: hashBytes(content) }));
	return { version: "interlinked-source-roles-v5", root: "/fixture", discovery: "git", files, gaps: [], excluded: [], issues: [],
		sourceHash: inventoryHash(files), inputHash: inventoryHash(files) };
}

function entriesOf(sources: Record<string, string>) {
	const inv = inventory(sources);
	const analysis = analyzeRepository(inv);
	return pythonScoringEntries(inv, analysis.files, new Set(analysis.files.map(file => file.input.path)));
}

describe("scriptTargets", () => {
	it("reads project, gui and poetry script tables and ignores other tables", () => {
		const toml = '[project]\nname = "x"\n\n[project.scripts]\nrun = "pkg.cli:main"\n# comment\nother = \'pkg.tool:go\'\n\n[project.entry-points."plug"]\nhook = "pkg.plug:h"\n\n[tool.poetry.scripts]\npoet = "pkg.poet:main"\n';
		expect(scriptTargets("pyproject.toml", toml)).toEqual(["pkg.cli", "pkg.tool", "pkg.poet"]);
	});

	it("reads console_scripts from setup.cfg and setup.py", () => {
		const cfg = "[metadata]\nname = x\n\n[options.entry_points]\nconsole_scripts =\n    a = pkg.one:main\n    b = pkg.two:run\ngui_scripts =\n    g = pkg.gui:main\n";
		expect(scriptTargets("setup.cfg", cfg)).toEqual(["pkg.one", "pkg.two", "pkg.gui"]);
		expect(scriptTargets("setup.py", "setup(entry_points={'console_scripts': ['go = pkg.go:main', \"stop=pkg.stop:end\"]})")).toEqual(["pkg.go", "pkg.stop"]);
		expect(scriptTargets("setup.py", "setup(name='x')")).toEqual([]);
		expect(scriptTargets("README.md", "x")).toEqual([]);
	});
});

describe("scriptEntries", () => {
	it("returns the declared command name with its module", () => {
		expect(scriptEntries("pyproject.toml", '[project.scripts]\nrun = "pkg.cli:main"\n')).toEqual([{ name: "run", module: "pkg.cli" }]);
		expect(scriptEntries("setup.py", "x('console_scripts', ['go = pkg.go:main'])")).toEqual([{ name: "go", module: "pkg.go" }]);
	});
});

describe("moduleFile", () => {
	it("resolves a dotted module to a module file or a package init under the manifest directory, src, or the root", () => {
		const known = new Set(["pkg/cli.py", "src/lib/__init__.py", "sub/app/run.py"]);
		expect(moduleFile("pkg.cli", "", known)).toBe("pkg/cli.py");
		expect(moduleFile("lib", "", known)).toBe("src/lib/__init__.py");
		expect(moduleFile("app.run", "sub", known)).toBe("sub/app/run.py");
		expect(moduleFile("nope", "", known)).toBeNull();
	});
});

describe.skipIf(!pythonAvailable())("pythonScoringEntries", () => {
	it("treats a product file with a __main__ guard, a __main__.py file and declared scripts as entries; tests never are", () => {
		const found = entriesOf({
			"pkg/__init__.py": "", "pkg/cli.py": "def main():\n    pass\n", "pkg/tool.py": "def go():\n    pass\n\n\nif __name__ == '__main__':\n    go()\n",
			"pkg/__main__.py": "from pkg import cli\ncli.main()\n", "tests/test_x.py": "if __name__ == '__main__':\n    pass\n",
			"pyproject.toml": '[project.scripts]\nrun = "pkg.cli:main"\n',
		});
		expect(found.entries).toEqual(["pkg/__main__.py", "pkg/cli.py", "pkg/tool.py"]);
		expect(found.publicEntries).toEqual(["pkg/cli.py"]);
	});

	it("reads python invocations from documentation, like the JavaScript node/tsx rule", () => {
		const found = entriesOf({ "scripts/build.py": "def build():\n    pass\n", "app/server.py": "def serve():\n    pass\n", "README.md": "Run `python scripts/build.py` or `python3 -m app.server`.\n" });
		expect(found.entries).toEqual(["app/server.py", "scripts/build.py"]);
		expect(found.publicEntries).toEqual([]);
	});

	it("finds no entry in a plain library", () => {
		expect(entriesOf({ "lib/a.py": "def a():\n    pass\n" })).toEqual({ entries: [], publicEntries: [] });
	});
});
