// Behavioral companion test for inline-block.ts.
//
// `runInlineCheckBlock` is a thin sequencer over eight numbered inline checks
// plus a binary/empty short-circuit. The first group below drives the real
// (unmocked) per-check helpers with hand-built fixtures so the genuine
// detection wiring is exercised end-to-end. The second group mocks the four
// leaf modules whose findings depend on disk state (coverage-final.json,
// sibling-file clone scans) so the riser / cold-file / code-clone / error
// branches can be driven deterministically with asserted outputs.
//
// Sibling smoke cases live in ./index.test.ts; this file is the exhaustive
// branch companion.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrapFinding } from "../checks/crap.js";
import type { CloneFinding } from "../checks/dry.js";
import type { FilePriority } from "../file-priority.js";
import type { HarnessEvent, PreEditBaseline } from "../types.js";

// --- Partial mocks: default to the real implementation, override per-test. ---
// Each factory spreads the actual module so the integration group keeps real
// behavior, then wraps ONLY the disk-dependent exports in `vi.fn(realImpl)` so
// they stay spies (callable via vi.mocked(...).mockReturnValueOnce) while still
// delegating to the genuine implementation by default.
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

import { nonNull } from "../../lib/non-null.js";
import { buildAgentSafetyChecks } from "../check-registry/index.js";
import { computeCrapRisers } from "../checks/crap-baseline.js";
import { filterToRisers as filterDryToRisers } from "../checks/dry-baseline.js";
import {
	checkCodeCloneFindings,
	formatCodeCloneFinding,
} from "../checks/dry-check.js";
import { type InlineBlockContext, runInlineCheckBlock } from "./inline-block.js";

// --- Fixture builders -------------------------------------------------------

const baseEvent: HarnessEvent = {
	hook_event: "PostToolUse",
	session_id: "sess-1",
	agent_source: "claude",
	tool_name: "Edit",
	timestamp: "2026-06-01T00:00:00Z",
};

/** Build an InlineBlockContext, defaulting every optional to "absent" so the
 *  exactOptionalPropertyTypes contract is honored (no explicit `undefined`
 *  keys unless the caller wants them). */
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

const crapFinding = (over: Partial<CrapFinding> = {}): CrapFinding => ({
	file: "src/example.ts",
	function: "doWork",
	line: 3,
	complexity: 12,
	coverage_pct: 10,
	crap_score: 88,
	stale: false,
	...over,
});

const cloneFinding = (over: Partial<CloneFinding> = {}): CloneFinding => ({
	name: "alpha",
	line: 1,
	otherName: "beta",
	otherFile: "/repo/src/example.ts",
	otherLine: 40,
	similarity: 0.95,
	...over,
});

afterEach(() => {
	// Clears call history + any *Once queued impls, while leaving each
	// vi.fn(realImpl) wrapper's default delegation intact for the next test.
	vi.clearAllMocks();
});

// ===========================================================================
// Group 1 — real per-check helpers, hand-built fixtures
// ===========================================================================

describe("runInlineCheckBlock — short-circuits", () => {
	it("flags binary content as an error and runs NO other inline check", () => {
		const out = runInlineCheckBlock(
			ctx({ fileContent: "valid text\x00with null byte" }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			name: "binary_content",
			severity: "error",
			file: "src/example.ts",
		});
		expect(nonNull(out[0]).message).toContain("Binary content detected");
		// Position + count make the invisible byte actionable, and the message
		// must say the escape spelling is the fix and name the black-out effect.
		expect(nonNull(out[0]).message).toContain("1 raw NUL byte");
		expect(nonNull(out[0]).message).toContain("line 1:11");
		expect(nonNull(out[0]).message).toContain("U+0000 string escape");
		expect(nonNull(out[0]).message).toContain("suppresses every other inline check");
	});

	it("flags a whitespace-only file as an empty_file warning", () => {
		const out = runInlineCheckBlock(ctx({ fileContent: "   \n\t\n" }));
		const empty = out.find((r) => r.name === "empty_file");
		expect(empty).toMatchObject({ severity: "warning" });
		expect(empty?.message).toContain("File is empty");
	});

	it("produces no binary/empty findings for clean prose (markdown)", () => {
		const out = runInlineCheckBlock(
			ctx({
				filePath: "docs/x.md",
				absFilePath: "/repo/docs/x.md",
				fileContent: "# Title\n\nProse with no code issues.\n",
			}),
		);
		expect(
			out.some((r) => r.name === "binary_content" || r.name === "empty_file"),
		).toBe(false);
	});
});

