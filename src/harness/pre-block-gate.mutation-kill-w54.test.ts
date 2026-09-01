import { existsSync as realExistsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fileSuppressionsFor,
	lineList,
	preBlockIntroducedBlock,
	preexistingPreBlockWarnings,
	runPreBlockRegistryGate,
	splitIntroduced,
	suppressionHint,
	type PreBlockCheckOutcome,
} from "./pre-block-gate.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pbg-w54-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveDiskBaseline — kills 7d7b68f0d6605342 (ConditionalExpression -> true)
// and f86a09d969701e05 (LogicalOperator && -> ||)
// ---------------------------------------------------------------------------
describe("resolveDiskBaseline", () => {
	it("returns null when existsSync reports false for a truthy filePath, even though the file is actually readable", async () => {
		const filePath = join(tmpDir, "real-file.txt");
		writeFileSync(filePath, "hello world", "utf-8");
		// Sanity: the file genuinely exists on disk.
		expect(realExistsSync(filePath)).toBe(true);

		vi.resetModules();
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return { ...actual, existsSync: () => false };
		});
		const mod = await import("./pre-block-gate.js");
		const result = mod.resolveDiskBaseline(filePath);
		expect(result).toBeNull();

		vi.doUnmock("node:fs");
		vi.resetModules();
	});
});

