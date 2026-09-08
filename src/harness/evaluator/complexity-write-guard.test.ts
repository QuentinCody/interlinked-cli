import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Python analyzer so the dispatch + block contract can be tested
// without `radon` installed (the radon→entries mapping is covered in
// cyclomatic-python.test.ts via an injected spawn). The TS analyzer
// (cyclomatic-ast, a different module) stays REAL so the JS/TS tests below
// exercise the unchanged path end-to-end.
vi.mock("../checks/cyclomatic-python.js", () => ({
	computeCyclomaticPython: vi.fn(),
}));

import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import { computeCyclomaticPython as mockedComputeCyclomaticPython } from "../checks/cyclomatic-python.js";
import {
	DEFAULT_MAX_CYCLOMATIC as METRIC_CAPS_DEFAULT_CYCLOMATIC,
	resetMetricCapsCache,
} from "../metric-caps.js";
import {
	__resetPythonDegradeWarningForTesting,
	checkFunctionComplexityWrite,
	DEFAULT_MAX_CYCLOMATIC,
	projectContent,
	resolveFilePath,
	selectAnalyzer,
	SUB_CAP_RATCHET_TOLERANCE,
} from "./complexity-write-guard.js";

const pythonMock = vi.mocked(mockedComputeCyclomaticPython);

/** One synthetic Python entry at the given complexity. */
function pyEntry(name: string, cyclomatic: number, line = 1): FunctionComplexityEntry {
	return { name, line, endLine: line + 5, cyclomatic, language: "python" };
}

/** A function body with `branches` if-statements → cyclomatic ≈ branches + 1. */
function fnWith(name: string, branches: number): string {
	let s = `export function ${name}(a: number): number {\n\tlet r = 0;\n`;
	for (let i = 0; i < branches; i++) s += `\tif (a === ${i}) r += ${i};\n`;
	return `${s}\treturn r;\n}\n`;
}

/** An anonymous arrow callback (named "(callback)" by the AST pass) with
 *  `branches` if-statements → cyclomatic ≈ branches + 1. */