describe("checkMissingReturnTypesBlock (section 4)", () => {
	// One exported fn lacking a return annotation.
	const oneMissing = "export function foo(a: number) {\n  return a + 1;\n}\n";

	it("returns no missing-return-type finding for a non-TS file", () => {
		const out = runInlineCheckBlock(
			ctx({
				filePath: "src/x.js",
				absFilePath: "/repo/src/x.js",
				fileContent: oneMissing,
			}),
		);
		expect(out.some((r) => r.name === "missing_return_types")).toBe(false);
	});

	it("flags an exported TS function missing its return type", () => {
		const out = runInlineCheckBlock(
			ctx({ fileContent: oneMissing, event: { ...baseEvent, tool_name: "Write" } }),
		);
		const f = out.find((r) => r.name === "missing_return_types");
		expect(f).toMatchObject({ severity: "warning" });
		expect(f?.message).toContain("1 exported function(s) without return type");
		expect(f?.detail).toContain("L1: export function foo");
	});

	it("subtracts the diff-aware baseline so a pre-existing signature is dropped", () => {
		const out = runInlineCheckBlock(
			ctx({
				fileContent: oneMissing,
				event: { ...baseEvent, tool_name: "Write" },
				diffAware: { enabled: true },
				baseline: baseline({
					// The trimmed signature text the detector emits for line 1.
					missingReturnTypes: new Set(["export function foo(a: number) {"]),
				}),
			}),
		);
		expect(out.some((r) => r.name === "missing_return_types")).toBe(false);
	});

	it("appends an overflow line when more than five functions are missing types", () => {
		// Seven exported arrow functions, none annotated.
		const many = Array.from(
			{ length: 7 },
			(_, i) => `export const fn${i} = (a: number) => a + ${i};`,
		).join("\n");
		const out = runInlineCheckBlock(
			ctx({
				fileContent: `${many}\n`,
				event: { ...baseEvent, tool_name: "Write" },
			}),
		);
		const f = out.find((r) => r.name === "missing_return_types");
		expect(f?.message).toContain("7 exported function(s)");
		expect(f?.detail).toContain("... and 2 more");
	});
});

describe("checkTestFileBlock (section 5)", () => {
	// NOTE on the guard's semantics: the `isNewFile` flag in the source is true
	// when the tool is NOT one of Write/WriteFile/write_file, and `if (isNewFile)
	// return []` short-circuits then. Net effect: the check is SKIPPED on Edit
	// and RUNS on Write. These tests pin that observed behavior.
	it("skips the no_test_file check on an Edit (early return)", () => {
		const out = runInlineCheckBlock(
			ctx({
				filePath: "src/widget.ts",
				absFilePath: "/repo/__nope__/src/widget.ts",
				fileContent: "export function build(): number {\n  return 2;\n}\n",
				event: { ...baseEvent, tool_name: "Edit" },
			}),
		);
		expect(out.some((r) => r.name === "no_test_file")).toBe(false);
	});

	it("flags a missing test file on a Write to a runtime module", () => {
		const out = runInlineCheckBlock(
			ctx({
				filePath: "src/fresh.ts",
				absFilePath: "/repo/does-not-exist/src/fresh.ts",
				fileContent: "export function go(): number {\n  return 1;\n}\n",
				event: { ...baseEvent, tool_name: "Write" },
			}),
		);
		const f = out.find((r) => r.name === "no_test_file");
		expect(f).toMatchObject({ severity: "warning" });
		expect(f?.message).toContain("No test file found for src/fresh.ts");
		expect(f?.detail).toContain("no test file found");
	});

	it("short-circuits to no finding for a generated-marker file on a Write", () => {
		// `no_test_file: "off"` keeps isNewFile false for the Write too, so the
		// check runs — but the @generated marker makes checkTestFileExists return
		// nothing (the noTestFile.length === 0 early return is exercised).
		const out = runInlineCheckBlock(
			ctx({
				filePath: "src/gen.ts",
				absFilePath: "/repo/__nope__/src/gen.ts",
				fileContent: "// @generated\nexport function g(): number {\n  return 0;\n}\n",
				event: { ...baseEvent, tool_name: "Write" },
				diffAware: { enabled: true, no_test_file: "off" },
			}),
		);
		expect(out.some((r) => r.name === "no_test_file")).toBe(false);
	});
});

