import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	blankStringLiteralsPreserveLength,
	checkBareCatchBlock,
	checkCatchReturnNull,
	checkErrorDispatchByInstanceof,
	checkErrorStringComparison,
	checkInconsistentErrorStrategy,
	checkLossyErrorRethrow,
	checkThrowAsControlFlow,
	checkUntypedCatch,
	isMessageExtractionGuard,
} from "./error-handling.js";

const TS = "src/lib/foo.ts";

describe("checkErrorDispatchByInstanceof — positive cases", () => {
	it("flags `e instanceof Error` inside catch", () => {
		const code = [
			"function bug() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    if (e instanceof Error) handle(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toMatch(/instanceof\s+Error/);
	});

	it("flags `e instanceof TypeError`", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    if (e instanceof TypeError) return;",
			"    throw e;",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags `err instanceof RangeError`", () => {
		const code = [
			"async function bug() {",
			"  try { await f(); }",
			"  catch (err) {",
			"    if (err instanceof RangeError) return -1;",
			"    throw err;",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags `e instanceof EvalError`", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    if (e instanceof EvalError) return;",
			"  }",
			"}",
		].join("\n");
		expect(checkErrorDispatchByInstanceof(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags `e instanceof ReferenceError`", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    if (e instanceof ReferenceError) return;",
			"  }",
			"}",
		].join("\n");
		expect(checkErrorDispatchByInstanceof(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags `e instanceof AggregateError`", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    if (e instanceof AggregateError) return;",
			"  }",
			"}",
		].join("\n");
		expect(checkErrorDispatchByInstanceof(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags multiple instanceof checks in one catch", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    if (e instanceof SyntaxError) return 1;",
			"    if (e instanceof URIError) return 2;",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(2);
	});

	it("still flags subtype `e instanceof TypeError` in a ternary (only base Error is exempt)", () => {
		const code = [
			"function f() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    const msg = e instanceof TypeError ? e.message : String(e);",
			"    log(msg);",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("still flags base `instanceof Error` used for real dispatch, not extraction", () => {
		const code = [
			"function f() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    if (e instanceof Error) { retry(); } else { giveUp(); }",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkErrorDispatchByInstanceof — negative cases (must NOT fire)", () => {
	it("does NOT flag `instanceof Error` OUTSIDE a catch block", () => {
		const code = [
			"function check(x: unknown) {",
			"  return x instanceof Error;",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});

	it("does NOT flag `instanceof` against custom user-defined classes inside catch", () => {
		const code = [
			"class NetworkError {}",
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    if (e instanceof NetworkError) handle(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});

	it("does NOT flag tag-dispatch in catch (the recommended pattern)", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    if ((e as { _tag?: string })._tag === 'NetworkError') handle();",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});

	it("skips test files entirely", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) { if (e instanceof Error) handle(e); }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, "src/lib/foo.test.ts");
		expect(out).toEqual([]);
	});

	it("skips non-JS/TS files even when the content would otherwise trigger the check", () => {
		// Content that WOULD match catch+instanceof if the extension guard were
		// bypassed — proves the guard itself is doing the work, not that this
		// text happens not to match the JS-specific regex.
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) { if (e instanceof Error) handle(e); }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, "src/lib/foo.py");
		expect(out).toEqual([]);
	});

	it("ignores `instanceof Error` in a comment", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    // Note: e instanceof Error fails across realms",
			"    handle(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});

	it("does NOT flag the message-extraction guard `e instanceof Error ? e.message : String(e)`", () => {
		const code = [
			"function f() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    const msg = e instanceof Error ? e.message : String(e);",
			"    log(msg);",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});

	it("does NOT flag the multi-line message-extraction guard", () => {
		const code = [
			"function f() {",
			"  try { risky(); }",
			"  catch (err) {",
			"    return err instanceof Error",
			"      ? err.message",
			"      : String(err);",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});

	it("does NOT flag the `.stack` extraction guard", () => {
		const code = [
			"function f() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    report(e instanceof Error ? e.stack : String(e));",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});
});

describe("checkErrorDispatchByInstanceof — sharper assertions (caps, boundaries)", () => {
	it("reports the exact 1-based line number of the instanceof check", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    logSomething();",
			"    if (e instanceof RangeError) return -1;",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(5);
	});

	it("produces the EXACT full message text, pinning every static segment of the template literal", () => {
		const code = ["try { f(); }", "catch (e) { if (e instanceof TypeError) log(e); }"].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0])).toEqual({
			line: 2,
			text: "instanceof TypeError inside catch — fragile across realm boundaries; dispatch on a _tag/code/name field instead: catch (e) { if (e instanceof TypeError) log(e); }",
		});
	});

	it("does NOT flag an instanceof check that is textually OUTSIDE an EMPTY catch block (openIdx must land on the catch's own brace, not past it)", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {}",
			"  if (x instanceof TypeError) {}",
			"}",
		].join("\n");
		// The instanceof check is a sibling statement after the (empty) catch, not inside it.
		expect(checkErrorDispatchByInstanceof(code, TS)).toEqual([]);
	});

	it("does not hang or crash when a catch's own opening brace never closes at all before EOF (closeIdx stays -1)", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) { if (true) {",
			"    if (e instanceof TypeError) log(e);",
		].join("\n");
		expect(() => checkErrorDispatchByInstanceof(code, TS)).not.toThrow();
		expect(checkErrorDispatchByInstanceof(code, TS)).toEqual([]);
	});

	it("caps at exactly 10 matches when 11 SEPARATE catch blocks each contain one instanceof check", () => {
		const lines: string[] = [];
		for (let i = 0; i < 11; i++) {
			lines.push(`try { f(); } catch (e${i}) { if (e${i} instanceof TypeError) log(e${i}); }`);
		}
		const out = checkErrorDispatchByInstanceof(lines.join("\n"), TS);
		expect(out.length).toBe(10);
	});

	it("caps at exactly 10 matches when ONE catch block contains 11 instanceof checks", () => {
		const lines: string[] = ["try { f(); } catch (e) {"];
		for (let i = 0; i < 11; i++) lines.push(`  if (e instanceof TypeError) return ${i};`);
		lines.push("}");
		const out = checkErrorDispatchByInstanceof(lines.join("\n"), TS);
		expect(out.length).toBe(10);
	});

	it("matches `catch(e){` with ZERO whitespace anywhere (catch keyword directly against paren/brace)", () => {
		const code = "function g() { try { f(); } catch(e){ if (e instanceof TypeError) log(e); } }";
		expect(checkErrorDispatchByInstanceof(code, TS).length).toBe(1);
	});

	it("matches `catch( e ){` with EXTRA internal whitespace around the bound variable", () => {
		const code = "function g() { try { f(); } catch( e ){ if (e instanceof TypeError) log(e); } }";
		expect(checkErrorDispatchByInstanceof(code, TS).length).toBe(1);
	});

	it("matches `instanceof  TypeError` with EXTRA whitespace between the keyword and the class name", () => {
		const code = [
			"function g() {",
			"  try { f(); }",
			"  catch (e) {",
			"    if (e instanceof  TypeError) log(e);",
			"  }",
			"}",
		].join("\n");
		expect(checkErrorDispatchByInstanceof(code, TS).length).toBe(1);
	});

	it("still finds the instanceof check after nested braces (an if-block) open and close within the same catch, without prematurely stopping at the inner close", () => {
		const code = [
			"function g() {",
			"  try { f(); }",
			"  catch (e) {",
			"    if (shouldLog) {",
			"      log(e);",
			"    }",
			"    if (e instanceof TypeError) return -1;",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBe(1);
	});

	it("embeds the ACTUAL trimmed source line as the message's trailing excerpt (not a stray single char, and leading whitespace is stripped)", () => {
		const code = [
			"function g() {",
			"  try { f(); }",
			"  catch (e) {",
			"      if (e instanceof RangeError) return -1;",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toBe(
			"instanceof RangeError inside catch — fragile across realm boundaries; dispatch on a _tag/code/name field instead: if (e instanceof RangeError) return -1;",
		);
	});

	it("truncates the trailing source-line excerpt to 120 characters", () => {
		const filler = "x".repeat(150);
		const code = [
			"function g() {",
			"  try { f(); }",
			"  catch (e) {",
			`    if (e instanceof TypeError) log("${filler}");`,
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBe(1);
		const text = nonNull(out[0]).text;
		const marker = "dispatch on a _tag/code/name field instead: ";
		const excerpt = text.slice(text.indexOf(marker) + marker.length);
		expect(excerpt.length).toBe(120);
	});
});

// ===========================================
// checkLossyErrorRethrow
// ===========================================

describe("checkLossyErrorRethrow — positive cases", () => {
	it("flags throw new Error in catch without cause", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			'    throw new Error("wrapped: " + err.message);',
			"  }",
			"}",
		].join("\n");
		const out = checkLossyErrorRethrow(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("without { cause: err }");
	});

	it("flags throw new TypeError with a template message but no cause", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    throw new TypeError(`bad input: ${e}`);",
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("still fires when `cause` appears only inside the message string, not as an option", () => {
		// `cause` inside the message must NOT count as preserving the cause —
		// the string content is blanked before the option check.
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			'    throw new Error("root cause: bad state");',
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS).length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkLossyErrorRethrow — negative cases (must NOT fire)", () => {
	it("ignores throw with single-line { cause }", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (e) {",
			'    throw new Error("wrapped", { cause: e });',
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("ignores throw with a MULTI-LINE { cause } after a string-heavy preamble", () => {
		// Regression (trajectory.ts shape): stripStrings collapsed earlier
		// literals and mis-sliced the cause window, falsely flagging this.
		const code = [
			"function g(target: { path: string }, raw: string) {",
			'  console.log("loading");',
			'  console.log("parsing the snapshot file now");',
			"  try {",
			"    JSON.parse(raw);",
			"  } catch (err) {",
			"    throw new Error(`snapshot ${target.path} is malformed`, {",
			"      cause: err,",
			"    });",
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("ignores a catch/throw pattern that lives inside a string literal", () => {
		// Regression (section-table-agent-safety.ts shape): the check's own
		// description string must not be mistaken for code.
		const code = [
			"const SPEC = {",
			'  noun: "catch (e) { throw new Error(...) } without { cause: e }",',
			"};",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("ignores `throw err` rethrow by reference", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			"    throw err;",
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});
});

describe("checkLossyErrorRethrow — sharper assertions (spacing, caps, boundaries)", () => {
	it("skips test files entirely", () => {
		const code = ['catch (e) {', '  throw new Error("wrapped");', "}"].join("\n");
		expect(checkLossyErrorRethrow(code, "src/lib/foo.test.ts")).toEqual([]);
	});

	it("skips non-JS/TS extensions even when the content would otherwise trigger the check", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			'    throw new Error("wrapped");',
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, "src/lib/foo.py")).toEqual([]);
	});

	it("reports the exact 1-based line number of the throw, not the catch", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			"    logSomething();",
			'    throw new Error("wrapped: " + err.message);',
			"  }",
			"}",
		].join("\n");
		const out = checkLossyErrorRethrow(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(5);
	});

	it("produces the EXACT full message text, pinning every static segment of the template literal", () => {
		const code = ["try { g(); }", 'catch (e) { throw new Error("wrapped"); }'].join("\n");
		const out = checkLossyErrorRethrow(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0])).toEqual({
			line: 2,
			text: 'throw new Error in catch(e) without { cause: e } — original stack lost: catch (e) { throw new Error("wrapped"); }',
		});
	});

	it("matches `catch(e){` with ZERO whitespace anywhere (catch keyword directly against paren/brace)", () => {
		const code = 'function g() { try { risky(); } catch(e){ throw new Error("wrapped"); } }';
		expect(checkLossyErrorRethrow(code, TS).length).toBe(1);
	});

	it("matches `catch ( e ) {` with EXTRA internal whitespace around the bound variable", () => {
		const code = 'function g() { try { risky(); } catch ( e ) { throw new Error("wrapped"); } }';
		expect(checkLossyErrorRethrow(code, TS).length).toBe(1);
	});

	it("matches a custom multi-character Error subclass name without cause (exercises the [A-Za-z0-9_$]* run, not just a single char)", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			'    throw new HttpError("upstream failure");',
			"  }",
			"}",
		].join("\n");
		const out = checkLossyErrorRethrow(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("without { cause: err }");
	});

	it("matches `throw  new  Error(` with EXTRA internal whitespace on both sides of `new`", () => {
		const code = 'function g() { try { risky(); } catch (e) { throw  new  Error("wrapped"); } }';
		expect(checkLossyErrorRethrow(code, TS).length).toBe(1);
	});

	it("matches `Error (` with a space before the call parens", () => {
		const code = 'function g() { try { risky(); } catch (e) { throw new Error ("wrapped"); } }';
		expect(checkLossyErrorRethrow(code, TS).length).toBe(1);
	});

	it("does NOT flag a throw whose args contain a NESTED call before the `{ cause }` option — the paren-depth scan must find the OUTER closing paren, not stop at the first one", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (e) {",
			'    throw new Error(buildMessage("x"), { cause: e });',
			"  }",
			"}",
		].join("\n");
		// A depth scan that stops on the FIRST `)` it sees (the one closing
		// `buildMessage("x")`) would slice out only `buildMessage("x"` as the
		// args window — missing the real `{ cause: e }` entirely.
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("still flags a lossy rethrow whose SOLE argument is a nested call with no cause (the depth scan must INCREMENT on `(`, not decrement, or it never finds the real closing paren at all)", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    throw new Error(getMessage());",
			"  }",
			"}",
		].join("\n");
		// One level of nesting, no `cause` anywhere. A depth counter that treats
		// `(` as a decrement (instead of increment) never returns to zero on any
		// `)` in this string, so it would find NO closing paren at all and
		// silently drop the whole throw instead of flagging it.
		const out = checkLossyErrorRethrow(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("without { cause: e }");
	});

	it("does NOT let `cause` text belonging to a DIFFERENT catch's throw leak into this throw's preservesCause check (the args window must be SLICED to this throw only)", () => {
		const code = [
			'catch (e1) { throw new Error("first"); }',
			'catch (e2) { throw new Error("second", { cause: e2 }); }',
		].join("\n");
		const out = checkLossyErrorRethrow(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("without { cause: e1 }");
	});

	it("recognizes `{ cause : e }` with a space before the colon as preserving cause", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (e) {",
			'    throw new Error("wrapped", { cause : e });',
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("does NOT flag an instance a throw is textually OUTSIDE an EMPTY catch block (openIdx must land on the catch's own brace, not past it)", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (e) {}",
			'  throw new Error("wrapped");',
			"}",
		].join("\n");
		// The throw is a sibling statement after the (empty) catch, not inside it.
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("caps at exactly 10 matches when 11 SEPARATE catch blocks each contain one lossy rethrow", () => {
		const lines: string[] = [];
		for (let i = 0; i < 11; i++) {
			lines.push(`try { g(); } catch (e${i}) { throw new Error("wrapped ${i}"); }`);
		}
		const out = checkLossyErrorRethrow(lines.join("\n"), TS);
		expect(out.length).toBe(10);
	});

	it("caps at exactly 10 matches when ONE catch block contains 11 lossy rethrows", () => {
		const lines: string[] = ["try { g(); } catch (e) {"];
		for (let i = 0; i < 11; i++) lines.push(`  if (cond${i}) throw new Error("wrapped ${i}");`);
		lines.push("}");
		const out = checkLossyErrorRethrow(lines.join("\n"), TS);
		expect(out.length).toBe(10);
	});

	it("does not crash and reports nothing for a throw whose call parens never close before the catch ends (argsEnd guard)", () => {
		const code = ["try { g(); }", 'catch (e) { throw new Error("wrapped" }'].join("\n");
		expect(() => checkLossyErrorRethrow(code, TS)).not.toThrow();
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("does not crash and reports EXACTLY one match for a single lossy throw whose companion regex search naturally exhausts on the next .exec() call (the loop's own null-check, not just the closeIdx bound)", () => {
		// Once the ONE real "throw new Error(" match is found and consumed, a
		// FURTHER `ERROR_CTOR_RE.exec(code)` call returns null (no more matches
		// anywhere in the string) and — per the regex spec — resets lastIndex to
		// 0. A mutant that drops the inner while's `throwMatch !== null` guard
		// would either crash dereferencing null on the very next loop turn, or
		// (if it somehow avoided that) re-scan from position 0 and duplicate the
		// same match. An exact length of 1 pins both failure modes.
		const code = 'try { g(); } catch (e) { throw new Error("wrapped"); }';
		expect(() => checkLossyErrorRethrow(code, TS)).not.toThrow();
		expect(checkLossyErrorRethrow(code, TS).length).toBe(1);
	});

	it("does not hang or crash when a catch's own opening brace never closes at all before EOF (closeIdx stays -1)", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (e) { if (true) {",
			'    throw new Error("wrapped");',
		].join("\n");
		expect(() => checkLossyErrorRethrow(code, TS)).not.toThrow();
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("does NOT consume a stray `)` that lives AFTER the catch has already closed, even when the throw's own parens never close inside it (the args-paren scan must stop at closeIdx, not run to EOF)", () => {
		const code = ['catch (e) { throw new Error("wrapped" }', ")"].join("\n");
		// The stray `)` on the next line belongs to nothing this check should
		// see as part of the throw's argument list — the scan must give up
		// (argsEnd stays unresolved) rather than reach past the catch's own
		// closing brace to find it.
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("does NOT attribute a throw AFTER an EMPTY catch's closing brace to that catch (the throw-search must stop at closeIdx, not scan the rest of the file)", () => {
		const code = [
			"catch (e1) { }",
			"doSomethingElse();",
			'throw new Error("unrelated, standalone throw outside any catch");',
		].join("\n");
		// catch(e1) has a zero-width body (bodyStart === closeIdx). A scan that
		// forgets to bound the throw-search by closeIdx would keep matching
		// ERROR_CTOR_RE forward past the catch entirely and wrongly report this
		// unrelated standalone throw as belonging to catch(e1).
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("still finds the lossy rethrow after nested braces (an if-block) open and close within the same catch, without prematurely stopping at the inner close", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			"    if (shouldLog) {",
			"      log(err);",
			"    }",
			'    throw new Error("wrapped");',
			"  }",
			"}",
		].join("\n");
		const out = checkLossyErrorRethrow(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("without { cause: err }");
	});

	it("embeds the ACTUAL trimmed source line as the message's trailing excerpt (not a stray single char, and leading whitespace is stripped)", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			'      throw new Error("wrapped: " + err.message);',
			"  }",
			"}",
		].join("\n");
		const out = checkLossyErrorRethrow(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toBe(
			'throw new Error in catch(err) without { cause: err } — original stack lost: throw new Error("wrapped: " + err.message);',
		);
	});

	it("truncates the trailing source-line excerpt to 100 characters", () => {
		const filler = "x".repeat(150);
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			`    throw new Error("${filler}");`,
			"  }",
			"}",
		].join("\n");
		const out = checkLossyErrorRethrow(code, TS);
		expect(out.length).toBe(1);
		const text = nonNull(out[0]).text;
		const marker = "original stack lost: ";
		const excerpt = text.slice(text.indexOf(marker) + marker.length);
		expect(excerpt.length).toBe(100);
	});

	it("matches `Error (` with a space before the call parens", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			'    throw new Error ("wrapped");',
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS).length).toBe(1);
	});

	it("correctly balances a NESTED function call in the throw's argument list before finding the { cause } option", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			'    throw new Error(computeMessage("x"), { cause: err });',
			"  }",
			"}",
		].join("\n");
		// If the paren-depth scan treated `computeMessage(...)`'s own closing
		// paren as the end of the argument list, it would slice off `{ cause: err }`
		// and wrongly report a missing cause.
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("correctly finds argsEnd past a NESTED function call with NO cause option — still flags the missing cause", () => {
		// Unlike the case above, there is genuinely no `{ cause }` here. If the
		// paren-depth counter treated an OPEN paren as a decrement (instead of
		// an increment), the nested call's own close would falsely appear
		// balanced early and argsEnd would never be found at all — silently
		// dropping the finding instead of reporting it.
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			'    throw new Error(computeMessage("x"));',
			"  }",
			"}",
		].join("\n");
		const out = checkLossyErrorRethrow(code, TS);
		expect(out.length).toBe(1);
	});

	it("does NOT let the argument-paren scan run past the catch's own close and pick up a LATER, unrelated closing paren", () => {
		// The throw's own args are genuinely unbalanced (no closing paren before
		// the catch ends) — the scan must stop at the catch's close and report
		// nothing, not keep hunting for a ")" in whatever text happens to follow
		// (here, a stray paren after the function itself closes).
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			'    throw new Error("wrapped"',
			"  }",
			"}",
			")",
		].join("\n");
		expect(() => checkLossyErrorRethrow(code, TS)).not.toThrow();
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("scopes the { cause } search to the throw's OWN argument list, not the whole file", () => {
		const code = [
			"function g() {",
			"  const opts = { cause: 'unrelated' };",
			"  try { risky(); }",
			"  catch (err) {",
			'    throw new Error("wrapped");',
			"  }",
			"}",
		].join("\n");
		// `cause:` appears elsewhere in the file (in `opts`), well outside this
		// throw's own parens — it must not suppress the finding.
		const out = checkLossyErrorRethrow(code, TS);
		expect(out.length).toBe(1);
	});

});

// ===========================================
// checkBareCatchBlock
// ===========================================

describe("checkBareCatchBlock — positive (must fire)", () => {
	it("P1: flags `catch (e) {}` bare on one line", () => {
		const code = ["function f() {", "  try { g(); }", "  catch (e) {}", "}"].join("\n");
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("bare catch block silently swallows error");
		expect(nonNull(out[0]).line).toBe(3);
	});

	it("P2: flags `catch {}` with no bound parameter", () => {
		const code = ["function f() {", "  try { g(); }", "  catch {}", "}"].join("\n");
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
	});

	it("P2b: truncates a long same-line bare-catch excerpt to 100 characters", () => {
		const filler = "x".repeat(150);
		const code = `function f() { try { g(); } /* ${filler} */ catch (e) {} }`;
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
		const marker = "bare catch block silently swallows error: ";
		const text = nonNull(out[0]).text;
		expect(text.slice(marker.length).length).toBe(100);
	});

	it("P1b: flags `catch(err){}` with ZERO whitespace and a multi-character variable name", () => {
		const code = "function f() { try { g(); } catch(err){} }";
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
	});

	it("P1c: flags `catch (e) { }` with whitespace INSIDE the otherwise-empty braces", () => {
		const code = "function f() { try { g(); } catch (e) { } }";
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
	});

	it("P1d: strips leading indentation from the same-line bare-catch excerpt", () => {
		const code = ["function f() {", "  try { g(); }", "      catch (e) {}", "}"].join("\n");
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text.endsWith("catch (e) {}")).toBe(true);
	});

	it("P3b: flags a comment-only catch with ZERO whitespace in the catch-open (`catch(e){`)", () => {
		const code = ["function f() {", "  try { g(); }", "  catch(e){", "    // swallow", "  }", "}"].join(
			"\n",
		);
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
	});

	it("P3c: flags a bare `catch {` (no parens) containing only a comment", () => {
		const code = ["function f() {", "  try { g(); }", "  catch {", "    // swallow", "  }", "}"].join(
			"\n",
		);
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
	});

	it("P3a: strips leading indentation from the comment-only-catch excerpt", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"      catch (e) {",
			"    // swallow intentionally",
			"  }",
			"}",
		].join("\n");
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toBe(
			"catch block with only a comment — error is silently ignored: catch (e) {",
		);
	});

	it("P3: flags a catch block containing only a `//` comment before the close", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    // swallow intentionally",
			"  }",
			"}",
		].join("\n");
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("catch block with only a comment");
	});

	it("P4: flags a catch block containing only a blank line before the close", () => {
		const code = ["function f() {", "  try { g(); }", "  catch (e) {", "", "  }", "}"].join(
			"\n",
		);
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
	});

	it("P5: flags a catch block containing only a `/*` comment opener before the close", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    /* intentionally empty */",
			"  }",
			"}",
		].join("\n");
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
	});

	it("P6: flags Python `except:` followed by `pass`", () => {
		const code = ["def f():", "    try:", "        g()", "    except:", "        pass"].join(
			"\n",
		);
		const out = checkBareCatchBlock(code, "src/lib/foo.py");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("bare except/pass silently swallows error");
		expect(nonNull(out[0]).line).toBe(4);
	});

	it("P6b: still flags Python `except:` when the line ends with trailing whitespace after the colon", () => {
		const code = ["def f():", "    try:", "        g()", `    except:${" "}`, "        pass"].join(
			"\n",
		);
		const out = checkBareCatchBlock(code, "src/lib/foo.py");
		expect(out.length).toBe(1);
	});

	it("P6e: strips leading indentation from the Python bare-except excerpt", () => {
		const code = ["def f():", "    try:", "        g()", "        except:", "        pass"].join(
			"\n",
		);
		const out = checkBareCatchBlock(code, "src/lib/foo.py");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toBe("bare except/pass silently swallows error: except:");
	});

	it("P7: flags Python `except Exception:` followed by `...`", () => {
		const code = [
			"def f():",
			"    try:",
			"        g()",
			"    except Exception:",
			"        ...",
		].join("\n");
		const out = checkBareCatchBlock(code, "src/lib/foo.py");
		expect(out.length).toBe(1);
	});

	it("P8: caps at exactly 10 matches when 11 bare catches are present", () => {
		const lines: string[] = ["function f() {"];
		for (let i = 0; i < 11; i++) lines.push("  try { g(); } catch (e) {}");
		lines.push("}");
		const out = checkBareCatchBlock(lines.join("\n"), TS);
		expect(out.length).toBe(10);
	});
});

describe("checkBareCatchBlock — negative (must NOT fire)", () => {
	it("N1: does NOT flag a catch block that actually handles the error", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    log(e);",
			"  }",
			"}",
		].join("\n");
		expect(checkBareCatchBlock(code, TS)).toEqual([]);
	});

	it("N2: skips test files entirely", () => {
		const code = ["try { g(); }", "catch (e) {}"].join("\n");
		expect(checkBareCatchBlock(code, "src/lib/foo.test.ts")).toEqual([]);
	});

	it("N3: skips an extension that is neither JS/TS nor Python (e.g. .go), even when the content would otherwise trigger the check", () => {
		const code = ["func f() {", "  // catch (e) {}", "}"].join("\n");
		expect(checkBareCatchBlock(code, "src/lib/foo.go")).toEqual([]);
	});

	it("N4: does NOT flag a comment-only catch when the line after the comment is NOT the closing brace", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    // note",
			"    log(e);",
			"  }",
			"}",
		].join("\n");
		expect(checkBareCatchBlock(code, TS)).toEqual([]);
	});

	it("N5: does NOT flag Python except when the next line is real handling, not pass/...", () => {
		const code = [
			"def f():",
			"    try:",
			"        g()",
			"    except Exception:",
			"        log(e)",
		].join("\n");
		expect(checkBareCatchBlock(code, "src/lib/foo.py")).toEqual([]);
	});

	it("N5b: does NOT flag Python-except-shaped text in a NON-Python (.ts) file, even though the regex+pass text would otherwise match", () => {
		const code = ["function f() {", "  except:", "  pass", "}"].join("\n");
		expect(checkBareCatchBlock(code, TS)).toEqual([]);
	});

	it("N6: does NOT flag a catch whose body opens on a later line with real code (not comment/blank)", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e)",
			"  {",
			"    log(e);",
			"  }",
			"}",
		].join("\n");
		expect(checkBareCatchBlock(code, TS)).toEqual([]);
	});

	it("N7: does NOT flag an unrelated line merely because a comment+closing-brace pair happens to follow it two lines later", () => {
		// If the comment-only-catch gate ever ran unconditionally (independent of
		// whether THIS line opens a catch), any line followed by a comment then
		// `}` would false-positive. `doSomething();` here has nothing to do with
		// catch at all.
		const code = ["function f() {", "  doSomething();", "  // unrelated comment", "}"].join("\n");
		expect(checkBareCatchBlock(code, TS)).toEqual([]);
	});

	it("N8: does not crash and does not flag when a catch-open sits within one line of EOF (no room for the 2-line lookahead)", () => {
		const code = ["function f() {", "  catch (e)", "  {"].join("\n");
		expect(() => checkBareCatchBlock(code, TS)).not.toThrow();
		expect(checkBareCatchBlock(code, TS)).toEqual([]);
	});

	it("N9: does not crash when a same-line catch-open sits EXACTLY one line short of the 2-line lookahead (i+2 === lines.length)", () => {
		// catch-open (with body on the SAME line) at index 1; only ONE more line
		// exists after it (index 2), so `i + 2` (3) equals `lines.length` (3) —
		// the boundary where `<` must reject but `<=` would wrongly admit it and
		// read past the end of the array.
		const lines = ["function f() {", "  catch (e) {", "  x();"];
		expect(lines.length).toBe(3);
		expect(() => checkBareCatchBlock(lines.join("\n"), TS)).not.toThrow();
		expect(checkBareCatchBlock(lines.join("\n"), TS)).toEqual([]);
	});
});

describe("checkBareCatchBlock — regex/boundary precision", () => {
	it("matches `catch(e) {}` with ZERO whitespace between `catch` and the parens", () => {
		const code = "function f() { try { g(); } catch(e) {} }";
		expect(checkBareCatchBlock(code, TS).length).toBe(1);
	});

	it("matches a MULTI-CHARACTER bound variable name (exercises the `[^)]*` run, not a single char)", () => {
		const code = "function f() { try { g(); } catch (err) {} }";
		expect(checkBareCatchBlock(code, TS).length).toBe(1);
	});

	it("matches `catch (e){}` with ZERO whitespace before the opening brace", () => {
		const code = "function f() { try { g(); } catch (e){} }";
		expect(checkBareCatchBlock(code, TS).length).toBe(1);
	});

	it("matches a bare catch with a SPACE between the braces: `catch (e) { }`", () => {
		const code = "function f() { try { g(); } catch (e) { } }";
		expect(checkBareCatchBlock(code, TS).length).toBe(1);
	});

	it("trims leading/trailing whitespace from the reported line text", () => {
		const code = ["function f() {", "  try { g(); }", "      catch (e) {}      ", "}"].join("\n");
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toBe(
			"bare catch block silently swallows error: catch (e) {}",
		);
	});

	it("does not crash when a comment-only catch sits at the VERY END of the file (i+2 boundary, no lines left to read)", () => {
		const lines = ["function f() {", "  try { g(); }", "  catch (e) {"];
		expect(() => checkBareCatchBlock(lines.join("\n"), TS)).not.toThrow();
		expect(checkBareCatchBlock(lines.join("\n"), TS)).toEqual([]);
	});

	it("does not crash when the catch's own close is the LAST line — i+2 lands exactly one past the end (boundary must be `<`, not `<=`)", () => {
		// catch is at index 2 of 4 lines: i+2 === lines.length exactly.
		const lines = ["function f() {", "  try { g(); }", "  catch (e) {", "  }"];
		expect(() => checkBareCatchBlock(lines.join("\n"), TS)).not.toThrow();
		expect(checkBareCatchBlock(lines.join("\n"), TS)).toEqual([]);
	});

	it("reports the exact 1-based line number for a comment-only catch found several lines into the file", () => {
		const code = [
			"function f() {",
			"  doOtherStuff();",
			"  try { g(); }",
			"  catch (e) {",
			"    // swallowed",
			"  }",
			"}",
		].join("\n");
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(4);
	});

	it("trims leading/trailing whitespace from the reported line text for a comment-only catch", () => {
		const code = ["function f() {", "  try { g(); }", "      catch (e) {      ", "  // note", "  }", "}"].join(
			"\n",
		);
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toBe(
			"catch block with only a comment — error is silently ignored: catch (e) {",
		);
	});

	it("truncates a comment-only catch's reported line text to 100 characters", () => {
		const longVar = "e".repeat(150);
		const code = [`try { g(); } catch (${longVar}) {`, "  // note", "}"].join("\n");
		const out = checkBareCatchBlock(code, TS);
		expect(out.length).toBe(1);
		const marker = "error is silently ignored: ";
		const text = nonNull(out[0]).text;
		const excerpt = text.slice(text.indexOf(marker) + marker.length);
		expect(excerpt.length).toBe(100);
	});

	it("caps at exactly 10 matches when 11 comment-only catches are present", () => {
		const lines: string[] = [];
		for (let i = 0; i < 11; i++) {
			lines.push(`try { g(); } catch (e${i}) {`, "  // swallow", "}");
		}
		const out = checkBareCatchBlock(lines.join("\n"), TS);
		expect(out.length).toBe(10);
	});

	it("does not crash when a Python `except:` sits at the VERY END of the file (i+1 boundary, no `pass` line to read)", () => {
		const lines = ["def f():", "    try:", "        g()", "    except:"];
		expect(() => checkBareCatchBlock(lines.join("\n"), "src/lib/foo.py")).not.toThrow();
		expect(checkBareCatchBlock(lines.join("\n"), "src/lib/foo.py")).toEqual([]);
	});

	it("Python `except:` regex requires the colon to be followed only by optional whitespace to end of line — trailing whitespace still matches", () => {
		const code = ["def f():", "    try:", "        g()", "    except:   ", "        pass"].join(
			"\n",
		);
		expect(checkBareCatchBlock(code, "src/lib/foo.py").length).toBe(1);
	});

	it("does NOT match a Python `except X: <code>` line where real code follows the colon on the SAME line (the `$` anchor requires only whitespace to end of line)", () => {
		const code = [
			"def f():",
			"    try:",
			"        g()",
			"    except Exception: log(e)",
			"    pass",
		].join("\n");
		// The line after the except is a bare `pass`, so if the except-detector
		// regex wrongly matched here (missing its end-of-line anchor), this
		// would be misreported as a bare except/pass.
		expect(checkBareCatchBlock(code, "src/lib/foo.py")).toEqual([]);
	});

	it("does NOT take the Python except/pass path for a NON-Python file, even when its content matches the except+pass shape (the `.py` extension check is mandatory, not optional)", () => {
		const code = ["function f() {", "  except Something:", "  pass", "}"].join("\n");
		expect(checkBareCatchBlock(code, TS)).toEqual([]);
	});

	it("trims leading/trailing whitespace from the reported line text for a Python bare except", () => {
		const code = ["def f():", "    try:", "        g()", "        except:      ", "        pass"].join(
			"\n",
		);
		const out = checkBareCatchBlock(code, "src/lib/foo.py");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toBe("bare except/pass silently swallows error: except:");
	});

	it("truncates a Python bare except's reported line text to 100 characters", () => {
		// The padding must sit BEFORE the colon — the detector regex requires
		// the colon to be followed by only optional whitespace to end of line.
		const longPadding = "x".repeat(150);
		const code = [
			"def f():",
			"    try:",
			"        g()",
			`    except Exception${longPadding}:`,
			"        pass",
		].join("\n");
		const out = checkBareCatchBlock(code, "src/lib/foo.py");
		expect(out.length).toBe(1);
		const marker = "silently swallows error: ";
		const text = nonNull(out[0]).text;
		const excerpt = text.slice(text.indexOf(marker) + marker.length);
		expect(excerpt.length).toBe(100);
	});

	it("reports the exact 1-based line number for a Python bare except found several lines in", () => {
		const code = [
			"def f():",
			"    do_other_stuff()",
			"    try:",
			"        g()",
			"    except:",
			"        pass",
		].join("\n");
		const out = checkBareCatchBlock(code, "src/lib/foo.py");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(5);
	});
});

// ===========================================
// checkCatchReturnNull
// ===========================================

describe("checkCatchReturnNull — positive (must fire)", () => {
	it("P1: flags `return null;` inside a catch block", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    return null;",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchReturnNull(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("return null/undefined in catch");
	});

	it("P2: flags `return undefined;` inside a catch block", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    return undefined;",
			"  }",
			"}",
		].join("\n");
		expect(checkCatchReturnNull(code, TS).length).toBe(1);
	});

	it("P3: flags `return null` with no trailing semicolon", () => {
		const code = ["function f() {", "  try { g(); }", "  catch (e) {", "    return null", "  }", "}"].join(
			"\n",
		);
		expect(checkCatchReturnNull(code, TS).length).toBe(1);
	});

	it("P4: still flags `return null;` after nested braces open and re-close within the same catch", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    if (e) {",
			"      log(e);",
			"    }",
			"    return null;",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchReturnNull(code, TS);
		expect(out.length).toBe(1);
	});

	it("P5: caps at exactly 10 matches when 11 catches each return null", () => {
		const lines: string[] = ["function f() {"];
		for (let i = 0; i < 11; i++) {
			lines.push(`  try { g(); } catch (e${i}) {`, "    return null;", "  }");
		}
		lines.push("}");
		const out = checkCatchReturnNull(lines.join("\n"), TS);
		expect(out.length).toBe(10);
	});
});

