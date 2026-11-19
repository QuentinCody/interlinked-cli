// Real-interpreter tests for check-python-duplicates.ts (duplicates on Python: functions
// whose parameters and body are the same syntax tree, whatever their names or comments).
// MUST-NOT-FIRE twins cover small bodies, dunder methods, different bodies, test modules
// and git-ignored members.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describePythonDuplicates, scanPythonDuplicates, type PythonDuplicateScan } from "./check-python-duplicates.js";
import { runPythonAnalysis } from "./check-python-run.js";

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function scan(files: Record<string, string>, opts: { git?: boolean } = {}): PythonDuplicateScan {
	const root = mkdtempSync(join(tmpdir(), "check-pydup-"));
	roots.push(root);
	if (opts.git) execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	return scanPythonDuplicates(root, runPythonAnalysis(root));
}

const BODY = [
	"    total = 0",
	"    for item in items:",
	"        if item.price > 0 and item.qty > 0:",
	"            total += item.price * item.qty",
	"        else:",
	"            total -= 1",
	"    return round(total, 2)",
].join("\n");

const fn = (name: string, body = BODY, args = "items"): string => `def ${name}(${args}):\n${body}\n`;

describe("A1 duplicate functions (MUST-FIRE)", () => {
	it("F1: the same body under two names in two files", () => {
		const r = scan({ "a.py": fn("compute"), "b.py": fn("sum_up") });
		expect([...r.files].sort()).toEqual(["a.py", "b.py"]);
		expect(r.groups).toHaveLength(1);
		expect(r.groups[0]?.members.map((m) => m.name).sort()).toEqual(["compute", "sum_up"]);
	});

	it("F2: comments, docstrings and layout do not hide a duplicate", () => {
		const commented = `def other(items):\n    """Docs."""\n    # a comment\n${BODY.replace("round(total, 2)", "round( total,2 )")}\n`;
		const r = scan({ "a.py": fn("compute"), "b.py": commented });
		expect(r.groups).toHaveLength(1);
	});

	it("F3: two identical methods in two classes, and two copies inside one file", () => {
		const method = (cname: string): string => `class ${cname}:\n    def calc(self, items):\n${BODY.replace(/^/gm, "    ")}\n`;
		const r = scan({ "a.py": method("A"), "b.py": method("B") });
		expect(r.groups).toHaveLength(1);
		const same = scan({ "a.py": `${fn("one")}\n${fn("two")}` });
		expect([...same.files]).toEqual(["a.py"]);
	});
});

describe("B1 not a duplicate (MUST-NOT-FIRE twins)", () => {
	it("N1: a small body is not reported", () => {
		const small = "    return x + 1\n";
		expect(scan({ "a.py": fn("f", small, "x"), "b.py": fn("g", small, "x") }).files.size).toBe(0);
	});

	it("N2: a different body or different parameters is not a duplicate", () => {
		const changed = BODY.replace("total -= 1", "total -= 2");
		expect(scan({ "a.py": fn("f"), "b.py": fn("g", changed) }).files.size).toBe(0);
		expect(scan({ "a.py": fn("f"), "b.py": fn("g", BODY, "items, extra=None") }).files.size).toBe(0);
	});

	it("N3: dunder methods are not reported", () => {
		const dunder = (c: string): string => `class ${c}:\n    def __eq__(self, items):\n${BODY.replace(/^/gm, "    ")}\n`;
		expect(scan({ "a.py": dunder("A"), "b.py": dunder("B") }).files.size).toBe(0);
	});

	it("N4: test modules are outside the population", () => {
		expect(scan({ "tests/test_a.py": fn("f"), "tests/test_b.py": fn("g") }).files.size).toBe(0);
	});

	it("N5: a git-ignored copy leaves a single member, which is not a duplicate", () => {
		const r = scan({ ".gitignore": "b.py\n", "a.py": fn("f"), "b.py": fn("g") }, { git: true });
		expect(r.files.size).toBe(0);
		expect(r.skips.gitignored_member).toBeUndefined();
	});
});

describe("C1 output description", () => {
	it("C1: groups are described as candidates with members and size", () => {
		const extras = describePythonDuplicates(scan({ "a.py": fn("f"), "b.py": fn("g") }));
		const python = extras.details?.python as { group_count: number; groups: { members: { path: string; line: number }[]; size: number }[] };
		expect(python.group_count).toBe(1);
		expect(python.groups[0]?.size).toBeGreaterThan(0);
		expect(python.groups[0]?.members[0]).toMatchObject({ path: "a.py", line: 1 });
		expect(extras.notes.join("\n")).toMatch(/candidates/);
	});

	it("C2: a tree without Python adds nothing", () => {
		const root = mkdtempSync(join(tmpdir(), "check-pydup-"));
		roots.push(root);
		writeFileSync(join(root, "a.ts"), "export {};\n");
		expect(describePythonDuplicates(scanPythonDuplicates(root, runPythonAnalysis(root)))).toEqual({ details: null, notes: [] });
	});

	it("C3: an unavailable interpreter is described by its reason", () => {
		const root = mkdtempSync(join(tmpdir(), "check-pydup-"));
		roots.push(root);
		writeFileSync(join(root, "a.py"), "x = 1\n");
		const result = scanPythonDuplicates(root, { status: "unavailable", note: "python3 was not found on PATH; Python files were not analysed" });
		expect(describePythonDuplicates(result).notes[0]).toMatch(/python3/);
	});
});