describe("checkComplexityBlock + filterComplexFnsToEdit (section 6)", () => {
	// A function with 6+ parameters trips the complexity detector deterministically.
	const sixParamFn =
		"export function wide(a: number, b: number, c: number, d: number, e: number, f: number): number {\n" +
		"  return a + b + c + d + e + f;\n}\n";

	it("flags a complex function when diff-awareness is fully off", () => {
		const out = runInlineCheckBlock(
			ctx({
				fileContent: sixParamFn,
				diffAware: { enabled: true, complexity: "off" },
			}),
		);
		const f = out.find((r) => r.name === "complexity");
		expect(f).toMatchObject({ severity: "warning" });
		expect(f?.message).toContain("complex function(s)");
	});

	it("keeps a complex fn inside the Edit region (strategy 1, new_string lookup)", () => {
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
			}),
		);
		expect(out.some((r) => r.name === "complexity")).toBe(true);
	});

	it("falls back to lookup via old_string when new_string is empty (deletion edit)", () => {
		// new_string "" -> lookupStr === old_string; the old_string text is present
		// in the post-edit content so the edit region resolves and the fn is kept.
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
			}),
		);
		expect(out.some((r) => r.name === "complexity")).toBe(true);
	});

	it("drops the finding when the Edit region does not contain the complex fn", () => {
		// The edit lands at line 1 (the marker, present in the post-edit content);
		// the 6-param fn is reported at line 81, outside the [start-5, end+50]
		// window -> strategy-1 filter removes it, no baseline -> [].
		const padded = `const MARKER = 1;\n${"const filler = 0;\n".repeat(80)}${sixParamFn}`;
		const out = runInlineCheckBlock(
			ctx({
				fileContent: padded,
				diffAware: { enabled: true },
				event: {
					...baseEvent,
					tool_name: "Edit",
					tool_input: {
						old_string: "const OLD = 0;",
						new_string: "const MARKER = 1;",
					},
				},
			}),
		);
		expect(out.some((r) => r.name === "complexity")).toBe(false);
	});

	it("uses strategy 2 (baseline subtraction) when there is no old_string", () => {
		const out = runInlineCheckBlock(
			ctx({
				fileContent: sixParamFn,
				diffAware: { enabled: true },
				// No old_string -> strategy 1 skipped -> baseline filters the known fn.
				event: { ...baseEvent, tool_name: "Edit" },
				baseline: baseline({
					complexFunctions: new Set([
						"[6 parameters] export function wide(a: number, b: number, c: number, d: number, e: number, f: number): number {",
					]),
				}),
			}),
		);
		expect(out.some((r) => r.name === "complexity")).toBe(false);
	});

	it("skips strategy 1 when new_string is absent from content (idx < 0), then strategy 2", () => {
		// old_string present, new_string a string that does NOT appear in the
		// post-edit content -> indexOf === -1 -> strategy 1 doesn't filter
		// (filtered stays false) -> strategy 2 (baseline) drops the known fn.
		const out = runInlineCheckBlock(
			ctx({
				fileContent: sixParamFn,
				diffAware: { enabled: true },
				event: {
					...baseEvent,
					tool_name: "Edit",
					tool_input: {
						old_string: "const present = 0;",
						new_string: "this text is not present anywhere in the file content",
					},
				},
				baseline: baseline({
					complexFunctions: new Set([
						"[6 parameters] export function wide(a: number, b: number, c: number, d: number, e: number, f: number): number {",
					]),
				}),
			}),
		);
		expect(out.some((r) => r.name === "complexity")).toBe(false);
	});

	it("appends an overflow line when more than five complex functions exist", () => {
		// Six 6-param functions -> six complexity findings -> overflow ("...more").
		const sixFns = Array.from({ length: 6 }, (_, i) =>
			`export function f${i}(a: number, b: number, c: number, d: number, e: number, g: number): number {\n  return a + b + c + d + e + g;\n}`,
		).join("\n");
		const out = runInlineCheckBlock(
			ctx({
				fileContent: `${sixFns}\n`,
				diffAware: { enabled: true, complexity: "off" },
			}),
		);
		const f = out.find((r) => r.name === "complexity");
		expect(f?.message).toContain("6 complex function(s)");
		expect(f?.detail).toContain("... and 1 more");
	});
});

describe("checkCrapRisersBlock (section 6b) — skip branches", () => {
	it("returns no crap finding when the baseline lacks crapScores", () => {
		const out = runInlineCheckBlock(
			ctx({ diffAware: { enabled: true }, baseline: baseline() }),
		);
		expect(out.some((r) => r.name === "crap")).toBe(false);
	});

	it("returns no crap finding when diff-awareness is disabled even with crapScores", () => {
		const out = runInlineCheckBlock(
			ctx({
				diffAware: { enabled: false },
				baseline: baseline({ crapScores: new Map([["src/example.ts", new Map()]]) }),
			}),
		);
		expect(out.some((r) => r.name === "crap")).toBe(false);
	});
});

