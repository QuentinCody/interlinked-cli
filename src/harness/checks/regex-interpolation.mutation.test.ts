// Mutation-driven hardening for regex-interpolation.ts (check id:
// regex_from_interpolation). Campaign A, 2026-10-21.
//
// Every case below was written for a mutant of the module that the existing
// tests (regex-interpolation.test.ts and the two mutation-kill siblings) let
// survive. Each title states the behavior the module's header comment (or its
// constants' doc comments) promises; the case must fail with the mutant
// applied and pass on the unmutated module. Sources are plain quoted strings,
// so backticks and "${...}" inside them are inert text, not live interpolation.

import { describe, expect, it } from "vitest";
import { checkRegexFromInterpolation } from "./regex-interpolation.js";

const FILE = "src/lib/patterns.ts";

function run(source: string, path: string = FILE) {
	return checkRegexFromInterpolation(source, path);
}

function lines(source: string): number[] {
	return run(source).map((finding) => finding.line);
}

// ─── call-site recognition ────────────────────────────────────────────────────

describe("regex_from_interpolation mutation hardening — call sites", () => {
	// test-contract: header — "lookbehind rejects member and renamed forms (`x.RegExp(`)".
	it("does not treat a member call ns.RegExp(...) as the RegExp constructor", () => {
		expect(run("const re = ns.RegExp(`${user}`);")).toHaveLength(0);
		expect(run("const re = new RegExp(`${user}`);")).toHaveLength(1);
	});

	// test-contract: header — an identifier is one token; $RegExp is not RegExp.
	it("does not treat an identifier that starts with $ before RegExp as the constructor", () => {
		expect(run("const re = $RegExp(`${user}`);")).toHaveLength(0);
		expect(run("const re = new RegExp(`${user}`);")).toHaveLength(1);
	});

	// test-contract: invariant — JavaScript names are case-sensitive; only RegExp builds a pattern.
	it.each(["regexp", "Regexp", "REGEXP", "regExp"])(
		"does not treat the differently cased name %s as the RegExp constructor, with or without new",
		(name) => {
			expect(run("const re = " + name + "(`${user}`);")).toHaveLength(0);
			expect(run("const re = new " + name + "(`${user}`);")).toHaveLength(0);
		},
	);
});

// ─── report text and budgets ──────────────────────────────────────────────────

describe("regex_from_interpolation mutation hardening — report and budgets", () => {
	const HEAD = "const ";
	const TAIL = " = new RegExp(`${y}`);";
	const lineOfLength = (length: number) =>
		HEAD + "a".repeat(length - HEAD.length - TAIL.length) + TAIL;
	/** The source-line part of a finding: whatever follows the last " — " separator. */
	const reportedSource = (source: string): string => {
		const text = run(source)[0]?.text ?? "";
		return text.slice(text.lastIndexOf(" — ") + 3);
	};

	// test-contract: boundary — REPORT_LINE_TRUNC is 150: a 150-character line is reported whole.
	it("reports a source line of exactly 150 characters in full", () => {
		const source = lineOfLength(150);
		expect(source).toHaveLength(150);
		expect(reportedSource(source)).toBe(source);
	});

	// test-contract: boundary — anything past the 150th character is cut from the report.
	it.each([151, 400])("cuts a %i-character source line to its first 150 characters", (length) => {
		const source = lineOfLength(length);
		expect(source).toHaveLength(length);
		expect(reportedSource(source)).toBe(source.slice(0, 150));
	});

	// test-contract: boundary — ARG_SCAN_BUDGET is 1500 characters and its upper bound is
	// exclusive (the existing suite pins that a 1500-character argument is skipped).
	it("still analyses a first argument of 1499 characters, one under the scan budget", () => {
		const prefix = "`${user}` + ";
		const arg = prefix + "x".repeat(1499 - prefix.length);
		expect(arg).toHaveLength(1499);
		const found = run("new RegExp(" + arg + ");");
		expect(found.map((finding) => finding.line)).toEqual([1]);
		expect(found[0]?.text).toMatch(/concatenation/);
	});
});

// ─── two-step escape: lookbehind window and scope ────────────────────────────

