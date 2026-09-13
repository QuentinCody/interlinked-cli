// Survivor-kill companion for inline-block.ts (fleet wave 29, pass1).
//
// Each case below targets one or more specific surviving mutants recorded in
// .interlinked/mutation-manifest.json for this file. See the `// test-contract`
// comment above each case for the mutantId(s) it targets and why the assertion
// distinguishes real behavior from the mutant.
//
// Two mutants are NOT addressed here — flagged as suspected-equivalent in the
// receipts, not asserted as such: the nested `if (baseline)` guard inside
// checkMissingReturnTypesBlock can only be reached when the outer `&&` chain
// already proved `ctx.baseline?.missingReturnTypes` truthy, and the
// `footgunFindings.length === 0` early return produces the same empty `out`
// whether it fires or the zero-iteration loop below it runs instead.

import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, PreEditBaseline } from "../types.js";

// --- Partial mocks: default to the real implementation, override per-test. ---
vi.mock("../checks/crap-baseline.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../checks/crap-baseline.js")>();
	return { ...actual, computeCrapRisers: vi.fn(actual.computeCrapRisers) };
});
vi.mock("../check-registry/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../check-registry/index.js")>();
	return { ...actual, buildAgentSafetyChecks: vi.fn(actual.buildAgentSafetyChecks) };
});
vi.mock("../checks/dry-check.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../checks/dry-check.js")>();
	return {
		...actual,
		checkCodeCloneFindings: vi.fn(actual.checkCodeCloneFindings),
		formatCodeCloneFinding: vi.fn(actual.formatCodeCloneFinding),
	};
});
vi.mock("../checks/dry-baseline.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../checks/dry-baseline.js")>();
	return { ...actual, filterToRisers: vi.fn(actual.filterToRisers) };
});
import { buildAgentSafetyChecks } from "../check-registry/index.js";
import { computeCrapRisers } from "../checks/crap-baseline.js";
import { filterToRisers as filterDryToRisers } from "../checks/dry-baseline.js";
import { checkCodeCloneFindings } from "../checks/dry-check.js";
import { type InlineBlockContext, runInlineCheckBlock } from "./inline-block.js";

const baseEvent: HarnessEvent = {
	hook_event: "PostToolUse",
	session_id: "sess-1",
	agent_source: "claude",
	tool_name: "Edit",
	timestamp: "2026-06-01T00:00:00Z",
};

function ctx(over: Partial<InlineBlockContext> = {}): InlineBlockContext {
	return {
		event: baseEvent,
		filePath: "src/example.ts",
		absFilePath: "/repo/src/example.ts",
		fileContent: "const ok = 1;\n",
		cwd: "/repo",
		diffAware: undefined,
		baseline: undefined,
		filePriority: undefined,
		...over,
	};
}

function baseline(over: Partial<PreEditBaseline> = {}): PreEditBaseline {
	return {
		missingReturnTypes: new Set(),
		complexFunctions: new Set(),
		capturedAt: 0,
		suppressionCount: 0,
		asAnyCastCount: 0,
		nonNullAssertionCount: 0,
		...over,
	};
}

const sixParamFn =
	"export function wide(a: number, b: number, c: number, d: number, e: number, f: number): number {\n" +
	"  return a + b + c + d + e + f;\n}\n";

const fetchFn =
	"export async function load(u: string): Promise<unknown> {\n" +
	"  const a = await fetch(u);\n" +
	"  return a;\n}\n";

afterEach(() => {
	// Clear unused one-shot implementations from checks intentionally skipped above.
	vi.resetAllMocks();
});

// ===========================================================================
// runInlineCheckBlock — binary-content message wording
// ===========================================================================

describe("runInlineCheckBlock — binary content message", () => {
	// test-contract: invariant — kills 2cf76870e37b6de8 (StringLiteral clause removed
	// from the binary-content message)
	it("kills: states the text-tool prohibition verbatim", () => {
		const out = runInlineCheckBlock(ctx({ fileContent: "valid text\x00with null byte" }));
		const f = out.find((r) => r.name === "binary_content");
		expect(f?.message).toContain(
			"Text editing tools should not write binary files; a deliberate NUL sentinel/separator belongs in",
		);
	});
});

// ===========================================================================
// checkTestFileBlock (section 5)
// ===========================================================================

