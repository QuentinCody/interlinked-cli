// Mutation-hardening companion for src/harness/checks/taste-smell.ts.
//
// Campaign A (2026-10-21) applied 40 single-change mutants to taste-smell.ts and ran
// taste-smell.test.ts against each; 33 survived. Every case below pins behavior that the
// module documents (or its own comments state) and that no existing suite guarded.
// Mutant ids (mNN) refer to
// scratch/CAMPAIGN-hardening-2026-10-21/A/harness__checks__taste-smell/mutants/mNN.patch
// and the table in RESULTS-harness__checks__taste-smell.md.
//
//   public surface    m01
//   magic numbers     m03 m04 m06 m07 m08 m09 m11
//   negated + else    m12 m13 m14 m16
//   nested ternary    m17
//   flag arguments    m21 m22 m23 m24 m25 m26 m27 m29
//   commented-out     m20 m30 m32 m33 m34 m36 m37 m38

import { describe, expect, it } from "vitest";
import {
	checkCommentedOutCode,
	checkFlagArguments,
	checkMagicNumbers,
	checkNegatedConditionWithElse,
	checkNestedTernary,
	checkSameTypedPrimitiveParams as reexportedSameTypedCheck,
} from "./taste-smell.js";
import { checkSameTypedPrimitiveParams } from "./taste-smell-same-typed-params.js";

const TS_PATH = "src/lib/app.ts";
const PY_PATH = "scripts/x.py";

function blockNote(totalLines: number): string {
	return `[${totalLines} lines of commented-out code → use version control instead]`;
}
function commentedOut(lines: string[], path = TS_PATH) {
	return checkCommentedOutCode(lines.join("\n"), path);
}

// ─── public surface ─────────────────────────────────────────────────────────

describe("taste-smell public surface", () => {
	// kills m01
	it("re-exports the same-typed-parameters detector so one module exposes every taste check", () => {
		expect(reexportedSameTypedCheck).toBe(checkSameTypedPrimitiveParams);
	});
});

// ─── checkMagicNumbers ──────────────────────────────────────────────────────

describe("checkMagicNumbers — comments, strings and reported text", () => {
	// kills m03
	it("ignores numbers that appear only inside string literals or comments", () => {
		const content = [
			'if (ready) { notify("retry 37 times"); }', // 1: the number is inside a string
			"if (ready) { notify(); } // retry after 41 seconds", // 2: the number is inside a comment
			"if (retries > 53) return;", // 3: a genuine magic number
		].join("\n");
		expect(checkMagicNumbers(content, TS_PATH)).toEqual([
			{ line: 3, text: "if (retries > 53) return;" },
		]);
	});

	// kills m04
	it("reports the original source line, with its string and trailing comment intact", () => {
		const line = 'if (retries > 37) { log("giving up"); } // bail out';
		expect(checkMagicNumbers(line, TS_PATH)).toEqual([{ line: 1, text: line }]);
	});
});

describe("checkMagicNumbers — return, case and expression context", () => {
	// kills m06
	it("treats a negative bare-number return as intentional, like a positive one", () => {
		expect(checkMagicNumbers("return -37; compute();", TS_PATH)).toEqual([]);
	});

	// kills m07
	it("treats a negative case label as a label, not as a magic number", () => {
		expect(checkMagicNumbers("case -37: compute();", TS_PATH)).toEqual([]);
	});

	// kills m08
	it("treats an arithmetic operator between operands as expression context", () => {
		expect(checkMagicNumbers("return base*37;", TS_PATH)).toEqual([
			{ line: 1, text: "return base*37;" },
		]);
	});
});

describe("checkMagicNumbers — a line keeps being scanned after numbers that are not findings", () => {
	// kills m09
	it("still reports a magic number that follows an allow-listed number on the same line", () => {
		const line = "if (retries > 0 && retries < 37) return;";
		expect(checkMagicNumbers(line, TS_PATH)).toEqual([{ line: 1, text: line }]);
	});

	// kills m11
	it("still reports a magic number that follows an array index on the same line", () => {
		const line = "if (items[3] > 37) return;";
		expect(checkMagicNumbers(line, TS_PATH)).toEqual([{ line: 1, text: line }]);
	});
});

// ─── checkNegatedConditionWithElse ──────────────────────────────────────────

