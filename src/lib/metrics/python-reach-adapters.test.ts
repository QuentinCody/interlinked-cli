import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pythonAvailable } from "./python-measure.js";
import { collectStaticMeasurements } from "./static-measurements.js";

function repo(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "interlinked-py-reach-"));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

function read(root: string, id: string) {
	const measured = collectStaticMeasurements(root);
	return { reading: measured.metrics.find(item => item.id === id)!, findings: measured.findings.filter(item => item.metric === id) };
}

const APP = {
	"pyproject.toml": '[project.scripts]\nrun = "app.cli:main"\n',
	"app/__init__.py": "",
	"app/cli.py": "from app.service import work\n\n\ndef main():\n    return work()\n",
	"app/service.py": "def work():\n    return helper()\n\n\ndef helper():\n    return 1\n\n\ndef orphan_function():\n    return 2\n",
	"app/stale.py": "def never_imported():\n    return 3\n",
};

describe.skipIf(!pythonAvailable())("redundancy.disconnected for Python", () => {
	it("reaches modules through resolved imports from declared scripts, and reports modules no entry reaches", () => {
		const { reading, findings } = read(repo(APP), "redundancy.disconnected");
		expect(reading).toMatchObject({ state: "measured", numerator: 1, denominator: 4 });
		expect(findings.map(item => item.file)).toEqual(["app/stale.py"]);
		expect(findings[0]?.message).toContain("No declared application entry point reaches this module");
	});

	it("loads the package __init__ of every reached module, and follows what that __init__ imports", () => {
		const root = repo({
			"tool.py": "from lib.sub import leaf\n\nif __name__ == '__main__':\n    leaf.go()\n",
			"lib/__init__.py": "from .shared import VALUE\n", "lib/shared.py": "VALUE = 1\n",
			"lib/sub/__init__.py": "", "lib/sub/leaf.py": "def go():\n    return 1\n",
		});
		const { reading } = read(root, "redundancy.disconnected");
		expect(reading).toMatchObject({ state: "measured", numerator: 0, denominator: 5 });
	});

	it("says only tests reach a module when a test imports it", () => {
		const root = repo({ ...APP, "tests/test_stale.py": "from app import stale\n\n\ndef test_it():\n    assert stale.never_imported()\n" });
		const { findings } = read(root, "redundancy.disconnected");
		expect(findings.map(item => [item.file, item.message.startsWith("Only tests reach")])).toEqual([["app/stale.py", true]]);
	});

	it("is inconclusive when no entry point is found, like the JavaScript rule", () => {
		const { reading } = read(repo({ "lib/a.py": "def a():\n    return 1\n" }), "redundancy.disconnected");
		expect(reading.state).toBe("inconclusive");
		expect(reading.limitations.join(" ")).toContain("Python entry points");
	});

	it("is inconclusive when a module is imported by a computed name", () => {
		const root = repo({ ...APP, "app/plugins.py": "import importlib\n\n\ndef load(name):\n    return importlib.import_module(name)\n" });
		expect(read(root, "redundancy.disconnected").reading.state).toBe("inconclusive");
		expect(read(root, "architecture.cycles").reading.state).toBe("inconclusive");
	});
});

describe.skipIf(!pythonAvailable())("redundancy.unused for Python", () => {
	it("flags a declaration that nothing references and keeps the JavaScript meaning of the denominator (all product declarations)", () => {
		const { reading, findings } = read(repo(APP), "redundancy.unused");
		const flagged = findings.map(item => `${item.file}:${item.message.split(" ")[0]}`).sort();
		expect(flagged).toEqual(["app/service.py:orphan_function", "app/stale.py:never_imported"]);
		// main, work, helper, orphan_function, never_imported
		expect(reading).toMatchObject({ numerator: 2, denominator: 5 });
	});

	it("does not flag an exported name that an importer names, or one reached through a module-level import", () => {
		const root = repo({
			"pyproject.toml": '[project.scripts]\nrun = "app.cli:main"\n',
			"app/__init__.py": "",
			"app/cli.py": "import app.util\nfrom app.named import used\nfrom app import ns\n\n\ndef main():\n    return app.util.a() + used() + ns.b()\n",
			"app/util.py": "def a():\n    return 1\n", "app/named.py": "def used():\n    return 1\n\n\ndef unused_here():\n    return 2\n",
			"app/ns.py": "def b():\n    return 1\n",
		});
		const flagged = read(root, "redundancy.unused").findings.map(item => item.message.split(" ")[0]);
		expect(flagged).toEqual(["unused_here"]);
	});

	it("leaves decorated declarations out of the count because the decorator may register them", () => {
		const root = repo({ "pyproject.toml": '[project.scripts]\nrun = "app.cli:main"\n', "app/cli.py": "import functools\n\n\n@functools.cache\ndef registered():\n    return 1\n\n\ndef main():\n    return 2\n" });
		const { reading, findings } = read(root, "redundancy.unused");
		expect(findings).toEqual([]);
		expect(reading).toMatchObject({ numerator: 0, denominator: 1 });
		expect(reading.limitations.join(" ")).toContain("decorated");
	});

	it("never counts a declaration of a public entry module", () => {
		const root = repo({ "pyproject.toml": '[project.scripts]\nrun = "app.cli:main"\n', "app/cli.py": "def main():\n    return 1\n\n\ndef extra():\n    return 2\n" });
		const { findings } = read(root, "redundancy.unused");
		expect(findings.map(item => item.message.split(" ")[0])).toEqual([]);
	});
});