describe("checkCatchReturnNull — negative (must NOT fire)", () => {
	it("N1: does NOT flag `return null;` outside any catch block", () => {
		const code = ["function f() {", "  return null;", "}"].join("\n");
		expect(checkCatchReturnNull(code, TS)).toEqual([]);
	});

	it("N2: does NOT flag a catch that returns a non-null value", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    return { error: e };",
			"  }",
			"}",
		].join("\n");
		expect(checkCatchReturnNull(code, TS)).toEqual([]);
	});

	it("N3: correctly closes catch tracking at its OWN closing brace — a later unrelated function's `return null;` is not attributed to it", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    log(e);",
			"  }",
			"  return doOther();",
			"}",
			"function h() {",
			"  return null;",
			"}",
		].join("\n");
		// If catch-block tracking never closed (e.g. the brace-depth decrement broke),
		// h()'s unrelated `return null;` would be misattributed to f()'s catch.
		expect(checkCatchReturnNull(code, TS)).toEqual([]);
	});

	it("N4: skips test files entirely", () => {
		const code = ["catch (e) {", "  return null;", "}"].join("\n");
		expect(checkCatchReturnNull(code, "src/lib/foo.test.ts")).toEqual([]);
	});

	it("N5: skips non-JS/TS extensions, even when the content would otherwise trigger the check", () => {
		const code = ["catch (e) {", "  return null;", "}"].join("\n");
		expect(checkCatchReturnNull(code, "src/lib/foo.py")).toEqual([]);
	});
});

