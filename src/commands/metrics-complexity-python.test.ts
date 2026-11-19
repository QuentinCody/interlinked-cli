import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectMixedCensus, isPythonSource } from "./metrics-complexity-python.js";
import { pythonAvailable } from "../lib/metrics/python-measure.js";

const PY = "def pick(items):\n    for item in items:\n        if item and item > 3:\n            return item\n    return None\n\n\nclass Box:\n    def get(self, key):\n        return key if key else None\n";
const TS = "export function pick(items: number[]): number | null {\n\tfor (const item of items) {\n\t\tif (item > 3) return item;\n\t}\n\treturn null;\n}\n";

function repo(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "interlinked-census-py-"));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}
const source = (file: string, content: string) => ({ file, content });

describe("isPythonSource", () => {
	it("matches .py files only", () => {
		expect(isPythonSource("a/b.py")).toBe(true);
		expect(isPythonSource("a/b.pyi")).toBe(false);
		expect(isPythonSource("a/b.ts")).toBe(false);
	});
});

describe.skipIf(!pythonAvailable())("collectMixedCensus", () => {
	it("measures Python functions and lines beside TypeScript ones, with one file count", () => {
		const root = repo({ "a.py": PY, "b.ts": TS });
		const rows = collectMixedCensus([source("a.py", PY), source("b.ts", TS)], root)!;
		expect(rows.files).toBe(2);
		expect(rows.cyclomatic.filter(row => row.file === "a.py").map(row => [row.name, row.value])).toEqual([["pick", 4], ["Box.get", 2]]);
		expect(rows.cognitive.filter(row => row.file === "a.py").map(row => [row.name, row.value])).toEqual([["pick", 4], ["Box.get", 1]]);
		expect(rows.cyclomatic.some(row => row.file === "b.ts")).toBe(true);
		expect(rows.lines.find(row => row.file === "a.py")?.value).toBe(10);
		expect(rows.notMeasured).toBeUndefined();
	});

	it("reports an unparseable Python file as not measured with its reason and still counts the others", () => {
		const root = repo({ "ok.py": PY, "bad.py": "def f(:\n" });
		const rows = collectMixedCensus([source("ok.py", PY), source("bad.py", "def f(:\n")], root)!;
		expect(rows.files).toBe(1);
		expect(rows.notMeasured).toEqual([{ file: "bad.py", reason: expect.stringContaining("SyntaxError") }]);
	});

	it("leaves Python test files and non-handwritten paths out, as it does for TypeScript", () => {
		const root = repo({ "tests/test_a.py": PY, "pkg/real.py": PY });
		const rows = collectMixedCensus([source("tests/test_a.py", PY), source("pkg/real.py", PY)], root)!;
		expect(rows.files).toBe(1);
		expect(rows.lines.map(row => row.file)).toEqual(["pkg/real.py"]);
	});
});

describe("collectMixedCensus without python3", () => {
	it("marks every Python file not measured with the analyzer reason, never an empty clean result", () => {
		const root = repo({ "a.py": PY });
		const rows = collectMixedCensus([source("a.py", PY)], root, undefined, "definitely-not-a-python-binary")!;
		expect(rows.files).toBe(0);
		expect(rows.notMeasured).toEqual([{ file: "a.py", reason: expect.stringContaining("python3") }]);
	});
});