function anonFnWith(branches: number): string {
	let body = "\tlet r = 0;\n";
	for (let i = 0; i < branches; i++) body += `\tif (a === ${i}) r += ${i};\n`;
	return `export const wired = register((a: number): number => {\n${body}\treturn r;\n});\n`;
}

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "cyc-guard-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("checkFunctionComplexityWrite — file-path resolution and edit-projection edge cases", () => {
	it("resolves the target file from `path` when `file_path` is absent", () => {
		const file = join(tmp, "viaPath.ts");
		const out = checkFunctionComplexityWrite(
			{ path: file, content: fnWith("f", 40) },
			tmp,
		);
		expect(out?.block).toContain("f (cyclomatic");
	});

	it("fails open (null) when neither file_path/path is set and the payload isn't an apply_patch", () => {
		const out = checkFunctionComplexityWrite({ content: fnWith("f", 40) }, tmp);
		expect(out).toBeNull();
	});

	it("fails open when the target path is a directory (unreadable as a file)", () => {
		const dirPath = join(tmp, "a-directory.ts");
		mkdirSync(dirPath);
		const out = checkFunctionComplexityWrite({ file_path: dirPath, content: fnWith("f", 40) }, tmp);
		expect(out).toBeNull();
	});

	it("replace_all rewrites every occurrence of old_string", () => {
		const file = join(tmp, "replaceall.ts");
		writeFileSync(file, `${fnWith("a", 1)}${fnWith("a2", 1)}`);
		// old_string "r += 0;" appears once per fnWith body (branches=1 → one `if`).
		const out = checkFunctionComplexityWrite(
			{
				file_path: file,
				old_string: "let r = 0;",
				new_string: "let r = 1;",
				replace_all: true,
			},
			tmp,
		);
		expect(out).toBeNull();
	});

	it("Edit is a no-op (before===after) when old_string is not found in the file", () => {
		const file = join(tmp, "nomatch-edit.ts");
		writeFileSync(file, fnWith("f", 3));
		const out = checkFunctionComplexityWrite(
			{ file_path: file, old_string: "NOT_PRESENT_ANYWHERE", new_string: "x" },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("returns null (unknown shape) when old_string is present but new_string is missing", () => {
		const file = join(tmp, "malformed-edit.ts");
		writeFileSync(file, fnWith("f", 3));
		const out = checkFunctionComplexityWrite(
			{ file_path: file, old_string: "let r = 0;" },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("MultiEdit (edits array): blocks when the combined edits push a function over cap", () => {
		const file = join(tmp, "multiedit.ts");
		writeFileSync(file, fnWith("f", 3));
		let added = "";
		for (let i = 0; i < 40; i++) added += `\tif (a === ${100 + i}) r += ${i};\n`;
		const out = checkFunctionComplexityWrite(
			{
				file_path: file,
				edits: [
					{ old_string: "let r = 0;", new_string: "let r = 1;" },
					{ old_string: "\treturn r;", new_string: `${added}\treturn r;` },
				],
			},
			tmp,
		);
		expect(out?.block).toContain("f (cyclomatic");
	});

	it("MultiEdit: an entry missing new_string is skipped, other entries still apply", () => {
		const file = join(tmp, "multiedit-skip.ts");
		writeFileSync(file, fnWith("f", 3));
		const out = checkFunctionComplexityWrite(
			{
				file_path: file,
				edits: [
					{ old_string: "let r = 0;" }, // missing new_string — skipped
					{ old_string: "let r = 0;", new_string: "let r = 2;" },
				],
			},
			tmp,
		);
		expect(out).toBeNull();
	});

	it("MultiEdit: a non-object entry in `edits` is skipped without throwing", () => {
		const file = join(tmp, "multiedit-nonobj.ts");
		writeFileSync(file, fnWith("f", 3));
		expect(() =>
			checkFunctionComplexityWrite(
				{
					file_path: file,
					edits: [null, "not-an-object", { old_string: "let r = 0;", new_string: "let r = 2;" }],
				},
				tmp,
			),
		).not.toThrow();
	});

	it("MultiEdit: returns null when the target file does not exist yet (before === '')", () => {
		const file = join(tmp, "multiedit-missing.ts");
		const out = checkFunctionComplexityWrite(
			{ file_path: file, edits: [{ old_string: "x", new_string: "y" }] },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("plain old_string/new_string Edit against a non-existent file returns null (before === '')", () => {
		const file = join(tmp, "single-edit-missing.ts");
		const out = checkFunctionComplexityWrite(
			{ file_path: file, old_string: "x", new_string: "y" },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("resolves a RELATIVE file_path against cwd", () => {
		writeFileSync(join(tmp, "rel.ts"), fnWith("f", 3));
		let added = "";
		for (let i = 0; i < 40; i++) added += `\tif (a === ${100 + i}) r += ${i};\n`;
		const out = checkFunctionComplexityWrite(
			{ file_path: "rel.ts", old_string: "\treturn r;", new_string: `${added}\treturn r;` },
			tmp,
		);
		expect(out?.block).toContain("f (cyclomatic");
	});
});

describe("checkFunctionComplexityWrite", () => {
	it("exposes the cap as 25", () => {
		expect(DEFAULT_MAX_CYCLOMATIC).toBe(25);
	});

	it("keeps the local default pinned to the single-source metric-caps default (no drift)", () => {
		expect(DEFAULT_MAX_CYCLOMATIC).toBe(METRIC_CAPS_DEFAULT_CYCLOMATIC);
	});

	it("honors a per-repo configured cap from .interlinked/metric-caps.json", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(join(tmp, ".interlinked", "metric-caps.json"), JSON.stringify({ max_cyclomatic: 15 }));
		resetMetricCapsCache();
		// cyclomatic ~18: UNDER the shipped default (25) but OVER the configured 15.
		const out = checkFunctionComplexityWrite({ file_path: join(tmp, "big.ts"), content: fnWith("big", 17) }, tmp);
		expect(out?.block).toContain("big");
		expect(out?.block).toContain("15-branch cap");
		resetMetricCapsCache();
	});

	it("allows that same function under the shipped default cap (no override file)", () => {
		const out = checkFunctionComplexityWrite({ file_path: join(tmp, "big.ts"), content: fnWith("big", 17) }, tmp);
		expect(out).toBeNull();
	});

	it("skips unhandled extensions (.rb — neither JS/TS nor Python)", () => {
		const out = checkFunctionComplexityWrite({ file_path: "src/x.rb", content: fnWith("f", 40) }, tmp);
		expect(out).toBeNull();
	});

	it("allows a Write where every function is under the cap", () => {
		const out = checkFunctionComplexityWrite(
			{ file_path: join(tmp, "ok.ts"), content: fnWith("ok", 5) },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("blocks a Write that adds a NEW over-cap function", () => {
		const out = checkFunctionComplexityWrite(
			{ file_path: join(tmp, "big.ts"), content: fnWith("big", 40) },
			tmp,
		);
		expect(out?.block).toContain("cyclomatic");
		expect(out?.block).toContain("big");
		expect(out?.block).toContain("new");
	});

	it("compares the over-cap MULTISET by rank when several functions are over cap", () => {
		// Two over-cap functions before (30, 28); the edit raises the worst to 35 →
		// rank-0 worsens → block. Exercises the multi-element before-profile sort.
		const file = join(tmp, "multi.ts");
		writeFileSync(file, `${fnWith("big1", 29)}${fnWith("big2", 27)}`); // 30, 28
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: `${fnWith("big1", 34)}${fnWith("big2", 27)}` }, // 35, 28
			tmp,
		);
		expect(out?.block).toContain("big1");
	});

	it("allows an Edit that holds/reduces an already-over-cap function (refactor-down)", () => {
		const file = join(tmp, "huge.ts");
		writeFileSync(file, fnWith("huge", 40)); // ~41, already over cap
		const out = checkFunctionComplexityWrite(
			{ file_path: file, old_string: "let r = 0;", new_string: "let r = 1;" },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("blocks an Edit that RAISES a function past the cap", () => {
		const file = join(tmp, "grow.ts");
		writeFileSync(file, fnWith("grow", 5)); // ~6, under cap
		let added = "";
		for (let i = 0; i < 40; i++) added += `\tif (a === ${100 + i}) r += ${i};\n`;
		const out = checkFunctionComplexityWrite(
			{ file_path: file, old_string: "\treturn r;", new_string: `${added}\treturn r;` },
			tmp,
		);
		expect(out?.block).toContain("grow");
		expect(out?.block).toContain("raised from");
	});

	it("exempts test files via the cappable-file exemption", () => {
		const out = checkFunctionComplexityWrite(
			{ file_path: join(tmp, "x.test.ts"), content: fnWith("t", 40) },
			tmp,
		);
		expect(out).toBeNull();
	});

	// --- F3: identity-free over-cap multiset comparison ---
	// The previous name-keyed-max logic dropped anonymous callbacks and collapsed
	// same-named functions, so both repros below were ALLOWED before the fix.

	it("blocks a NEW anonymous callback over the cap (was dropped by name-keying)", () => {
		const out = checkFunctionComplexityWrite(
			{ file_path: join(tmp, "anon.ts"), content: anonFnWith(40) },
			tmp,
		);
		expect(out?.block).toContain("cyclomatic");
		expect(out?.block).toContain("anonymous");
	});

	it("blocks shuffling complexity between same-named functions", () => {
		const file = join(tmp, "shuffle.ts");
		// before: two run()s at ~31 and ~6 → over-cap profile [31]
		writeFileSync(file, fnWith("run", 30) + fnWith("run", 5));
		// after: ~30 and ~27 → over-cap profile [30, 27]; a NEW over-cap value (27)
		// appears even though the max dropped 31→30. Name-keyed-max saw only run→30
		// vs run→31 (a reduction) and allowed it.
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: fnWith("run", 29) + fnWith("run", 26) },
			tmp,
		);
		expect(out?.block).toContain("cyclomatic");
		expect(out?.block).toContain("run");
	});

	it("allows splitting one over-cap function into several under-cap ones", () => {
		const file = join(tmp, "split.ts");
		writeFileSync(file, fnWith("big", 40)); // [41] — over cap
		const after = fnWith("a", 8) + fnWith("b", 8) + fnWith("c", 8); // all under cap
		const out = checkFunctionComplexityWrite({ file_path: file, content: after }, tmp);
		expect(out).toBeNull();
	});

	it("allows adding a new UNDER-cap function alongside an existing over-cap one", () => {
		const file = join(tmp, "coexist.ts");
		writeFileSync(file, fnWith("legacy", 40)); // [41] — already over cap, untouched
		// Whole-file rewrite that holds `legacy` and adds a small helper.
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: fnWith("legacy", 40) + fnWith("helper", 5) },
			tmp,
		);
		expect(out).toBeNull();
	});

	// --- F2: Codex apply_patch no longer bypasses the gate ---

	/** Build an apply_patch "Add File" payload from full file content. */
	function applyPatchAdd(path: string, content: string): { command: string } {
		const body = content
			.split("\n")
			.map((l) => `+${l}`)
			.join("\n");
		return { command: `*** Begin Patch\n*** Add File: ${path}\n${body}\n*** End Patch` };
	}

	it("blocks an apply_patch Add File introducing an over-cap function", () => {
		const out = checkFunctionComplexityWrite(
			applyPatchAdd(join(tmp, "gen.ts"), fnWith("genned", 40)),
			tmp,
		);
		expect(out?.block).toContain("cyclomatic");
		expect(out?.block).toContain("gen.ts");
	});

	it("allows an apply_patch Add File with only under-cap functions", () => {
		const out = checkFunctionComplexityWrite(
			applyPatchAdd(join(tmp, "okgen.ts"), fnWith("okfn", 5)),
			tmp,
		);
		expect(out).toBeNull();
	});

	it("blocks an apply_patch Update File that raises a function past the cap", () => {
		const file = join(tmp, "grow.ts");
		writeFileSync(file, fnWith("grow", 5)); // grow ~6, under cap; last `if` is a===4
		let added = "";
		for (let i = 0; i < 40; i++) added += `+\tif (a === ${100 + i}) r += ${i};\n`;
		const patch =
			"*** Begin Patch\n" +
			`*** Update File: ${file}\n` +
			"@@\n" +
			" \tif (a === 4) r += 4;\n" + // context (space + tab + line)
			added +
			" \treturn r;\n" + // context
			"*** End Patch";
		const out = checkFunctionComplexityWrite({ command: patch }, tmp);
		expect(out?.block).toContain("cyclomatic");
		expect(out?.block).toContain("grow");
	});

	it("fails open on an apply_patch whose context cannot be matched", () => {
		const file = join(tmp, "nomatch.ts");
		writeFileSync(file, fnWith("nm", 5));
		const patch =
			"*** Begin Patch\n" +
			`*** Update File: ${file}\n` +
			"@@\n" +
			" nonexistent context line\n" +
			"-foo\n" +
			"+bar\n" +
			"*** End Patch";
		expect(checkFunctionComplexityWrite({ command: patch }, tmp)).toBeNull();
	});
});

// ===========================================================================
// Python (.py) dispatch — same block contract via the radon-backed analyzer.
// The analyzer is mocked (pythonMock); these tests pin the EXTENSION DISPATCH,
// the cap boundary, and the loud-degrade-not-silent-pass behavior. The
// radon→entries mapping itself is covered in cyclomatic-python.test.ts.
// ===========================================================================
describe("checkFunctionComplexityWrite — Python dispatch", () => {
	let pyTmp: string;
	beforeEach(() => {
		pyTmp = mkdtempSync(join(tmpdir(), "cyc-guard-py-"));
		pythonMock.mockReset();
	});
	afterEach(() => {
		rmSync(pyTmp, { recursive: true, force: true });
	});

	it("routes a .py edit to computeCyclomaticPython (NOT the TS AST)", () => {
		pythonMock.mockReturnValue([pyEntry("greet", 3)]);
		checkFunctionComplexityWrite(
			{ file_path: join(pyTmp, "app.py"), content: "def greet():\n    pass\n" },
			pyTmp,
		);
		expect(pythonMock).toHaveBeenCalledTimes(2);
		expect(pythonMock).toHaveBeenNthCalledWith(1, "def greet():\n    pass\n", join(pyTmp, "app.py"));
		expect(pythonMock).toHaveBeenNthCalledWith(2, "", join(pyTmp, "app.py"));
	});

	it("blocks a Python Write whose function is over the cap (cyc 26)", () => {
		pythonMock.mockImplementation((content: string) =>
			content.trim() === "" ? [] : [pyEntry("dispatch", 26)],
		);
		const out = checkFunctionComplexityWrite(
			{ file_path: join(pyTmp, "dispatch.py"), content: "def dispatch():\n    ...\n" },
			pyTmp,
		);
		expect(out?.block).toContain("cyclomatic");
		expect(out?.block).toContain("dispatch");
		expect(out?.block).toContain("26");
	});

	it("allows a simple Python function (cyc <= 25)", () => {
		pythonMock.mockReturnValue([pyEntry("simple", 4)]);
		const out = checkFunctionComplexityWrite(
			{ file_path: join(pyTmp, "simple.py"), content: "def simple():\n    return 1\n" },
			pyTmp,
		);
		expect(out).toBeNull();
	});

	it("boundary: cyclomatic exactly 25 is allowed, 26 is blocked", () => {
		// 25 — at the cap, not over → allowed.
		pythonMock.mockReturnValue([pyEntry("atcap", DEFAULT_MAX_CYCLOMATIC)]);
		expect(
			checkFunctionComplexityWrite(
				{ file_path: join(pyTmp, "atcap.py"), content: "def atcap():\n    ...\n" },
				pyTmp,
			),
		).toBeNull();

		// 26 — one over the cap → blocked (file did not exist before → empty before).
		pythonMock.mockImplementation((content: string) =>
			content.trim() === "" ? [] : [pyEntry("over", DEFAULT_MAX_CYCLOMATIC + 1)],
		);
		const blocked = checkFunctionComplexityWrite(
			{ file_path: join(pyTmp, "over.py"), content: "def over():\n    ...\n" },
			pyTmp,
		);
		expect(blocked?.block).toContain("cyclomatic");
		expect(blocked?.block).toContain("over");
	});

	it("radon unavailable → LOUD degrade to stderr, NOT a silent pass and NOT a false block", () => {
		// Reset the once-per-process latch so the warning fires regardless of which
		// earlier test already tripped it.
		__resetPythonDegradeWarningForTesting();
		// null = the analyzer-unavailable signal (radon not on PATH).
		pythonMock.mockReturnValue(null);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const out = checkFunctionComplexityWrite(
				{ file_path: join(pyTmp, "noradon.py"), content: "def f():\n    ...\n" },
				pyTmp,
			);
			expect(out).toBeNull(); // fail OPEN — never a false block
			// LOUD: a degrade warning naming radon was written to stderr (not silent).
			const wrote = stderrSpy.mock.calls.some(
				(c) => typeof c[0] === "string" && c[0].includes("radon"),
			);
			expect(wrote).toBe(true);
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it("allows holding an already-over-cap Python function (refactor-down / delta)", () => {
		const file = join(pyTmp, "legacy.py");
		writeFileSync(file, "def legacy():\n    ...\n");
		// before AND after both report the same over-cap function → held, allowed.
		pythonMock.mockReturnValue([pyEntry("legacy", 40)]);
		const out = checkFunctionComplexityWrite(
			{ file_path: file, old_string: "...", new_string: "pass" },
			pyTmp,
		);
		expect(out).toBeNull();
	});

	it("skips a non-code extension (.md) without invoking any analyzer", () => {
		const out = checkFunctionComplexityWrite(
			{ file_path: join(pyTmp, "notes.md"), content: "def looks_like_code(): ...\n" },
			pyTmp,
		);
		expect(out).toBeNull();
		expect(pythonMock).not.toHaveBeenCalled();
	});
});

// MOVED-SECTION RECONSTRUCTION (finding 2026-06). An apply_patch `*** Move to:`
// section's path is the DESTINATION (not yet on disk); the before-state lives at
// `fromPath`. Reading the destination yielded "" → hunks unreconstructable → the
// strict cyclomatic gate silently failed OPEN on a move introducing an over-cap fn.
describe("checkFunctionComplexityWrite — apply_patch Move sections", () => {
	it("BLOCKS a move whose update grows the function over the cap", () => {
		writeFileSync(join(tmp, "old.ts"), fnWith("grow", 5), "utf-8"); // ~6, under cap
		const patch = [
			"*** Begin Patch",
			"*** Update File: old.ts",
			"*** Move to: moved.ts",
			"@@",
			...fnWith("grow", 5)
				.split("\n")
				.filter((l) => l.length > 0)
				.map((l) => `-${l}`),
			...fnWith("grow", 40) // ~41, over cap
				.split("\n")
				.filter((l) => l.length > 0)
				.map((l) => `+${l}`),
			"*** End Patch",
		].join("\n");
		const out = checkFunctionComplexityWrite({ command: patch }, tmp);
		expect(out).not.toBeNull(); // reconstructed from the SOURCE → over-cap caught
		expect(out?.block).toContain("grow");
	});

	it("allows a pure rename (no hunks worsening complexity)", () => {
		writeFileSync(join(tmp, "keep-old.ts"), fnWith("ok", 5), "utf-8");
		const patch = [
			"*** Begin Patch",
			"*** Update File: keep-old.ts",
			"*** Move to: keep-new.ts",
			"@@",
			" export function ok(a: number): number {",
			"*** End Patch",
		].join("\n");
		expect(checkFunctionComplexityWrite({ command: patch }, tmp)).toBeNull();
	});
});


describe("sub-cap per-edit slew ratchet (bounded rise, cap is the backstop)", () => {
	// fnWith(name, b) → cyclomatic b + 1, so branchesFor(cyclomatic) = cyclomatic - 1.
	// Fixtures are built relative to SUB_CAP_RATCHET_TOLERANCE so a future change to
	// the tolerance is a one-place edit (mirrors the line-cap test convention).
	const branchesFor = (cyclomatic: number) => cyclomatic - 1;

	it("pins the per-edit slew tolerance (default 2)", () => {
		expect(SUB_CAP_RATCHET_TOLERANCE).toBe(2);
	});

	it("allows a single-branch sub-cap rise within tolerance (5 -> 6)", () => {
		const file = join(tmp, "slew-one.ts");
		writeFileSync(file, fnWith("f", branchesFor(5)));
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: fnWith("f", branchesFor(6)) },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("allows a sub-cap rise of exactly the tolerance", () => {
		const file = join(tmp, "slew-edge.ts");
		const pre = 5;
		writeFileSync(file, fnWith("f", branchesFor(pre)));
		// rise === SUB_CAP_RATCHET_TOLERANCE (5 -> 7 at the default): allowed.
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: fnWith("f", branchesFor(pre + SUB_CAP_RATCHET_TOLERANCE)) },
			tmp,
		);
		expect(out).toBeNull();
	});

	it("blocks a sub-cap rise one past the tolerance (5 -> 8 at the default)", () => {
		const file = join(tmp, "ratchet.ts");
		const pre = 5;
		const post = pre + SUB_CAP_RATCHET_TOLERANCE + 1; // rise === tolerance + 1
		writeFileSync(file, fnWith("f", branchesFor(pre)));
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: fnWith("f", branchesFor(post)) },
			tmp,
		);
		expect(out?.block).toContain(`${pre} -> ${post}`);
		expect(out?.block).toContain(`rose ${post - pre} in one edit`);
		expect(out?.block).toContain(`+${SUB_CAP_RATCHET_TOLERANCE}/edit`);
	});

	it("still blocks a within-tolerance rise that crosses the cap (cap is the backstop)", () => {
		const file = join(tmp, "cross.ts");
		// pre just under the cap; a rise within the slew tolerance still lands the
		// END-STATE over the cap → the over-cap path blocks regardless of the slew.
		const pre = DEFAULT_MAX_CYCLOMATIC - 1; // 24, under cap
		const post = DEFAULT_MAX_CYCLOMATIC + 1; // 26, over cap (rise 2 = default tolerance)
		writeFileSync(file, fnWith("f", branchesFor(pre)));
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: fnWith("f", branchesFor(post)) },
			tmp,
		);
		expect(out?.block).toContain("cyclomatic");
		expect(out?.block).toContain("raised from");
	});

	it("allows holding a sub-cap function (5 -> 5)", () => {
		const file = join(tmp, "hold.ts");
		writeFileSync(file, fnWith("f", 4));
		const out = checkFunctionComplexityWrite({ file_path: file, content: fnWith("f", 4) }, tmp);
		expect(out).toBeNull();
	});

	it("allows reducing a sub-cap function (8 -> 5)", () => {
		const file = join(tmp, "reduce.ts");
		writeFileSync(file, fnWith("f", 7));
		const out = checkFunctionComplexityWrite({ file_path: file, content: fnWith("f", 4) }, tmp);
		expect(out).toBeNull();
	});

	it("allows adding a NEW sub-cap function even if more complex than existing ones", () => {
		const file = join(tmp, "addnew.ts");
		writeFileSync(file, fnWith("a", 2)); // cyclomatic 3
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: fnWith("a", 2) + fnWith("b", 6) }, // b new, cyclomatic 7
			tmp,
		);
		expect(out).toBeNull();
	});

	it("does NOT sub-cap-ratchet collision-named functions (only the cap protects them)", () => {
		const file = join(tmp, "collide.ts");
		// Two functions both named "h" -> name collides -> excluded from the unique
		// ratchet. Raising one sub-cap is allowed (the cap still bounds it).
		const before = `function h(a: number): number {\n\tif (a===0) return 0;\n\treturn 1;\n}\nfunction h(a: number): number {\n\tif (a===1) return 1;\n\treturn 0;\n}\n`;
		const after = `function h(a: number): number {\n\tif (a===0) return 0;\n\tif (a===2) return 2;\n\treturn 1;\n}\nfunction h(a: number): number {\n\tif (a===1) return 1;\n\treturn 0;\n}\n`;
		writeFileSync(file, before);
		const out = checkFunctionComplexityWrite({ file_path: file, content: after }, tmp);
		expect(out).toBeNull();
	});
});

// The hole the cognitive gate already closed, ported here (2026-08-04). A pure
// rank comparison sees "one over-cap entry traded for one over-cap entry" and
// reads the profile as held; identity-based comparison sees a name that never
// existed before, whose baseline is therefore the cap.
describe("over-cap relocation — identity beats rank", () => {
	const OVER = DEFAULT_MAX_CYCLOMATIC + 8;

	describe("— positive (must fire)", () => {
		it("P1: blocks shrinking an over-cap function by relocating the excess into a NEW over-cap helper", () => {
			const file = join(tmp, "relocate.ts");
			writeFileSync(file, fnWith("target", OVER + 6)); // one over-cap fn
			// target drops but stays over cap; the excess moves into a brand-new
			// helper that is ALSO over cap. Over-cap COUNT is unchanged (1 -> 2 is
			// caught by rank, so make it 1 -> 2 with the top rank IMPROVED), and the
			// sorted profile's top entry strictly improves — rank alone allows this.
			const after = fnWith("target", OVER) + fnWith("relocatedHelper", OVER + 1);
			const out = checkFunctionComplexityWrite({ file_path: file, content: after }, tmp);
			expect(out?.block).toContain("relocatedHelper");
		});

		it("P2: blocks a NEW over-cap helper even when the pre-edit state had a worse offender", () => {
			const file = join(tmp, "worse-existed.ts");
			writeFileSync(file, fnWith("huge", OVER + 20));
			const after = fnWith("huge", OVER + 20) + fnWith("freshOverCap", OVER);
			const out = checkFunctionComplexityWrite({ file_path: file, content: after }, tmp);
			expect(out?.block).toContain("freshOverCap");
		});

		it("P3: blocks raising a uniquely-named over-cap function past its own prior value", () => {
			const file = join(tmp, "raise.ts");
			writeFileSync(file, fnWith("a", OVER) + fnWith("b", OVER + 10));
			// `a` rises; the sorted profile is unchanged at rank 0 (b still worst).
			const after = fnWith("a", OVER + 4) + fnWith("b", OVER + 10);
			const out = checkFunctionComplexityWrite({ file_path: file, content: after }, tmp);
			expect(out?.block).toContain("a (cyclomatic");
		});
	});

	describe("— negative (must not fire)", () => {
		it("N1: allows a genuine decompose — over-cap function split into all-sub-cap parts", () => {
			const file = join(tmp, "decompose.ts");
			writeFileSync(file, fnWith("target", OVER + 6));
			const after = fnWith("target", 4) + fnWith("partOne", 4) + fnWith("partTwo", 4);
			expect(checkFunctionComplexityWrite({ file_path: file, content: after }, tmp)).toBeNull();
		});

		it("N2: allows an over-cap function to SHRINK while staying over cap (the refactor-down path)", () => {
			const file = join(tmp, "shrink.ts");
			writeFileSync(file, fnWith("target", OVER + 10));
			const after = fnWith("target", OVER + 2);
			expect(checkFunctionComplexityWrite({ file_path: file, content: after }, tmp)).toBeNull();
		});

		it("N3: allows an unrelated edit that leaves an over-cap function untouched", () => {
			const file = join(tmp, "untouched.ts");
			writeFileSync(file, fnWith("legacy", OVER + 3));
			const after = `${fnWith("legacy", OVER + 3)}export const NOTE = "unrelated";\n`;
			expect(checkFunctionComplexityWrite({ file_path: file, content: after }, tmp)).toBeNull();
		});

		it("N4: still allows an anonymous over-cap callback to hold its rank (pooled fallback intact)", () => {
			const file = join(tmp, "anon-hold.ts");
			writeFileSync(file, anonFnWith(OVER + 4));
			expect(
				checkFunctionComplexityWrite({ file_path: file, content: anonFnWith(OVER + 1) }, tmp),
			).toBeNull();
		});

		// P4 exercises the pooled comparator with >=2 before-side ambiguous over-cap
		// entries, so the `.sort((a, b) => b - a)` comparator on `beforeVals` is
		// actually invoked (a 0/1-element array never calls its comparator).
		it("P4: pooled comparison with two before-side anonymous over-cap callbacks still blocks a worsened one", () => {
			const file = join(tmp, "anon-pair.ts");
			/** A second, differently-named anonymous over-cap callback (still AST-named
			 *  "(callback)", so it pools with `anonFnWith`'s entries). */
			function anon2With(branches: number): string {
				let body = "\tlet r = 0;\n";
				for (let i = 0; i < branches; i++) body += `\tif (a === ${i}) r += ${i};\n`;
				return `export const w2 = register((a: number): number => {\n${body}\treturn r;\n});\n`;
			}
			// Before: two ambiguous (anonymous) over-cap entries → beforeVals has 2
			// elements → the `.sort((a, b) => b - a)` comparator actually runs (a
			// 0/1-element array never invokes its comparator).
			writeFileSync(file, anonFnWith(OVER) + anon2With(OVER + 3));
			// After: the worst-ranked anonymous entry (rank 0, the w2 one) rises past
			// its before-rank baseline (OVER+3 -> OVER+20).
			const after = anonFnWith(OVER) + anon2With(OVER + 20);
			const out = checkFunctionComplexityWrite({ file_path: file, content: after }, tmp);
			expect(out?.block).toContain("cyclomatic");
		});
	});
});

describe("checkFunctionComplexityWrite — unreadable file (existsSync true, read throws)", () => {
	it("fails open when the target path exists as a directory (EISDIR on read)", () => {
		const dirPath = join(tmp, "unreadable-dir.ts");
		mkdirSync(dirPath);
		const out = checkFunctionComplexityWrite(
			{ file_path: dirPath, old_string: "a", new_string: "b" },
			tmp,
		);
		expect(out).toBeNull();
	});
});

describe("warnAnalyzerUnavailable — once-per-process latch (Python)", () => {
	it("writes the degrade warning only once across two consecutive unavailable edits", () => {
		__resetPythonDegradeWarningForTesting();
		pythonMock.mockReturnValue(null);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			checkFunctionComplexityWrite(
				{ file_path: join(tmp, "first.py"), content: "def f():\n    ...\n" },
				tmp,
			);
			const afterFirst = stderrSpy.mock.calls.filter(
				(c) => typeof c[0] === "string" && c[0].includes("radon"),
			).length;
			expect(afterFirst).toBe(1);

			checkFunctionComplexityWrite(
				{ file_path: join(tmp, "second.py"), content: "def g():\n    ...\n" },
				tmp,
			);
			const afterSecond = stderrSpy.mock.calls.filter(
				(c) => typeof c[0] === "string" && c[0].includes("radon"),
			).length;
			expect(afterSecond).toBe(1); // still 1 — latch suppressed the second warning
		} finally {
			stderrSpy.mockRestore();
			pythonMock.mockReset();
		}
	});
});

describe("checkFunctionComplexityWrite — apply_patch: non-code section + unavailable analyzer", () => {
	it("skips a non-code Add File section within an apply_patch (no analyzer selected)", () => {
		const patch =
			"*** Begin Patch\n" +
			`*** Add File: ${join(tmp, "notes.md")}\n` +
			"+# just notes\n" +
			"*** End Patch";
		expect(checkFunctionComplexityWrite({ command: patch }, tmp)).toBeNull();
	});

	it("fails open entirely when a .py section's analyzer is unavailable inside an apply_patch", () => {
		pythonMock.mockReturnValue(null);
		const patch =
			"*** Begin Patch\n" +
			`*** Add File: ${join(tmp, "gen.py")}\n` +
			"+def f():\n" +
			"+    pass\n" +
			"*** End Patch";
		expect(checkFunctionComplexityWrite({ command: patch }, tmp)).toBeNull();
		pythonMock.mockReset();
	});

	it("skips a section whose destination is exempt (test file) even with an over-cap function", () => {
		const body = fnWith("t", 40)
			.split("\n")
			.map((l) => `+${l}`)
			.join("\n");
		const patch = `*** Begin Patch\n*** Add File: ${join(tmp, "skip.test.ts")}\n${body}\n*** End Patch`;
		const out = checkFunctionComplexityWrite({ command: patch }, tmp);
		expect(out).toBeNull();
	});

	it("falls back to '' when the move's SOURCE path exists but is unreadable (a directory)", () => {
		const dirPath = join(tmp, "old-as-dir.ts");
		mkdirSync(dirPath);
		const patch = [
			"*** Begin Patch",
			"*** Update File: old-as-dir.ts",
			"*** Move to: moved-from-dir.ts",
			"@@",
			" some context that will not match",
			"-foo",
			"+bar",
			"*** End Patch",
		].join("\n");
		// existsSync(abs) is true (it's a directory) but safeRead throws → falls
		// back to "" via `safeRead(abs) ?? ""`, then the hunk fails to match
		// against empty content → reconstructAfterContent returns null → skipped.
		expect(checkFunctionComplexityWrite({ command: patch }, tmp)).toBeNull();
	});
});

describe("checkFunctionComplexityWrite — beforeFns null fallback (analyzer available for after, not before)", () => {
	let pyTmp2: string;
	beforeEach(() => {
		pyTmp2 = mkdtempSync(join(tmpdir(), "cyc-guard-py2-"));
		pythonMock.mockReset();
	});
	afterEach(() => {
		rmSync(pyTmp2, { recursive: true, force: true });
	});

	it("treats a null beforeFns compute() result as an empty before-state (?? [])", () => {
		// The mock returns null only for the BEFORE content (empty string), and a
		// real entry for the AFTER content — exercising `analyzer.compute(before,
		// filePath) ?? []` independently of the earlier afterFns-null early return.
		pythonMock.mockImplementation((content: string) =>
			content === "" ? null : [pyEntry("f", 3)],
		);
		const file = join(pyTmp2, "newfile.py");
		const out = checkFunctionComplexityWrite(
			{ file_path: file, content: "def f():\n    pass\n" },
			pyTmp2,
		);
		expect(out).toBeNull(); // f (cyc 3) is well under cap either way
	});
});

// ===========================================================================
// Mutation-kill additions (pass-1, W11 fleet). projectContent/selectAnalyzer/
// resolveFilePath are called DIRECTLY (exported) rather than through
// checkFunctionComplexityWrite so downstream masking (empty-file-parses-to-
// zero-functions, cappable-file exemptions) can't hide the mutated branch.
// ===========================================================================

describe("projectContent — direct exact-observable branch coverage", () => {
	// test-contract: invariant — old_string/new_string is a matched pair; a
	// caller supplying only one half must not fall through to Edit semantics.
	it("returns null when only old_string is set (new_string absent) against an existing file", () => {
		const file = join(tmp, "only-old.ts");
		writeFileSync(file, "hello world");
		expect(projectContent({ old_string: "hello" }, file)).toBeNull();
	});

	// test-contract: boundary — a non-string old_string must not satisfy the
	// old_string/new_string branch.
	it("returns null when old_string is present but not a string", () => {
		const file = join(tmp, "old-not-string.ts");
		writeFileSync(file, "hello world");
		expect(projectContent({ old_string: 123, new_string: "y" }, file)).toBeNull();
	});

	// test-contract: boundary — mirror of the old_string case for new_string.
	it("returns null when new_string is present but not a string", () => {
		const file = join(tmp, "new-not-string.ts");
		writeFileSync(file, "hello world");
		expect(projectContent({ old_string: "hello", new_string: 456 }, file)).toBeNull();
	});

	// test-contract: boundary — before==="" (file does not exist) must
	// return null exactly, for BOTH the old_string/new_string branch and the
	// edits-array branch; going through checkFunctionComplexityWrite masks
	// this (an empty before/after both parse to zero functions either way).
	it("old_string/new_string branch: before==='' (missing file) returns null exactly", () => {
		const file = join(tmp, "single-missing-direct.ts");
		expect(projectContent({ old_string: "x", new_string: "y" }, file)).toBeNull();
	});

	it("edits-array branch: before==='' (missing file) returns null exactly", () => {
		const file = join(tmp, "multi-missing-direct.ts");
		expect(projectContent({ edits: [{ old_string: "x", new_string: "y" }] }, file)).toBeNull();
	});

	// test-contract: boundary — `typeof raw !== "object"` must independently
	// gate entry even when a typeof-"function" value's OWN properties happen
	// to look string-shaped (the sibling old_string/new_string type guard is
	// not the only line of defense).
	it("skips an edits entry whose typeof is not 'object' even when it carries string-shaped properties", () => {
		const file = join(tmp, "typeof-not-object.ts");
		const content = "untouched content";
		writeFileSync(file, content);
		const fakeEdit = Object.assign(() => {}, { old_string: "untouched", new_string: "CHANGED" });
		const out = projectContent({ edits: [fakeEdit] }, file);
		expect(out).toEqual({ before: content, after: content });
	});
});

describe("projectContent / applyEdit — replace_all and not-found branches (old_string/new_string)", () => {
	// test-contract: public-api — replace_all:true rewrites EVERY occurrence.
	it("replace_all:true rewrites every occurrence", () => {
		const file = join(tmp, "replall-true.ts");
		writeFileSync(file, "aXbXc");
		const out = projectContent({ old_string: "X", new_string: "Y", replace_all: true }, file);
		expect(out).toEqual({ before: "aXbXc", after: "aYbYc" });
	});

	// test-contract: public-api — replace_all omitted rewrites ONLY the
	// first occurrence.
	it("replace_all omitted rewrites only the first occurrence", () => {
		const file = join(tmp, "replall-omit.ts");
		writeFileSync(file, "aXbXc");
		const out = projectContent({ old_string: "X", new_string: "Y" }, file);
		expect(out).toEqual({ before: "aXbXc", after: "aYbXc" });
	});

	// test-contract: boundary — an old_string that never occurs leaves the
	// content byte-for-byte unchanged (no phantom edit at a -1 index).
	it("old_string not found leaves content unchanged", () => {
		const file = join(tmp, "notfound.ts");
		writeFileSync(file, "hello world");
		const out = projectContent({ old_string: "ZZZ_NOT_PRESENT", new_string: "y" }, file);
		expect(out).toEqual({ before: "hello world", after: "hello world" });
	});
});

describe("projectContent — edits array: per-entry type guards and replace_all", () => {
	// test-contract: invariant — an edits[] entry missing old_string (not a
	// string) must be skipped, never treated as a literal "undefined" search.
	it("skips an edits entry whose old_string is missing (not a string)", () => {
		const file = join(tmp, "edits-old-missing.ts");
		const content = "start undefined middle";
		writeFileSync(file, content);
		const out = projectContent({ edits: [{ new_string: "REPLACED" }] }, file);
		expect(out).toEqual({ before: content, after: content });
	});

	// test-contract: invariant — mirror of the above for new_string.
	it("skips an edits entry whose new_string is missing (not a string)", () => {
		const file = join(tmp, "edits-new-missing.ts");
		const content = "before OLDMARK after";
		writeFileSync(file, content);
		const out = projectContent({ edits: [{ old_string: "OLDMARK" }] }, file);
		expect(out).toEqual({ before: content, after: content });
	});

	// test-contract: public-api — an edits[] entry's OWN replace_all:true
	// rewrites every occurrence within that entry's application.
	it("an edits entry's replace_all:true rewrites every occurrence", () => {
		const file = join(tmp, "edits-replall-true.ts");
		writeFileSync(file, "aXbXc");
		const out = projectContent({ edits: [{ old_string: "X", new_string: "Y", replace_all: true }] }, file);
		expect(out).toEqual({ before: "aXbXc", after: "aYbYc" });
	});

	// test-contract: public-api — replace_all omitted on an edits[] entry
	// rewrites only the first occurrence.
	it("an edits entry's replace_all omitted rewrites only the first occurrence", () => {
		const file = join(tmp, "edits-replall-omit.ts");
		writeFileSync(file, "aXbXc");
		const out = projectContent({ edits: [{ old_string: "X", new_string: "Y" }] }, file);
		expect(out).toEqual({ before: "aXbXc", after: "aYbXc" });
	});
});

describe("selectAnalyzer — direct extension-dispatch tests", () => {
	// test-contract: boundary — PY_RE is end-anchored; an extension merely
	// containing ".py" without ending in it must not route to Python.
	it("does not match an extension that merely contains '.py' without ending in it", () => {
		expect(selectAnalyzer("script.pyc")).toBeNull();
	});

	// test-contract: boundary — JS_TS_RE is end-anchored the same way.
	it("does not match an extension that merely contains a JS/TS extension without ending in it", () => {
		expect(selectAnalyzer("weird.tsxyz")).toBeNull();
	});

	// test-contract: public-api — the returned language tag is the exact
	// string "js_ts" for a JS/TS path.
	it("tags a JS/TS path with language 'js_ts' exactly", () => {
		expect(selectAnalyzer("f.ts")?.language).toBe("js_ts");
	});
});

describe("resolveFilePath — direct type-guard tests", () => {
	// test-contract: boundary — a non-string file_path must not be returned
	// verbatim; the function's return type is always `string`.
	it("ignores a non-string file_path value and falls through to path/''", () => {
		expect(resolveFilePath({ file_path: 123 })).toBe("");
	});

	// test-contract: boundary — mirror of the above for `path` when
	// file_path is absent.
	it("ignores a non-string path value when file_path is absent", () => {
		expect(resolveFilePath({ path: 456 })).toBe("");
	});
});

describe("checkApplyPatchComplexity — non-code sections fail safe (never crash)", () => {
	// test-contract: invariant — a section whose extension has no registered
	// analyzer must be skipped BEFORE any analyzer method is invoked; it must
	// never reach `analyzer.compute` with a null analyzer.
	it("skips a non-analyzable (.rb) Add File section instead of crashing", () => {
		const patch =
			"*** Begin Patch\n" + `*** Add File: ${join(tmp, "script.rb")}\n` + "+puts 'hi'\n" + "*** End Patch";
		expect(() => checkFunctionComplexityWrite({ command: patch }, tmp)).not.toThrow();
		expect(checkFunctionComplexityWrite({ command: patch }, tmp)).toBeNull();
	});
});

describe("checkApplyPatchComplexity — source-content resolution reaches the reconstructed after-content", () => {
	function blankContextAddPatch(destPath: string): string {
		return "*** Begin Patch\n" + `*** Update File: ${destPath}\n` + "@@\n" + "\n" + "+MARKER_LINE\n" + "*** End Patch";
	}

	// test-contract: boundary — when the source path does not exist at all,
	// `before` must resolve to the empty string (not a placeholder), so a
	// blank-line context hunk against it still reconstructs successfully.
	it("a missing source path resolves before to '' (blank-context hunk reconstructs)", () => {
		pythonMock.mockImplementation((content: string) =>
			content.includes("MARKER_LINE") ? [pyEntry("newfn", 40)] : [],
		);
		const patch = blankContextAddPatch(join(tmp, "never-existed.py"));
		const out = checkFunctionComplexityWrite({ command: patch }, tmp);
		expect(out?.block).toContain("newfn");
		pythonMock.mockReset();
	});

	// test-contract: boundary — when the source path EXISTS but cannot be
	// read (a directory), `before` must also fall back to '' (not some other
	// sentinel), so the same blank-context hunk still reconstructs.
	it("an unreadable (directory) source path also resolves before to '' (blank-context hunk reconstructs)", () => {
		pythonMock.mockImplementation((content: string) =>
			content.includes("MARKER_LINE") ? [pyEntry("newfn2", 40)] : [],
		);
		const dest = join(tmp, "as-a-directory.py");
		mkdirSync(dest);
		const patch = blankContextAddPatch(dest);
		const out = checkFunctionComplexityWrite({ command: patch }, tmp);
		expect(out?.block).toContain("newfn2");
		pythonMock.mockReset();
	});
});

describe("buildBlock — exact message contract (all template pieces present)", () => {
	// test-contract: public-api — the block message is user-facing guidance;
	// every documented piece (tolerance language, decompose instruction,
	// no-suppression note, the `caps` command hints) must actually be
	// present, not silently dropped.
	it("produces the exact block text for one new over-cap function", () => {
		pythonMock.mockImplementation((content: string) => (content === "AFTER" ? [pyEntry("foo", 99)] : []));
		const file = join(tmp, "exactmsg.py");
		writeFileSync(file, "BEFORE");
		const out = checkFunctionComplexityWrite({ file_path: file, content: "AFTER" }, tmp);
		const expected =
			"[interlinked:cyclomatic] BLOCKED: this edit pushes 1 function(s) past a " +
			`cyclomatic limit — a function may rise by at most ${SUB_CAP_RATCHET_TOLERANCE} branch(es) ` +
			`per edit, and no function may exceed the ${DEFAULT_MAX_CYCLOMATIC}-branch cap:\n` +
			"  • foo (cyclomatic 99, new over-cap function)\n" +
			"Decompose: extract cohesive branches into smaller named functions, then retry. " +
			"Holding or reducing an existing function is always allowed; there is no suppression.\n" +
			`This ${DEFAULT_MAX_CYCLOMATIC}-branch cap is per-repo configurable: \`interlinked caps set cyclomatic <n>\` ` +
			"(run `interlinked caps explain cyclomatic` for what cyclomatic complexity measures).";
		expect(out?.block).toBe(expected);
		pythonMock.mockReset();
	});
});

describe("warnAnalyzerUnavailable — exact degrade message text", () => {
	// test-contract: public-api — the degrade message names `radon` and the
	// exact remediation command; a silently-truncated piece would leave an
	// operator without the install hint.
	it("emits the exact degrade message (all pieces intact)", () => {
		__resetPythonDegradeWarningForTesting();
		pythonMock.mockReturnValue(null);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		checkFunctionComplexityWrite({ file_path: join(tmp, "exactdegrade.py"), content: "def f():\n    ...\n" }, tmp);
		const expected =
			"[interlinked] WARNING: `radon` is not resolvable — the strict cyclomatic " +
			"PreToolUse gate for Python (.py) is degraded and cannot enforce the " +
			`${DEFAULT_MAX_CYCLOMATIC}-branch cap. Install it (e.g. \`pip install radon\`) ` +
			"in this repo to restore enforcement. Edits are allowed meanwhile (fail-open).\n";
		expect(stderrSpy).toHaveBeenCalledWith(expected);
		stderrSpy.mockRestore();
		pythonMock.mockReset();
	});
});

describe("complexityViolations — exact cap boundary (=== cap is allowed, cap+1 blocks)", () => {
	// test-contract: boundary — the over-cap filter is a strict `>`; a
	// function sitting exactly at the cap must never be treated as over it.
	it("a brand-new function at exactly the cap is allowed", () => {
		pythonMock.mockImplementation((content: string) =>
			content === "AFTER" ? [pyEntry("atcap", DEFAULT_MAX_CYCLOMATIC)] : [],
		);
		const file = join(tmp, "atcap-exact.py");
		writeFileSync(file, "BEFORE");
		const out = checkFunctionComplexityWrite({ file_path: file, content: "AFTER" }, tmp);
		expect(out).toBeNull();
		pythonMock.mockReset();
	});
});

describe("uniqueByName — ambiguous entries never enter the sub-cap ratchet", () => {
	// test-contract: invariant — an anonymous callback has no reliable
	// cross-edit identity; its rise must never be sub-cap-ratcheted even
	// when the jump is far past the tolerance.
	it("does not ratchet an anonymous callback's rise (no reliable identity)", () => {
		pythonMock.mockImplementation((content: string) =>
			content === "AFTER" ? [pyEntry("(callback)", 20)] : [pyEntry("(callback)", 5)],
		);
		const file = join(tmp, "anon-ratchet.py");
		writeFileSync(file, "BEFORE");
		const out = checkFunctionComplexityWrite({ file_path: file, content: "AFTER" }, tmp);
		expect(out).toBeNull();
		pythonMock.mockReset();
	});

	// test-contract: invariant — a same-named collision pair also has no
	// reliable cross-edit identity; the last-declared entry's rise must
	// never be ratcheted against the pair's earlier value.
	it("does not ratchet a collision-named pair's rise (no reliable identity)", () => {
		pythonMock.mockImplementation((content: string) =>
			content === "AFTER"
				? [pyEntry("dup", 5), pyEntry("dup", 20)]
				: [pyEntry("dup", 5), pyEntry("dup", 5)],
		);
		const file = join(tmp, "collide-rise.py");
		writeFileSync(file, "BEFORE");
		const out = checkFunctionComplexityWrite({ file_path: file, content: "AFTER" }, tmp);
		expect(out).toBeNull();
		pythonMock.mockReset();
	});
});

describe("pooledAmbiguousOverCapViolations — sort/filter chain integrity", () => {
	// test-contract: invariant — the after-side ambiguous set must be
	// compared rank-for-rank in sorted-descending order; an unsorted
	// comparison misattributes which entry actually worsened.
	it("compares the after-side ambiguous ranks in sorted-descending order, not source order", () => {
		pythonMock.mockImplementation((content: string) =>
			content === "AFTER" ? [pyEntry("(callback)", 26), pyEntry("(callback)", 40)] : [pyEntry("(callback)", 40)],
		);
		const file = join(tmp, "after-unsorted.py");
		writeFileSync(file, "BEFORE");
		const out = checkFunctionComplexityWrite({ file_path: file, content: "AFTER" }, tmp);
		expect(out?.block).toContain("cyclomatic 26");
		expect(out?.block).not.toContain("cyclomatic 40");
		pythonMock.mockReset();
	});

	// test-contract: invariant — the before-side ambiguous baseline must
	// also be sorted-descending; an unsorted baseline misaligns rank 0 and
	// false-blocks an unchanged function.
	it("compares the before-side ambiguous baseline in sorted-descending order, not source order", () => {
		pythonMock.mockImplementation((content: string) =>
			content === "AFTER" ? [pyEntry("(callback)", 40)] : [pyEntry("(callback)", 26), pyEntry("(callback)", 40)],
		);
		const file = join(tmp, "before-unsorted.py");
		writeFileSync(file, "BEFORE");
		const out = checkFunctionComplexityWrite({ file_path: file, content: "AFTER" }, tmp);
		expect(out).toBeNull();
		pythonMock.mockReset();
	});

	// test-contract: invariant — the before-side ambiguous filter requires
	// BOTH over-cap AND ambiguous; a uniquely-named over-cap function must
	// never leak into the pooled baseline (it has its own identity-based
	// comparison already).
	it("a uniquely-named before-side over-cap function never leaks into the pooled baseline", () => {
		pythonMock.mockImplementation((content: string) =>
			content === "AFTER"
				? [pyEntry("(callback)", 40), pyEntry("steady", 35), pyEntry("(callback)", 30)]
				: [pyEntry("(callback)", 40), pyEntry("steady", 35)],
		);
		const file = join(tmp, "spurious-unique.py");
		writeFileSync(file, "BEFORE");
		const out = checkFunctionComplexityWrite({ file_path: file, content: "AFTER" }, tmp);
		expect(out?.block).toContain("cyclomatic 30");
		pythonMock.mockReset();
	});

	// test-contract: invariant — two ambiguous entries held at their exact
	// prior values must never be flagged (held is `<=`, not `<`).
	it("holding two ambiguous over-cap entries at their exact prior values is allowed", () => {
		pythonMock.mockReturnValue([pyEntry("(callback)", 40), pyEntry("(callback)", 30)]);
		const file = join(tmp, "held-exact.py");
		writeFileSync(file, "BEFORE");
		const out = checkFunctionComplexityWrite({ file_path: file, content: "AFTER" }, tmp);
		expect(out).toBeNull();
		pythonMock.mockReset();
	});

	// test-contract: invariant — a same-named collision pair over cap is
	// reported with the non-anonymous wording, never the anonymous-callback
	// wording, since `post.name` is a real name.
	it("a collision-named (non-anonymous) pooled violation uses the non-anonymous wording", () => {
		pythonMock.mockImplementation((content: string) =>
			content === "AFTER" ? [pyEntry("dup", 30), pyEntry("dup", 30)] : [],
		);
		const file = join(tmp, "collision-wording.py");
		writeFileSync(file, "BEFORE");
		const out = checkFunctionComplexityWrite({ file_path: file, content: "AFTER" }, tmp);
		expect(out?.block).toContain("dup (cyclomatic 30, new over-cap function)");
		pythonMock.mockReset();
	});
});

describe("subCapRatchetViolations — the <= cap band gate and sort order", () => {
	// test-contract: invariant — the ratchet is scoped to the `<= cap` band
	// ONLY (module comment: "no double-report"); a rise that lands OVER cap
	// must be reported once, by the over-cap path, never again by the ratchet.
	it("a rise that lands over cap is reported once (over-cap wording), not twice", () => {
		pythonMock.mockImplementation((content: string) =>
			content === "AFTER" ? [pyEntry("named", 30)] : [pyEntry("named", 5)],
		);
		const file = join(tmp, "ratchet-overcap-once.py");
		writeFileSync(file, "BEFORE");
		const out = checkFunctionComplexityWrite({ file_path: file, content: "AFTER" }, tmp);
		expect(out?.block).toContain("named (cyclomatic 30, raised from 5)");
		expect(out?.block).not.toContain("rose 25 in one edit");
	});

	// test-contract: boundary — a big rise that lands EXACTLY at cap is still
	// `<= cap`, so the ratchet (not the strictly-over-cap path) must catch it.
	it("a big rise landing exactly at cap is caught by the ratchet", () => {
		pythonMock.mockImplementation((content: string) =>
			content === "AFTER" ? [pyEntry("named", DEFAULT_MAX_CYCLOMATIC)] : [pyEntry("named", 5)],
		);
		const file = join(tmp, "ratchet-at-cap.py");
		writeFileSync(file, "BEFORE");
		const out = checkFunctionComplexityWrite({ file_path: file, content: "AFTER" }, tmp);
		expect(out).not.toBeNull();
		expect(out?.block).toContain(`rose ${DEFAULT_MAX_CYCLOMATIC - 5} in one edit`);
	});

	// test-contract: invariant — the returned violation strings are sorted
	// alphabetically, independent of the functions' source/iteration order.
	it("two ratchet violations are listed alphabetically, not in source order", () => {
		pythonMock.mockImplementation((content: string) =>
			content === "AFTER"
				? [pyEntry("zebra", 20), pyEntry("apple", 22)] // source order: zebra first
				: [pyEntry("zebra", 5), pyEntry("apple", 5)],
		);
		const file = join(tmp, "ratchet-sort-order.py");
		writeFileSync(file, "BEFORE");
		const out = checkFunctionComplexityWrite({ file_path: file, content: "AFTER" }, tmp);
		const block = out?.block ?? "";
		const appleIdx = block.indexOf("apple");
		const zebraIdx = block.indexOf("zebra");
		expect(appleIdx).toBeGreaterThanOrEqual(0);
		expect(zebraIdx).toBeGreaterThanOrEqual(0);
		expect(appleIdx).toBeLessThan(zebraIdx);
	});
});
