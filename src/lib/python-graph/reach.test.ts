import { describe, expect, it } from "vitest";
import { importChainLinks, reachableModules, type ReachGraph } from "./reach.js";
import type { PyEdge, PyModule } from "./types.js";

function mod(path: string): PyModule {
	return { path, role: "other", mainGuard: false, all: [], star: false, getattr: false, dynamic: [], defs: [], dynamicComputed: [], loaderGlobs: [] };
}

function edge(from: string, to: string, extra: Partial<PyEdge> = {}): PyEdge {
	return { from, to, line: 1, names: [], star: false, inFunction: false, typeOnly: false, guarded: false, kind: "import", ...extra };
}

function graph(paths: string[], edges: PyEdge[]): ReachGraph {
	return { modules: new Map(paths.map((path) => [path, mod(path)])), edges };
}

describe("reachableModules", () => {
	it("MUST-FIRE: follows a relative import chain of any length from a root", () => {
		const g = graph(["a.py", "pkg/__init__.py", "pkg/b.py", "pkg/c.py"], [edge("a.py", "pkg/b.py"), edge("pkg/b.py", "pkg/c.py")]);
		expect([...reachableModules(g, ["a.py"])].sort()).toEqual(["a.py", "pkg/__init__.py", "pkg/b.py", "pkg/c.py"]);
	});

	it("MUST-FIRE: importing a module runs the __init__.py of every parent package, and what those import", () => {
		const g = graph(["main.py", "pkg/__init__.py", "pkg/sub/__init__.py", "pkg/sub/leaf.py", "pkg/side.py"], [edge("main.py", "pkg/sub/leaf.py"), edge("pkg/__init__.py", "pkg/side.py")]);
		const reached = reachableModules(g, ["main.py"]);
		expect(reached.has("pkg/__init__.py")).toBe(true);
		expect(reached.has("pkg/sub/__init__.py")).toBe(true);
		expect(reached.has("pkg/side.py")).toBe(true);
	});

	it("MUST-FIRE: a type-only edge, a function-level edge and a string edge all reach", () => {
		const g = graph(["r.py", "t.py", "f.py", "s.py"], [edge("r.py", "t.py", { typeOnly: true }), edge("r.py", "f.py", { inFunction: true }), edge("r.py", "s.py", { kind: "string" })]);
		expect([...reachableModules(g, ["r.py"])].sort()).toEqual(["f.py", "r.py", "s.py", "t.py"]);
	});

	it("MUST-NOT-FIRE: a module nothing reaches stays out, and so does the parent of a gap in the package chain", () => {
		const g = graph(["main.py", "orphan.py", "top/__init__.py", "top/mid/leaf.py"], [edge("main.py", "top/mid/leaf.py")]);
		const reached = reachableModules(g, ["main.py"]);
		expect(reached.has("orphan.py")).toBe(false);
		expect(reached.has("top/__init__.py")).toBe(false);
	});

	it("ignores a root that is not a module and survives a cycle", () => {
		const g = graph(["a.py", "b.py"], [edge("a.py", "b.py"), edge("b.py", "a.py")]);
		expect([...reachableModules(g, ["a.py", "gone.py"])].sort()).toEqual(["a.py", "b.py"]);
	});
});

describe("importChainLinks", () => {
	const g = graph(["a.py", "b.py", "c.py", "d.py"], [edge("a.py", "b.py"), edge("b.py", "c.py")]);

	it("MUST-FIRE: a chain of any length, in either direction, links two files", () => {
		expect(importChainLinks(g, "a.py", "c.py")).toBe(true);
		expect(importChainLinks(g, "c.py", "a.py")).toBe(true);
	});

	it("MUST-NOT-FIRE: files with no chain between them are not linked", () => {
		expect(importChainLinks(g, "a.py", "d.py")).toBe(false);
	});
});
