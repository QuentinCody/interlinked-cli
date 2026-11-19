import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PYTHON_SCORE_SCRIPT } from "./python-score-script.js";

const python = spawnSync("python3", ["-I", "-S", "-B", "-c", "import sys; print(sys.version_info >= (3, 10))"], { encoding: "utf8" });
const usable = python.status === 0 && python.stdout.trim() === "True";

function run(entries: { path: string; content: string }[]): { files: Record<string, unknown>[] } {
	const result = spawnSync("python3", ["-I", "-S", "-B", "-c", PYTHON_SCORE_SCRIPT], { encoding: "utf8", input: JSON.stringify(entries), cwd: "/" });
	expect(result.status).toBe(0);
	return JSON.parse(result.stdout);
}

describe("PYTHON_SCORE_SCRIPT", () => {
	it("imports only standard-library modules and never evaluates target source", () => {
		const imports = [...PYTHON_SCORE_SCRIPT.matchAll(/^import ([\w, ]+)$/gm)].flatMap(match => (match[1] ?? "").split(",").map(name => name.trim()));
		expect([...new Set(imports)].sort()).toEqual(["ast", "bisect", "io", "json", "keyword", "math", "re", "sys", "token", "tokenize", "warnings"].sort());
		expect(PYTHON_SCORE_SCRIPT).not.toMatch(/\b(exec|eval|__import__|importlib|runpy|subprocess)\(/);
	});

	it.skipIf(!usable)("reports one row per input in order, with errors that carry the exception class", () => {
		const rows = run([{ path: "a.py", content: "x = 1\n" }, { path: "b.py", content: "def f(:\n" }]).files;
		expect(rows.map(row => row.path)).toEqual(["a.py", "b.py"]);
		expect(rows[0]).toHaveProperty("result");
		expect(rows[1]).toMatchObject({ error: "SyntaxError: source could not be analyzed" });
	});

	it.skipIf(!usable)("handles non-ASCII source, CRLF line ends and form feeds without shifting offsets", () => {
		const content = "# café 😀\r\ndef f(a):\r\n    return a\x0c + 1\r\n";
		const row = run([{ path: "u.py", content }]).files[0] as { result: { functions: { startOffset: number; endOffset: number; line: number }[] } };
		const fn = row.result.functions[0]!;
		expect(content.slice(fn.startOffset, fn.endOffset)).toMatch(/^def f\(a\):/);
		expect(fn.line).toBe(2);
	});
});
