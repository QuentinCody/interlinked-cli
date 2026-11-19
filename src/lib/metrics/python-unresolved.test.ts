import { describe, expect, it } from "vitest";
import type { AnalyzedFile } from "./analysis.js";
import type { PythonImportRow } from "./python-measure.js";
import { pythonUnresolvedImports } from "./python-unresolved.js";

function ref(module: string, names: string[] = ["x"], level = 0, line = 1): PythonImportRow {
	return { module, level, names, line, typeOnly: false };
}

function file(path: string, imports: PythonImportRow[]): AnalyzedFile {
	return { input: { path }, python: { row: { imports } } } as unknown as AnalyzedFile;
}

const inventory = ["app/__init__.py", "app/main.py", "app/util.py", "app/sub/__init__.py", "app/sub/leaf.py", "app/_speed.cpython-311-darwin.so", "app/stubbed.pyi",
	"ns/inner/mod.py", "top.py", "scripts/run.py", "scripts/helper.py"];

function unresolved(from: string, rows: PythonImportRow[]): { line: number; specifier: string | null; reason?: string }[] {
	return pythonUnresolvedImports([file(from, rows)], inventory).map(({ line, specifier, reason }) => ({ line, specifier, ...(reason ? { reason } : {}) }));
}

describe("pythonUnresolvedImports", () => {
	it("MUST-FIRE: an absolute import into a first-party package whose module does not exist", () => {
		expect(unresolved("top.py", [ref("app.missing", ["f"], 0, 4)])).toEqual([{ line: 4, specifier: "app.missing", reason: "python-module-missing" }]);
	});

	it("MUST-FIRE: a relative import whose target module does not exist", () => {
		expect(unresolved("app/main.py", [ref("gone", ["f"], 1, 2)])).toEqual([{ line: 2, specifier: ".gone", reason: "python-relative-target-missing" }]);
		expect(unresolved("app/sub/leaf.py", [ref("nothing", ["f"], 2, 3)])).toEqual([{ line: 3, specifier: "..nothing", reason: "python-relative-target-missing" }]);
	});

	it("MUST-NOT-FIRE: modules that exist, third-party and standard-library imports", () => {
		expect(unresolved("top.py", [ref("app.util"), ref("app.sub.leaf"), ref("numpy.linalg"), ref("os.path"), ref("app", ["anything"])])).toEqual([]);
		expect(unresolved("app/main.py", [ref("util", ["f"], 1), ref("", ["util"], 1)])).toEqual([]);
	});

	it("MUST-NOT-FIRE: a native extension, a stub file and a namespace directory are not missing", () => {
		expect(unresolved("top.py", [ref("app._speed"), ref("app.stubbed"), ref("ns.inner.mod"), ref("ns.inner")])).toEqual([]);
	});

	it("MUST-NOT-FIRE: a namespace directory does not shadow an installed package, and a sibling file of a package does not shadow the standard library", () => {
		const paths = [...inventory, "docker/compose.yml", "docker/run.sh", "app/email.py"];
		const run = (from: string, row: PythonImportRow) => pythonUnresolvedImports([file(from, [row])], paths);
		expect(run("top.py", ref("docker.utils.socket"))).toEqual([]);
		expect(run("app/main.py", ref("email.mime.text"))).toEqual([]);
	});

	it("MUST-NOT-FIRE: an underscore module of a repository that builds native code may be a compiled extension", () => {
		const row = ref("app._ffi");
		expect(pythonUnresolvedImports([file("top.py", [row])], inventory)).toHaveLength(1);
		expect(pythonUnresolvedImports([file("top.py", [row])], [...inventory, "rust/Cargo.toml"])).toEqual([]);
	});

	it("MUST-FIRE: a plain folder of scripts still finds its own directory first", () => {
		expect(unresolved("scripts/run.py", [ref("helper.nothing", ["x"], 0, 6)])).toEqual([{ line: 6, specifier: "helper.nothing", reason: "python-module-missing" }]);
	});

	it("MUST-NOT-FIRE: a relative import of a bare name cannot be judged without the package's own names", () => {
		expect(unresolved("app/main.py", [ref("", ["defined_in_init"], 1)])).toEqual([]);
	});

	it("finds a sibling script module through the importing file's own directory, like the resolver", () => {
		expect(unresolved("scripts/run.py", [ref("helper"), ref("missing_helper")])).toEqual([]);
	});

	it("ignores a file that is not Python", () => {
		expect(pythonUnresolvedImports([{ input: { path: "a.ts" } } as unknown as AnalyzedFile], inventory)).toEqual([]);
	});
});
