// Check Evidence Contract cases for type-discipline.ts +
// type-discipline-unknown-alias.ts (advisory, post-phase). Labeled with the
// P<n>:/N<n>: prefix convention recognized by check-evidence/case-parser.ts
// — see CLAUDE.md "Check Evidence Contract".
//
// conditional_empty_object_spread needs >=1/1 (post/advisory minimum); ships
// with 4 positive / 15 negative (N9-N15 lock in the widened guard-shape
// exemption added after the corpus scan — see type-discipline.ts's header).
// unknown_type_alias same tier; ships with 4 positive / 5 negative.

import { afterEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { detectUnknownTypeAlias } from "./type-discipline-unknown-alias.js";
import { detectConditionalEmptyObjectSpread } from "./type-discipline.js";

const TS_FILE = "src/lib/data.ts";
const JS_FILE = "src/lib/data.js";
const JSX_FILE = "src/components/widget.jsx";

// ═══════════════════════════════════════════════════════════════════════
// conditional_empty_object_spread
// ═══════════════════════════════════════════════════════════════════════

describe("detectConditionalEmptyObjectSpread — positive cases (must fire)", () => {
	it("P1: fires when the empty object is the ternary's true branch", () => {
		const content = "const a = { ...(cond ? {} : { field: value }) };";
		const findings = detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/conditional empty-object spread/);
	});

	it("P2: fires when the empty object is the ternary's false branch (mirror image)", () => {
		const content = "const a = { ...(!cond ? { field: value } : {}) };";
		const findings = detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(findings.length).toBe(1);
	});

	it("P3: fires even when the non-empty branch has multiple fields", () => {
		const content = "const a = { ...(cond ? {} : { x: 1, y: 2 }) };";
		const findings = detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(findings.length).toBe(1);
	});

	it("P4: fires on a multi-line spread nested inside a return statement", () => {
		const content = `
function build(cond: boolean) {
  return {
    base: 1,
    ...(cond ? { extra: true } : {}),
  };
}
`.trim();
		const findings = detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(4);
	});
});