describe("regex_from_interpolation mutation hardening — escape lookbehind window", () => {
	const WINDOW = 2500; // ESCAPE_ASSIGN_WINDOW: how far back the two-step idiom looks
	const ASSIGN = "n = escapeForRegex(raw);";
	const CALL = "new RegExp(`^${n}`);";
	const withGap = (gap: number) => ASSIGN + " ".repeat(gap) + CALL;

	// test-contract: boundary — the idiom looks back 2500 characters from the start of the call.
	it("exempts an escape assignment exactly 2500 characters before the call, not one character further", () => {
		const farthestInside = WINDOW - ASSIGN.length;
		expect(withGap(farthestInside).indexOf("new RegExp")).toBe(WINDOW);
		expect(run(withGap(farthestInside))).toHaveLength(0);
		expect(lines(withGap(farthestInside + 1))).toEqual([1]);
	});

	// test-contract: header — "the preceding ~2.5KB window": well inside exempts, far outside does not.
	it("exempts an escape assignment 1500 characters back but not one 3500 characters back", () => {
		expect(run(withGap(1500))).toHaveLength(0);
		expect(lines(withGap(3500))).toEqual([1]);
	});

	// test-contract: header — "the window is cut at the nearest column-0 `}`": the LAST one wins.
	it("cuts the window at the nearest column-0 brace, not the first one in the window", () => {
		const source = [
			"function a() {",
			"}",
			"function b() {",
			"  const n = escapeForRegex(1);",
			"}",
			"function c(n) {",
			"  return new RegExp(`^${n}`);",
			"}",
		].join("\n");
		expect(lines(source)).toEqual([7]);
	});

	// test-contract: header — an assignment placed right after the cutting brace is kept whole.
	it("keeps a two-step escape assignment that follows the column-0 brace line directly", () => {
		const source = [
			"let n;",
			"function f() {",
			"  return 1;",
			"}",
			"n = escapeForRegex(x);",
			"const re = new RegExp(`^${n}`);",
		].join("\n");
		expect(run(source)).toHaveLength(0);
	});
});

// ─── two-step escape: which assignments count ────────────────────────────────

describe("regex_from_interpolation mutation hardening — two-step escape idiom", () => {
	const twoStep = (name: string, body: string[] = []): string =>
		[
			"function f(raw, extra, list) {",
			`  const ${name} = escapeRegExp(raw);`,
			...body,
			"  return new RegExp(`^${" + name + "}`);",
			"}",
		].join("\n");

	// test-contract: header — "a bare identifier whose LAST assignment ... is an /escape/i call".
	it.each(["ab", "safe", "escapedPattern", "safe_pattern_for_regex"])(
		"exempts a substitution of the identifier %s that was assigned from an escape call",
		(name) => {
			expect(run(twoStep(name))).toHaveLength(0);
		},
	);

	// test-contract: invariant — identifiers may start with an underscore.
	it.each(["_n", "_escaped", "__pat"])(
		"exempts a substitution of the underscore-led identifier %s assigned from an escape call",
		(name) => {
			expect(run(twoStep(name))).toHaveLength(0);
		},
	);

	// test-contract: invariant — `$` is an identifier character, any number of times.
	it.each(["$a$", "$$", "a$b$"])(
		"exempts a substitution of the identifier %s that holds several $ characters",
		(name) => {
			expect(run(twoStep(name))).toHaveLength(0);
		},
	);

	// test-contract: header — "bare identifier": an assignment to a property is not an assignment to n.
	it("does not let obj.n = escape(...) exempt a different bare n", () => {
		const source = [
			"function f(n, obj, raw) {",
			"  obj.n = escapeForRegex(raw);",
			"  return new RegExp(`^${n}`);",
			"}",
		].join("\n");
		expect(lines(source)).toEqual([3]);
	});

	// test-contract: header — the assignment target must be the identifier itself, not a longer name.
	it("does not let pattern = escape(...) exempt a different identifier n that pattern ends with", () => {
		const source = [
			"function f(n, raw) {",
			"  const pattern = escapeForRegex(raw);",
			"  return new RegExp(`^${n}`);",
			"}",
		].join("\n");
		expect(lines(source)).toEqual([3]);
	});

	// test-contract: header — only a LATER REASSIGNMENT cancels the exemption; a comparison is not one.
	it("keeps the exemption when the identifier is only compared (n === other) after the escape call", () => {
		const source = twoStep("n", ["  if (n === extra) {", "    return null;", "  }"]);
		expect(run(source)).toHaveLength(0);
	});

	// test-contract: header — an arrow function parameter named n is not a reassignment of n.
	it("keeps the exemption when an arrow function parameter is named like the identifier", () => {
		const source = twoStep("n", ["  list.forEach(n => n.trim());"]);
		expect(run(source)).toHaveLength(0);
	});

	// test-contract: header — "a later reassignment (`n = n + user`, `n += user`) cancels it".
	it.each(["+=", "-=", "*=", "/=", "%=", "&=", "|=", "^="])(
		"cancels the exemption when the identifier is reassigned with %s",
		(operator) => {
			const source = twoStep("n", ["  n " + operator + " extra;"]);
			expect(lines(source)).toEqual([4]);
		},
	);

	// test-contract: header — an escape call may be namespaced (RegExp.escape) in the assignment too.
	it("exempts an identifier assigned from the namespaced RegExp.escape(...) call", () => {
		const source = [
			"function f(raw) {",
			"  const n = RegExp.escape(raw);",
			"  return new RegExp(`^${n}`);",
			"}",
		].join("\n");
		expect(run(source)).toHaveLength(0);
	});

	// test-contract: header — "/escape/i": the callee name matches regardless of letter case.
	it("exempts an identifier assigned from a callee whose name contains Escape in any case", () => {
		const source = [
			"function f(raw) {",
			"  const n = sanitizeEscape(raw);",
			"  return new RegExp(`^${n}`);",
			"}",
		].join("\n");
		expect(run(source)).toHaveLength(0);
	});
});

