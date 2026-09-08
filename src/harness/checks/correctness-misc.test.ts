import { afterEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	detectContradictoryNullnessChain,
	detectImplicitSwitchFallthrough,
	detectNumericSortWithoutComparator,
} from "./correctness-misc.js";

const TS_FILE = "src/lib/data.ts";

// ═══════════════════════════════════════════════════════════════════════════
// numeric_sort_without_comparator
// ═══════════════════════════════════════════════════════════════════════════

describe("detectNumericSortWithoutComparator — positive cases (must fire)", () => {
	it("fires on a numeric array literal sorted with no comparator", () => {
		const content = `
const sorted = [10, 9, 1].sort();
`.trim();
		const findings = detectNumericSortWithoutComparator(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/numeric_sort_without_comparator/);
		expect(nonNull(findings[0]).line).toBe(1);
	});

	it("fires on a negative/float literal array sorted with no comparator", () => {
		const content = `
export function order(): number[] {
  return [-3, 2.5, 10].sort();
}
`.trim();
		const findings = detectNumericSortWithoutComparator(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(2);
	});

	it("fires when an identifier annotated number[] is sorted with no comparator", () => {
		const content = `
const scores: number[] = load();
scores.sort();
`.trim();
		const findings = detectNumericSortWithoutComparator(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/"scores"/);
		expect(nonNull(findings[0]).line).toBe(2);
	});

	it("fires when an identifier annotated Array<number> is sorted with no comparator", () => {
		const content = `
let latencies: Array<number> = [];
function summarize(): void {
  latencies.sort();
}
`.trim();
		const findings = detectNumericSortWithoutComparator(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(3);
	});

	// Regression: a dollar-bearing identifier must not be interpolated raw into
	// the use-site RegExp. An unescaped dollar reads as an end-of-input anchor,
	// so the sort call was silently never matched (a false-negative).
	it("fires on a dollar-containing identifier annotated number[]", () => {
		const content = ["const data$: number[] = load();", "data$.sort();"].join("\n");
		const findings = detectNumericSortWithoutComparator(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toContain('"data$"');
		expect(nonNull(findings[0]).line).toBe(2);
	});
});

describe("detectNumericSortWithoutComparator — negative cases (must NOT fire)", () => {
	it("does not fire when a comparator is provided", () => {
		const content = `
const sorted = [10, 9, 1].sort((a, b) => a - b);
const scores: number[] = load();
scores.sort((a, b) => a - b);
`.trim();
		expect(detectNumericSortWithoutComparator(content, TS_FILE)).toEqual([]);
	});

	it("does not fire on a string array literal (lexicographic is correct)", () => {
		const content = `
const names = ["zoe", "amy", "bob"].sort();
`.trim();
		expect(detectNumericSortWithoutComparator(content, TS_FILE)).toEqual([]);
	});

	it("does not fire on an unannotated identifier (no type inference attempted)", () => {
		const content = `
const items = load();
items.sort();
`.trim();
		expect(detectNumericSortWithoutComparator(content, TS_FILE)).toEqual([]);
	});

	it("does not fire on a same-named PROPERTY of another object", () => {
		const content = `
const scores: number[] = [];
stats.scores.sort();
`.trim();
		expect(detectNumericSortWithoutComparator(content, TS_FILE)).toEqual([]);
	});

	it("does not fire on a string[]-annotated identifier", () => {
		const content = `
const names: string[] = load();
names.sort();
`.trim();
		expect(detectNumericSortWithoutComparator(content, TS_FILE)).toEqual([]);
	});

	it("does not fire inside comments or strings", () => {
		const content = `
// [10, 9, 1].sort() would be wrong
const doc = "call [1, 2].sort() carefully";
`.trim();
		expect(detectNumericSortWithoutComparator(content, TS_FILE)).toEqual([]);
	});

	it("does not fire on non-JS/TS files", () => {
		expect(detectNumericSortWithoutComparator("[10, 9, 1].sort()", "notes.md")).toEqual([]);
	});

	it("returns [] for a JS/TS file that contains no .sort( call at all", () => {
		expect(detectNumericSortWithoutComparator("const xs: number[] = [1, 2];", TS_FILE)).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// implicit_switch_fallthrough
// ═══════════════════════════════════════════════════════════════════════════

describe("detectImplicitSwitchFallthrough — positive cases (must fire)", () => {
	it("fires on a non-empty case with no break before the next case", () => {
		const content = `
function handle(kind: string): void {
  switch (kind) {
    case "a":
      doA();
    case "b":
      doB();
      break;
  }
}
`.trim();
		const findings = detectImplicitSwitchFallthrough(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/implicit_switch_fallthrough/);
		expect(nonNull(findings[0]).line).toBe(3);
	});

	it("fires when a case ends in a plain statement before default", () => {
		const content = `
switch (n) {
  case 1: {
    count++;
  }
  default:
    reset();
}
`.trim();
		const findings = detectImplicitSwitchFallthrough(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(2);
	});

	it("fires when only ONE branch of a trailing if returns", () => {
		const content = `
switch (op) {
  case "get":
    if (cached) return cached;
  case "set":
    write();
    break;
}
`.trim();
		const findings = detectImplicitSwitchFallthrough(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(2);
	});

	it("fires on a non-last default clause that falls into a case", () => {
		const content = `
switch (mode) {
  default:
    warn();
  case "safe":
    run();
    break;
}
`.trim();
		const findings = detectImplicitSwitchFallthrough(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(2);
	});
});

describe("detectImplicitSwitchFallthrough — negative cases (must NOT fire)", () => {
	it("does not fire when every case ends in break/return/throw", () => {
		const content = `
switch (kind) {
  case "a":
    doA();
    break;
  case "b":
    return doB();
  case "c":
    throw new Error("nope");
  default:
    doDefault();
}
`.trim();
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toEqual([]);
	});

	it("does not fire on intentional empty-case grouping", () => {
		const content = `
switch (kind) {
  case "a":
  case "b":
    doAB();
    break;
  default:
    doDefault();
}
`.trim();
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toEqual([]);
	});

	it("does not fire when a fallthrough comment marks intent", () => {
		const content = `
switch (kind) {
  case "a":
    prime();
    // falls through
  case "b":
    doB();
    break;
  case "c":
    prep();
    // fallthrough
  default:
    doDefault();
}
`.trim();
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toEqual([]);
	});

	// 2026-07-06 cross-repo calibration: the ONE foreign FP was a case ending in
	// a nested switch whose every branch (incl. default) returns — control can
	// never reach the next clause, yet the last-statement-kind check flagged it.
	it("does not fire when the case ends in a nested exhaustive-and-terminating switch", () => {
		const content = `
switch (mode) {
  case "string":
    switch (unit) {
      case "ms":
        return msProvider();
      case "s":
        return secondsProvider();
      default:
        return defaultProvider();
    }
  case "number":
    return numberProvider();
}
`.trim();
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toEqual([]);
	});

	it("STILL fires when the nested switch lacks a default (control can fall out of it)", () => {
		const content = `
switch (mode) {
  case "string":
    switch (unit) {
      case "ms":
        return msProvider();
      case "s":
        return secondsProvider();
    }
  case "number":
    return numberProvider();
}
`.trim();
		const findings = detectImplicitSwitchFallthrough(content, TS_FILE);
		expect(findings).toHaveLength(1);
	});

	it("STILL fires when a nested-switch clause does not terminate", () => {
		const content = `
switch (mode) {
  case "string":
    switch (unit) {
      case "ms":
        log(unit);
      default:
        return defaultProvider();
    }
  case "number":
    return numberProvider();
}
`.trim();
		// Two fallthroughs: the nested "ms" clause AND the outer "string" case
		// (the nested switch is not terminating, so the outer case falls through).
		const findings = detectImplicitSwitchFallthrough(content, TS_FILE);
		expect(findings.length).toBeGreaterThanOrEqual(1);
	});

	it("does not fire when the trailing if/else terminates on both paths", () => {
		const content = `
switch (op) {
  case "get":
    if (cached) {
      return cached;
    } else {
      throw new Error("miss");
    }
  case "set":
    write();
    break;
}
`.trim();
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toEqual([]);
	});

	it("does not fire on the last clause (nothing to fall into)", () => {
		const content = `
switch (kind) {
  case "a":
    break;
  default:
    cleanup();
}
`.trim();
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toEqual([]);
	});

	it("does not fire on non-JS/TS files", () => {
		const content = `switch (x) { case 1: a(); case 2: b(); }`;
		expect(detectImplicitSwitchFallthrough(content, "README.md")).toEqual([]);
	});

	it("returns [] for a JS/TS file that contains no 'switch' keyword at all", () => {
		expect(detectImplicitSwitchFallthrough("const x = 1;", TS_FILE)).toEqual([]);
	});
});

describe("detectImplicitSwitchFallthrough — never-returning call ends a non-last case", () => {
	// Fix for a default-gate false-positive: a case whose last statement is a
	// curated never-returning call leaves the switch just like return/throw, so
	// it must NOT be reported as fallthrough. Covers assertNever, process.exit,
	// and the bare exit/fail/panic/unreachable/invariant helpers.
	const NEVER_RETURNING = [
		"assertNever(x);",
		"process.exit(1);",
		"exit(1);",
		"fail('bad kind');",
		"panic('bad kind');",
		"unreachable();",
		"invariant(false);",
	];
	it.each(NEVER_RETURNING)("does not fire when a non-last case ends in %s", (call) => {
		const content = [
			"switch (kind) {",
			'case "a":',
			call,
			'case "b":',
			"doB();",
			"break;",
			"}",
		].join("\n");
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toEqual([]);
	});

	it("STILL fires when a non-last case ends in an ordinary call", () => {
		const content = [
			"switch (kind) {",
			'case "a":',
			"persist(x);",
			'case "b":',
			"doB();",
			"break;",
			"}",
		].join("\n");
		const findings = detectImplicitSwitchFallthrough(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toContain("implicit_switch_fallthrough");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// contradictory_nullness_chain
// ═══════════════════════════════════════════════════════════════════════════

describe("detectContradictoryNullnessChain — positive cases (must fire)", () => {
	it("fires on a?.b!.c", () => {
		const content = `
const name = user?.profile!.name;
`.trim();
		const findings = detectContradictoryNullnessChain(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/contradictory_nullness_chain/);
		expect(nonNull(findings[0]).line).toBe(1);
	});

	it("fires on a bare a?.b! assertion", () => {
		const content = `
function pick(cfg?: Config): string {
  return cfg?.label!;
}
`.trim();
		const findings = detectContradictoryNullnessChain(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(2);
	});

	it("fires on a parenthesized (a?.b)! chain", () => {
		const content = `
const value = (payload?.data)!;
`.trim();
		const findings = detectContradictoryNullnessChain(content, TS_FILE);
		expect(findings.length).toBe(1);
	});

	it("fires on an optional index access a?.[0]!.x", () => {
		const content = `
const first = rows?.[0]!.id;
`.trim();
		const findings = detectContradictoryNullnessChain(content, TS_FILE);
		expect(findings.length).toBe(1);
	});
});

describe("detectContradictoryNullnessChain — negative cases (must NOT fire)", () => {
	it("does not fire on a consistent optional chain a?.b?.c", () => {
		const content = `
const name = user?.profile?.name;
`.trim();
		expect(detectContradictoryNullnessChain(content, TS_FILE)).toEqual([]);
	});

	it("does not fire on a plain non-null assertion a!.b", () => {
		const content = `
const name = user!.profile.name;
`.trim();
		expect(detectContradictoryNullnessChain(content, TS_FILE)).toEqual([]);
	});

	it("does not fire on chain and assertion in separate statements", () => {
		const content = `
const profile = user?.profile;
const name = profile!.name;
`.trim();
		expect(detectContradictoryNullnessChain(content, TS_FILE)).toEqual([]);
	});

	it("does not fire on inequality comparisons after an optional chain", () => {
		const content = `
if (user?.age != null) grant();
if (user?.age !== undefined) grant();
`.trim();
		expect(detectContradictoryNullnessChain(content, TS_FILE)).toEqual([]);
	});

	it("does not fire when the ! asserts a CALL result, not the chain (fn(a?.b)!)", () => {
		const content = `
const out = resolve(user?.id)!;
`.trim();
		expect(detectContradictoryNullnessChain(content, TS_FILE)).toEqual([]);
	});

	it("does not fire in .js files (non-null assertion is TS syntax)", () => {
		expect(detectContradictoryNullnessChain("const x = a?.b!.c;", "src/lib/data.js")).toEqual(
			[],
		);
	});

	it("does not fire inside comments or strings", () => {
		const content = `
// user?.profile!.name would be contradictory
const doc = "never write user?.profile!.name";
`.trim();
		expect(detectContradictoryNullnessChain(content, TS_FILE)).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Additional branch coverage: caps, dedupe, other extensions, statement kinds
// ═══════════════════════════════════════════════════════════════════════════

describe("detectNumericSortWithoutComparator — caps and dedupe", () => {
	it("caps at 10 matches per file even when more than 10 occurrences exist", () => {
		const content = Array.from({ length: 12 }, () => "[1, 2].sort();").join("\n");
		expect(detectNumericSortWithoutComparator(content, TS_FILE)).toHaveLength(10);
	});

	it("dedupes when a literal-array hit and an annotated-identifier hit land on the same line", () => {
		const content = "const xs: number[] = []; xs.sort(); [1, 2, 3].sort();";
		expect(detectNumericSortWithoutComparator(content, TS_FILE)).toHaveLength(1);
	});
});

describe("detectImplicitSwitchFallthrough — other JS/TS extensions", () => {
	const content = [
		"function f(x) {",
		"  switch (x) {",
		'    case "a":',
		"      doA();",
		'    case "b":',
		"      doB();",
		"      break;",
		"  }",
		"}",
	].join("\n");

	it("parses and fires on a .tsx file", () => {
		expect(detectImplicitSwitchFallthrough(content, "src/ui/widget.tsx")).toHaveLength(1);
	});

	it("parses and fires on a .jsx file", () => {
		expect(detectImplicitSwitchFallthrough(content, "src/ui/widget.jsx")).toHaveLength(1);
	});

	it("parses and fires on a plain .js file", () => {
		expect(detectImplicitSwitchFallthrough(content, "src/lib/widget.js")).toHaveLength(1);
	});
});

describe("detectImplicitSwitchFallthrough — statementTerminates fallback and never-returning-call shape", () => {
	it("does not treat a call through a non-identifier, non-property callee as never-returning (element-access call)", () => {
		// `handlers[x]()` — callee is neither ts.isIdentifier nor
		// ts.isPropertyAccessExpression, so isNeverReturningCall's final
		// `return false` fires and the case is correctly flagged.
		const content = [
			"const handlers = [() => {}, () => {}];",
			"switch (x) {",
			'  case "a":',
			"    handlers[x]();",
			'  case "b":',
			"    doB();",
			"    break;",
			"}",
		].join("\n");
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toHaveLength(1);
	});

	it("does not treat a for-loop as terminating (statementTerminates falls to its final return false)", () => {
		const content = [
			"switch (x) {",
			'  case "a":',
			"    for (let i = 0; i < x; i++) { log(i); }",
			'  case "b":',
			"    doB();",
			"    break;",
			"}",
		].join("\n");
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toHaveLength(1);
	});

	it("caps at 10 matches per file even with more fallthrough clauses than that", () => {
		const cases = Array.from({ length: 12 }, (_, i) => `  case ${i}:\n    doThing();`).join("\n");
		const content = ["switch (x) {", cases, "  case 99:\n    return 0;", "}"].join("\n");
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toHaveLength(10);
	});
});

describe("detectImplicitSwitchFallthrough — optional 'typescript' dep unavailable", () => {
	afterEach(() => {
		vi.doUnmock("node:module");
		vi.resetModules();
	});

	it("returns [] when 'typescript' cannot be required (loadTs's catch caches null)", async () => {
		vi.resetModules();
		vi.doMock("node:module", () => ({
			createRequire: () => () => {
				throw new Error("cannot find module 'typescript'");
			},
		}));
		const mod = await import("./correctness-misc.js");
		const content = [
			"switch (x) {",
			'  case "a":',
			"    doA();",
			'  case "b":',
			"    doB();",
			"    break;",
			"}",
		].join("\n");
		expect(mod.detectImplicitSwitchFallthrough(content, TS_FILE)).toEqual([]);
	});

	it("returns [] when ts.createSourceFile throws (parse failure is swallowed)", async () => {
		vi.resetModules();
		const real = (await vi.importActual("typescript"));
		vi.doMock("node:module", () => ({
			createRequire: () => () => ({
				...real,
				createSourceFile: () => {
					throw new Error("synthetic parse failure");
				},
			}),
		}));
		const mod = await import("./correctness-misc.js");
		const content = [
			"switch (x) {",
			'  case "a":',
			"    doA();",
			'  case "b":',
			"    doB();",
			"    break;",
			"}",
		].join("\n");
		expect(mod.detectImplicitSwitchFallthrough(content, TS_FILE)).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Mutation-kill: W6 pass-1 residue (2026-08-17)
// Exact message text pinned once here and reused so every excerpt test is a
// precise toEqual, per the excerpt contract in rawExcerpt/pushMatch.
// ═══════════════════════════════════════════════════════════════════════════

const NUMERIC_SORT_MSG =
	"numeric_sort_without_comparator: numeric array sorted with no comparator — default sort is lexicographic ([10,9,1] → [1,10,9]); use .sort((a, b) => a - b)";

const FALLTHROUGH_TEXT =
	'implicit_switch_fallthrough: non-empty case falls through to the next clause — end it with break/return/throw, or mark intent with a "// falls through" comment';

const NULLNESS_MSG =
	'contradictory_nullness_chain: "?." (may be absent) immediately followed by "!" (cannot be absent) on the same chain — pick one: keep the optional chain, or prove non-null and drop the "?."';

describe("detectNumericSortWithoutComparator — rawExcerpt correctness (undefined-return, ?? vs &&, split(\"\\n\") vs split(\"\"))", () => {
	// test-contract: invariant — a finding's text is exactly "<message> — <excerpt>"
	// where excerpt is the real trimmed source line. A broken excerpt helper
	// (returns undefined, or drops "" through a truthy-check instead of a
	// null-check, or splits the file by CHARACTER instead of by line) must not
	// slip past — pin the full text, not just a substring match.
	it("finding text is exactly the message plus the trimmed source line", () => {
		const content = "[10, 9, 1].sort();";
		const findings = detectNumericSortWithoutComparator(content, TS_FILE);
		expect(findings).toEqual([{ line: 1, text: `${NUMERIC_SORT_MSG} — [10, 9, 1].sort();` }]);
	});

	// test-contract: invariant — the excerpt is drawn from the SAME line the
	// finding is reported on; an off-by-one/two index must not silently grab a
	// neighboring (or out-of-range, empty-excerpt) line instead.
	it("finding text quotes the sort line itself, not a neighboring line", () => {
		const content = ["// before", "[10, 9, 1].sort();", "// after"].join("\n");
		const findings = detectNumericSortWithoutComparator(content, TS_FILE);
		expect(findings).toEqual([{ line: 2, text: `${NUMERIC_SORT_MSG} — [10, 9, 1].sort();` }]);
	});

	// test-contract: invariant — the excerpt is capped at REPORT_LINE_TRUNC (120)
	// chars so one pathological line can't blow up the finding text.
	it("truncates a long source line's excerpt to 120 characters", () => {
		const content = `[10, 9, 1].sort(); // ${"x".repeat(150)}`;
		const findings = detectNumericSortWithoutComparator(content, TS_FILE);
		expect(findings).toHaveLength(1);
		const expectedExcerpt = content.slice(0, 120);
		expect(expectedExcerpt).toHaveLength(120);
		expect(nonNull(findings[0]).text).toBe(`${NUMERIC_SORT_MSG} — ${expectedExcerpt}`);
	});

	// test-contract: invariant — the excerpt is trimmed, so indentation before
	// the flagged call must never leak into the finding text.
	it("trims leading indentation out of the excerpt", () => {
		const content = ["function f() {", "  [10, 9, 1].sort();", "}"].join("\n");
		const findings = detectNumericSortWithoutComparator(content, TS_FILE);
		expect(findings).toEqual([{ line: 2, text: `${NUMERIC_SORT_MSG} — [10, 9, 1].sort();` }]);
	});
});

describe("detectNumericSortWithoutComparator — collectNumberArrayNames never synthesizes a phantom identifier", () => {
	// test-contract: invariant — with zero number[]/Array<number> declarations
	// in the file, the annotated-identifier scan contributes NOTHING; the
	// accumulator must start genuinely empty, never pre-seeded with a name that
	// could coincidentally match unrelated text later in the file.
	it("does not fire on text shaped like a seeded placeholder name followed by .sort()", () => {
		const content = "Stryker was here.sort();";
		expect(detectNumericSortWithoutComparator(content, TS_FILE)).toEqual([]);
	});
});

describe("detectImplicitSwitchFallthrough — switchTerminates requires ALL clauses to terminate", () => {
	// test-contract: invariant — a nested, defaulted switch terminates only when
	// EVERY clause's last statement terminates (Array.every), not merely SOME
	// of them (Array.some); one non-terminating clause means the whole switch —
	// and the outer case containing it — still falls through.
	it("still flags the outer case when only SOME nested clauses terminate", () => {
		const content = `
switch (mode) {
  case "a":
    switch (y) {
      case "p":
        doStuff();
      default:
        return 2;
    }
  case "b":
    doB();
    break;
}
`.trim();
		const findings = detectImplicitSwitchFallthrough(content, TS_FILE);
		expect(findings).toEqual([
			{ line: 2, text: FALLTHROUGH_TEXT },
			{ line: 4, text: FALLTHROUGH_TEXT },
		]);
	});

	// test-contract: invariant — an empty (grouped) clause vacuously terminates
	// on its own; switchTerminates must not force it through statementTerminates
	// with an undefined "last statement" (which the TS AST guard functions
	// reject outright — verified: ts.isBreakStatement(undefined) throws).
	it("treats an empty grouped clause as vacuously terminating, not as a false fallthrough", () => {
		const content = `
switch (mode) {
  case "a":
    switch (y) {
      case "p":
      case "q":
        return 1;
      default:
        return 2;
    }
  case "b":
    doB();
    break;
}
`.trim();
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toEqual([]);
	});
});

describe("detectImplicitSwitchFallthrough — isNeverReturningCall only trusts the curated process.exit(...) shape", () => {
	// test-contract: invariant — an ELEMENT-access callee (process["exit"]) is
	// not the curated dotted process.exit(...) shape and must not be treated as
	// never-returning.
	it('does not treat process["exit"]() as the curated process.exit(...) call', () => {
		const content = [
			"switch (kind) {",
			'case "a":',
			'process["exit"]();',
			'case "b":',
			"doB();",
			"break;",
			"}",
		].join("\n");
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toHaveLength(1);
	});

	// test-contract: invariant — a dotted call is never-returning only when BOTH
	// the object is literally "process" AND the method is literally "exit";
	// getting the OBJECT wrong (foo.exit()) must still be flagged as fallthrough.
	it("does not treat foo.exit() as process.exit (wrong object)", () => {
		const content = [
			"switch (kind) {",
			'case "a":',
			"foo.exit();",
			'case "b":',
			"doB();",
			"break;",
			"}",
		].join("\n");
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toHaveLength(1);
	});

	// test-contract: invariant — getting the METHOD wrong (process.abort()) must
	// still be flagged; only the literal .exit(...) method is curated.
	it("does not treat process.abort() as process.exit (wrong method)", () => {
		const content = [
			"switch (kind) {",
			'case "a":',
			"process.abort();",
			'case "b":',
			"doB();",
			"break;",
			"}",
		].join("\n");
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toHaveLength(1);
	});
});

describe("detectImplicitSwitchFallthrough — statementTerminates on an empty block", () => {
	// test-contract: invariant — an EMPTY block `{}` as a case's last statement
	// does not terminate (nothing inside it returns/breaks/throws); it must not
	// be forced into recursing statementTerminates on an undefined statement.
	it("treats an empty block {} as non-terminating (falls through)", () => {
		const content = ["switch (kind) {", 'case "a": {}', 'case "b":', "doB();", "break;", "}"].join("\n");
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toHaveLength(1);
	});
});

describe("detectImplicitSwitchFallthrough — the fallthrough-comment scan is scoped to THIS clause's own gap", () => {
	// test-contract: invariant — a "falls through" comment ANYWHERE else in the
	// file (not in the trivia gap between the flagged clause and its successor)
	// must not suppress this finding.
	it("still fires when a fallthrough comment exists elsewhere in the file but not in this clause's gap", () => {
		const content = [
			"// unrelated note: falls through is mentioned here, far from any case",
			"switch (kind) {",
			'case "a":',
			"doA();",
			'case "b":',
			"doB();",
			"break;",
			"}",
		].join("\n");
		expect(detectImplicitSwitchFallthrough(content, TS_FILE)).toHaveLength(1);
	});
});

describe("detectContradictoryNullnessChain — rawExcerpt, extension recognition, and bracket-content matching", () => {
	// test-contract: invariant — same excerpt contract as the sort checker: the
	// excerpt is the real source line, never a single split-by-character artifact.
	it("finding text is exactly the message plus the full source line", () => {
		const content = "const name = user?.profile!.name;";
		const findings = detectContradictoryNullnessChain(content, TS_FILE);
		expect(findings).toEqual([{ line: 1, text: `${NULLNESS_MSG} — const name = user?.profile!.name;` }]);
	});

	// test-contract: public-api — the module docstring documents .tsx as a
	// covered TS extension; a .tsx file must still be scanned.
	it("still fires on a .tsx file", () => {
		const content = "const name = user?.profile!.name;";
		expect(detectContradictoryNullnessChain(content, "src/ui/widget.tsx")).toHaveLength(1);
	});

	// test-contract: public-api — same contract for .mts.
	it("still fires on a .mts file", () => {
		const content = "const name = user?.profile!.name;";
		expect(detectContradictoryNullnessChain(content, "src/lib/data.mts")).toHaveLength(1);
	});

	// test-contract: invariant — an optional index access's bracket content can
	// be more than one character (rows?.[i + 1]!), not just exactly one.
	it("still fires when the optional index expression is more than one character", () => {
		const content = "const first = rows?.[i + 1]!.id;";
		expect(detectContradictoryNullnessChain(content, TS_FILE)).toHaveLength(1);
	});
});