describe("checkTestFileBlock — isNewFile guard clauses", () => {
	// test-contract: invariant — kills 6d266c043f827802 (`enabled !== false` -> true):
	// with enabled explicitly false, isNewFile must be false so the check RUNS.
	it("kills: diffAware.enabled=false still runs the test-file check on an Edit", () => {
		const out = runInlineCheckBlock(
			ctx({
				filePath: "src/widget.ts",
				absFilePath: "/repo/__nope__/src/widget.ts",
				fileContent: "export function build(): number {\n  return 2;\n}\n",
				event: { ...baseEvent, tool_name: "Edit" },
				diffAware: { enabled: false },
			}),
		);
		expect(out.some((r) => r.name === "no_test_file")).toBe(true);
	});

	// test-contract: invariant — kills 6cc2aabb3da7c1b6 (`tool_name != null` -> true):
	// a null-ish tool_name must short-circuit isNewFile to false (check RUNS).
	it("kills: an absent tool_name still runs the test-file check", () => {
		const out = runInlineCheckBlock(
			ctx({
				filePath: "src/widget2.ts",
				absFilePath: "/repo/__nope__/src/widget2.ts",
				fileContent: "export function build(): number {\n  return 2;\n}\n",
				event: { ...baseEvent, tool_name: undefined },
			}),
		);
		expect(out.some((r) => r.name === "no_test_file")).toBe(true);
	});

	// test-contract: invariant — kills 073f4166b3e966bc (StringLiteral "WriteFile" -> "")
	it("kills: tool_name 'WriteFile' is recognized as a write (check runs)", () => {
		const out = runInlineCheckBlock(
			ctx({
				filePath: "src/widget3.ts",
				absFilePath: "/repo/__nope__/src/widget3.ts",
				fileContent: "export function build(): number {\n  return 2;\n}\n",
				event: { ...baseEvent, tool_name: "WriteFile" },
			}),
		);
		expect(out.some((r) => r.name === "no_test_file")).toBe(true);
	});

	// test-contract: invariant — kills e898f82b5ceeb7f9 (StringLiteral "write_file" -> "")
	it("kills: tool_name 'write_file' is recognized as a write (check runs)", () => {
		const out = runInlineCheckBlock(
			ctx({
				filePath: "src/widget4.ts",
				absFilePath: "/repo/__nope__/src/widget4.ts",
				fileContent: "export function build(): number {\n  return 2;\n}\n",
				event: { ...baseEvent, tool_name: "write_file" },
			}),
		);
		expect(out.some((r) => r.name === "no_test_file")).toBe(true);
	});

	// Pointing at a REAL file with a real companion test must return no finding
	// and must NOT throw (mutant removes the early return, then dereferences
	// noTestFile[0] which is undefined, throwing and silently swallowing every
	// later check in this file's try/catch).
	// test-contract: invariant — kills 97f772cf14b21878 (`noTestFile.length === 0` -> false)
	it("kills: a file with a real companion test produces no finding and does not swallow later checks", () => {
		const realAbsPath = fileURLToPath(new URL("./inline-block.ts", import.meta.url));
		const out = runInlineCheckBlock(
			ctx({
				filePath: "src/harness/quality-checks/inline-block.ts",
				absFilePath: realAbsPath,
				fileContent: fetchFn,
				event: { ...baseEvent, tool_name: "Write" },
			}),
		);
		expect(out.some((r) => r.name === "no_test_file")).toBe(false);
		expect(out.some((r) => r.name === "node_fetch_no_timeout")).toBe(true);
	});
});

// ===========================================================================
// checkComplexityBlock + filterComplexFnsToEdit (section 6)
// ===========================================================================

