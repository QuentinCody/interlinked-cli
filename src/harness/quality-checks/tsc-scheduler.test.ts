import { describe, expect, it } from "vitest";
import weights from "./tsc-scheduler-weights.json" with { type: "json" };
import {
	editTextsFor,
	extractTscEditFeatures,
	importLinesTouched,
	patchSectionTexts,
	predictTscReports,
	recallPointFor,
	TSC_SCHEDULER_FEATURES,
	type TscEditFeatures,
	type TscEditInput,
	tscReportProbability,
} from "./tsc-scheduler.js";

const CWD = "/repo";
const FILE = "/repo/src/harness/foo.ts";
const TS = "2026-10-08T12:00:00Z";

function edit(overrides: Partial<TscEditInput>): TscEditInput {
	return { toolName: "Edit", toolInput: {}, filePath: FILE, cwd: CWD, toolUseId: "toolu_01", isSubagent: false, timestamp: TS, ...overrides };
}

function patch(body: string): TscEditInput {
	return edit({ toolName: "apply_patch", toolUseId: "call_abc", toolInput: { command: `*** Begin Patch\n*** Update File: src/harness/foo.ts\n@@\n${body}*** End Patch\n` } });
}

const COMMENT_PATCH = patch(" const a = 1;\n-// old comment\n+// new comment\n const b = 2;\n");
const IMPORT_PATCH = patch(' import { a } from "./a.js";\n+import { b } from "./b.js";\n const x = a;\n');

function logisticPart(f: TscEditFeatures): TscEditFeatures {
	return Object.fromEntries(TSC_SCHEDULER_FEATURES.map((k) => [k, f[k]])) as TscEditFeatures;
}

// Expected vectors and p were computed by the Python study code
// (build_compile.meta_for + patch_section, weights from fit_for_ship.py).
describe("extractTscEditFeatures — parity with the E21 Python features", () => {
	it("P1: comment-only apply_patch section", () => {
		const f = extractTscEditFeatures(COMMENT_PATCH);
		expect(f && logisticPart(f)).toEqual({ edit_chars: 40, old_chars: 40, edit_lines: 3, old_lines: 3, net_lines: 0, import_lines_added: 0,
			has_any: 0, has_as: 0, has_optchain: 0, has_bang: 0, brace_imbalance: 0, is_test_file: 0, is_write: 0, is_apply_patch: 1,
			is_subagent: 0, is_claude: 0, hour: 12 });
		expect(f?.import_touched).toBe(0);
		expect(tscReportProbability(f!)).toBeCloseTo(0.01974064448198903, 12);
	});

	it("P2: type tokens, test path, subagent", () => {
		const f = extractTscEditFeatures(edit({ filePath: "/repo/src/harness/__tests__/foo.test.ts", isSubagent: true,
			toolInput: { old_string: "const x = a;", new_string: "const x = (a as any)!.b?.c;" } }));
		expect(f && logisticPart(f)).toEqual({ edit_chars: 27, old_chars: 12, edit_lines: 1, old_lines: 1, net_lines: 0, import_lines_added: 0,
			has_any: 1, has_as: 1, has_optchain: 1, has_bang: 1, brace_imbalance: 0, is_test_file: 1, is_write: 0, is_apply_patch: 0,
			is_subagent: 1, is_claude: 1, hour: 12 });
		expect(tscReportProbability(f!)).toBeCloseTo(0.2986482119759386, 12);
	});

	it("P3: Write counts every new import as added", () => {
		const f = extractTscEditFeatures(edit({ toolName: "Write", toolInput: { content: 'import { a } from "./a.js";\nexport const x = { a };\n' } }));
		expect(f).toMatchObject({ edit_chars: 52, old_chars: 0, edit_lines: 3, old_lines: 0, net_lines: 3, import_lines_added: 1, is_write: 1, import_touched: 1 });
		expect(tscReportProbability(f!)).toBeCloseTo(0.2350374812730488, 12);
	});

	it("P4: a holdout item vector scores the Python probability", () => {
		const f: TscEditFeatures = { edit_chars: 816, old_chars: 276, edit_lines: 18, old_lines: 7, net_lines: 11, import_lines_added: 0,
			has_any: 0, has_as: 0, has_optchain: 1, has_bang: 0, brace_imbalance: 0, is_test_file: 1, is_write: 0, is_apply_patch: 0,
			is_subagent: 1, is_claude: 1, hour: 19 };
		expect(tscReportProbability(f)).toBeCloseTo(0.25920677370688355, 12);
	});

	it("N1: a tool without edit text yields no features", () => {
		expect(extractTscEditFeatures(edit({ toolName: "Bash", toolInput: { command: "ls" } }))).toBeNull();
		expect(extractTscEditFeatures(edit({ toolInput: { old_string: "", new_string: "" } }))).toBeNull();
	});

	it("N2: a patch with no section for the file yields no features", () => {
		expect(extractTscEditFeatures(edit({ toolName: "apply_patch", toolInput: { command: "*** Begin Patch\n*** Update File: src/other.ts\n@@\n+x\n*** End Patch\n" } }))).toBeNull();
	});

	it("N3: an unparseable timestamp reads as hour 0, as the Python study did", () => {
		expect(extractTscEditFeatures(edit({ timestamp: "nope", toolInput: { old_string: "a", new_string: "b" } }))?.hour).toBe(0);
	});
});