describe("checkCatchReturnNull — regex/boundary precision", () => {
	it("matches a bare `catch {` (no parens at all) that returns null", () => {
		const code = ["function f() {", "  try { g(); }", "  catch {", "    return null;", "  }", "}"].join(
			"\n",
		);
		expect(checkCatchReturnNull(code, TS).length).toBe(1);
	});

	it("truncates the reported catch-line excerpt to 80 characters", () => {
		const filler = "x".repeat(100);
		const code = [
			"function f() {",
			"  try { g(); }",
			`  catch (e) { /* ${filler} */`,
			"    return null;",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchReturnNull(code, TS);
		expect(out.length).toBe(1);
		const marker = "return null/undefined in catch — error context is lost: ";
		const text = nonNull(out[0]).text;
		expect(text.slice(marker.length).length).toBe(80);
	});

	it("matches `catch(e){` with ZERO whitespace between `catch` and the parens", () => {
		const code = ["function f() {", "  try { g(); }", "  catch(e){", "    return null;", "  }", "}"].join(
			"\n",
		);
		expect(checkCatchReturnNull(code, TS).length).toBe(1);
	});

	it("matches a MULTI-CHARACTER bound variable name", () => {
		const code = ["function f() {", "  try { g(); }", "  catch (err) {", "    return null;", "  }", "}"].join(
			"\n",
		);
		expect(checkCatchReturnNull(code, TS).length).toBe(1);
	});

	it("matches `return  null;` with TWO spaces after `return` (the gap must be one-or-more, not exactly one)", () => {
		const code = ["function f() {", "  try { g(); }", "  catch (e) {", "    return  null;", "  }", "}"].join(
			"\n",
		);
		expect(checkCatchReturnNull(code, TS).length).toBe(1);
	});

	it("does NOT attribute a `return null;` to a catch that has ALREADY closed on the immediately preceding line (catchDepth must turn off at depth 0, not only below 0)", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    log(e);",
			"  }",
			"  return null;",
			"}",
		].join("\n");
		// The `return null;` is a SIBLING statement after the catch closes, not
		// inside it — a one-line-late close would wrongly flag it.
		expect(checkCatchReturnNull(code, TS)).toEqual([]);
	});

	it("trims leading/trailing whitespace from the reported catch-line text", () => {
		const code = ["function f() {", "  try { g(); }", "      catch (e) {      ", "    return null;", "  }", "}"].join(
			"\n",
		);
		const out = checkCatchReturnNull(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toBe(
			"return null/undefined in catch — error context is lost: catch (e) {",
		);
	});

	it("reports the exact 1-based line number of the `return null;` statement, not the catch's own line", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    logSomething();",
			"    return null;",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchReturnNull(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(5);
	});

	it("truncates the reported catch-line text to 80 characters", () => {
		const longSuffix = "x".repeat(100);
		const code = [
			"function f() {",
			"  try { g(); }",
			`  catch (e) { /* ${longSuffix} */`,
			"    return null;",
			"  }",
			"}",
		].join("\n");
		const out = checkCatchReturnNull(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text.length).toBeLessThanOrEqual(
			"return null/undefined in catch — error context is lost: ".length + 80,
		);
	});
});