describe("checkFootgunBlock (section 8b) — real node-fetch detector", () => {
	it("groups footgun findings by id and surfaces the fix instruction", () => {
		// Two bare fetch() calls -> node_fetch_no_timeout fires twice, grouped.
		const content =
			"export async function load(u: string): Promise<unknown> {\n" +
			"  const a = await fetch(u);\n" +
			"  const b = await fetch(u + '/2');\n" +
			"  return [a, b];\n}\n";
		const out = runInlineCheckBlock(ctx({ fileContent: content }));
		const f = out.find((r) => r.name === "node_fetch_no_timeout");
		expect(f).toMatchObject({ severity: "warning" });
		expect(f?.message).toContain("[node-fetch]");
		expect(f?.detail).toContain("→");
		// Two matches -> "2 ... issue(s)".
		expect(f?.message).toContain("2 ");
	});

	it("appends an overflow line when a footgun id fires more than five times", () => {
		// Six bare fetch() calls -> node_fetch_no_timeout fires six times in one
		// bucket -> the bucket.length > 5 overflow branch is exercised.
		const calls = Array.from({ length: 6 }, (_, i) => `  const r${i} = await fetch(u + '/${i}');`).join("\n");
		const content = `export async function loadMany(u: string): Promise<void> {\n${calls}\n}\n`;
		const out = runInlineCheckBlock(ctx({ fileContent: content }));
		const f = out.find((r) => r.name === "node_fetch_no_timeout");
		expect(f?.message).toContain("6 ");
		expect(f?.detail).toContain("... and 1 more");
	});

	it("returns no footgun findings for code that uses no flagged library APIs", () => {
		const out = runInlineCheckBlock(
			ctx({ fileContent: "export function pure(n: number): number {\n  return n * 2;\n}\n" }),
		);
		expect(out.some((r) => r.name.startsWith("node_fetch"))).toBe(false);
	});
});

// ===========================================================================
// Group 2 — mocked leaf modules for disk-dependent branches
// ===========================================================================

describe("checkCrapRisersBlock (section 6b) — riser findings (mocked)", () => {
	it("renders a crap finding with per-function detail when risers exist", () => {
		vi.mocked(computeCrapRisers).mockReturnValueOnce([crapFinding()]);
		const out = runInlineCheckBlock(
			ctx({
				diffAware: { enabled: true },
				baseline: baseline({ crapScores: new Map([["src/example.ts", new Map()]]) }),
			}),
		);
		const f = out.find((r) => r.name === "crap");
		expect(f).toMatchObject({ severity: "warning" });
		expect(f?.message).toContain("function(s) with risen CRAP");
		expect(f?.detail).toContain("doWork: CRAP 88 (cyc 12, cov 10%)");
		expect(f?.detail).toContain("→ restore a test");
	});

	it("appends an overflow line when more than five risers exist", () => {
		const risers = Array.from({ length: 7 }, (_, i) =>
			crapFinding({ function: `fn${i}`, line: i + 1 }),
		);
		vi.mocked(computeCrapRisers).mockReturnValueOnce(risers);
		const out = runInlineCheckBlock(
			ctx({
				diffAware: { enabled: true },
				baseline: baseline({ crapScores: new Map([["src/example.ts", new Map()]]) }),
			}),
		);
		const f = out.find((r) => r.name === "crap");
		expect(f?.message).toContain("7 function(s)");
		expect(f?.detail).toContain("... and 2 more");
	});

	it("emits no crap finding when computeCrapRisers returns an empty list", () => {
		// crapScores present + diff-aware enabled => the block calls
		// computeCrapRisers; an empty result hits the `risers.length === 0` return.
		vi.mocked(computeCrapRisers).mockReturnValueOnce([]);
		const out = runInlineCheckBlock(
			ctx({
				diffAware: { enabled: true },
				baseline: baseline({ crapScores: new Map([["src/example.ts", new Map()]]) }),
			}),
		);
		expect(vi.mocked(computeCrapRisers)).toHaveBeenCalledOnce();
		expect(out.some((r) => r.name === "crap")).toBe(false);
	});
});