describe("detectConditionalEmptyObjectSpread — negative cases (must not fire)", () => {
	it("N1: does not fire on an unconditional spread", () => {
		const content = "const a = { ...base };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N2: does not fire when neither ternary branch is an empty object", () => {
		const content = "const a = { ...(cond ? { x: 1 } : { y: 2 }) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N3: does not fire when the ternary is not spread at all", () => {
		const content = "const a = cond ? {} : { x: 1 };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N4: does not fire on an array spread (SpreadElement, not SpreadAssignment)", () => {
		const content = "const a = [...(cond ? [] : [1])];";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N5: does not fire on a logical-AND spread (not a ConditionalExpression)", () => {
		const content = "const a = { ...(cond && { field: value }) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N6: does not fire on the idiomatic exactOptionalPropertyTypes key-omission shape (!== undefined)", () => {
		const content = "const a = { ...(opts.json !== undefined ? { json: opts.json } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N7: does not fire on the branch-swapped mirror (=== undefined)", () => {
		const content = "const a = { ...(opts.json === undefined ? {} : { json: opts.json }) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N8: does not fire on the shorthand-property form of the key-omission shape", () => {
		const content = "const a = { ...(json !== undefined ? { json } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	// Corpus-shaped: scratch/type-discipline-corpus-scan.mts found these guard
	// variants (bare truthy, negated, typeof, .length/.size) after the
	// strict-undefined exemption alone still left 106 fires. Real examples
	// (trimmed) from src/lib/config.ts, src/lib/local-activity.ts,
	// src/lib/collection/builder.ts, src/harness/coverage-runner-failing-tests.ts.
	it("N9: does not fire on a bare truthy-identifier guard with a renamed key", () => {
		const content = "const a = { ...(mergedServers ? { servers: mergedServers } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N10: does not fire on a bare truthy-identifier guard with shorthand property", () => {
		const content = "const a = { ...(toolCall ? { toolCall } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N11: does not fire on the negated form (populated branch on whenFalse)", () => {
		const content = "const a = { ...(!cleanupError ? {} : { error: cleanupError }) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N12: does not fire on a typeof-narrowing guard", () => {
		const content = "const a = { ...(typeof ts === \"string\" ? { ts } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N13: does not fire on a .length non-empty guard", () => {
		const content = "const a = { ...result, ...(cappedNames.length > 0 ? { failingTests: cappedNames } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N14: does not fire on a .size non-empty guard", () => {
		const content = "const a = { ...(items.size > 0 ? { items } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("N15: does not fire when the guard uses ?. and the value uses . (same proven-safe path)", () => {
		const content =
			"const a = { ...(existingShared?.mode ? { mode: existingShared.mode } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	it("still fires when the checked expression and the property VALUE differ (not a passthrough)", () => {
		const content = "const a = { ...(opts.json !== undefined ? { enabled: true } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	it("still fires on a loose-equality undefined check (not the strict guard shape)", () => {
		const content = "const a = { ...(opts.json != undefined ? { json: opts.json } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	it("still fires on a bare truthy guard whose value does not match the guard (unrelated field)", () => {
		const content = "const a = { ...(cond ? { key: somethingElse } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	it("still fires on a .length guard whose populated branch has multiple fields", () => {
		const content =
			"const a = { ...(covered.size > 0 || uncovered.size > 0 ? { coveredLines: covered, uncoveredLines: uncovered } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	it("still fires when the populated branch's value is a composed expression, not the guarded one", () => {
		const content = "const a = { ...(options.env ? { env: { ...process.env, ...options.env } } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});
});

describe("detectConditionalEmptyObjectSpread — scope and limits", () => {
	it("runs on plain JS files too (the pattern is not TS-specific)", () => {
		const content = "const a = { ...(cond ? {} : { field: value }) };";
		expect(detectConditionalEmptyObjectSpread(content, JS_FILE).length).toBe(1);
	});

	it("runs on JSX files", () => {
		const content = "const a = { ...(cond ? {} : { field: value }) };";
		expect(detectConditionalEmptyObjectSpread(content, JSX_FILE).length).toBe(1);
	});

	it("skips non-JS/TS extensions entirely", () => {
		const content = "const a = { ...(cond ? {} : { field: value }) };";
		expect(detectConditionalEmptyObjectSpread(content, "README.md")).toEqual([]);
	});

	it("skips test files", () => {
		const content = "const a = { ...(cond ? {} : { field: value }) };";
		expect(detectConditionalEmptyObjectSpread(content, "src/lib/data.test.ts")).toEqual([]);
	});

	it("skips empty content", () => {
		expect(detectConditionalEmptyObjectSpread("", TS_FILE)).toEqual([]);
	});

	it("caps at 10 matches per file even with more offending spreads than that", () => {
		const lines = Array.from(
			{ length: 12 },
			(_, i) => `const c${i} = { ...(cond ? {} : { x: ${i} }) };`,
		);
		const findings = detectConditionalEmptyObjectSpread(lines.join("\n"), TS_FILE);
		expect(findings.length).toBe(10);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// unknown_type_alias
// ═══════════════════════════════════════════════════════════════════════

describe("detectUnknownTypeAlias — positive cases (must fire)", () => {
	it("P1: fires on a bare alias to unknown", () => {
		const content = "type Foo = unknown;";
		const findings = detectUnknownTypeAlias(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(1);
		expect(nonNull(findings[0]).text).toMatch(/only renames 'unknown'/);
	});

	it("P2: fires through a same-file, non-generic alias chain (both links)", () => {
		const content = ["type Foo = unknown;", "type Bar = Foo;"].join("\n");
		const findings = detectUnknownTypeAlias(content, TS_FILE);
		expect(findings.length).toBe(2);
		expect(findings.map((f) => f.line).sort()).toEqual([1, 2]);
	});

	it("P3: fires through a parenthesized unknown", () => {
		const content = "type Foo = (unknown);";
		expect(detectUnknownTypeAlias(content, TS_FILE).length).toBe(1);
	});

	it("P4: fires on an exported alias", () => {
		const content = "export type Foo = unknown;";
		expect(detectUnknownTypeAlias(content, TS_FILE).length).toBe(1);
	});
});

describe("detectUnknownTypeAlias — negative cases (must not fire)", () => {
	it("N1: does not fire on an alias to a concrete type", () => {
		expect(detectUnknownTypeAlias("type Foo = string;", TS_FILE)).toEqual([]);
	});

	it("N2: does not fire on Record<string, unknown> (a generic instantiation, not an alias to unknown)", () => {
		const content = "type Foo = Record<string, unknown>;";
		expect(detectUnknownTypeAlias(content, TS_FILE)).toEqual([]);
	});

	it("N3: does not fire through a generic alias reference (parameterized, not a bare rename)", () => {
		const content = ["type ID<T> = T;", "type UserId = ID<string>;"].join("\n");
		expect(detectUnknownTypeAlias(content, TS_FILE)).toEqual([]);
	});

	it("N4: does not fire when the alias NAME contains 'unknown' but the type does not", () => {
		const content = "type UnknownFields = { [key: string]: string };";
		expect(detectUnknownTypeAlias(content, TS_FILE)).toEqual([]);
	});

	it("N5: does not fire on a union that merely includes unknown", () => {
		const content = "type Foo = string | unknown;";
		expect(detectUnknownTypeAlias(content, TS_FILE)).toEqual([]);
	});
});

describe("detectUnknownTypeAlias — scope and limits", () => {
	it("skips non-TS extensions (type aliases don't exist in plain JS)", () => {
		expect(detectUnknownTypeAlias("type Foo = unknown;", JS_FILE)).toEqual([]);
	});

	it("skips test files", () => {
		expect(detectUnknownTypeAlias("type Foo = unknown;", "src/lib/data.test.ts")).toEqual([]);
	});

	it("skips empty content", () => {
		expect(detectUnknownTypeAlias("", TS_FILE)).toEqual([]);
	});

	it("caps at 10 matches per file even with more offending aliases than that", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `type Foo${i} = unknown;`);
		const findings = detectUnknownTypeAlias(lines.join("\n"), TS_FILE);
		expect(findings.length).toBe(10);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// AST-availability degrade — mirrors correctness-misc.test.ts's convention
// ═══════════════════════════════════════════════════════════════════════

describe("type-discipline — optional 'typescript' dep unavailable", () => {
	afterEach(() => {
		vi.doUnmock("node:module");
		vi.resetModules();
	});

	it("both detectors return [] when 'typescript' cannot be required", async () => {
		vi.resetModules();
		vi.doMock("node:module", () => ({
			createRequire: () => () => {
				throw new Error("cannot find module 'typescript'");
			},
		}));
		const spreadMod = await import("./type-discipline.js");
		const aliasMod = await import("./type-discipline-unknown-alias.js");
		const spreadContent = "const a = { ...(cond ? {} : { field: value }) };";
		const aliasContent = "type Foo = unknown;";
		expect(spreadMod.detectConditionalEmptyObjectSpread(spreadContent, TS_FILE)).toEqual([]);
		expect(aliasMod.detectUnknownTypeAlias(aliasContent, TS_FILE)).toEqual([]);
	});

	it("both detectors return [] when ts.createSourceFile throws (parse failure is swallowed)", async () => {
		vi.resetModules();
		const real = (await vi.importActual("typescript")) as Record<string, unknown>;
		vi.doMock("node:module", () => ({
			createRequire: () => () => ({
				...real,
				createSourceFile: () => {
					throw new Error("synthetic parse failure");
				},
			}),
		}));
		const spreadMod = await import("./type-discipline.js");
		const aliasMod = await import("./type-discipline-unknown-alias.js");
		const spreadContent = "const a = { ...(cond ? {} : { field: value }) };";
		const aliasContent = "type Foo = unknown;";
		expect(spreadMod.detectConditionalEmptyObjectSpread(spreadContent, TS_FILE)).toEqual([]);
		expect(aliasMod.detectUnknownTypeAlias(aliasContent, TS_FILE)).toEqual([]);
	});

	// test-contract: invariant — loadTs's module-level `_ts` cache memoizes a
	// FAILED require too (not just a successful one): once `_ts` is set to
	// `null`, a repeat call must short-circuit on `_ts !== undefined` rather
	// than re-invoking createRequire.
	it("memoizes a failed typescript require — createRequire runs once across repeated detector calls", async () => {
		vi.resetModules();
		const createRequireMock = vi.fn(() => () => {
			throw new Error("cannot find module 'typescript'");
		});
		vi.doMock("node:module", () => ({ createRequire: createRequireMock }));
		const spreadMod = await import("./type-discipline.js");
		const content = "const a = { ...(cond ? {} : { field: value }) };";
		const first = spreadMod.detectConditionalEmptyObjectSpread(content, TS_FILE);
		const second = spreadMod.detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(first).toEqual([]);
		expect(second).toEqual([]);
		expect(createRequireMock).toHaveBeenCalledTimes(1);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Mutation-kill: exact guard-shape and boundary assertions (PASS-1 W6).
// Every expected value below was checked against the live detector before
// landing (see scratch/fleet-r3/receipts/type-discipline.jsonl) — none is a
// re-derivation from reading the source alone.
// ═══════════════════════════════════════════════════════════════════════

describe("typeofCheckedExpression — operator-kind and gate exactness", () => {
	// test-contract: invariant — typeofCheckedExpression's docstring: "either
	// equality strictness" recognizes both === and !==; a strict !== guard
	// must be exempted exactly like the === mirror (populated on the false
	// branch here).
	it("exempts a strict !== typeof guard", () => {
		const content = 'const a = { ...(typeof x !== "string" ? {} : { x }) };';
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	// test-contract: invariant — same docstring: loose == must behave the same
	// as strict === ("loose vs. strict makes no practical difference").
	it("exempts a loose == typeof guard", () => {
		const content = 'const a = { ...(typeof x == "string" ? { x } : {}) };';
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	// test-contract: invariant — an operator that is neither eq nor ne (here
	// `<`) must NOT be recognized as a typeof guard at all, so the ternary
	// stays flagged.
	it("does not recognize a non-equality operator (<) as a typeof guard", () => {
		const content = 'const a = { ...(typeof x < "string" ? {} : { x }) };';
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	// test-contract: invariant — loose != must be recognized identically to
	// strict !==.
	it("exempts a loose != typeof guard", () => {
		const content = 'const a = { ...(typeof x != "string" ? {} : { x }) };';
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	// test-contract: invariant — the operand of === must itself be a `typeof`
	// expression; a bare equality (`x === "string"`) is a different,
	// unrecognized shape and must stay flagged.
	it("does not recognize an equality check without typeof on the left", () => {
		const content = 'const a = { ...(x === "string" ? {} : { x }) };';
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});
});

describe("detectConditionalEmptyObjectSpread — MAX_LINES_PER_FILE boundary", () => {
	// test-contract: boundary — file header: MAX_LINES_PER_FILE = 1500 is a
	// hard `content.split("\n").length > 1500` cutoff; content over the cap
	// must be skipped entirely, even when it contains a flaggable spread.
	it("skips a file with more than 1500 lines even though it contains a flaggable spread", () => {
		const padding = Array.from({ length: 1501 }, () => "// pad");
		const content = [...padding, "const a = { ...(cond ? {} : { field: value }) };"].join("\n");
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	// test-contract: boundary — the cap is `> 1500`, not `>= 1500`; a file at
	// exactly the limit must still be scanned.
	it("still scans a file at exactly 1500 lines", () => {
		const padding = Array.from({ length: 1499 }, () => "// pad");
		const content = [...padding, "const a = { ...(cond ? {} : { field: value }) };"].join("\n");
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	// test-contract: boundary — the line-count cap counts NEWLINES, not
	// characters; a single very long line must not be treated as "too many
	// lines".
	it("does not gate a file on character count when its newline-based line count is small", () => {
		const content = `// ${"x".repeat(1600)}\nconst a = { ...(cond ? {} : { field: value }) };`;
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});
});

describe("undefinedCheckedExpression — operator and side exactness", () => {
	// test-contract: invariant — docstring: "Anything else (loose `!=`, ...)
	// returns null" — a loose == undefined comparison must NOT be exempted,
	// even though it superficially resembles the strict guard shape.
	it("does not exempt a loose == undefined comparison", () => {
		const content = "const a = { ...(opts.json == undefined ? {} : { json: opts.json }) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	// test-contract: invariant — `undefined === expr` (undefined on the LEFT)
	// must be recognized exactly like the mirror `expr === undefined`.
	it("exempts undefined === expr with undefined on the left side", () => {
		const content = "const a = { ...(undefined === opts.json ? {} : { json: opts.json }) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});

	// test-contract: invariant — comparing to the STRING LITERAL "undefined"
	// is not the same as comparing to the `undefined` value; must not exempt.
	it('does not exempt a comparison to the string literal "undefined"', () => {
		const content = 'const a = { ...(opts.json !== "undefined" ? { json: opts.json } : {}) };';
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	// test-contract: invariant — the non-undefined side must be checked by
	// exact identifier NAME, not merely "is some identifier"; comparing
	// against an unrelated bare identifier must not be treated as an
	// undefined-guard.
	it("does not exempt a comparison against an unrelated bare identifier", () => {
		const content = "const a = { ...(opts.json !== someOtherVar ? { json: opts.json } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});
});

describe("singleAssignableProperty / isGuardedKeyOmission — shape exactness", () => {
	// test-contract: invariant — singleAssignableProperty's docstring: null
	// "for anything else (empty, spread, method, computed, or MULTI-PROPERTY)"
	// — a 2-property populated branch must never be treated as a single-key
	// omission, even though its first property's value matches the guard.
	it("still fires when the populated branch has two properties (not a single key)", () => {
		const content = "const a = { ...(cond ? { a: cond, b: 2 } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	// test-contract: invariant — the populated branch of a conditional spread
	// can be ANY expression, not necessarily an object literal (file
	// docstring: "the other branch can be anything ... a variable, a call");
	// a bare-variable populated branch must never be exempted.
	it("still fires when the populated branch is a bare variable, not an object literal", () => {
		const content = "const a = { ...(cond ? someVar : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	// test-contract: invariant — a single-property object whose one property
	// is itself a SPREAD (not a key:value assignment) has no assignable key
	// to compare against the guard; must never be exempted.
	it("still fires when the populated branch's single property is itself a spread", () => {
		const content = "const a = { ...(cond ? { ...base } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	// test-contract: invariant — isGuardedKeyOmission requires the populated
	// branch to be on the side the guard says is "present"; a guard/branch
	// mismatch (truthy guard populating the FALSE branch) is backwards logic
	// and must stay flagged even though the property value textually matches
	// the guard expression.
	it("still fires when the populated branch is on the wrong side of the guard", () => {
		const content = "const a = { ...(cond ? {} : { field: cond }) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});
});

describe("collectConditionalEmptySpreads / excerptAt — exact finding text", () => {
	const PREFIX =
		"conditional empty-object spread omits a field via ternary — prefer a direct property or two statements: ";

	// test-contract: public-api — the reported finding text embeds the exact,
	// trimmed source excerpt; it must never come through empty or as the
	// literal string "undefined".
	it("reports the trimmed source line verbatim in the finding text", () => {
		const content = "const a = { ...(cond ? {} : { field: value }) };";
		const findings = detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(findings).toEqual([
			{ line: 1, text: `${PREFIX}const a = { ...(cond ? {} : { field: value }) ` },
		]);
	});

	// test-contract: public-api — the excerpt is keyed by the spread's OWN
	// 1-based line number, not an off-by-one neighbor line.
	it("reports the excerpt of the spread's own line in a multi-line file", () => {
		const content = ["// L1", "const a = { ...(cond ? {} : { field: value }) };", "// L3"].join("\n");
		const findings = detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(findings).toEqual([
			{ line: 2, text: `${PREFIX}const a = { ...(cond ? {} : { field: value }) ` },
		]);
	});

	// test-contract: public-api — the excerpt is TRIMMED; leading/trailing
	// whitespace on the source line must not leak into the reported text.
	it("trims leading and trailing whitespace out of the reported excerpt", () => {
		const content = "   const a = { ...(cond ? {} : { field: value }) };   ";
		const findings = detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(findings).toEqual([
			{ line: 1, text: `${PREFIX}const a = { ...(cond ? {} : { field: value }) ` },
		]);
	});

	// test-contract: boundary — REPORT_LINE_TRUNC (150) caps the WHOLE
	// message, including the fixed prefix; a long source line must not push
	// the message past that cap. 150 - PREFIX.length(104) - "const ".length(6)
	// = 40 visible padding characters survive the cap.
	it("caps the total finding text at 150 characters on a long source line", () => {
		const content = `const ${"x".repeat(60)} = { ...(cond ? {} : { field: value }) };`;
		const findings = detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(findings).toEqual([{ line: 1, text: `${PREFIX}const ${"x".repeat(40)}` }]);
		expect(nonNull(findings[0]).text.length).toBe(150);
	});
});

describe("guardedExpression — negation and catch-all exactness", () => {
	// test-contract: invariant — the negation shape requires BOTH
	// isPrefixUnaryExpression AND operator === "!"; a different unary
	// operator (here unary minus) must not be treated as the negation guard.
	it("does not recognize unary minus as the negation guard", () => {
		const content = "const a = { ...(-cond ? {} : { field: cond }) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});

	// test-contract: invariant — the catch-all shape is restricted to a bare
	// identifier / property access / element access; a function CALL must
	// stay unrecognized even when its own text happens to match the
	// populated branch's value.
	it("does not recognize a call expression as a bare-identifier guard", () => {
		const content = "const a = { ...(isReady() ? { field: isReady() } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});
});

describe("propertyValueText — one exempt match must not swallow unrelated findings", () => {
	// test-contract: bug — propertyValueText's shorthand branch only applies
	// to a genuine ShorthandPropertyAssignment; an earlier ternary that
	// correctly resolves to exempt must not abort the walk (via a wrong-kind
	// crash) and silently drop an unrelated flaggable spread later in the
	// same file.
	it("still reports an independent flaggable spread after an earlier exempt shorthand match", () => {
		const content = [
			"const a = { ...(json !== undefined ? { json } : {}) };",
			"const b = { ...(cond2 ? {} : { other: 1 }) };",
		].join("\n");
		const findings = detectConditionalEmptyObjectSpread(content, TS_FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(2);
	});
});

describe("lengthCheckedExpression — property-name exactness", () => {
	// test-contract: invariant — docstring: recognizes ONLY `.length`/`.size`;
	// any other property name (here `.count`) must not be treated as a
	// non-empty guard.
	it("does not recognize a .count property access as a length/size guard", () => {
		const content = "const a = { ...(arr.count > 0 ? { arr } : {}) };";
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE).length).toBe(1);
	});
});

describe("detectConditionalEmptyObjectSpread — collector-crash safety", () => {
	// A left-associative `a + a + …` chain is the one shape that PARSES but
	// cannot be WALKED: TypeScript builds it with precedence climbing (an
	// iterative loop) and fixes up parent pointers with an iterative walk, so
	// `parseSourceFile` succeeds — but the AST it yields is left-deep, and
	// collectConditionalEmptySpreads's recursive `visit` overflows the call
	// stack on it (measured: RangeError at ~1.4k levels; 50k is a wide,
	// environment-independent margin). Packed onto one line so the file stays
	// far under MAX_LINES_PER_FILE — this exercises AST DEPTH, not line count.
	const DEEP_CHAIN_LENGTH = 50_000;
	const FLAGGABLE = "const a = { ...(cond ? {} : { field: value }) };";

	// test-contract: invariant — the outer try/catch turns a runtime failure
	// inside the walk into a silent `[]`; every quality-check caller assumes a
	// detector never throws.
	it("returns [] rather than throwing when the AST walk overflows the call stack", () => {
		const chain = Array.from({ length: DEEP_CHAIN_LENGTH }, () => "a").join(" + ");
		const content = `const deep = ${chain};\n${FLAGGABLE}\n`;
		// The flaggable line ALONE reports one finding, so `[]` for the same
		// line preceded by the deep chain is the discriminating observable: a
		// completed walk would report that finding, and no catch at all would
		// let the RangeError escape to the caller.
		expect(detectConditionalEmptyObjectSpread(FLAGGABLE, TS_FILE).length).toBe(1);
		expect(detectConditionalEmptyObjectSpread(content, TS_FILE)).toEqual([]);
	});
});