describe("checkComplexityBlock — outer diff-aware guard", () => {
	// test-contract: invariant — kills 315f7cb50959d22e (whole guard -> true),
	// 8ab5eabd42560bef (`enabled !== false` -> true), and 559f82eb4d49bee1
	// (&& -> ||): with diffAware.enabled explicitly false, filtering must be
	// skipped entirely, so a baseline-matching complex fn is still reported.
	it("kills: enabled=false skips complexity filtering even with a matching baseline entry", () => {
		const out = runInlineCheckBlock(
			ctx({
				fileContent: sixParamFn,
				diffAware: { enabled: false },
				baseline: baseline({
					complexFunctions: new Set([
						"[6 parameters] export function wide(a: number, b: number, c: number, d: number, e: number, f: number): number {",
					]),
				}),
			}),
		);
		expect(out.some((r) => r.name === "complexity")).toBe(true);
	});

	// test-contract: invariant — kills 6bba2a7b207a3f21 (`complexity !== "off"` ->
	// true) and 3fb07c5980828db6 (StringLiteral "off" -> ""): with
	// complexity:"off" (enabled otherwise true), filtering must be skipped
	// even with a matching baseline entry.
	it("kills: complexity:'off' skips filtering even with a matching baseline entry", () => {
		const out = runInlineCheckBlock(
			ctx({
				fileContent: sixParamFn,
				diffAware: { enabled: true, complexity: "off" },
				baseline: baseline({
					complexFunctions: new Set([
						"[6 parameters] export function wide(a: number, b: number, c: number, d: number, e: number, f: number): number {",
					]),
				}),
			}),
		);
		expect(out.some((r) => r.name === "complexity")).toBe(true);
	});

	// test-contract: invariant — kills 9c9735129c694f1a (render arrow -> () =>
	// undefined) and e5d661c7a54eaaf3 (render template -> ``): pins the exact
	// "L{line}: {text}" detail line for a complexity finding.
	it("kills: complexity detail lines render as 'L{line}: {text}'", () => {
		const out = runInlineCheckBlock(
			ctx({ fileContent: sixParamFn, diffAware: { enabled: true, complexity: "off" } }),
		);
		const f = out.find((r) => r.name === "complexity");
		expect(f?.detail).toContain("L1: [6 parameters] export function wide");
	});
});