// ===========================================
// checkThrowAsControlFlow
// ===========================================

describe("checkThrowAsControlFlow — positive (must fire)", () => {
	it('P1: flags throw new Error("not found: ...")', () => {
		const code = 'function f() { throw new Error("not found: id"); }';
		const out = checkThrowAsControlFlow(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("throw for expected condition");
	});

	it('P2: flags throw new TypeError("invalid ...")', () => {
		const code = 'function f() { throw new TypeError("invalid input"); }';
		expect(checkThrowAsControlFlow(code, TS).length).toBe(1);
	});

	it('P3: flags throw new RangeError("missing ...")', () => {
		const code = 'function f() { throw new RangeError("missing value"); }';
		expect(checkThrowAsControlFlow(code, TS).length).toBe(1);
	});

	it('P4: flags "expected ..." phrasing', () => {
		const code = 'function f() { throw new Error("expected a string"); }';
		expect(checkThrowAsControlFlow(code, TS).length).toBe(1);
	});

	it('P5: flags "no such ..." phrasing', () => {
		const code = 'function f() { throw new Error("no such file"); }';
		expect(checkThrowAsControlFlow(code, TS).length).toBe(1);
	});

	it('P6: flags "does not exist" phrasing', () => {
		const code = 'function f() { throw new Error("does not exist"); }';
		expect(checkThrowAsControlFlow(code, TS).length).toBe(1);
	});

	it('P7: flags "cannot find ..." phrasing', () => {
		const code = 'function f() { throw new Error("cannot find module"); }';
		expect(checkThrowAsControlFlow(code, TS).length).toBe(1);
	});

	it('P8: flags "failed to ..." phrasing', () => {
		const code = 'function f() { throw new Error("failed to parse"); }';
		expect(checkThrowAsControlFlow(code, TS).length).toBe(1);
	});

	it("P9: is case-insensitive on the message phrase", () => {
		const code = 'function f() { throw new Error("NOT FOUND: id"); }';
		expect(checkThrowAsControlFlow(code, TS).length).toBe(1);
	});

	it("P10: caps at exactly 5 matches when 6 are present", () => {
		const lines: string[] = [];
		for (let i = 0; i < 6; i++) lines.push(`function f${i}() { throw new Error("not found: ${i}"); }`);
		const out = checkThrowAsControlFlow(lines.join("\n"), TS);
		expect(out.length).toBe(5);
	});
});

describe("checkThrowAsControlFlow — negative (must NOT fire)", () => {
	it("N1: does NOT flag a throw whose message is not a control-flow phrase", () => {
		const code = 'function f() { throw new Error("database connection lost"); }';
		expect(checkThrowAsControlFlow(code, TS)).toEqual([]);
	});

	it("N2: does NOT flag a custom Error subclass (constructor name restricted to Error/TypeError/RangeError)", () => {
		const code = 'function f() { throw new HttpError("not found: user"); }';
		expect(checkThrowAsControlFlow(code, TS)).toEqual([]);
	});

	it("N3: does NOT flag a commented-out throw", () => {
		const code = ['function f() {', '  // throw new Error("not found: id");', '}'].join("\n");
		expect(checkThrowAsControlFlow(code, TS)).toEqual([]);
	});

	it("N4: skips test files entirely", () => {
		const code = 'throw new Error("not found: id");';
		expect(checkThrowAsControlFlow(code, "src/lib/foo.test.ts")).toEqual([]);
	});

	it("N5: skips non-JS/TS extensions, even when the content would otherwise trigger the check", () => {
		const code = 'throw new Error("not found: id");';
		expect(checkThrowAsControlFlow(code, "src/lib/foo.py")).toEqual([]);
	});
});

describe("checkThrowAsControlFlow — regex spacing precision", () => {
	it("matches `throw  new  Error(` with EXTRA whitespace on both sides of `new`", () => {
		const code = 'function f() { throw  new  Error("not found: id"); }';
		expect(checkThrowAsControlFlow(code, TS).length).toBe(1);
	});

	it("matches `Error (` with a space before the call parens", () => {
		const code = 'function f() { throw new Error ("not found: id"); }';
		expect(checkThrowAsControlFlow(code, TS).length).toBe(1);
	});

	it("matches `( \"not found` with a space right after the opening paren", () => {
		const code = 'function f() { throw new Error( "not found: id"); }';
		expect(checkThrowAsControlFlow(code, TS).length).toBe(1);
	});

	it("reports the exact 1-based line number of the throw", () => {
		const code = ["function f() {", '  throw new Error("not found: id");', "}"].join("\n");
		const out = checkThrowAsControlFlow(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(2);
	});

	it("embeds the ACTUAL trimmed source line, not a stray single character", () => {
		const code = ['      throw new Error("not found: id");'].join("\n");
		const out = checkThrowAsControlFlow(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toBe(
			'throw for expected condition — return a Result or error value instead: throw new Error("not found: id");',
		);
	});

	it("truncates the trailing source-line excerpt to 120 characters", () => {
		const filler = "x".repeat(150);
		const code = `throw new Error("not found: ${filler}");`;
		const out = checkThrowAsControlFlow(code, TS);
		expect(out.length).toBe(1);
		const text = nonNull(out[0]).text;
		const marker = "return a Result or error value instead: ";
		const excerpt = text.slice(text.indexOf(marker) + marker.length);
		expect(excerpt.length).toBe(120);
	});
});

// ===========================================
// checkUntypedCatch
// ===========================================

describe("checkUntypedCatch — positive (must fire)", () => {
	it("P1: flags an untyped catch with no narrowing at all", () => {
		const code = ["function f() {", "  try { g(); }", "  catch (e) {", "    log(e);", "  }", "}"].join(
			"\n",
		);
		const out = checkUntypedCatch(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("untyped catch(e) without narrowing");
	});

	it("P2: still flags when narrowing appears OUTSIDE the 10-line lookahead window", () => {
		// catch is at index 2; endSearch = min(2+10, lines.length) = 12, so the
		// window covers indices 3..11 (9 lines). The narrowing line must sit at
		// index >= 12 to land genuinely outside it — hence 9 filler statements,
		// not 8 (an 8-filler version puts the narrowing at index 11, which is
		// still INSIDE the window and would wrongly assert 0 findings).
		const lines = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    a();",
			"    b();",
			"    c();",
			"    d();",
			"    f2();",
			"    g2();",
			"    h();",
			"    i2();",
			"    j2();",
			"    if (e instanceof Error) { retry(); }",
			"  }",
			"}",
		];
		const out = checkUntypedCatch(lines.join("\n"), TS);
		expect(out.length).toBe(1);
	});

	it("P3: caps at exactly 5 matches when 6 untyped catches are present", () => {
		const lines: string[] = ["function f() {"];
		for (let i = 0; i < 6; i++) lines.push(`  try { g(); } catch (e${i}) { log(e${i}); }`);
		lines.push("}");
		const out = checkUntypedCatch(lines.join("\n"), TS);
		expect(out.length).toBe(5);
	});
});

describe("checkUntypedCatch — negative (must NOT fire)", () => {
	it("N1: does NOT flag when `instanceof` narrowing is present", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    if (e instanceof Error) throw e;",
			"  }",
			"}",
		].join("\n");
		expect(checkUntypedCatch(code, TS)).toEqual([]);
	});

	it("N2: does NOT flag when `.${varName}._tag` narrowing is present", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    if (e._tag === 'NetworkError') return;",
			"  }",
			"}",
		].join("\n");
		expect(checkUntypedCatch(code, TS)).toEqual([]);
	});

	it("N3: does NOT flag when `.${varName}.code` narrowing is present", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    if (e.code === 'ENOENT') return;",
			"  }",
			"}",
		].join("\n");
		expect(checkUntypedCatch(code, TS)).toEqual([]);
	});

	it("N4: does NOT flag when `typeof ${varName}` narrowing is present", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    if (typeof e === 'string') return;",
			"  }",
			"}",
		].join("\n");
		expect(checkUntypedCatch(code, TS)).toEqual([]);
	});

	it("N5: does NOT flag when `as SomeError` narrowing is present", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    const err = e as NetworkError;",
			"  }",
			"}",
		].join("\n");
		expect(checkUntypedCatch(code, TS)).toEqual([]);
	});

	it("N6: skips test files entirely", () => {
		const code = ["catch (e) {", "  log(e);", "}"].join("\n");
		expect(checkUntypedCatch(code, "src/lib/foo.test.ts")).toEqual([]);
	});

	it("N7: skips non-JS/TS extensions, even when the content would otherwise trigger the check", () => {
		const code = ["catch (e) {", "  log(e);", "}"].join("\n");
		expect(checkUntypedCatch(code, "src/lib/foo.py")).toEqual([]);
	});
});