// ─── operand classification ───────────────────────────────────────────────────

describe("regex_from_interpolation mutation hardening — operand classification", () => {
	// test-contract: header — "(2) a bare CONST_CASE identifier": digits are CONST_CASE characters.
	it.each(["UTF8_RE", "ISO8601", "HTTP2_PREFIX"])(
		"treats the CONST_CASE identifier %s as a fragment constant, not as data",
		(name) => {
			expect(run("const re = new RegExp(`^${" + name + "}`);")).toHaveLength(0);
		},
	);

	// test-contract: header — "(3) a numeric literal": binary and octal literals are numeric.
	it.each(["0b101", "0o17", "0B11", "0O7"])(
		"treats the numeric literal %s in a substitution as a number, not as data",
		(literal) => {
			expect(run("const re = new RegExp(`x{1,${" + literal + "}}`);")).toHaveLength(0);
		},
	);

	// test-contract: header — "(1) an /escape/i call": the callee may be a dotted path of several names.
	it("treats a namespaced escape helper with several segments as an escape call", () => {
		expect(run("const re = new RegExp(`^${utils.regex.escapeRegExp(q)}`);")).toHaveLength(0);
		expect(run("const re = new RegExp(`^${utils.regex.build(q)}`);")).toHaveLength(1);
	});

	// test-contract: header — an "/escape/i call" is judged by its callee name, not by its arguments.
	it("does not treat a call as an escape call just because an argument's name contains escape", () => {
		expect(run("const re = new RegExp(`${normalize(escapedInput)}`);")).toHaveLength(1);
		expect(run("const re = new RegExp(`${escapeRegExp(normalized)}`);")).toHaveLength(0);
	});
});

// ─── lexing ───────────────────────────────────────────────────────────────────

describe("regex_from_interpolation mutation hardening — lexer", () => {
	// test-contract: header — "regex literals are lexed with a prev-significant-char division
	// heuristic": after a value-ending char the `/` divides, so the call after it is real code.
	it.each([
		["a closing bracket", "const v = arr[0] / RegExp(`${z}`) / 2;"],
		["a closing brace", "const v = {} / RegExp(`${z}`) / 2;"],
		["a bare $ identifier", "const v = $ / RegExp(`${z}`) / 2;"],
		["a closing single quote", "const v = 'a' / RegExp(`${z}`) / 2;"],
		["a closing double quote", 'const v = "a" / RegExp(`${z}`) / 2;'],
		["a closing backtick", "const v = `a` / RegExp(`${z}`) / 2;"],
	])("reads a `/` after %s as division, so the RegExp call behind it is still scanned", (_what, source) => {
		expect(lines(source)).toEqual([1]);
	});

	// test-contract: invariant — a block comment closes at a `*/` that follows its opener.
	it("does not let the slash-star-slash sequence close its own comment", () => {
		const source = ["/*/ new RegExp(`${x}`) */", "const re = new RegExp(`${y}`);"].join("\n");
		expect(lines(source)).toEqual([2]);
	});

	// test-contract: invariant — the first argument ends at the first top-level comma only.
	it("keeps commas inside braces in the first argument: an object-literal lookup is one argument", () => {
		const found = run("const re = new RegExp({ a: 'x', b: 'y' }[kind] + suffix);");
		expect(found.map((finding) => finding.line)).toEqual([1]);
		expect(found[0]?.text).toMatch(/concatenation/);
	});
});

// ─── one finding per line ─────────────────────────────────────────────────────

describe("regex_from_interpolation mutation hardening — one finding per line", () => {
	// test-contract: invariant — a call without a finding does not claim the line for later calls.
	it("still reports an unsafe call that follows a safe call on the same line", () => {
		expect(lines("const a = new RegExp(SAFE_PART), b = new RegExp(`${y}`);")).toEqual([1]);
	});
});