describe("filterComplexFnsToEdit — strategy 1 (edit-region) internals", () => {
	// test-contract: invariant — kills 9127a06cb67a6228 (StringLiteral "" ->
	// "Stryker was here!"): the new_string fallback default must be the empty
	// string, so an empty new_string (deletion edit) still falls back to a
	// successful old_string lookup.
	it("kills: empty new_string falls back to '' (not a sentinel), keeping the old_string lookup live", () => {
		const out = runInlineCheckBlock(
			ctx({
				fileContent: sixParamFn,
				diffAware: { enabled: true },
				event: {
					...baseEvent,
					tool_name: "Edit",
					tool_input: {
						old_string:
							"export function wide(a: number, b: number, c: number, d: number, e: number, f: number): number {",
						new_string: "",
					},
				},
				baseline: baseline({
					complexFunctions: new Set([
						"[6 parameters] export function wide(a: number, b: number, c: number, d: number, e: number, f: number): number {",
					]),
				}),
			}),
		);
		// Real: strategy-1 lookup succeeds on old_string (newStr==="" is falsy),
		// `filtered=true`, so baseline subtraction (which WOULD remove this fn)
		// never runs. Mutant sentinel breaks the old_string fallback lookup,
		// falls through to baseline subtraction, and removes the finding.
		expect(out.some((r) => r.name === "complexity")).toBe(true);
	});

	// test-contract: invariant — kills 4bcbcb438e68f774 / 138a9115bedc79b6 (one of
	// the three "\n" -> "" split-delimiter sites): editStartLine must be a LINE
	// count, not a CHARACTER count. A long single line before the edit point
	// pushes a char-based count far outside the true line-based window.
	it("kills: edit-region start is computed by line count, not character count", () => {
		const preamble = `${"x".repeat(300)}\n`;
		const content = `${preamble}const MARKER = 1;\n${sixParamFn}`;
		const out = runInlineCheckBlock(
			ctx({
				fileContent: content,
				diffAware: { enabled: true },
				event: {
					...baseEvent,
					tool_name: "Edit",
					tool_input: { old_string: "const MARKER = 1;", new_string: "const MARKER = 1;" },
				},
			}),
		);
		// Real editStartLine=2 (line count) -> window [-3,53] includes fn@line3.
		// Mutant editStartLine=301 (char count) -> window [296,352] excludes it.
		expect(out.some((r) => r.name === "complexity")).toBe(true);
	});

	// test-contract: invariant — kills the old_string-side "\n" -> "" split-delimiter
	// mutant: oldLines must be a line count, not a character count.
	it("kills: old_string line-count (not char-count) sizes the edit-region width", () => {
		const filler = "const filler = 0;\n";
		const content = `line0\nAAAA\nBBBB\nCCCC\n${filler.repeat(55)}${sixParamFn}`;
		const out = runInlineCheckBlock(
			ctx({
				fileContent: content,
				diffAware: { enabled: true },
				event: {
					...baseEvent,
					tool_name: "Edit",
					tool_input: { old_string: "AAAA\nBBBB\nCCCC", new_string: "" },
				},
			}),
		);
		// Real: oldLines=3 -> editEndLine=5 -> window upper=55 -> fn@line60 excluded.
		// Mutant: oldLines=14 (char count) -> editEndLine=16 -> window upper=66 -> included.
		expect(out.some((r) => r.name === "complexity")).toBe(false);
	});

	// test-contract: invariant — kills the new_string-side "\n" -> "" split-delimiter
	// mutant: newLines must be a line count, not a character count.
	it("kills: new_string line-count (not char-count) sizes the edit-region width", () => {
		const filler = "const filler = 0;\n";
		const content = `line0\nAAAA\nBBBB\nCCCC\n${filler.repeat(55)}${sixParamFn}`;
		const out = runInlineCheckBlock(
			ctx({
				fileContent: content,
				diffAware: { enabled: true },
				event: {
					...baseEvent,
					tool_name: "Edit",
					tool_input: { old_string: "X", new_string: "AAAA\nBBBB\nCCCC" },
				},
			}),
		);
		// Real: newLines=3 -> editEndLine=5 -> window upper=55 -> fn@line60 excluded.
		// Mutant: newLines=14 (char count) -> editEndLine=16 -> window upper=66 -> included.
		expect(out.some((r) => r.name === "complexity")).toBe(false);
	});

	// test-contract: invariant — kills 8c17a9e524c2681b (Math.max -> Math.min): the
	// edit-region width must use the WIDER of old/new line counts.
	it("kills: edit-region width uses the wider (max) of old/new line counts", () => {
		const filler = "const filler = 0;\n";
		const content = `line0\nA\nB\nC\nD\nE\n${filler.repeat(48)}${sixParamFn}`;
		const out = runInlineCheckBlock(
			ctx({
				fileContent: content,
				diffAware: { enabled: true },
				event: {
					...baseEvent,
					tool_name: "Edit",
					tool_input: { old_string: "X", new_string: "A\nB\nC\nD\nE" },
				},
			}),
		);
		// Real: max(1,5)=5 -> editEndLine=7 -> window upper=57 -> fn@line55 included.
		// Mutant: min(1,5)=1 -> editEndLine=3 -> window upper=53 -> fn@line55 excluded.
		expect(out.some((r) => r.name === "complexity")).toBe(true);
	});

	// test-contract: invariant — kills 08637e8fb3aa1bc2 (start + width -> start -
	// width): editEndLine must be AFTER editStartLine, not before it.
	it("kills: edit-region end is start-plus-width, not start-minus-width", () => {
		const filler = "const filler = 0;\n";
		const content = `line0\nA\nB\nC\nD\nE\n${filler.repeat(43)}${sixParamFn}`;
		const out = runInlineCheckBlock(
			ctx({
				fileContent: content,
				diffAware: { enabled: true },
				event: {
					...baseEvent,
					tool_name: "Edit",
					tool_input: { old_string: "X", new_string: "A\nB\nC\nD\nE" },
				},
			}),
		);
		// Real: editEndLine=2+5=7 -> window upper=57 -> fn@line50 included.
		// Mutant: editEndLine=2-5=-3 -> window upper=47 -> fn@line50 excluded.
		expect(out.some((r) => r.name === "complexity")).toBe(true);
	});

	// test-contract: invariant — kills 70eb68e84f81f493 (filtered=true -> false):
	// after a successful edit-region match, the baseline subtraction must NOT
	// re-apply on top of it.
	it("kills: a successful edit-region match must not also re-apply the baseline subtraction", () => {
		const out = runInlineCheckBlock(
			ctx({
				fileContent: sixParamFn,
				diffAware: { enabled: true },
				event: {
					...baseEvent,
					tool_name: "Edit",
					tool_input: {
						old_string: "// placeholder",
						new_string:
							"export function wide(a: number, b: number, c: number, d: number, e: number, f: number): number {",
					},
				},
				baseline: baseline({
					complexFunctions: new Set([
						"[6 parameters] export function wide(a: number, b: number, c: number, d: number, e: number, f: number): number {",
					]),
				}),
			}),
		);
		expect(out.some((r) => r.name === "complexity")).toBe(true);
	});

	// test-contract: invariant — kills 0a649593a1724baa (`>=` -> `>` on the lower
	// bound): the lower bound is INCLUSIVE of editStartLine - 5.
	it("kills: edit-region lower bound is inclusive (editStartLine - 5)", () => {
		const filler = "const filler = 0;\n";
		const content = `${filler.repeat(4)}${sixParamFn}${filler.repeat(2)}const MARKER = 1;\n`;
		const out = runInlineCheckBlock(
			ctx({
				fileContent: content,
				diffAware: { enabled: true },
				event: {
					...baseEvent,
					tool_name: "Edit",
					tool_input: { old_string: "const MARKER = 1;", new_string: "const MARKER = 1;" },
				},
			}),
		);
		// editStartLine=10, boundary=5, fn@line5: real (>=) includes it exactly at
		// the boundary; mutant (>) excludes it.
		expect(out.some((r) => r.name === "complexity")).toBe(true);
	});

	// test-contract: invariant — kills 65db8aa66814a329 (`<=` -> `<` on the upper
	// bound): the upper bound is INCLUSIVE of editEndLine + 50.
	it("kills: edit-region upper bound is inclusive (editEndLine + 50)", () => {
		const filler = "const filler = 0;\n";
		const content = `line0\nconst MARKER = 1;\n${filler.repeat(50)}${sixParamFn}`;
		const out = runInlineCheckBlock(
			ctx({
				fileContent: content,
				diffAware: { enabled: true },
				event: {
					...baseEvent,
					tool_name: "Edit",
					tool_input: { old_string: "const MARKER = 1;", new_string: "const MARKER = 1;" },
				},
			}),
		);
		// editStartLine=2, editEndLine=3, boundary=53, fn@line53: real (<=)
		// includes it exactly at the boundary; mutant (<) excludes it.
		expect(out.some((r) => r.name === "complexity")).toBe(true);
	});

	// test-contract: invariant — kills b3b547f242968341 (strategy-2 filter arrow ->
	// () => undefined): the baseline-subtraction filter must KEEP a function
	// whose text is absent from the baseline, not drop everything.
	it("kills: strategy-2 baseline filter keeps a function that is not in the baseline", () => {
		const out = runInlineCheckBlock(
			ctx({
				fileContent: sixParamFn,
				diffAware: { enabled: true },
				event: { ...baseEvent, tool_name: "Edit" }, // no old_string -> strategy 2
				baseline: baseline({ complexFunctions: new Set(["[6 parameters] some other signature"]) }),
			}),
		);
		expect(out.some((r) => r.name === "complexity")).toBe(true);
	});
});

