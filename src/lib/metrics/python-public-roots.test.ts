import { describe, expect, it } from "vitest";
import type { InventoryFile } from "./measurement-types.js";
import { moduleFile } from "./python-entries.js";
import { pythonPublicRoots } from "./python-public-roots.js";

function file(path: string, content: string, role: InventoryFile["role"] = "product"): InventoryFile {
	return { path, content, language: path.endsWith(".py") ? "python" : null, role, sha256: path };
}
const LIBRARY = file("pyproject.toml", '[project]\nname = "lib"\nversion = "1"\n', "configuration");

function roots(files: InventoryFile[]) {
	return pythonPublicRoots(files, new Set(files.filter(item => item.path.endsWith(".py")).map(item => item.path)), moduleFile);
}

describe("pythonPublicRoots: tool files", () => {
	it("P1: setup.py, conftest.py, noxfile.py, tasks.py, manage.py and docs/conf.py are tool-file roots", () => {
		const paths = ["setup.py", "conftest.py", "noxfile.py", "tasks.py", "manage.py", "docs/conf.py", "sub/conftest.py"];
		expect(roots(paths.map(path => file(path, "x = 1\n"))).toolFiles.sort()).toEqual([...paths].sort());
	});
	it("N1: an ordinary module is not a tool file", () => {
		expect(roots([file("lib/util.py", "x = 1\n")]).toolFiles).toEqual([]);
	});
});

describe("pythonPublicRoots: public API of a distributed library", () => {
	const modules = [file("lib/__init__.py", ""), file("lib/llm/__init__.py", ""), file("lib/llm/batch/__init__.py", "from .api import run\n"), file("lib/llm/batch/api.py", "def run(): ..."), file("lib/other.py", "x = 1\n")];
	it("P2: the package's top __init__.py is a public root", () => {
		expect(roots([LIBRARY, ...modules]).publicApi).toContain("lib/__init__.py");
	});
	it("P3: a module that a test imports by its dotted public name is a public root", () => {
		const test = file("tests/test_batch.py", "from lib.llm.batch import run\n", "test");
		expect(roots([LIBRARY, ...modules, test]).publicApi).toContain("lib/llm/batch/__init__.py");
	});
	it("P4: a module that documentation imports by its dotted name is a public root", () => {
		const doc = file("docs/batch.md", "```python\nimport lib.other\nfrom lib.llm.batch import api\n```\n", "documentation");
		const publicApi = roots([LIBRARY, ...modules, doc]).publicApi;
		expect(publicApi).toContain("lib/other.py");
		expect(publicApi).toContain("lib/llm/batch/api.py");
	});
	it("N2: a repository with no distribution metadata has no public roots", () => {
		const test = file("tests/test_batch.py", "from lib.llm.batch import run\n", "test");
		expect(roots([...modules, test]).publicApi).toEqual([]);
	});
	it("N3: a module that nothing imports by a public name is not a root", () => {
		const test = file("tests/test_batch.py", "from lib.llm.batch import run\n", "test");
		expect(roots([LIBRARY, ...modules, test]).publicApi).not.toContain("lib/other.py");
	});
	it("N4: test and example directories are not distributed packages", () => {
		const files = [LIBRARY, file("tests/__init__.py", ""), file("examples/__init__.py", ""), file("lib/__init__.py", "")];
		expect(roots(files).publicApi).toEqual(["lib/__init__.py"]);
	});
});