describe("checkUntypedCatch — regex/boundary precision", () => {
	it("matches `catch(e){` with ZERO whitespace between `catch` and the parens", () => {
		const code = ["function f() {", "  try { g(); }", "  catch(e){", "    log(e);", "  }", "}"].join(
			"\n",
		);
		expect(checkUntypedCatch(code, TS).length).toBe(1);
	});

	it("matches `catch( e){` with a space right after the opening paren", () => {
		const code = ["function f() {", "  try { g(); }", "  catch( e){", "    log(e);", "  }", "}"].join(
			"\n",
		);
		expect(checkUntypedCatch(code, TS).length).toBe(1);
	});

	it("matches `catch(e ){` with a space right before the closing paren", () => {
		const code = ["function f() {", "  try { g(); }", "  catch(e ){", "    log(e);", "  }", "}"].join(
			"\n",
		);
		expect(checkUntypedCatch(code, TS).length).toBe(1);
	});

	it("does NOT treat instanceof-shaped text on the line IMMEDIATELY BEFORE the catch as narrowing for it (the lookahead must start AFTER the catch line, not before)", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  if (x instanceof Foo) {}",
			"  catch (e) {",
			"    log(e);",
			"  }",
			"}",
		].join("\n");
		// The catch itself has no narrowing — the `instanceof` on the immediately
		// preceding line belongs to an unrelated, already-closed `if`, not this
		// catch's body.
		const out = checkUntypedCatch(code, TS);
		expect(out.length).toBe(1);
	});

	it("embeds the ACTUAL trimmed source line, not a stray single character", () => {
		const code = ["      catch (e) {", "        log(e);", "      }"].join("\n");
		const out = checkUntypedCatch(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toBe(
			"untyped catch(e) without narrowing — use instanceof, tagged errors, or error codes: catch (e) {",
		);
	});

	it("truncates the trailing source-line excerpt to 100 characters", () => {
		const filler = "x".repeat(150);
		const code = [`  catch (e) { /* ${filler} */`, "    log(e);", "  }"].join("\n");
		const out = checkUntypedCatch(code, TS);
		expect(out.length).toBe(1);
		const text = nonNull(out[0]).text;
		const marker = "use instanceof, tagged errors, or error codes: ";
		const excerpt = text.slice(text.indexOf(marker) + marker.length);
		expect(excerpt.length).toBe(100);
	});

	it("reports the exact 1-based line number of the catch, not the first narrowing-search line", () => {
		const code = [
			"function f() {",
			"  doOtherStuff();",
			"  try { g(); }",
			"  catch (e) {",
			"    log(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkUntypedCatch(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(4);
	});

	it("a line containing BOTH `}` and `{` (e.g. `} else {`) does NOT prematurely stop the narrowing search", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    if (x) {",
			"      y();",
			"    } else {",
			"      if (e instanceof Error) log(e);",
			"    }",
			"  }",
			"}",
		].join("\n");
		// The narrowing is found on the line RIGHT AFTER `} else {` — with no
		// other lone-`}` line in between. The break condition requires a "}"
		// WITHOUT a "{" on the same line, so `} else {` (both present) must not
		// stop the scan before the narrowing line is reached.
		expect(checkUntypedCatch(code, TS)).toEqual([]);
	});

	it("a LONE closing brace (no `{` on the same line) DOES stop the narrowing search early, even when real narrowing exists further down", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    if (x) {",
			"      y();",
			"    }",
			"    if (e instanceof Error) log(e);",
			"  }",
			"}",
		].join("\n");
		// The lone `}` closing the nested if-block (line 6) is indistinguishable
		// to this heuristic from the catch's own close, so the scan gives up
		// there and never sees the instanceof narrowing two lines later.
		const out = checkUntypedCatch(code, TS);
		expect(out.length).toBe(1);
	});

	it("matches `as  NetworkError` with TWO spaces (the gap must be one-or-more, not exactly one)", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  catch (e) {",
			"    const err = e as  NetworkError;",
			"  }",
			"}",
		].join("\n");
		expect(checkUntypedCatch(code, TS)).toEqual([]);
	});

	it("matches `catch ( e )` with EXTRA whitespace on both sides of the bound variable", () => {
		const code = ["function f() {", "  try { g(); }", "  catch ( e ) {", "    log(e);", "  }", "}"].join(
			"\n",
		);
		expect(checkUntypedCatch(code, TS).length).toBe(1);
	});

	it("does NOT let text on the line BEFORE the catch count as narrowing (the lookahead must start at i+1, not i-1)", () => {
		const code = [
			"function f() {",
			"  try { g(); }",
			"  if (x instanceof Error) {}",
			"  catch (e) {",
			"    log(e);",
			"  }",
			"}",
		].join("\n");
		// The `instanceof Error` text sits on the line immediately BEFORE the
		// catch — unrelated prior code, not narrowing inside this catch — so
		// this must still be flagged as untyped.
		expect(checkUntypedCatch(code, TS).length).toBe(1);
	});

	it("truncates the trailing source-line excerpt to 100 characters", () => {
		const filler = "x".repeat(150);
		const code = `catch (e) { /* ${filler} */`;
		const out = checkUntypedCatch(code, TS);
		expect(out.length).toBe(1);
		const text = nonNull(out[0]).text;
		const marker = "tagged errors, or error codes: ";
		const excerpt = text.slice(text.indexOf(marker) + marker.length);
		expect(excerpt.length).toBe(100);
	});
});