// ===========================================================================
// checkCrapRisersBlock (section 6b)
// ===========================================================================

describe("checkCrapRisersBlock — skip-guard internals", () => {
	// test-contract: invariant — kills ea2c50b0caf5b90e (`enabled === false` ->
	// false) and 99fdcf191035b770 (ArrayDeclaration [] -> ["Stryker was
	// here"]): diffAware disabled must skip the CRAP computation entirely and
	// return a genuinely empty contribution.
	it("kills: diffAware.enabled=false skips CRAP risers even with a crapScores baseline", () => {
		vi.mocked(computeCrapRisers).mockReturnValueOnce([]);
		const out = runInlineCheckBlock(
			ctx({
				diffAware: { enabled: false },
				baseline: baseline({ crapScores: new Map([["src/example.ts", new Map()]]) }),
			}),
		);
		expect(out.some((r) => r.name === "crap")).toBe(false);
		expect(vi.mocked(computeCrapRisers)).not.toHaveBeenCalled();
	});

	// test-contract: invariant — kills 5245c980d37d6d67 (OptionalChaining removed
	// from ctx.diffAware?.enabled): with diffAware entirely absent, accessing
	// `.enabled` must not throw (which would silently drop every later check).
	it("kills: an absent diffAware object does not throw, and later checks still run", () => {
		vi.mocked(computeCrapRisers).mockReturnValueOnce([
			{
				file: "src/example.ts",
				function: "doWork",
				line: 3,
				complexity: 12,
				coverage_pct: 10,
				crap_score: 88,
				stale: false,
			},
		]);
		const out = runInlineCheckBlock(
			ctx({
				fileContent: fetchFn,
				baseline: baseline({ crapScores: new Map([["src/example.ts", new Map()]]) }),
				// diffAware left undefined
			}),
		);
		expect(out.some((r) => r.name === "crap")).toBe(true);
		expect(out.some((r) => r.name === "node_fetch_no_timeout")).toBe(true);
	});

	// test-contract: invariant — kills e674b566f87dd74a (ObjectLiteral argument ->
	// {}): computeCrapRisers must receive the real content/absFilePath/cwd/baseline.
	it("kills: computeCrapRisers is called with the real argument object", () => {
		vi.mocked(computeCrapRisers).mockReturnValueOnce([]);
		const crapScores = new Map([["src/example.ts", new Map()]]);
		const out = runInlineCheckBlock(
			ctx({
				fileContent: "const ok = 1;\n",
				absFilePath: "/repo/src/example.ts",
				cwd: "/repo",
				diffAware: { enabled: true },
				baseline: baseline({ crapScores }),
			}),
		);
		expect(vi.mocked(computeCrapRisers)).toHaveBeenCalledWith({
			content: "const ok = 1;\n",
			absFilePath: "/repo/src/example.ts",
			cwd: "/repo",
			baseline: crapScores,
		});
		// Real observable state: the mocked empty-risers return produces no
		// crap finding in the emitted results.
		expect(out.some((r) => r.name === "crap")).toBe(false);
	});
});