describe("checkNegatedConditionWithElse — what counts as an if statement", () => {
	// kills m12
	it("ignores an if statement that appears only inside comments or string literals", () => {
		const content = [
			"// if (!ready) {",
			"//   start();",
			"// } else {",
			"//   wait();",
			"// }",
			'const sample = "if (!ready) { start(); } else { wait(); }";',
		].join("\n");
		expect(checkNegatedConditionWithElse(content, TS_PATH)).toEqual([]);
	});

	// kills m13
	it("does not mistake a call to a function whose name ends in 'if' for an if statement", () => {
		const content = "const r = verif(!x); if (y) { a(); } else { b(); }";
		expect(checkNegatedConditionWithElse(content, TS_PATH)).toEqual([]);
	});

	// kills m14
	it.each([
		["a compound condition", "if (!ready && armed) {"],
		["a negated method call", "if (!items.includes(x)) {"],
	])("reports only the negation of a single identifier, not %s", (_label, head) => {
		const content = [head, "  a();", "} else {", "  b();", "}"].join("\n");
		expect(checkNegatedConditionWithElse(content, TS_PATH)).toEqual([]);
	});

	// kills m16
	it("reports the original source line, with its string and trailing comment intact", () => {
		const line = 'if (!ready) { log("not ready"); } else { run(); } // fallback path';
		expect(checkNegatedConditionWithElse(line, TS_PATH)).toEqual([{ line: 1, text: line }]);
	});
});

// ─── checkNestedTernary ─────────────────────────────────────────────────────

describe("checkNestedTernary — comments and string literals", () => {
	// kills m17
	it("ignores nested-ternary text inside comments and string literals", () => {
		const content = [
			'const label = "a ? b ? c : d : e";', // 1: inside a string
			"// alpha ? beta ? gamma : delta : epsilon", // 2: inside a comment
			"const ok = flag ? 1 : 2;", // 3: a single ternary
			"const nested = a ? b ? c : d : e;", // 4: a genuine nested ternary
		].join("\n");
		expect(checkNestedTernary(content, TS_PATH)).toEqual([
			{ line: 4, text: "const nested = a ? b ? c : d : e;" },
		]);
	});
});

// ─── checkFlagArguments ─────────────────────────────────────────────────────

describe("checkFlagArguments — signature collection", () => {
	// kills m22
	it("analyses a parameter list spread over several lines as one signature", () => {
		const content = [
			"function configure(",
			"  verbose: boolean,",
			"  dryRun: boolean,",
			") {",
			"  return verbose && dryRun;",
			"}",
		].join("\n");
		expect(checkFlagArguments(content, TS_PATH)).toEqual([
			{ line: 1, text: "[2 boolean params → use options object] function configure(" },
		]);
	});

	// kills m23
	it("does not report a function with exactly one boolean parameter", () => {
		const content = ["function toggle(enabled: boolean) {", "  return !enabled;", "}"].join("\n");
		expect(checkFlagArguments(content, TS_PATH)).toEqual([]);
	});

	// kills m21
	it("ignores a boolean annotation that appears only inside a comment in the parameter list", () => {
		const content = [
			"function sync(",
			"  force: boolean,",
			"  // legacy: dryRun: boolean,",
			"  target: string,",
			") {",
			"}",
		].join("\n");
		expect(checkFlagArguments(content, TS_PATH)).toEqual([]);
	});

	// kills m27
	it("does not analyse a parameter list that never closes within the collect window, even if it names booleans", () => {
		const lines = [
			"function configure(",
			"  verbose: boolean,",
			"  dryRun: boolean,",
			...Array.from({ length: 25 }, (_, i) => `  extra${i},`),
		];
		expect(checkFlagArguments(lines.join("\n"), TS_PATH)).toEqual([]);
	});

	// kills m29
	it("counts only parameters typed exactly boolean", () => {
		const content = ["function f(a: booleanish, b: booleanish) {", "}"].join("\n");
		expect(checkFlagArguments(content, TS_PATH)).toEqual([]);
	});
});

describe("checkFlagArguments — declaration forms and reported text", () => {
	// kills m25, m26
	it.each(["const", "let", "var"])("reports an arrow function bound with %s", (keyword) => {
		const content = `${keyword} handler = (a: boolean, b: boolean) => a && b;`;
		expect(checkFlagArguments(content, TS_PATH)).toEqual([
			{ line: 1, text: `[2 boolean params → use options object] ${content}` },
		]);
	});

	// kills m24
	it("reports the original signature line, with its trailing comment intact", () => {
		const line = "function sync(a: boolean, b: boolean) { return a && b; } // keep in sync";
		expect(checkFlagArguments(line, TS_PATH)).toEqual([
			{ line: 1, text: `[2 boolean params → use options object] ${line}` },
		]);
	});
});

