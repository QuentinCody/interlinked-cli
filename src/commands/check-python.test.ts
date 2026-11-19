// Tests for check-python.ts: the dispatcher that merges the Python scans into the
// structural results of `interlinked check`. One Python child process serves every
// Python-aware check of a run; a run that selects none of them starts no process.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPythonChecks } from "./check-python.js";
import type { PythonSpawn } from "./check-python-run.js";
import type { StructuralCheckResult } from "./check-output.js";

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "check-pydisp-"));
	roots.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	return root;
}

const results = (...names: string[]): StructuralCheckResult[] => names.map((name) => ({ name, files: new Set<string>() }));

describe("applyPythonChecks", () => {
	it("D1: broken-imports and cycles are filled from ONE child process", () => {
		let calls = 0;
		const counting = ((...args: Parameters<PythonSpawn>) => {
			calls += 1;
			return (spawnSync as (...a: unknown[]) => unknown)(...args);
		}) as PythonSpawn;
		const root = tree({ "pkg/__init__.py": "", "a.py": "import b\nimport pkg.gone\n", "b.py": "import a\n" });
		const out = results("broken-imports", "cycles", "dead-imports", "blast-radius", "secrets", "missing-tests");
		const notes = applyPythonChecks(out, root, counting);
		expect(calls).toBe(1);
		expect([...(out[0]?.files ?? [])]).toEqual(["a.py"]);
		expect([...(out[1]?.files ?? [])].sort()).toEqual(["a.py", "b.py"]);
		expect(out[0]?.details?.python).toMatchObject({ status: "ok", candidate_count: 1 });
		expect(out[1]?.details?.python).toMatchObject({ status: "ok", cycle_count: 1 });
		expect(out[2]?.details?.python).toMatchObject({ status: "ok", file_count: 2, import_count: 3 });
		expect(out[3]?.details?.python).toMatchObject({ status: "ok", file_count: 0, threshold: 5 });
		expect(out[4]?.details?.python).toMatchObject({ status: "ok", file_count: 0 });
		expect(out[5]?.details?.python).toMatchObject({ status: "ok", missing_count: 2 });
		expect(notes).toHaveLength(2);
	});

	it("D2: a run that selects only the file-list checks starts no process, and still describes Python", () => {
		let calls = 0;
		const spawn = (() => {
			calls += 1;
			return {};
		}) as unknown as PythonSpawn;
		expect(applyPythonChecks(results("secrets", "missing-tests"), "/x", spawn)).toEqual([]);
		expect(calls).toBe(0);
		const out = results("secrets", "missing-tests");
		const root = tree({ "pkg/core.py": "x = 1\n" });
		expect(applyPythonChecks(out, root, spawn)).toEqual([]);
		expect(calls).toBe(0);
		expect([...(out[1]?.files ?? [])]).toEqual(["pkg/core.py"]);
		expect(out[0]?.details?.python).toMatchObject({ status: "ok", file_count: 0 });
	});

	it("D7: a run that selects a check that is not Python-aware starts nothing", () => {
		expect(applyPythonChecks(results("some-engine-tool"), "/x")).toEqual([]);
	});

	it("D3: a TypeScript-only tree leaves the results untouched", () => {
		const root = tree({ "a.ts": "export {};\n" });
		const out = results("broken-imports", "cycles");
		const notes = applyPythonChecks(out, root);
		expect(out.every((r) => r.files.size === 0 && r.details === undefined)).toBe(true);
		expect(notes).toEqual([]);
	});

	it("D4: files the TypeScript scan already found stay in the set", () => {
		const root = tree({ "pkg/__init__.py": "", "a.py": "import pkg.gone\n" });
		const out: StructuralCheckResult[] = [{ name: "broken-imports", files: new Set(["src/x.ts"]) }];
		applyPythonChecks(out, root);
		expect([...(out[0]?.files ?? [])].sort()).toEqual(["a.py", "src/x.ts"]);
	});

	it("D6: hitting the Python file-count bound is reported, not silent", () => {
		const answer = { files_py: 5, files_truncated: true, candidates: [], cycle_groups: [], any_types: [], duplicate_groups: [], stats: {}, skips: {}, import_roots: [], unparsed: [] };
		const spawn = (() => ({ status: 0, stdout: JSON.stringify(answer), stderr: "" })) as unknown as PythonSpawn;
		const notes = applyPythonChecks(results("cycles"), "/x", spawn);
		expect(notes.join("\n")).toMatch(/file-count bound/);
	});

	it("D5: with no interpreter the result is untouched except for the note", () => {
		const root = tree({ "a.py": "import b\n" });
		const spawn = (() => ({ error: Object.assign(new Error("x"), { code: "ENOENT" }) })) as unknown as PythonSpawn;
		const out = results("broken-imports");
		const notes = applyPythonChecks(out, root, spawn);
		expect(out[0]?.files.size).toBe(0);
		expect(out[0]?.details?.python).toMatchObject({ status: "unavailable" });
		expect(notes).toHaveLength(1);
	});
});