// ===========================================
// checkErrorStringComparison
// ===========================================

describe("checkErrorStringComparison — positive (must fire)", () => {
	it("P1: flags `err.message === \"...\"`", () => {
		const code = 'if (err.message === "not found") { retry(); }';
		const out = checkErrorStringComparison(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("comparing error.message string");
	});

	it("P2: flags `err.message == \"...\"` (loose equality)", () => {
		const code = 'if (err.message == "not found") { retry(); }';
		expect(checkErrorStringComparison(code, TS).length).toBe(1);
	});

	it('P3: flags `err.message.includes("...")`', () => {
		const code = 'if (err.message.includes("timeout")) { retry(); }';
		expect(checkErrorStringComparison(code, TS).length).toBe(1);
	});

	it("P4: caps at exactly 5 matches when 6 are present", () => {
		const lines: string[] = [];
		for (let i = 0; i < 6; i++) lines.push(`if (err.message === "case ${i}") { retry(); }`);
		const out = checkErrorStringComparison(lines.join("\n"), TS);
		expect(out.length).toBe(5);
	});

	it("reports the exact 1-based line number of the comparison, found several lines into the file", () => {
		const code = [
			"function f() {",
			"  doOtherStuff();",
			"  logSomething();",
			'  if (err.message === "not found") { retry(); }',
			"}",
		].join("\n");
		const out = checkErrorStringComparison(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(4);
	});
});

describe("checkErrorStringComparison — negative (must NOT fire)", () => {
	it("N1: does NOT flag comparisons on a non-.message property", () => {
		const code = 'if (err.code === "ENOENT") { retry(); }';
		expect(checkErrorStringComparison(code, TS)).toEqual([]);
	});

	it("N2: does NOT flag `.message` used without a quoted-string comparison", () => {
		const code = "if (err.message.length > 0) { log(err.message); }";
		expect(checkErrorStringComparison(code, TS)).toEqual([]);
	});

	it("N3: does NOT flag a commented-out comparison", () => {
		const code = '// if (err.message === "not found") { retry(); }';
		expect(checkErrorStringComparison(code, TS)).toEqual([]);
	});

	it("N4: skips test files entirely", () => {
		const code = 'if (err.message === "not found") { retry(); }';
		expect(checkErrorStringComparison(code, "src/lib/foo.test.ts")).toEqual([]);
	});

	it("N5: skips non-JS/TS extensions", () => {
		const code = 'if err.message == "not found": retry()';
		expect(checkErrorStringComparison(code, "src/lib/foo.py")).toEqual([]);
	});

	it("N6: does NOT flag `.message ===` compared against a bare identifier, not a quoted string (the char after `===?` must be a quote)", () => {
		const code = "if (err.message === someOtherVar) { retry(); }";
		expect(checkErrorStringComparison(code, TS)).toEqual([]);
	});
});

describe("checkErrorStringComparison — regex spacing precision", () => {
	it("matches with EXTRA whitespace before `===`", () => {
		const code = 'if (err.message  === "not found") { retry(); }';
		expect(checkErrorStringComparison(code, TS).length).toBe(1);
	});

	it("matches with EXTRA whitespace after `===`, before the quote", () => {
		const code = 'if (err.message ===  "not found") { retry(); }';
		expect(checkErrorStringComparison(code, TS).length).toBe(1);
	});

	it("matches `.includes (` with a space before the call parens", () => {
		const code = 'if (err.message.includes ("timeout")) { retry(); }';
		expect(checkErrorStringComparison(code, TS).length).toBe(1);
	});

	it("matches `.includes( ` with a space right after the opening paren", () => {
		const code = 'if (err.message.includes( "timeout")) { retry(); }';
		expect(checkErrorStringComparison(code, TS).length).toBe(1);
	});

	it("reports the exact 1-based line number of the comparison", () => {
		const code = ["function f() {", '  if (err.message === "not found") { retry(); }', "}"].join(
			"\n",
		);
		const out = checkErrorStringComparison(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(2);
	});

	it("embeds the ACTUAL trimmed source line, not a stray single character", () => {
		const code = '      if (err.message === "not found") { retry(); }';
		const out = checkErrorStringComparison(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toBe(
			'comparing error.message string — fragile, use error codes or instanceof instead: if (err.message === "not found") { retry(); }',
		);
	});

	it("truncates the trailing source-line excerpt to 120 characters", () => {
		const filler = "x".repeat(150);
		const code = `if (err.message === "${filler}") { retry(); }`;
		const out = checkErrorStringComparison(code, TS);
		expect(out.length).toBe(1);
		const text = nonNull(out[0]).text;
		const marker = "fragile, use error codes or instanceof instead: ";
		const excerpt = text.slice(text.indexOf(marker) + marker.length);
		expect(excerpt.length).toBe(120);
	});

	it("embeds the ACTUAL trimmed source line, not a stray single character", () => {
		const code = ["      if (a) { x(); }", '      if (err.message === "not found") { retry(); }'].join(
			"\n",
		);
		const out = checkErrorStringComparison(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toBe(
			'comparing error.message string — fragile, use error codes or instanceof instead: if (err.message === "not found") { retry(); }',
		);
	});

	it("truncates the trailing source-line excerpt to 120 characters", () => {
		const filler = "x".repeat(150);
		const code = `if (err.message === "${filler}") { retry(); }`;
		const out = checkErrorStringComparison(code, TS);
		expect(out.length).toBe(1);
		const text = nonNull(out[0]).text;
		const marker = "use error codes or instanceof instead: ";
		const excerpt = text.slice(text.indexOf(marker) + marker.length);
		expect(excerpt.length).toBe(120);
	});
});

// ===========================================
// checkInconsistentErrorStrategy
// ===========================================

describe("checkInconsistentErrorStrategy — positive (must fire)", () => {
	it("P1: flags a file mixing all three error strategies (exact counts in the message)", () => {
		const lines = [
			"function a() {",
			"  throw new Error('a');",
			"}",
			"function b() {",
			"  return null;",
			"}",
			"function c() {",
			"  return null;",
			"}",
			"function d() {",
			"  return { error: true };",
			"}",
			"function e() {",
			"  return 1;",
			"}",
			"function f() {",
			"  return 2;",
			"}",
			"function g() {",
			"  return 3;",
			"}",
			"function h() {",
			"  return 4;",
			"}",
		];
		expect(lines.length).toBeGreaterThanOrEqual(20);
		const out = checkInconsistentErrorStrategy(lines.join("\n"), TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(1);
		expect(nonNull(out[0]).text).toBe(
			"file uses 3 different error strategies (throw: 1, return null: 2, return {error}: 1) — pick one approach, preferably Result types or typed error returns",
		);
	});
});

describe("checkInconsistentErrorStrategy — negative (must NOT fire)", () => {
	it("N1: does NOT flag a file using only two strategies", () => {
		const lines = [
			"function a() {",
			"  throw new Error('a');",
			"}",
			"function b() {",
			"  return null;",
			"}",
			"function c() {",
			"  return null;",
			"}",
			"function d() { return 1; }",
			"function e() { return 2; }",
			"function f() { return 3; }",
			"function g() { return 4; }",
			"function h() { return 5; }",
			"function i() { return 6; }",
			"function j() { return 7; }",
			"function k() { return 8; }",
			"function l() { return 9; }",
			"function m() { return 10; }",
			"function n() { return 11; }",
		];
		expect(lines.length).toBeGreaterThanOrEqual(20);
		expect(checkInconsistentErrorStrategy(lines.join("\n"), TS)).toEqual([]);
	});

	it("N2: does NOT flag when returnNullCount is exactly 1 (needs > 1 to count as a strategy)", () => {
		const lines = [
			"function a() {",
			"  throw new Error('a');",
			"}",
			"function b() {",
			"  return null;",
			"}",
			"function d() {",
			"  return { error: true };",
			"}",
			"function e() { return 1; }",
			"function f() { return 2; }",
			"function g() { return 3; }",
			"function h() { return 4; }",
			"function i() { return 5; }",
			"function j() { return 6; }",
			"function k() { return 7; }",
			"function l() { return 8; }",
			"function m() { return 9; }",
			"function n() { return 10; }",
			"function o() { return 11; }",
		];
		expect(lines.length).toBeGreaterThanOrEqual(20);
		expect(checkInconsistentErrorStrategy(lines.join("\n"), TS)).toEqual([]);
	});

	it("N3: does NOT flag a short file (< 20 lines) even with all three strategies present", () => {
		const lines = [
			"function a() { throw new Error('a'); }",
			"function b() { return null; }",
			"function c() { return null; }",
			"function d() { return { error: true }; }",
		];
		expect(lines.length).toBeLessThan(20);
		expect(checkInconsistentErrorStrategy(lines.join("\n"), TS)).toEqual([]);
	});

	it("N4: skips test files entirely, even when the content would otherwise trigger the check", () => {
		const lines: string[] = [];
		for (let i = 0; i < 6; i++) lines.push("throw new Error('a');");
		for (let i = 0; i < 3; i++) lines.push("return null;");
		for (let i = 0; i < 6; i++) lines.push("return { error: true };");
		for (let i = 0; i < 6; i++) lines.push("noop();");
		expect(lines.length).toBeGreaterThanOrEqual(20);
		expect(checkInconsistentErrorStrategy(lines.join("\n"), "src/lib/foo.test.ts")).toEqual([]);
	});

	it("N5: skips non-JS/TS extensions, even when the content would otherwise trigger the check", () => {
		const lines: string[] = [];
		for (let i = 0; i < 6; i++) lines.push("throw new Error('a');");
		for (let i = 0; i < 3; i++) lines.push("return null;");
		for (let i = 0; i < 6; i++) lines.push("return { error: true };");
		for (let i = 0; i < 6; i++) lines.push("noop();");
		expect(lines.length).toBeGreaterThanOrEqual(20);
		expect(checkInconsistentErrorStrategy(lines.join("\n"), "src/lib/foo.py")).toEqual([]);
	});

	it("N6: does NOT flag a file with ZERO throws, even though returnNull>1 and returnErrorObj>0 are both present (only 2 real strategies — `throwCount > 0` must require an ACTUAL throw, not just be vacuously true)", () => {
		const lines: string[] = [
			"function a() { return null; }",
			"function b() { return null; }",
			"function c() { return { error: true }; }",
		];
		for (let i = 0; i < 17; i++) lines.push(`function f${i}() { return ${i}; }`);
		expect(lines.length).toBeGreaterThanOrEqual(20);
		expect(checkInconsistentErrorStrategy(lines.join("\n"), TS)).toEqual([]);
	});

	it("N8: does NOT flag a file with ZERO `return null;` occurrences at all — exercises the `stripped.match(...) || []` fallback for a truly-absent pattern, not just a below-threshold count", () => {
		const lines: string[] = [
			"function a() { throw new Error('a'); }",
			"function b() { throw new Error('b'); }",
			"function c() { return { error: true }; }",
		];
		for (let i = 0; i < 17; i++) lines.push(`function f${i}() { return ${i}; }`);
		expect(lines.length).toBeGreaterThanOrEqual(20);
		expect(checkInconsistentErrorStrategy(lines.join("\n"), TS)).toEqual([]);
	});

	it("N7: skips non-JS/TS extensions even when the content would otherwise trigger the check (proves the guard, not that .go content never matches)", () => {
		const lines: string[] = [
			"function a() { throw new Error('a'); }",
			"function b() { return null; }",
			"function c() { return null; }",
			"function d() { return { error: true }; }",
		];
		for (let i = 0; i < 16; i++) lines.push(`function f${i}() { return ${i}; }`);
		expect(lines.length).toBeGreaterThanOrEqual(20);
		expect(checkInconsistentErrorStrategy(lines.join("\n"), "src/lib/foo.go")).toEqual([]);
	});
});

describe("checkInconsistentErrorStrategy — regex spacing precision", () => {
	function pad(lines: string[]): string {
		const out = [...lines];
		while (out.length < 20) out.push(`function pad${out.length}() { return ${out.length}; }`);
		return out.join("\n");
	}

	it("counts `throw  new  Error` with extra whitespace as a throw-strategy occurrence", () => {
		const code = pad([
			"function a() { throw  new  Error('a'); }",
			"function b() { return null; }",
			"function c() { return null; }",
			"function d() { return { error: true }; }",
		]);
		const out = checkInconsistentErrorStrategy(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("throw: 1");
	});

	it("counts `throw new HttpError` (a multi-character custom subclass name) as a throw-strategy occurrence", () => {
		const code = pad([
			"function a() { throw new HttpError('a'); }",
			"function b() { return null; }",
			"function c() { return null; }",
			"function d() { return { error: true }; }",
		]);
		const out = checkInconsistentErrorStrategy(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("throw: 1");
	});

	it("counts `return null ;` (whitespace BEFORE the mandatory semicolon) as a return-null occurrence", () => {
		const code = pad([
			"function a() { throw new Error('a'); }",
			"function b() { return null ; }",
			"function c() { return null ; }",
			"function d() { return { error: true }; }",
		]);
		const out = checkInconsistentErrorStrategy(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("return null: 2");
	});

	it("counts `return  {` with extra whitespace between `return` and the brace as a return-error-object occurrence", () => {
		const code = pad([
			"function a() { throw new Error('a'); }",
			"function b() { return null; }",
			"function c() { return null; }",
			"function d() { return  { error: true }; }",
		]);
		const out = checkInconsistentErrorStrategy(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("return {error}: 1");
	});

	it("counts `return  null;` with extra whitespace as a return-null occurrence", () => {
		const code = pad([
			"function a() { throw new Error('a'); }",
			"function b() { return  null; }",
			"function c() { return  null; }",
			"function d() { return { error: true }; }",
		]);
		const out = checkInconsistentErrorStrategy(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("return null: 2");
	});

	it("counts `return {  error` with extra whitespace after the brace as a return-error-object occurrence", () => {
		const code = pad([
			"function a() { throw new Error('a'); }",
			"function b() { return null; }",
			"function c() { return null; }",
			"function d() { return {  error: true }; }",
		]);
		const out = checkInconsistentErrorStrategy(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("return {error}: 1");
	});

	it("counts `return { success  :  false` with extra whitespace around the colon", () => {
		const code = pad([
			"function a() { throw new Error('a'); }",
			"function b() { return null; }",
			"function c() { return null; }",
			"function d() { return { success  :  false }; }",
		]);
		const out = checkInconsistentErrorStrategy(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("return {error}: 1");
	});

	it("counts `return null ;` with a space before the semicolon", () => {
		const code = pad([
			"function a() { throw new Error('a'); }",
			"function b() { return null ; }",
			"function c() { return null ; }",
			"function d() { return { error: true }; }",
		]);
		const out = checkInconsistentErrorStrategy(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("return null: 2");
	});

	it("counts `return  {error` with TWO spaces after `return`", () => {
		const code = pad([
			"function a() { throw new Error('a'); }",
			"function b() { return null; }",
			"function c() { return null; }",
			"function d() { return  { error: true }; }",
		]);
		const out = checkInconsistentErrorStrategy(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("return {error}: 1");
	});
});

// ===========================================
// blankStringLiteralsPreserveLength (direct unit tests)
// ===========================================

describe("blankStringLiteralsPreserveLength — direct unit tests", () => {
	it("blanks a double-quoted string's interior, preserving length and delimiters", () => {
		const input = 'const x = "hello";';
		const out = blankStringLiteralsPreserveLength(input);
		expect(out.length).toBe(input.length);
		expect(out).toBe('const x = "     ";');
	});

	it("blanks a single-quoted string's interior, preserving length and delimiters", () => {
		const input = "const x = 'hi';";
		const out = blankStringLiteralsPreserveLength(input);
		expect(out.length).toBe(input.length);
		expect(out).toBe("const x = '  ';");
	});

	it("blanks a backtick template literal's interior, preserving length and delimiters", () => {
		const input = "const x = `hi`;";
		const out = blankStringLiteralsPreserveLength(input);
		expect(out.length).toBe(input.length);
		expect(out).toBe("const x = `  `;");
	});

	it("does NOT blank content outside any string literal", () => {
		const input = "if (a === b) { c(); }";
		expect(blankStringLiteralsPreserveLength(input)).toBe(input);
	});

	it("preserves a real embedded newline inside a template literal instead of blanking it", () => {
		const input = "`a\nb`";
		const out = blankStringLiteralsPreserveLength(input);
		expect(out.length).toBe(input.length);
		expect(out).toBe("` \n `");
		expect(out.split("\n").length).toBe(2);
	});

	it("treats an escaped quote inside a string as still-inside — does not end the string early", () => {
		// Raw content: x = "a\"b" trailing   (one literal backslash before the inner quote)
		const input = String.raw`x = "a\"b" trailing`;
		const out = blankStringLiteralsPreserveLength(input);
		expect(out.length).toBe(input.length);
		// The escaped quote is CONTENT (blanked along with a, \, b); the real closing
		// quote is the one right after "b"; everything after it stays literal.
		expect(out).toBe('x = "    " trailing');
	});

	it("does not overrun the output array on an unterminated string literal at EOF", () => {
		const input = 'x = "abc';
		const out = blankStringLiteralsPreserveLength(input);
		expect(out.length).toBe(input.length);
		expect(out).toBe('x = "   ');
	});

	it("blanks a backslash-escaped pair inside a double-quoted string", () => {
		// Raw content: x = "a\qb"  (a literal backslash followed by 'q' inside the string)
		const input = String.raw`x = "a\qb"`;
		const out = blankStringLiteralsPreserveLength(input);
		expect(out.length).toBe(input.length);
		expect(out).toBe('x = "    "');
	});

	it("P: blanks the backslash ITSELF (not just its escaped partner) to a single space — a mutant that drops this char loses one character of output length", () => {
		// Isolates the FIRST of the two length-preserving writes inside the
		// escape-pair branch: `if (s[i] !== "\n") out[i] = " ";` blanks the
		// backslash position. Two backslash-escape pairs in one literal so a
		// dropped/emptied write shows up as a 2-character length shortfall,
		// not a single off-by-one that could be misread as a boundary quirk.
		const input = String.raw`x = "a\qb\rc"`;
		const out = blankStringLiteralsPreserveLength(input);
		expect(out.length).toBe(input.length);
		expect(out.slice(0, 5)).toBe('x = "');
		expect(out.slice(-1)).toBe('"');
		expect(out.slice(5, -1)).toBe(" ".repeat(7));
	});

	it("does not extend the output when a backslash escape's second character is out of bounds (backslash is the very last character)", () => {
		// Content: x = "a\   (an unterminated string whose last char is a
		// dangling backslash — there is no character at i+1 to blank). Built via
		// concatenation, not a raw template, since a trailing single backslash
		// right before a closing backtick would escape the delimiter itself.
		const input = `x = "a${"\\"}`;
		const out = blankStringLiteralsPreserveLength(input);
		expect(out.length).toBe(input.length);
	});

	it("preserves a real newline that is the SECOND character of a backslash-escape pair, instead of blanking it", () => {
		// Raw content: `a\<newline>b`  — the character right after the backslash
		// is an actual newline, not letter content.
		const input = "`a\\\nb`";
		const out = blankStringLiteralsPreserveLength(input);
		expect(out.length).toBe(input.length);
		expect(out).toContain("\n");
		expect(out.split("\n").length).toBe(2);
	});

	it("blanks the escaped character strictly at i+1, not i-1 — an index shift there would corrupt an adjacent PRESERVED newline and leak the escaped character unblanked", () => {
		// Raw content: `<newline>\X`  (backtick, real newline, backslash, X,
		// backtick). The newline at i-1 must stay untouched, and the "X" at
		// i+1 must be blanked — a mutant writing to i-1 instead would blank
		// the newline AND leave the raw "X" showing through.
		const input = "`\n\\X`";
		const out = blankStringLiteralsPreserveLength(input);
		expect(out.length).toBe(input.length);
		expect(out).toBe("`\n  `");
	});
});

// ===========================================
// isMessageExtractionGuard (direct unit tests)
// ===========================================

describe("isMessageExtractionGuard — direct unit tests", () => {
	it("true for ' ? e.message : String(e)' right after the operand", () => {
		expect(isMessageExtractionGuard("Error", " ? e.message : String(e)", 0)).toBe(true);
	});

	it("false when className is not the base Error", () => {
		expect(isMessageExtractionGuard("TypeError", " ? e.message : String(e)", 0)).toBe(false);
	});

	it("true for the .stack extraction guard", () => {
		expect(isMessageExtractionGuard("Error", " ? e.stack : String(e)", 0)).toBe(true);
	});

	it("true for the .name extraction guard", () => {
		expect(isMessageExtractionGuard("Error", " ? e.name : String(e)", 0)).toBe(true);
	});

	it("true for the .cause extraction guard", () => {
		expect(isMessageExtractionGuard("Error", " ? e.cause : String(e)", 0)).toBe(true);
	});

	it("false for a property NOT in the allowed set (e.g. .code)", () => {
		expect(isMessageExtractionGuard("Error", " ? e.code : String(e)", 0)).toBe(false);
	});

	it("false when the leading anchor is not satisfied — a `?` located later in the slice must not match", () => {
		// Without the `^` anchor the regex could match starting mid-string; the anchor
		// requires the (optionally-whitespace-preceded) `?` to be at the very start.
		expect(isMessageExtractionGuard("Error", "xxx ? e.message", 0)).toBe(false);
	});

	it("true with ZERO whitespace between `?` and the property access", () => {
		expect(isMessageExtractionGuard("Error", "?e.message", 0)).toBe(true);
	});

	it("true with whitespace BEFORE the dot (identifier . message)", () => {
		expect(isMessageExtractionGuard("Error", "? e .message", 0)).toBe(true);
	});

	it("true with whitespace AFTER the dot (identifier. message)", () => {
		expect(isMessageExtractionGuard("Error", "? e. message", 0)).toBe(true);
	});

	it("true for .toString() with a multi-character identifier and no internal whitespace", () => {
		expect(isMessageExtractionGuard("Error", "? err.toString() : String(err)", 0)).toBe(true);
	});

	it("true for .toString() with whitespace before the dot", () => {
		expect(isMessageExtractionGuard("Error", "? err .toString() : String(err)", 0)).toBe(true);
	});

	it("true for .toString() with whitespace after the dot", () => {
		expect(isMessageExtractionGuard("Error", "? err. toString() : String(err)", 0)).toBe(true);
	});

	it("true for .toString () with whitespace before the call parens", () => {
		expect(isMessageExtractionGuard("Error", "? err.toString () : String(err)", 0)).toBe(true);
	});

	it("true for the bare String(...) extraction guard with no internal whitespace", () => {
		expect(isMessageExtractionGuard("Error", "? String(e) : e.message", 0)).toBe(true);
	});

	it("true for String (...) with whitespace before the call parens", () => {
		expect(isMessageExtractionGuard("Error", "? String (e) : e", 0)).toBe(true);
	});

	it("respects the afterIdx offset into the slice", () => {
		const stripped = "xxxxx ? e.message : String(e)";
		expect(isMessageExtractionGuard("Error", stripped, 5)).toBe(true);
		expect(isMessageExtractionGuard("Error", stripped, 0)).toBe(false);
	});
});