// ─── checkCommentedOutCode ──────────────────────────────────────────────────

describe("checkCommentedOutCode — divider and documentation lines", () => {
	// kills m30
	it("treats an ASCII arrow line as a divider, not as a documentation placeholder", () => {
		const found = commentedOut([
			"// save(data);",
			"// audit(data);",
			"// publish(data);",
			"// <-- -->",
			"realCode();",
		]);
		expect(found).toEqual([{ line: 1, text: blockNote(4) }]);
	});

	// kills m32
	it.each(["e.g.", "i.e.", "see", "per", "note", "or", "and", "matches", "with"])(
		"treats a '(%s ...)' prose parenthetical as documentation that vetoes the block",
		(word) => {
			const found = commentedOut([
				"// save(data);",
				"// audit(data);",
				"// publish(data);",
				`// (${word} the design notes)`,
				"realCode();",
			]);
			expect(found).toEqual([]);
		},
	);

	// kills m36
	it.each(["TODO", "FIXME", "NOTE", "HACK", "XXX"])(
		"does not let a '%s: ...' marker line veto a disabled-code block",
		(marker) => {
			const found = commentedOut([
				"// save(data);",
				"// audit(data);",
				"// publish(data);",
				`// ${marker}: restore after the migration`,
				"realCode();",
			]);
			expect(found).toEqual([{ line: 1, text: blockNote(4) }]);
		},
	);

	// kills m20 — the trailing "(see ...)" would veto the block if the line were classified
	it.each(["Copyright", "License", "MIT", "Apache", "BSD", "GPL", "All rights reserved"])(
		"does not let a '%s' header line veto a disabled-code block",
		(marker) => {
			const found = commentedOut([
				"// save(data);",
				"// audit(data);",
				"// publish(data);",
				`// ${marker} (see LICENSE.md)`,
				"realCode();",
			]);
			expect(found).toEqual([{ line: 1, text: blockNote(4) }]);
		},
	);
});

describe("checkCommentedOutCode — statement keywords", () => {
	// kills m33
	it.each([
		"const x",
		"let x",
		"var x",
		"function run",
		"async function run",
		"class Job",
		"interface Job",
		"enum Mode",
		"import dep",
		"export dep",
		"return value",
		"throw failure",
		"await task",
		"yield item",
		"if ready",
		"else retry",
		"for each",
		"while busy",
		"do work",
		"switch mode",
		"case Mode",
		"try work",
		"catch failure",
		"finally cleanup",
		"break",
		"continue",
		"new Job",
		"delete entry",
	])("counts a bare '%s' comment line as a disabled statement", (statement) => {
		const found = commentedOut(["// save(data);", "// audit(data);", `// ${statement}`, "realCode();"]);
		expect(found).toEqual([{ line: 1, text: blockNote(3) }]);
	});

	// kills m34
	it.each([
		"def run",
		"class Job",
		"import dep",
		"from dep",
		"return value",
		"raise failure",
		"yield item",
		"await task",
		"async def run",
		"if ready",
		"elif ready",
		"else retry",
		"for each",
		"while busy",
		"with handle",
		"try work",
		"except failure",
		"finally cleanup",
		"break",
		"continue",
		"pass",
		"global value",
		"nonlocal value",
		"assert ready",
		"del entry",
		"lambda value",
	])("counts a bare '%s' Python comment line as a disabled statement", (statement) => {
		const found = commentedOut(
			["# save(data)", "# audit(data)", `# ${statement}`, "real_code()"],
			PY_PATH,
		);
		expect(found).toEqual([{ line: 1, text: blockNote(3) }]);
	});
});

describe("checkCommentedOutCode — each comment block is judged on its own", () => {
	// kills m37
	it("does not count code lines left over from an earlier block toward a later block", () => {
		const found = commentedOut([
			"// save(data);", // block 1: two code lines + one neutral line
			"// audit(data);",
			"// x;",
			"realCode();",
			"// publish(data);", // block 2: two code lines + one neutral line
			"// verify(data);",
			"// y;",
			"moreCode();",
		]);
		expect(found).toEqual([]);
	});

	// kills m38
	it("does not carry a documentation veto from one comment block into the next", () => {
		const found = commentedOut([
			"// save(data);", // block 1: vetoed by the bare annotation below
			"// audit(data);",
			"// publish(data);",
			"// retries: number",
			"realCode();",
			"// load(data);", // block 2: clean
			"// check(data);",
			"// store(data);",
			"moreCode();",
		]);
		expect(found).toEqual([{ line: 6, text: blockNote(3) }]);
	});
});
