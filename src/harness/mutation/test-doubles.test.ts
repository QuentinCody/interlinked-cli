import { describe, expect, it } from "vitest";
import {
	extractTestDoubles,
	importedModules,
	mockedSymbols,
	moduleKey,
	type TestDouble,
} from "./test-doubles.js";

const FILE = "src/harness/__tests__/a.test.ts";

function only(src: string): TestDouble {
	const found = extractTestDoubles(FILE, src);
	expect(found).toHaveLength(1);
	const first = found[0];
	if (first === undefined) throw new Error("unreachable");
	return first;
}

describe("extractTestDoubles — positive (must fire)", () => {
	it("P1: vi.mock without factory is module_mock with a resolved relative path", () => {
		const d = only('vi.mock("../foo.js");');
		expect(d).toMatchObject({
			kind: "module_mock",
			specifier: "../foo.js",
			resolvedPath: "src/harness/foo.js",
			hasFactory: false,
			factoryReturnsCanned: false,
			line: 1,
		});
	});
	it("P2: vi.mock with a literal factory is module_mock_factory and canned", () => {
		const d = only('vi.mock("./util", () => ({ read: vi.fn(() => "x"), n: 1 }));');
		expect(d).toMatchObject({
			kind: "module_mock_factory",
			resolvedPath: "src/harness/__tests__/util",
			hasFactory: true,
			factoryReturnsCanned: true,
		});
	});
	it("P3: vi.doMock and jest.mock are recognised; bare packages stay unresolved", () => {
		const found = extractTestDoubles(FILE, 'vi.doMock("node:fs");\njest.mock("lodash", () => 1);');
		expect(found.map((d) => [d.kind, d.specifier, d.resolvedPath])).toEqual([
			["module_mock", "node:fs", undefined],
			["module_mock_factory", "lodash", undefined],
		]);
		expect(found[1]?.line).toBe(2);
	});
	it("P4: vi.mock(import(...)) form carries the specifier", () => {
		expect(only('vi.mock(import("./bar.js"));').specifier).toBe("./bar.js");
	});
	it("P5: vi.spyOn records object.method and a canned replacement from the chain", () => {
		const d = only('vi.spyOn(fs, "readFileSync").mockReturnValue("data");');
		expect(d).toMatchObject({ kind: "spy", target: "fs.readFileSync", hasFactory: true, factoryReturnsCanned: true });
	});
	it("P6: vi.spyOn on a property chain without replacement has no factory", () => {
		const d = only('vi.spyOn(a.b, "run");');
		expect(d).toMatchObject({ kind: "spy", target: "a.b.run", hasFactory: false, factoryReturnsCanned: false });
	});
	it("P7: vi.fn assigned to a named const", () => {
		const d = only("const send = vi.fn().mockResolvedValue({ ok: true });");
		expect(d).toMatchObject({ kind: "fn", target: "send", hasFactory: true, factoryReturnsCanned: true });
	});
	it("P8: vi.stubGlobal and vi.stubEnv", () => {
		const found = extractTestDoubles(FILE, 'vi.stubGlobal("fetch", vi.fn());\nvi.stubEnv("MODE", "test");');
		expect(found.map((d) => [d.kind, d.target, d.factoryReturnsCanned])).toEqual([
			["global_stub", "fetch", true],
			["env_stub", "MODE", true],
		]);
	});
	it("P9: nested doubles inside describe/it bodies are found with their own lines", () => {
		const src = 'describe("x", () => {\n  it("y", () => {\n    vi.spyOn(console, "log");\n  });\n});';
		expect(only(src).line).toBe(3);
	});
});