// ---------------------------------------------------------------------------
// splitIntroduced / matchKey normalization
// kills 7a61b0553a35a084 (drop .trim()), 8d1e78585cd21c53 (regex \s+ -> \s),
// ef40beab4dc2fae4 (regex \s+ -> \S+), 8ce57adfb42f93cd (" " -> ""),
// 4715c1daa934f74d (matchKey body -> {})
// ---------------------------------------------------------------------------
describe("splitIntroduced / matchKey normalization", () => {
	it("matches baseline/new lines that differ only by surrounding/collapsed whitespace (kills missing-trim mutant)", () => {
		const baseline = [{ line: 1, text: "  foo   bar  " }];
		const fresh = [{ line: 2, text: "foo bar" }];
		const { introduced, preexisting } = splitIntroduced(fresh, baseline);
		expect(preexisting).toHaveLength(1);
		expect(introduced).toHaveLength(0);
	});

	it("treats a run of two spaces as equal to one space after normalization (kills \\s+ -> \\s mutant)", () => {
		const baseline = [{ line: 1, text: "foo  bar" }];
		const fresh = [{ line: 2, text: "foo bar" }];
		const { introduced, preexisting } = splitIntroduced(fresh, baseline);
		expect(preexisting).toHaveLength(1);
		expect(introduced).toHaveLength(0);
	});

	it("does not conflate genuinely different word content (kills \\s+->\\S+, \" \"->\"\", and body->{} mutants)", () => {
		const baseline = [{ line: 1, text: "foo bar" }];
		const fresh = [{ line: 2, text: "baz qux" }];
		const { introduced, preexisting } = splitIntroduced(fresh, baseline);
		expect(introduced).toHaveLength(1);
		expect(preexisting).toHaveLength(0);
	});

	it("does not collapse space-separated words into one token (kills \" \" -> \"\" mutant)", () => {
		const baseline = [{ line: 1, text: "foo bar" }];
		const fresh = [{ line: 2, text: "foobar" }];
		const { introduced, preexisting } = splitIntroduced(fresh, baseline);
		expect(introduced).toHaveLength(1);
		expect(preexisting).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// fileSuppressionsFor — kills 823342d65df024bf ("/" -> "")
// ---------------------------------------------------------------------------
describe("fileSuppressionsFor", () => {
	it("normalizes backslashes to forward slashes before matching a suppression key", () => {
		mkdirSync(join(tmpDir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".interlinked", "verify-suppressions.json"),
			JSON.stringify({
				"sub/dir/file.ts": { "my-check": { reason: "r", by: "b", at: "2026-01-01" } },
			}),
			"utf-8",
		);
		// Backslash is a valid POSIX filename character; relative()+replace(/\\/g,"/")
		// is expected to turn it into "sub/dir/file.ts".
		const filePath = "sub\\dir/file.ts";
		const suppressions = fileSuppressionsFor(filePath, tmpDir);
		expect(suppressions.has("my-check")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// runPreBlockRegistryGate integration — real registry, real eval_usage check
// kills bfd31b094e30d4e4 (?? -> &&), f6efaaa48ba7da86 ("pre_block" -> "")
// ---------------------------------------------------------------------------
describe("runPreBlockRegistryGate", () => {
	it("carries the check's real fix_instruction text (kills ??-> && mutant)", () => {
		const outcomes = runPreBlockRegistryGate({
			content: "const x = eval('1+1');",
			filePath: "test.ts",
			baselineContent: null,
		});
		const outcome = outcomes.find((o) => o.checkId === "eval_usage");
		expect(outcome).toBeDefined();
		expect(outcome?.instruction.length).toBeGreaterThan(0);
		expect(outcome?.instruction).toContain("eval()");
	});

	it("classifies a line already present in the baseline as pre-existing, not introduced (kills phase-literal mutant)", () => {
		const line = "const x = eval('1+1');";
		const outcomes = runPreBlockRegistryGate({
			content: `${line}\n`,
			filePath: "test.ts",
			baselineContent: `${line}\n`,
		});
		const outcome = outcomes.find((o) => o.checkId === "eval_usage");
		expect(outcome).toBeDefined();
		expect(outcome?.preexisting.length).toBe(1);
		expect(outcome?.introduced.length).toBe(0);
	});

	it("finds violations at all when using the real pre_block phase filter", () => {
		const outcomes = runPreBlockRegistryGate({
			content: "const x = eval('1+1');",
			filePath: "test.ts",
			baselineContent: null,
		});
		expect(outcomes.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// DEFERRABLE_CHECK_IDS derivation — module-level constant, tested via a
// mocked registry so at least one entry is genuinely deferrable.
// kills 4d968a93a5bab0da / b55283c9202e71b6 / ae198843a6f8edc2 /
// 63ecd7ba3ba9fed0 / 1859d423d07e96a3 / 32055ad71e126b9c / 32cec552e6bb6bd8
// ---------------------------------------------------------------------------
describe("DEFERRABLE_CHECK_IDS derivation (mocked registry)", () => {
	afterEach(() => {
		vi.doUnmock("./check-registry/registry.js");
		vi.resetModules();
	});

	it("marks only the registry entry flagged deferrable:true as deferrable, and leaves the other false", async () => {
		vi.resetModules();
		vi.doMock("./check-registry/registry.js", () => ({
			CHECK_REGISTRY: [
				{
					id: "fake-deferrable",
					phase: "pre_block",
					name: "Fake Deferrable",
					description: "d",
					tier: 1,
					determinism: "fully_deterministic",
					severity: "error",
					pipeline: "agent_safety",
					fix_instruction: "fix it",
					fn: (content: string) =>
						content.includes("TRIGGER_DEFER") ? [{ line: 1, text: "TRIGGER_DEFER" }] : [],
					resultsPropName: "fakeDeferrable",
					deferrable: true,
				},
				{
					id: "fake-normal",
					phase: "pre_block",
					name: "Fake Normal",
					description: "d",
					tier: 1,
					determinism: "fully_deterministic",
					severity: "error",
					pipeline: "agent_safety",
					fix_instruction: "fix it too",
					fn: (content: string) =>
						content.includes("TRIGGER_NORMAL") ? [{ line: 2, text: "TRIGGER_NORMAL" }] : [],
					resultsPropName: "fakeNormal",
				},
			],
		}));

		const mod = await import("./pre-block-gate.js");
		const outcomes = mod.runPreBlockRegistryGate({
			content: "TRIGGER_DEFER\nTRIGGER_NORMAL",
			filePath: "fake.ts",
			baselineContent: null,
		});
		const deferrableOutcome = outcomes.find((o) => o.checkId === "fake-deferrable");
		const normalOutcome = outcomes.find((o) => o.checkId === "fake-normal");
		expect(deferrableOutcome).toBeDefined();
		expect(normalOutcome).toBeDefined();
		expect(deferrableOutcome?.deferrable).toBe(true);
		expect(normalOutcome?.deferrable).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// lineList — kills 1dfec138143a4537 (> 5 -> >= 5)
// ---------------------------------------------------------------------------
describe("lineList", () => {
	it("does not truncate exactly five matches", () => {
		const matches = [1, 2, 3, 4, 5].map((line) => ({ line, text: "x" }));
		expect(lineList(matches)).toBe("L1, L2, L3, L4, L5");
	});

	it("truncates six matches with an ellipsis", () => {
		const matches = [1, 2, 3, 4, 5, 6].map((line) => ({ line, text: "x" }));
		expect(lineList(matches)).toBe("L1, L2, L3, L4, L5, …");
	});
});

// ---------------------------------------------------------------------------
// suppressionHint — kills 264506122c6e5139 (StringLiteral -> "")
// ---------------------------------------------------------------------------
describe("suppressionHint", () => {
	it("includes the full auditable-exception clause", () => {
		const hint = suppressionHint("my-check");
		expect(hint).toContain(
			"on the line above (counted by the suppression ratchet), or add a file entry to",
		);
		expect(hint).toContain(".interlinked/verify-suppressions.json");
	});
});

// ---------------------------------------------------------------------------
// preBlockIntroducedBlock — kills 9de36e0f00482d0a (fallback "" -> text),
// b36d9cc2ae04752b (severity "high" -> ""), 5f07532123a13c6d (category -> "")
// ---------------------------------------------------------------------------
describe("preBlockIntroducedBlock", () => {
	const baseOutcome: PreBlockCheckOutcome = {
		checkId: "eval_usage",
		introduced: [{ line: 3, text: "eval(x)" }],
		preexisting: [],
		instruction: "avoid eval",
		deferrable: false,
	};

	it("omits the pre-existing note text when there are no pre-existing findings", () => {
		const decision = preBlockIntroducedBlock(baseOutcome, "test.ts", []);
		expect(decision.reason).not.toContain("Stryker was here!");
		expect(decision.reason).not.toContain("pre-existing instance");
	});

	it("sets severity to 'high'", () => {
		const decision = preBlockIntroducedBlock(baseOutcome, "test.ts", []);
		expect(decision.severity).toBe("high");
	});

	it("sets category to 'pre-block'", () => {
		const decision = preBlockIntroducedBlock(baseOutcome, "test.ts", []);
		expect(decision.category).toBe("pre-block");
	});

	it("includes the pre-existing note when preexisting findings are present", () => {
		const outcome: PreBlockCheckOutcome = {
			...baseOutcome,
			preexisting: [{ line: 1, text: "eval(y)" }],
		};
		const decision = preBlockIntroducedBlock(outcome, "test.ts", []);
		expect(decision.reason).toContain("1 pre-existing instance(s) at L1");
	});
});

// ---------------------------------------------------------------------------
// preexistingPreBlockWarnings — kills 325373b6571107aa (template -> ``)
// ---------------------------------------------------------------------------
describe("preexistingPreBlockWarnings", () => {
	it("includes the deliberate-line ignore-comment guidance verbatim", () => {
		const outcomes: PreBlockCheckOutcome[] = [
			{
				checkId: "eval_usage",
				introduced: [],
				preexisting: [{ line: 4, text: "eval(z)" }],
				instruction: "avoid eval",
				deferrable: false,
			},
		];
		const warnings = preexistingPreBlockWarnings(outcomes, "test.ts");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(
			"mark deliberate lines with `// interlinked-ignore: eval_usage — <why>`.",
		);
	});
});