// ===========================================================================
// checkAgentSafetyBlock (section 8)
// ===========================================================================

describe("checkAgentSafetyBlock — phase argument + code_clones routing guard", () => {
	// test-contract: invariant — kills 08cc89d64d7072bf (StringLiteral "post" -> "")
	it("kills: buildAgentSafetyChecks is called with phase 'post', and its finding surfaces", () => {
		vi.mocked(buildAgentSafetyChecks).mockReturnValueOnce([
			{ name: "boolean_trap", severity: "warning", fn: () => [{ line: 1, text: "x" }] },
		]);
		const out = runInlineCheckBlock(ctx());
		expect(vi.mocked(buildAgentSafetyChecks).mock.calls[0]?.[2]).toBe("post");
		expect(out.some((r) => r.name === "boolean_trap")).toBe(true);
	});

	// test-contract: invariant — kills 4ed3f1c4998fe97b (&& -> ||), fd7a3099bf718bc5
	// (2-term guard -> true), and c91ba3770ac31efa (name check -> true): a
	// non-code_clones check must NEVER take the DRY-baseline routing path, even
	// when diffAware is enabled and a dryCloneBaseline is present.
	it("kills: only the code_clones check may route through the DRY-baseline path", () => {
		vi.mocked(buildAgentSafetyChecks).mockReturnValueOnce([
			{ name: "boolean_trap", severity: "warning", fn: () => [{ line: 1, text: "boolean trap match" }] },
		]);
		const out = runInlineCheckBlock(
			ctx({
				diffAware: { enabled: true },
				baseline: baseline({ dryCloneBaseline: new Map([["/repo/src/example.ts", new Map()]]) }),
			}),
		);
		const f = out.find((r) => r.name === "boolean_trap");
		expect(f?.detail).toContain("L1: boolean trap match");
		expect(vi.mocked(filterDryToRisers)).not.toHaveBeenCalled();
	});

	// test-contract: invariant — kills 474be35633ffd82b (`enabled !== false` ->
	// true): even a code_clones check must fall back to fn() when diffAware is
	// explicitly disabled, not take the DRY-baseline path.
	it("kills: code_clones still uses fn() when diffAware.enabled is explicitly false", () => {
		vi.mocked(checkCodeCloneFindings).mockReturnValueOnce([]);
		vi.mocked(buildAgentSafetyChecks).mockReturnValueOnce([
			{ name: "code_clones", severity: "warning", fn: () => [{ line: 5, text: "direct clone match" }] },
		]);
		const out = runInlineCheckBlock(
			ctx({
				diffAware: { enabled: false },
				baseline: baseline({ dryCloneBaseline: new Map([["/repo/src/example.ts", new Map()]]) }),
			}),
		);
		const f = out.find((r) => r.name === "code_clones");
		expect(f?.detail).toContain("L5: direct clone match");
		expect(vi.mocked(filterDryToRisers)).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// checkFootgunBlock (section 8b)
// ===========================================================================

describe("checkFootgunBlock — grouping, join, and overflow internals", () => {


	// test-contract: invariant — kills b76ef35e6b722ce9 (bucket.slice(...) -> bucket,
	// i.e. no cap applied): exactly MAX_LISTED_FINDINGS (5) lines must be
	// rendered, even when 6 findings exist.
	it("kills: the shown-findings list is capped at 5, not the full bucket", () => {
		const calls = Array.from({ length: 6 }, (_, i) => `  const r${i} = await fetch(u + '/${i}');`).join("\n");
		const content = `export async function loadMany(u: string): Promise<void> {\n${calls}\n}\n`;
		const out = runInlineCheckBlock(ctx({ fileContent: content }));
		const f = out.find((r) => r.name === "node_fetch_no_timeout");
		const shownLines = (f?.detail ?? "").split("\n").filter((l) => l.startsWith("  L"));
		expect(shownLines).toHaveLength(5);
	});

	// test-contract: invariant — kills 2e1bde8a1e2e8d97 (StringLiteral "\n" -> ""
	// join separator): each finding line must be joined by a real newline, not
	// concatenated onto the previous line.
	it("kills: finding lines are joined by a real newline", () => {
		const content =
			"export async function load(u: string): Promise<unknown> {\n" +
			"  const a = await fetch(u);\n" +
			"  const b = await fetch(u + '/2');\n" +
			"  return [a, b];\n}\n";
		const out = runInlineCheckBlock(ctx({ fileContent: content }));
		const f = out.find((r) => r.name === "node_fetch_no_timeout");
		const shownLines = (f?.detail ?? "").split("\n").filter((l) => l.startsWith("  L"));
		expect(shownLines).toHaveLength(2);
	});

	// test-contract: invariant — kills 6b7df86e8821e539 (`> MAX_LISTED_FINDINGS` ->
	// true) and 173685e75fae64ea (StringLiteral "" -> "Stryker was here!"): a
	// small bucket (below the cap) must render NO overflow line at all.
	it("kills: a bucket at or below the cap renders no overflow line", () => {
		const content =
			"export async function load(u: string): Promise<unknown> {\n" +
			"  const a = await fetch(u);\n" +
			"  const b = await fetch(u + '/2');\n" +
			"  return [a, b];\n}\n";
		const out = runInlineCheckBlock(ctx({ fileContent: content }));
		const f = out.find((r) => r.name === "node_fetch_no_timeout");
		expect(f?.detail).not.toContain("more");
	});

	// test-contract: invariant — kills cf50ddeab7bd2345 (`>` -> `>=` at the cap
	// boundary): exactly MAX_LISTED_FINDINGS (5) findings must NOT trigger the
	// overflow line (only STRICTLY more than 5 does).
	it("kills: exactly 5 findings does not trigger the overflow line", () => {
		const calls = Array.from({ length: 5 }, (_, i) => `  const r${i} = await fetch(u + '/${i}');`).join("\n");
		const content = `export async function loadFive(u: string): Promise<void> {\n${calls}\n}\n`;
		const out = runInlineCheckBlock(ctx({ fileContent: content }));
		const f = out.find((r) => r.name === "node_fetch_no_timeout");
		expect(f?.message).toContain("5 ");
		expect(f?.detail).not.toContain("more");
	});

	// test-contract: invariant — kills a61a402041b2ec29 (render arrow -> () =>
	// undefined) and 44d9303226e0b9fe (render template -> ``): pins the exact
	// "L{line}: {text}" content of a footgun finding line.
	it("kills: footgun detail lines render as 'L{line}: {text}'", () => {
		const content =
			"export async function load(u: string): Promise<unknown> {\n" +
			"  const a = await fetch(u);\n" +
			"  return a;\n}\n";
		const out = runInlineCheckBlock(ctx({ fileContent: content }));
		const f = out.find((r) => r.name === "node_fetch_no_timeout");
		expect(f?.detail).toContain("L2: const a = await fetch(u);");
	});
});
