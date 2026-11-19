// Tests for check-python-run.ts: the one batch `python3 -I -S -B -c` child process
// that parses Python source with `ast` only. The spawn function is injected for the
// failure paths (no python3, timeout, output bound, bad JSON, old Python); the success
// path runs the real interpreter on a real temp tree.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BLAST_RADIUS_MIN_DEPENDENTS,
	runPythonAnalysis,
	type PythonRun,
	type PythonSpawn,
	type RawAnyEntry,
	type RawCycleGroup,
	type RawDuplicateGroup,
	type RawPythonCandidate,
	type RawPythonResult,
} from "./check-python-run.js";
import { PYTHON_CHECK_SCRIPT } from "./check-python-script.js";
import { PYTHON_RESOLVE_PART } from "./check-python-script-resolve.js";

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "check-pyrun-"));
	roots.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	return root;
}

function fakeSpawn(result: Record<string, unknown>): PythonSpawn {
	return (() => result) as unknown as PythonSpawn;
}

describe("runPythonAnalysis — failure paths", () => {
	it("M1: a missing python3 is reported as unavailable, never thrown", () => {
		const run = runPythonAnalysis("/x", fakeSpawn({ error: Object.assign(new Error("spawn"), { code: "ENOENT" }) }));
		expect(run.status).toBe("unavailable");
		expect(run.note).toMatch(/python3/);
	});

	it("M2: a timeout is reported as failed with the word timeout", () => {
		const run = runPythonAnalysis("/x", fakeSpawn({ error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }));
		expect(run.status).toBe("failed");
		expect(run.note).toMatch(/time/);
	});

	it("M3: output beyond the buffer bound is reported as failed", () => {
		const run = runPythonAnalysis("/x", fakeSpawn({ error: Object.assign(new Error("b"), { code: "ENOBUFS" }) }));
		expect(run.status).toBe("failed");
		expect(run.note).toMatch(/output/);
	});

	it("M4: a nonzero exit keeps the end of stderr in the note", () => {
		const run = runPythonAnalysis("/x", fakeSpawn({ status: 1, stdout: "", stderr: "Traceback boom" }));
		expect(run.status).toBe("failed");
		expect(run.note).toContain("boom");
	});

	it("M5: output that is not JSON is failed", () => {
		const run = runPythonAnalysis("/x", fakeSpawn({ status: 0, stdout: "not json", stderr: "" }));
		expect(run.status).toBe("failed");
	});

	it("M6: an interpreter older than the script needs is unavailable", () => {
		const run = runPythonAnalysis("/x", fakeSpawn({ status: 0, stdout: JSON.stringify({ unsupported: "3.6.1" }), stderr: "" }));
		expect(run.status).toBe("unavailable");
		expect(run.note).toContain("3.6.1");
	});

	it("M7: JSON that lacks the candidate list is failed", () => {
		const run = runPythonAnalysis("/x", fakeSpawn({ status: 0, stdout: JSON.stringify({ files_py: 1 }), stderr: "" }));
		expect(run.status).toBe("failed");
	});

	it("M8: the child is started with isolated flags, the embedded script, the root on stdin and cwd /", () => {
		let seen: { args: readonly string[]; options: Record<string, unknown> } | null = null;
		const spawn = ((_cmd: string, args: readonly string[], options: Record<string, unknown>) => {
			seen = { args, options };
			return { status: 0, stdout: JSON.stringify({ candidates: [], stats: {}, skips: {} }), stderr: "" };
		}) as unknown as PythonSpawn;
		runPythonAnalysis("/the/root", spawn);
		expect(seen).not.toBeNull();
		const call = seen as unknown as { args: string[]; options: Record<string, unknown> };
		expect(call.args.slice(0, 4)).toEqual(["-I", "-S", "-B", "-c"]);
		expect(call.args[4]).toBe(PYTHON_CHECK_SCRIPT);
		expect(call.options.cwd).toBe("/");
		expect(JSON.parse(String(call.options.input))).toEqual({ root: "/the/root", files: null, blast_min: BLAST_RADIUS_MIN_DEPENDENTS });
		expect(call.options.timeout).toBeGreaterThan(0);
		expect(call.options.maxBuffer).toBeGreaterThan(0);
	});
});

