// Tests for the Python reads of `metrics arch` and `metrics coupling`: real interpreter, real temp trees.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pythonArchGraph, pythonLinkLookup } from "./metrics-python-graph.js";

const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "py-arch-"));
	made.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	return root;
}

const LAYERED = {
	"app/__init__.py": ``,
	"app/api/__init__.py": ``,
	"app/api/routes.py": `from app.core import service\nfrom app.core.service import run\n`,
	"app/core/__init__.py": ``,
	"app/core/service.py": `from app.data import store\ndef run(): pass\n`,
	"app/data/__init__.py": ``,
	"app/data/store.py": `X = 1\n`,
	"app/data/lonely.py": `Y = 2\n`,
	"app/broken.py": `from app.missing import nothing\n`,
	"tests/test_service.py": `from app.core import service\n`,
};

describe("pythonArchGraph", () => {
	it("MUST-FIRE: every production module is a node and every static import is an edge, so directories get Ca and Ce", () => {
		const arch = pythonArchGraph(tree(LAYERED), false);
		expect(arch?.files).toContain("app/core/service.py");
		expect(arch?.files).not.toContain("tests/test_service.py");
		expect(arch?.edges).toContainEqual({ from: "app/api/routes.py", to: "app/core/service.py" });
		expect(arch?.edges).toContainEqual({ from: "app/core/service.py", to: "app/data/store.py" });
	});

	it("includes test modules and their edges only on request", () => {
		const arch = pythonArchGraph(tree(LAYERED), true);
		expect(arch?.files).toContain("tests/test_service.py");
		expect(arch?.edges).toContainEqual({ from: "tests/test_service.py", to: "app/core/service.py" });
	});

	it("MUST-FIRE: the unresolved internal import count is reported", () => {
		const arch = pythonArchGraph(tree(LAYERED), false);
		expect(arch?.unresolved).toBe(1);
	});

	it("MUST-NOT-FIRE: a string-literal module name is not an architecture edge", () => {
		const arch = pythonArchGraph(tree({ "a.py": `X = "pkg.mod"\n`, "pkg/__init__.py": ``, "pkg/mod.py": `Y = 1\n` }), false);
		expect(arch?.edges).toEqual([]);
	});

	it("returns null for a tree without Python", () => {
		expect(pythonArchGraph(tree({ "a.ts": `export const a = 1;\n` }), false)).toBeNull();
	});
});

describe("pythonLinkLookup", () => {
	it("MUST-FIRE: two files joined by an import chain of any length are linked, in either direction", () => {
		const link = pythonLinkLookup(tree({ ...LAYERED, "app/broken.py": `X = 1\n` }));
		expect(link("app/api/routes.py", "app/data/store.py")).toBe(true);
		expect(link("app/data/store.py", "app/api/routes.py")).toBe(true);
	});

	it("MUST-FIRE: files with no chain and no unresolved import are hidden", () => {
		const link = pythonLinkLookup(tree({ ...LAYERED, "app/broken.py": `X = 1\n` }));
		expect(link("app/data/lonely.py", "app/api/routes.py")).toBe(false);
	});

	it("MUST-FIRE: no chain, and either file has an unresolved internal import: unknown", () => {
		const link = pythonLinkLookup(tree(LAYERED));
		expect(link("app/broken.py", "app/data/lonely.py")).toBeNull();
		expect(link("app/data/lonely.py", "app/broken.py")).toBeNull();
	});

	it("MUST-NOT-FIRE: a chain wins over an unresolved import elsewhere in the file", () => {
		const link = pythonLinkLookup(tree({ ...LAYERED, "app/api/routes.py": `from app.core import service\nfrom app.missing import nothing\n` }));
		expect(link("app/api/routes.py", "app/core/service.py")).toBe(true);
	});

	it("MUST-FIRE: a file the graph does not hold is unknown, never hidden", () => {
		const link = pythonLinkLookup(tree(LAYERED));
		expect(link("app/nowhere.py", "app/data/lonely.py")).toBeNull();
	});
});