describe("checkAgentSafetyBlock (section 8) — mocked registry", () => {
	it("renders a generic agent-safety finding with detail + overflow", () => {
		const matches = Array.from({ length: 7 }, (_, i) => ({
			line: i + 1,
			text: `issue ${i}`,
		}));
		vi.mocked(buildAgentSafetyChecks).mockReturnValueOnce([
			{ name: "boolean_trap", severity: "warning", fn: () => matches },
		]);
		const out = runInlineCheckBlock(ctx());
		const f = out.find((r) => r.name === "boolean_trap");
		expect(f).toMatchObject({ severity: "warning" });
		expect(f?.message).toContain("7 boolean trap issue(s)");
		expect(f?.detail).toContain("L1: issue 0");
		expect(f?.detail).toContain("... and 2 more");
	});

	it("emits nothing for a check whose fn returns no matches", () => {
		vi.mocked(buildAgentSafetyChecks).mockReturnValueOnce([
			{ name: "broad_object_types", severity: "warning", fn: () => [] },
		]);
		const out = runInlineCheckBlock(ctx());
		expect(out.some((r) => r.name === "broad_object_types")).toBe(false);
	});

	it("activates cold-file mode (deterministic-only) for a cold file in the priority map", () => {
		const filePriority = new Map<string, FilePriority>([
			["src/example.ts", { ageDays: 400, tier: "cold" }],
		]);
		vi.mocked(buildAgentSafetyChecks).mockReturnValueOnce([]);
		runInlineCheckBlock(ctx({ filePriority }));
		// 5th positional arg (coldFileMode) must be true for a cold file.
		expect(vi.mocked(buildAgentSafetyChecks).mock.calls[0]?.[4]).toBe(true);
	});

	it("passes coldFileMode=false for a hot file in the priority map", () => {
		const filePriority = new Map<string, FilePriority>([
			["src/example.ts", { ageDays: 1, tier: "hot" }],
		]);
		vi.mocked(buildAgentSafetyChecks).mockReturnValueOnce([]);
		runInlineCheckBlock(ctx({ filePriority }));
		expect(vi.mocked(buildAgentSafetyChecks).mock.calls[0]?.[4]).toBe(false);
	});

	it("routes code_clones through the diff-aware DRY riser filter when baselined", () => {
		vi.mocked(buildAgentSafetyChecks).mockReturnValueOnce([
			// fn() must NOT be the source of matches for code_clones — the block
			// substitutes the filtered DRY findings instead. Make fn() throw to
			// prove the branch never calls it.
			{
				name: "code_clones",
				severity: "warning",
				fn: () => {
					throw new Error("code_clones fn() should not be invoked on the DRY path");
				},
			},
		]);
		const dryBaseline = new Map([["/repo/src/example.ts", new Map()]]);
		vi.mocked(checkCodeCloneFindings).mockReturnValueOnce([cloneFinding()]);
		vi.mocked(filterDryToRisers).mockReturnValueOnce([cloneFinding()]);
		// Real formatter is fine, but pin it so the detail text is asserted exactly.
		vi.mocked(formatCodeCloneFinding).mockReturnValueOnce((f: CloneFinding) => ({
			line: f.line,
			text: `${f.name}() ~ ${f.otherName}()`,
		}));

		const out = runInlineCheckBlock(
			ctx({
				diffAware: { enabled: true },
				baseline: baseline({ dryCloneBaseline: dryBaseline }),
			}),
		);
		const f = out.find((r) => r.name === "code_clones");
		expect(f).toMatchObject({ severity: "warning" });
		expect(f?.message).toContain("1 code clones issue(s)");
		expect(f?.detail).toContain("alpha() ~ beta()");
		expect(vi.mocked(filterDryToRisers)).toHaveBeenCalledOnce();
	});

	it("uses the detector's own fn() for code_clones when no DRY baseline is present", () => {
		vi.mocked(buildAgentSafetyChecks).mockReturnValueOnce([
			{
				name: "code_clones",
				severity: "warning",
				fn: () => [{ line: 9, text: "inline clone match" }],
			},
		]);
		const out = runInlineCheckBlock(ctx({ diffAware: { enabled: true } }));
		const f = out.find((r) => r.name === "code_clones");
		expect(f?.detail).toContain("L9: inline clone match");
		// The DRY riser filter must NOT be consulted without a baseline.
		expect(vi.mocked(filterDryToRisers)).not.toHaveBeenCalled();
	});
});

describe("runInlineCheckBlock — error containment", () => {
	it("swallows a thrown error from an inline check and returns []", () => {
		// Force the agent-safety builder to throw; the top-level try/catch must
		// absorb it and yield no findings (file-unreadable / detector-blowup path).
		vi.mocked(buildAgentSafetyChecks).mockImplementationOnce(() => {
			throw new Error("simulated detector failure");
		});
		const out = runInlineCheckBlock(ctx());
		expect(out).toEqual([]);
	});
});