describe("runPythonAnalysis — the root path", () => {
	it("P1: a relative root is made absolute before the child (whose cwd is /) sees it", () => {
		let input = "";
		const spawn = ((_cmd: string, _args: readonly string[], options: { input: string }) => {
			input = options.input;
			return { status: 0, stdout: JSON.stringify({ candidates: [] }), stderr: "" };
		}) as unknown as PythonSpawn;
		runPythonAnalysis("some/relative", spawn);
		expect(JSON.parse(input).root).toBe(resolve("some/relative"));
	});
});

describe("the analysis answer", () => {
	it("S1: the joined script holds both parts and the answer carries every section the scans read", () => {
		expect(PYTHON_CHECK_SCRIPT).toContain(PYTHON_RESOLVE_PART);
		const run: PythonRun = runPythonAnalysis(tree({ "a.py": "x = 1\n" }));
		expect(run.status).toBe("ok");
		if (run.status !== "ok") return;
		const data: RawPythonResult = run.data;
		const candidates: RawPythonCandidate[] = data.candidates;
		const cycles: RawCycleGroup[] = data.cycle_groups;
		const anys: RawAnyEntry[] = data.any_types;
		const dups: RawDuplicateGroup[] = data.duplicate_groups;
		expect([candidates, cycles, anys, dups]).toEqual([[], [], [], []]);
	});
});

describe("runPythonAnalysis — file discovery", () => {
	const gitTree = (files: Record<string, string>): string => {
		const root = tree(files);
		execFileSync("git", ["init", "-q"], { cwd: root });
		return root;
	};
	const LAYOUT = {
		".gitignore": "ignored_dir/\n",
		"keep.py": "x = 1\n",
		"ignored_dir/a.py": "x = 1\n",
		"ignored_dir/b.py": "x = 1\n",
		"node_modules/pkg/c.py": "x = 1\n",
		".claude/worktrees/w/d.py": "x = 1\n",
	};

	it("G1: in a git repository only tracked and non-ignored files are analysed", () => {
		const run = runPythonAnalysis(gitTree({ ...LAYOUT, ".claude/worktrees/w/.gitignore": "" }));
		expect(run.status).toBe("ok");
		if (run.status !== "ok") return;
		expect(run.data.files_py).toBe(2);
		expect(run.data.discovery).toBe("git");
	});

	it("G2: outside a git repository the walk skips node_modules and dot-directories", () => {
		const run = runPythonAnalysis(tree(LAYOUT));
		expect(run.status).toBe("ok");
		if (run.status !== "ok") return;
		expect(run.data.discovery).toBe("walk");
		expect(run.data.files_py).toBe(3);
	});

	it("G3: a time-out names the cause", () => {
		const run = runPythonAnalysis("/x", fakeSpawn({ error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }));
		expect(run.note).toMatch(/large working tree|ignored/);
	});
});

describe("runPythonAnalysis — the real interpreter", () => {
	it("R1: an empty tree gives zero files and no candidates", () => {
		const run = runPythonAnalysis(tree({ "README.md": "x" }));
		expect(run.status).toBe("ok");
		if (run.status !== "ok") return;
		expect(run.data.files_py).toBe(0);
		expect(run.data.candidates).toEqual([]);
	});

	it("R2: the script never executes the code it reads (an import-time side effect does not run)", () => {
		const marker = join(tmpdir(), `check-pyrun-marker-${process.pid}`);
		const root = tree({
			"pkg/__init__.py": `open(${JSON.stringify(marker)}, "w").write("ran")\n`,
			"app.py": "import pkg.gone\n",
		});
		const run = runPythonAnalysis(root);
		expect(run.status).toBe("ok");
		let ran = true;
		try {
			rmSync(marker, { force: false });
		} catch {
			ran = false;
		}
		expect(ran).toBe(false);
	});

	it("R3: a file with a syntax error is listed as unparsed and does not stop the run", () => {
		const run = runPythonAnalysis(tree({ "a.py": "def (:\n", "b.py": "x = 1\n" }));
		expect(run.status).toBe("ok");
		if (run.status !== "ok") return;
		expect(run.data.unparsed_total).toBe(1);
		expect(run.data.files_parsed).toBe(1);
	});
});