describe("extractTestDoubles — negative (must not fire)", () => {
	it("N1: unrelated calls and a different receiver", () => {
		expect(extractTestDoubles(FILE, 'foo.mock("./x");\nmock("./y");\nother.fn();')).toEqual([]);
	});
	it("N2: vi.fn not bound to a named variable (inline argument, property)", () => {
		expect(extractTestDoubles(FILE, "run(vi.fn());\nconst o = { f: vi.fn() };")).toEqual([]);
	});
	it("N3: non-literal module specifier is skipped", () => {
		expect(extractTestDoubles(FILE, "vi.mock(name);\nvi.mock(`./${n}`);")).toEqual([]);
	});
	it("N4: mention in a string or comment is not a call", () => {
		expect(extractTestDoubles(FILE, '// vi.mock("./x")\nconst s = \'vi.mock("./y")\';')).toEqual([]);
	});
	it("N5: partial mock with importActual spread is a factory but not canned", () => {
		const d = only('vi.mock("./z", async () => ({ ...(await vi.importActual("./z")), f: vi.fn() }));');
		expect(d).toMatchObject({ kind: "module_mock_factory", hasFactory: true, factoryReturnsCanned: false });
	});
	it("N6: spy replacement reading live state is not canned", () => {
		expect(only('vi.spyOn(a, "b").mockImplementation((x) => x + 1);').factoryReturnsCanned).toBe(false);
	});
	it("N7: stubEnv with a computed value is not canned", () => {
		expect(only('vi.stubEnv("K", compute());').factoryReturnsCanned).toBe(false);
	});
});

describe("mockedSymbols — positive and negative", () => {
	const src = [
		'import { a, b as c, unused } from "./dep.js";',
		'import def, * as ns from "./other.js";',
		'import { z } from "./untouched.js";',
		'vi.mock("./dep.js", () => ({ a: 1 }));',
		'vi.mock("./other.js");',
		"a(); c(); ns.x(); def();",
		"obj.unused;",
	].join("\n");
	const doubles = extractTestDoubles(FILE, src);
	it("P1: used named imports resolve to their exported names", () => {
		expect(mockedSymbols(doubles[0] as TestDouble, src)).toEqual(["a", "b"]);
	});
	it("P2: default and namespace imports are reported", () => {
		expect(mockedSymbols(doubles[1] as TestDouble, src)).toEqual(["*", "default"]);
	});
	it("P3: dynamic-import destructure counts", () => {
		const text = 'vi.mock("./d.js");\nconst { q, r: s } = await import("./d.js");';
		expect(mockedSymbols(only(text), text)).toEqual(["q", "r"]);
	});
	it("N1: imported but only used as a property name is not used", () => {
		expect(mockedSymbols(doubles[0] as TestDouble, src)).not.toContain("unused");
	});
	it("N2: non-module doubles have no mocked symbols", () => {
		const text = 'import { a } from "./dep.js";\nvi.spyOn(a, "m");';
		expect(mockedSymbols(only(text), text)).toEqual([]);
	});
	it("N3: an import of another module is not attributed to the mock", () => {
		const text = 'import { z } from "./untouched.js";\nvi.mock("./dep.js");\nz();';
		expect(mockedSymbols(only(text), text)).toEqual([]);
	});
	it("P4: a mock written with a different extension still matches the import", () => {
		const text = 'import { k } from "./dep";\nvi.mock("./dep.js");\nk();';
		expect(mockedSymbols(only(text), text)).toEqual(["k"]);
	});
});

describe("importedModules and moduleKey — positive and negative", () => {
	it("P1: static, dynamic and re-export specifiers with resolved paths", () => {
		const src = 'import a from "./a.js";\nexport { b } from "../b.js";\nconst c = await import("./c.js");\nimport "pkg";';
		expect(importedModules(FILE, src).map((m) => [m.kind, m.specifier, m.resolvedPath])).toEqual([
			["static", "./a.js", "src/harness/__tests__/a.js"],
			["reexport", "../b.js", "src/harness/b.js"],
			["dynamic", "./c.js", "src/harness/__tests__/c.js"],
			["static", "pkg", undefined],
		]);
	});
	it("N1: type-only imports are skipped", () => {
		expect(importedModules(FILE, 'import type { T } from "./t.js";')).toEqual([]);
	});
	it("P2: moduleKey strips script extensions and index", () => {
		expect(moduleKey("src/x/foo.js")).toBe("src/x/foo");
		expect(moduleKey("src/x/foo.ts")).toBe("src/x/foo");
		expect(moduleKey("src/x/foo/index.ts")).toBe("src/x/foo");
		expect(moduleKey("src/x/foo")).toBe("src/x/foo");
	});
	it("N2: moduleKey leaves other extensions alone", () => {
		expect(moduleKey("data/foo.json")).toBe("data/foo.json");
	});
});
