import { describe, expect, it } from "vitest";
import { findUnusedExports, type ExportGraph } from "./exports.js";
import type { PyDef, PyEdge, PyModule } from "./types.js";

function def(name: string, extra: Partial<PyDef> = {}): PyDef {
	return { name, line: 1, kind: "function", decorated: false, ownUse: false, ...extra };
}

function mod(path: string, defs: PyDef[], extra: Partial<PyModule> = {}): PyModule {
	return { path, role: "other", mainGuard: false, all: [], star: false, getattr: false, dynamic: [], defs, dynamicComputed: [], loaderGlobs: [], ...extra };
}

function graph(modules: PyModule[], extra: Partial<ExportGraph> = {}): ExportGraph {
	return { modules: new Map(modules.map((item) => [item.path, item])), edges: [], consumed: {}, valueUsed: {}, getattrOn: {}, ...extra };
}

const names = (scan: ReturnType<typeof findUnusedExports>): string[] => scan.items.map((item) => `${item.file}:${item.name}`);

describe("findUnusedExports", () => {
	it("MUST-FIRE: a public name that no other module imports or reads", () => {
		const g = graph([mod("lib.py", [def("used"), def("lonely")])], { consumed: { "lib.py": { used: ["app.py"] } } });
		expect(names(findUnusedExports(g, new Set()))).toEqual(["lib.py:lonely"]);
	});

	it("MUST-NOT-FIRE: a name an importer reads by attribute is in the consumed table", () => {
		const g = graph([mod("lib.py", [def("tool")])], { consumed: { "lib.py": { tool: ["app.py"] } } });
		expect(findUnusedExports(g, new Set()).items).toEqual([]);
	});

	it("MUST-NOT-FIRE: a module that an importer enumerates reads every public name", () => {
		const g = graph([mod("mixins.py", [def("get_metadata"), def("create_tables")])], { consumed: { "mixins.py": { "*": ["pkg.py"] } } });
		expect(findUnusedExports(g, new Set()).items).toEqual([]);
	});

	it("MUST-NOT-FIRE: a module that is an entry root, a test module and a decorated definition", () => {
		const g = graph([mod("cli.py", [def("main")]), mod("tests/test_a.py", [def("helper")], { role: "test" }), mod("api.py", [def("handler", { decorated: true })])]);
		const scan = findUnusedExports(g, new Set(["cli.py"]));
		expect(scan.items).toEqual([]);
		expect(scan.decorated).toBe(1);
	});

	it("MUST-FIRE: an underscore name is private unless __all__ lists it", () => {
		const g = graph([mod("lib.py", [def("_hidden"), def("_listed")], { all: ["_listed"] })]);
		expect(names(findUnusedExports(g, new Set()))).toEqual(["lib.py:_listed"]);
	});

	it("marks a name that __all__ lists as weaker evidence: external consumers are not visible", () => {
		const g = graph([mod("lib.py", [def("api")], { all: ["api"] })]);
		expect(findUnusedExports(g, new Set()).items[0]?.weaker).toContain("listed_in_all");
	});

	it("MUST-FIRE: a star import consumes the names that the importer reads, and weakens the rest", () => {
		const edges: PyEdge[] = [{ from: "app.py", to: "lib.py", line: 1, names: [], star: true, inFunction: false, typeOnly: false, guarded: false, kind: "import" }];
		const g = graph([mod("lib.py", [def("read_by_app"), def("other")])], { edges, consumed: { "lib.py": { read_by_app: ["app.py"] } } });
		const scan = findUnusedExports(g, new Set());
		expect(names(scan)).toEqual(["lib.py:other"]);
		expect(scan.items[0]?.weaker).toContain("star_import_of_module");
	});

	it("marks getattr on a module and a module used as a value as weaker evidence", () => {
		const g = graph([mod("lib.py", [def("x")]), mod("pkg.py", [def("y")], { getattr: true })], { getattrOn: { "lib.py": { "*": ["app.py"] } }, valueUsed: { "lib.py": { "*": ["app.py"] } } });
		const scan = findUnusedExports(g, new Set());
		const lib = scan.items.find((item) => item.file === "lib.py");
		expect(lib?.weaker).toEqual(expect.arrayContaining(["getattr_on_module", "module_used_as_value"]));
		expect(scan.items.find((item) => item.file === "pkg.py")?.weaker).toContain("getattr_on_module");
	});

	it("marks every item weaker when the tree imports by a computed name", () => {
		const g = graph([mod("lib.py", [def("x")]), mod("loader.py", [], { dynamicComputed: [4] })]);
		expect(findUnusedExports(g, new Set()).items[0]?.weaker).toContain("dynamic_import_in_tree");
	});

	it("marks a name read in its own module and a definition in a package init", () => {
		const g = graph([mod("pkg/__init__.py", [def("a", { ownUse: true })])]);
		expect(findUnusedExports(g, new Set()).items[0]?.weaker).toEqual(expect.arrayContaining(["used_in_own_file", "defined_in_package_init"]));
	});
});