describe("predictTscReports — positive (defers)", () => {
	it("P1: a trivial comment-only patch is deferred at the default 0.90 point", () => {
		const r = predictTscReports(extractTscEditFeatures(COMMENT_PATCH)!);
		expect(r).toMatchObject({ defer: true, recall_point: 0.9 });
		expect(r.p).toBeLessThan(r.threshold);
		expect(r.override).toBeUndefined();
	});

	it("P2: the same edit is still deferred at the strictest fitted point (0.99)", () => {
		expect(predictTscReports(extractTscEditFeatures(COMMENT_PATCH)!, 0.99).defer).toBe(true);
	});
});

describe("predictTscReports — negative (runs)", () => {
	it("N1: an import-adding patch the logistic would defer still runs", () => {
		const f = extractTscEditFeatures(IMPORT_PATCH)!;
		expect(f.import_lines_added).toBe(1);
		const r = predictTscReports(f);
		expect(r.p).toBeLessThan(r.threshold);
		expect(r).toMatchObject({ defer: false, override: "import-touched" });
	});

	it("N2: rewriting an import line (no net import added) still runs", () => {
		const f = extractTscEditFeatures(edit({ toolUseId: "call_abc", toolInput: { old_string: 'import { a } from "./a.js";', new_string: 'import { a, b } from "./a.js";' } }))!;
		expect(f.import_lines_added).toBe(0);
		expect(predictTscReports(f)).toMatchObject({ defer: false, override: "import-touched" });
	});

	it("N3: a comment-only Claude Edit scores above the threshold (Claude edits reported 246/784 in E21)", () => {
		const r = predictTscReports(extractTscEditFeatures(edit({ toolInput: { old_string: "// old comment", new_string: "// new comment" } }))!);
		expect(r.p).toBeCloseTo(0.3146178989053573, 12);
		expect(r.defer).toBe(false);
		expect(r.override).toBeUndefined();
	});
});

describe("recallPointFor", () => {
	it("P1: the default is the 0.90 point with its committed threshold", () => {
		const committed = weights.recall_points.find((pt) => Math.abs(pt.recall_point - 0.9) < 1e-9);
		expect(recallPointFor()).toEqual({ recall_point: 0.9, threshold: committed?.threshold });
		expect(committed?.threshold).toBeCloseTo(0.2324, 4);
	});

	it("P2: an unfitted request takes the next STRICTER point, never a looser one", () => {
		expect(recallPointFor(0.91).recall_point).toBe(0.95);
		expect(recallPointFor(0.5).recall_point).toBe(0.8);
		expect(recallPointFor(1).recall_point).toBe(0.99);
	});
});

describe("editTextsFor / importLinesTouched / patchSectionTexts", () => {
	it("P1: MultiEdit joins its edits with newlines, as activity_scan did", () => {
		expect(editTextsFor({ toolName: "MultiEdit", filePath: FILE, cwd: CWD,
			toolInput: { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] } })).toEqual({ old: "a\nc", new: "b\nd" });
	});

	it("P2: Edit input is capped at 8,000 code points", () => {
		const texts = editTextsFor({ toolName: "Edit", filePath: FILE, cwd: CWD, toolInput: { old_string: "x", new_string: "y".repeat(9000) } });
		expect(texts?.new.length).toBe(8000);
	});

	it("P3: a moved import line is not a touch; a changed one is", () => {
		expect(importLinesTouched('import a from "a";\nx();', 'x();\nimport a from "a";')).toBe(false);
		expect(importLinesTouched('import a from "a";', 'import b from "b";')).toBe(true);
		expect(importLinesTouched("", "const importer = 1;")).toBe(false);
	});

	it("P4: patch parsing stops at the next file header and drops trailers", () => {
		const raw = "*** Begin Patch\n*** Update File: src/harness/foo.ts\n@@\n-a\n+b\n*** Update File: src/other.ts\n@@\n+c\n*** End Patch\n";
		expect(patchSectionTexts(raw, FILE, CWD)).toEqual({ old: "a", new: "b" });
	});
});
