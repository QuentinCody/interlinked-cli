import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkFreshCollectionKeyLookup,
	checkIteratorInvalidation,
} from "./iteration-safety.js";

const TS = "src/lib/foo.ts";

// ===========================================
// checkIteratorInvalidation
// ===========================================

describe("checkIteratorInvalidation — positive cases", () => {
	it("flags array.push inside for-of over the same array", () => {
		const code = [
			"function bug(items: number[]) {",
			"  for (const x of items) {",
			"    items.push(x * 2);",
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("items.push");
	});

	it("flags Set.delete inside .forEach over the same Set", () => {
		const code = [
			"function bug(set: Set<number>) {",
			"  set.forEach((v) => {",
			"    set.delete(v);",
			"  });",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("set.delete");
	});

	it("flags Map.set inside .forEach over the same Map", () => {
		const code = [
			"function bug(m: Map<string, number>) {",
			"  m.forEach((v, k) => {",
			"    m.set(k, v + 1);",
			"  });",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags `delete obj[k]` inside for-in over the same object", () => {
		const code = [
			"function bug(obj: Record<string, number>) {",
			"  for (const k in obj) {",
			"    delete obj[k];",
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("delete obj");
	});

	it("flags array.splice inside .forEach over the same array", () => {
		const code = [
			"function bug(rows: any[]) {",
			"  rows.forEach((_r, i) => {",
			"    rows.splice(i, 1);",
			"  });",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags receiver.push inside a brace-bodied .some() callback over the same receiver", () => {
		// A brace-bodied callback genuinely mutating the iterated receiver is a
		// real bug and must still fire after the expression-arrow FP fix.
		const code = [
			"function bug(items: number[]) {",
			"  items.some((x) => {",
			"    items.push(x);",
			"    return false;",
			"  });",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkIteratorInvalidation — negative cases (must NOT fire)", () => {
	it("ignores non-mutating iteration", () => {
		const code = [
			"function ok(items: number[]) {",
			"  for (const x of items) {",
			"    console.log(x);",
			"  }",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("ignores mutation of a different collection", () => {
		const code = [
			"function copy(source: number[], dest: number[]) {",
			"  for (const x of source) {",
			"    dest.push(x);",
			"  }",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("ignores .map building a new array (no mutation of source)", () => {
		const code = [
			"const doubled = items.map((x) => x * 2);",
			"const filtered = items.filter((x) => x > 0);",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("ignores .find / .some / .every read-only callbacks", () => {
		const code = [
			"const found = items.find((x) => x === target);",
			"const any = items.some((x) => x > 5);",
			"const all = items.every((x) => x !== null);",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("ignores equality comparison that visually resembles index assignment", () => {
		// `arr[i] === ...` is NOT an assignment.
		const code = [
			"function ok(arr: number[]) {",
			"  for (const x of arr) {",
			"    if (arr[0] === x) console.log('first');",
			"  }",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("ignores receiver.push in an if-block guarded by receiver.some() (expression-arrow callback)", () => {
		// Regression (project-graph.ts shape): `result.some((e) => e.name === x)`
		// is a brace-less callback; `result.push(exp)` lives in the ENCLOSING
		// if-block, and the loops iterate DIFFERENT collections. Must not fire.
		const code = [
			"function build(starTargets: string[], direct: Exp[]) {",
			"  const result = direct.filter((e) => e.name !== '*');",
			"  for (const target of starTargets) {",
			"    for (const exp of getExports(target)) {",
			"      if (exp.name !== '*' && !result.some((e) => e.name === exp.name)) {",
			"        result.push(exp);",
			"      }",
			"    }",
			"  }",
			"  return result;",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("ignores receiver.push guarded by !receiver.some() with no enclosing loop", () => {
		// Regression (hook-detection.ts shape): `managers.some(...)` is a
		// brace-less callback used as a condition; the push is in a nested if,
		// not a loop over `managers`.
		const code = [
			"function detect(managers: Mgr[]) {",
			"  if (!managers.some((m) => m.name === 'lefthook')) {",
			"    const pkg = readPkg();",
			"    if (pkg && pkg.deps.lefthook) {",
			"      managers.push({ name: 'lefthook' });",
			"    }",
			"  }",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});
});

// ===========================================
// checkFreshCollectionKeyLookup
// ===========================================

describe("checkFreshCollectionKeyLookup — positive cases", () => {
	it("flags .set with empty object literal as key", () => {
		const code = [
			"const m = new Map<object, number>();",
			"m.set({}, 1);",
		].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .get with spread object literal as key", () => {
		const code = [
			"const m = new Map<object, number>();",
			"const x = { a: 1 };",
			"m.get({ ...x });",
		].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .set with fresh Symbol() as key", () => {
		const code = [
			"const m = new Map<symbol, number>();",
			'm.set(Symbol("k"), 1);',
		].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .has(NaN) as key", () => {
		const code = ["const m = new Map<number, string>();", "m.has(NaN);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .set with fresh `new Date()` as key", () => {
		const code = [
			"const m = new Map<Date, number>();",
			"m.set(new Date(), 1);",
		].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .add(Symbol(...)) on a Set", () => {
		const code = [
			"const s = new Set<symbol>();",
			's.add(Symbol("k"));',
		].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkFreshCollectionKeyLookup — negative cases (must NOT fire)", () => {
	it("ignores stable string keys", () => {
		const code = [
			"const m = new Map<string, number>();",
			'm.set("foo", 1);',
			'm.get("foo");',
		].join("\n");
		expect(checkFreshCollectionKeyLookup(code, TS)).toEqual([]);
	});

	it("ignores variable keys", () => {
		const code = [
			"const m = new Map<string, number>();",
			'const key = "x";',
			"m.set(key, 1);",
			"m.get(key);",
		].join("\n");
		expect(checkFreshCollectionKeyLookup(code, TS)).toEqual([]);
	});

	it("does not fire when file has no Map/Set primitive (Mongoose-style .set)", () => {
		// File-wide gate: if no `new Map(...)` or `Map<...>`/`Set<...>` type
		// annotation appears in the file, we assume `.set({})` is something
		// like a Mongoose document or form helper and skip.
		const code = [
			"function update(doc: any) {",
			"  doc.set({});",
			"}",
		].join("\n");
		expect(checkFreshCollectionKeyLookup(code, TS)).toEqual([]);
	});

	it("ignores parseInt/Number computations that COULD be NaN at runtime", () => {
		// We only flag literal `NaN`, not values that might be NaN at runtime.
		// Tracking parseInt/Number outputs would explode FP. Static `NaN`
		// is the bug class we care about here.
		const code = [
			"const m = new Map<number, string>();",
			"const n = parseInt(input, 10);",
			"m.set(n, 1);",
			"m.get(Number(input));",
		].join("\n");
		expect(checkFreshCollectionKeyLookup(code, TS)).toEqual([]);
	});

	it("ignores destructuring patterns inside method calls", () => {
		// `obj.method({ a, b })` is destructuring on argument shape, not a
		// fresh-key pattern when the receiver isn't a Map/Set. The Map gate
		// guards this case as well.
		const code = [
			"function ok(svc: { set: (opts: { a: number }) => void }) {",
			"  svc.set({ a: 1 });",
			"}",
		].join("\n");
		expect(checkFreshCollectionKeyLookup(code, TS)).toEqual([]);
	});
});

// ===========================================
// checkIteratorInvalidation — receiver identity is the whole member chain (2026-10-22)
// ===========================================
// Dogfood: `for (const [file, facts] of files) { g.files.push(file) }` in spec/ledger-drift.ts fired because
// `\bfiles` also matches inside `g.files`. Repo-wide the same shape made 5 of 11 findings.

describe("checkIteratorInvalidation — member chains (positive)", () => {
	it("P: flags a mutation through the same member chain the loop iterates (forEach and for-of)", () => {
		const viaForEach = ["class Q {", "  drain() {", "    this.items.forEach((item) => {", "      this.items.push(item);", "    });", "  }", "}"].join("\n");
		expect(checkIteratorInvalidation(viaForEach, TS).map((m) => m.line)).toEqual([4]);
		const viaForOf = ["function grow(state: { queue: number[] }) {", "  for (const n of state.queue) {", "    state.queue.push(n + 1);", "  }", "}"].join("\n");
		expect(checkIteratorInvalidation(viaForOf, TS).map((m) => m.line)).toEqual([3]);
	});
});

describe("checkIteratorInvalidation — member chains (negative)", () => {
	it("N: ignores a same-named property of another object while iterating a local collection", () => {
		const code = ["function fold(files: Map<string, number>, g: { files: string[] }) {", "  for (const [file, n] of files) {", "    if (!g.files.includes(file)) g.files.push(file);", "  }", "}"].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("N: ignores a local collection that shares its name with the iterated member", () => {
		const code = ["function copy(upstream: Response) {", "  const headers: Record<string, string> = {};", "  upstream.headers.forEach((value, name) => {", "    headers[name] = value;", "  });", "}"].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});
});

// ===========================================
// checkIteratorInvalidation — extension gate
// ===========================================

describe("checkIteratorInvalidation — extension gate", () => {
	it("N: does not analyze a non-JS/TS file even when the content would otherwise flag", () => {
		const code = ["function bug(items) {", "  for (const x of items) {", "    items.push(x);", "  }", "}"].join(
			"\n",
		);
		expect(checkIteratorInvalidation(code, "src/lib/foo.md")).toEqual([]);
	});
});

// ===========================================
// checkIteratorInvalidation — remaining MUTATING_METHODS coverage
// ===========================================

describe("checkIteratorInvalidation — every mutating method fires (positive)", () => {
	it("P: flags array.pop inside for-of over the same array", () => {
		const code = ["function bug(items) {", "  for (const x of items) {", "    items.pop();", "  }", "}"].join(
			"\n",
		);
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("items.pop");
	});

	it("P: flags array.shift inside for-of over the same array", () => {
		const code = ["function bug(items) {", "  for (const x of items) {", "    items.shift();", "  }", "}"].join(
			"\n",
		);
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("items.shift");
	});

	it("P: flags array.unshift inside for-of over the same array", () => {
		const code = [
			"function bug(items) {",
			"  for (const x of items) {",
			"    items.unshift(x);",
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("items.unshift");
	});

	it("P: flags array.sort inside for-of over the same array", () => {
		const code = ["function bug(items) {", "  for (const x of items) {", "    items.sort();", "  }", "}"].join(
			"\n",
		);
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("items.sort");
	});

	it("P: flags array.reverse inside for-of over the same array", () => {
		const code = [
			"function bug(items) {",
			"  for (const x of items) {",
			"    items.reverse();",
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("items.reverse");
	});

	it("P: flags array.fill inside for-of over the same array", () => {
		const code = ["function bug(items) {", "  for (const x of items) {", "    items.fill(0);", "  }", "}"].join(
			"\n",
		);
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("items.fill");
	});

	it("P: flags array.copyWithin inside for-of over the same array", () => {
		const code = [
			"function bug(items) {",
			"  for (const x of items) {",
			"    items.copyWithin(0, 1);",
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("items.copyWithin");
	});

	it("P: flags Map/Set.clear inside .forEach over the same collection", () => {
		const code = ["function bug(m) {", "  m.forEach((v, k) => {", "    m.clear();", "  });", "}"].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("m.clear");
	});

	it("P: flags Set.add inside .forEach over the same Set", () => {
		const code = ["function bug(s) {", "  s.forEach((v) => {", "    s.add(v + 1);", "  });", "}"].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("s.add");
	});
});

// ===========================================
// checkIteratorInvalidation — internal helper boundary conditions
// (findMatchingBrace / findMatchingParen / findBodyOpen / resolveLoopBodyRange
// / findMutationOffsets are unexported; every case below exercises them only
// through the two public detectors.)
// ===========================================

describe("checkIteratorInvalidation — brace/paren scan-cap boundaries", () => {
	it("N: a mutation past the 20000-char brace-scan cap is NOT reported (deliberately bounded)", () => {
		// The loop body is padded past MAX_BRACE_SCAN_CHARS before its closing
		// `}`; findMatchingBrace's capped scan must fail to find it, so the
		// whole candidate is dropped rather than mis-detecting past the cap.
		const code = [
			"function bug(items) {",
			"  for (const x of items) {",
			" ".repeat(21000),
			"    items.push(x);",
			"  }",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("N: a forEach call whose closing paren sits past the 20000-char paren-scan cap is NOT reported", () => {
		const code = [
			"function bug(items) {",
			"  items.forEach((x) => { items.push(x); }, " + "X".repeat(21000) + ")",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("N: a closing brace exactly one char past the scan window is NOT found (i < end, not i <= end)", () => {
		// Exact boundary: MAX_BRACE_SCAN_CHARS=20000 filler chars separate the
		// loop's `{` from its `}`, so the real close sits at openIdx+20000 —
		// one index past the last position `i < end` ever visits.
		const header = "function bug(items) {\n  for (const x of items) ";
		const mutCall = "items.push(x);";
		const fillerLen = 20000 - 1 - mutCall.length;
		const code = header + "{" + mutCall + " ".repeat(fillerLen) + "}\n}\n";
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("N: a forEach closing paren exactly one char past the paren-scan window is NOT found", () => {
		const prefix = "function bug(items) {\n  items.forEach(";
		const middle = "(x) => { items.push(x); }, ";
		const fillerLen = 20000 - 1 - middle.length;
		const code = prefix + middle + "X".repeat(fillerLen) + ")\n}\n";
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("P: a genuine mutation nested behind an inner if-block brace is still found (depth-tracked, not first-`}`)", () => {
		// If findMatchingBrace returned on the FIRST `}` seen regardless of
		// depth, it would stop at the if-block's own close and miss the push
		// that follows it, still inside the loop's real body.
		const code = [
			"function bug(items) {",
			"  for (const x of items) {",
			"    if (true) {",
			"      console.log(x);",
			"    }",
			"    items.push(x);",
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("items.push");
	});
});

describe("checkIteratorInvalidation — header-to-body resolution boundaries", () => {
	it("N: a `{` more than 200 chars past the loop header is NOT treated as the loop's body", () => {
		const code = [
			"function bug(items) {",
			"  for (const x of items)",
			" ".repeat(250),
			"  if (cond) {",
			"    items.push(1);",
			"  }",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("P: a `{` with zero gap after the header (no space) is still found (openBrace===0 boundary)", () => {
		const code = ["function bug(items) {", "  for (const x of items){", "    items.push(x);", "  }", "}"].join(
			"\n",
		);
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("items.push");
	});

	it("P: a normal body with no semicolon anywhere before its brace still resolves", () => {
		const code = ["function bug(items) {", "  for (const x of items) {", "    items.push(x)", "  }", "}"].join(
			"\n",
		);
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("items.push");
	});

	it("N: a semicolon immediately after the header (no body at all) blocks a later unrelated brace from being adopted", () => {
		const code = [
			"function bug(items) {",
			"  for (const x of items);",
			"  if (cond) {",
			"    items.push(1);",
			"  }",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("N: an expression-arrow forEach callback (semicolon before any brace) does not adopt a later unrelated block", () => {
		const code = [
			"function ok(items) {",
			"  items.forEach((x) => doThing(x));",
			"  if (cond) {",
			"    items.push(1);",
			"  }",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("N: an unclosed loop body (no matching `}` anywhere) is not treated as a valid range", () => {
		const code = [
			"function bug(items) {",
			"  for (const x of items) {",
			"    items.push(x)",
			"    more filler text here",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});
});

describe("checkIteratorInvalidation — reported offset must point at the actual mutation", () => {
	// The collection name sits on its own line, separated by newlines from
	// the operator that follows it (the detector's regexes allow this via
	// `\s`). A wrong body-slice or offset-translation arithmetic shifts the
	// reported position by a few characters — enough here to land on the
	// WRONG source line, changing both `line` and `text`.
	it("P: reports the exact line of a method-call mutation split across lines", () => {
		const code = ["function bug(s) {", "  s.forEach((v) => {", "s", ".add(v)", "  });", "}"].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).line).toBe(3);
		expect(nonNull(out[0]).text).toBe("s");
	});

	it("P: reports the exact line of an index-assignment mutation split across lines", () => {
		const code = ["function bug(items) {", "  for (const x of items) {", "items", "[0] = x", "  }", "}"].join(
			"\n",
		);
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).line).toBe(3);
		expect(nonNull(out[0]).text).toBe("items");
	});

	it("P: reports the exact line of a `delete` mutation split across lines", () => {
		const code = ["function bug(items) {", "  for (const k in items) {", "delete", "items[k]", "  }", "}"].join(
			"\n",
		);
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).line).toBe(3);
		expect(nonNull(out[0]).text).toBe("delete");
	});
});

describe("checkIteratorInvalidation — dedup and report-line truncation", () => {
	it("P: a mutation visible to two overlapping candidates (outer for-of, inner forEach) is reported only once", () => {
		// The outer for-of's body textually contains the inner forEach's own
		// body, so both candidates independently find the SAME absolute
		// mutation offset. The seen-set must dedup it to a single match.
		const code = [
			"function bug(items) {",
			"  for (const x of items) {",
			"    items.forEach((y) => {",
			"      items.push(y);",
			"    });",
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBe(1);
	});

	it("P: a matching line longer than the 150-char report cap is truncated in the reported text", () => {
		const code = [
			"function bug(items) {",
			"  for (const x of items) {",
			`    items.push(x); ${"y".repeat(200)}`,
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text.length).toBe(150);
	});

	it("N: mutating a different collection strictly AFTER (outside) the loop body is not reported", () => {
		const code = [
			"function ok(items) {",
			"  for (const x of items) {",
			"    console.log(x);",
			"  }",
			"  items.push(99);",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});
});

// ===========================================
// checkIteratorInvalidation — report-text trimming and `$`-in-identifier
// escaping (findMutationOffsets escapes a literal `$` in the collection
// name before embedding it in a constructed RegExp; an unescaped `$` reads
// as a regex end-of-string anchor, not a literal dollar sign)
// ===========================================

describe("checkIteratorInvalidation — report-line trimming and `$` escaping", () => {
	it("P: leading/trailing whitespace on the reported line is trimmed", () => {
		// Every existing fixture's mutation line has no leading/trailing
		// whitespace of its own (any indentation lives on OTHER lines), which
		// hides a missing `.trim()`. This fixture pads the mutation's own line.
		const code = ["function bug(items) {", "  for (const x of items) {", "      items.push(x);   ", "  }", "}"].join(
			"\n",
		);
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toBe("items.push(x);");
	});

	it("P: a collection name containing `$` is matched by for-of iteration + mutation", () => {
		// `$` is a valid JS identifier character but a regex metacharacter
		// (end-of-string anchor). findMutationOffsets escapes it before
		// building the mutating-method RegExp; without escaping, the `$`
		// breaks the match and the real bug goes undetected.
		const code = ["function bug(a$) {", "  for (const x of a$) {", "    a$.push(x);", "  }", "}"].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("a$.push");
	});

	it("P: a `$`-prefixed collection name is matched inside a forEach callback", () => {
		const code = ["function bug($items) {", "  $items.forEach((x) => {", "    $items.splice(0, 1);", "  });", "}"].join(
			"\n",
		);
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("$items.splice");
	});
});

// ===========================================
// checkIteratorInvalidation — match cap (mirrors the fresh-key 10-hit cap)
// ===========================================

describe("checkIteratorInvalidation — match cap boundary", () => {
	it("P: more than 10 mutations inside a SINGLE loop body are capped at exactly 10 (inner per-offset cap)", () => {
		// Twelve real `items.push(i)` mutating calls in one loop body: the
		// inner `if (matches.length >= 10) break;` guard (inside the
		// per-offset loop) must stop accumulation at exactly 10, not 11 or 12.
		// A `matches.length >= 10 -> false` mutant never breaks (12 matches);
		// a `>= 10 -> > 10` mutant breaks one item late (11 matches). Both
		// diverge from the real 10 here.
		const code = [
			"function bug(items) {",
			"  for (const x of items) {",
			...Array.from({ length: 12 }, (_, i) => `    items.push(${i});`),
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBe(10);
		expect(nonNull(out[9]).text).toContain("items.push(9)");
	});
});

describe("checkIteratorInvalidation — ITERATOR_HEADER_RE / FOREACH_HEADER_RE whitespace boundaries", () => {
	it("P: matches a for-of header with no space between `for` and `(`", () => {
		const code = ["function bug(items) {", "  for( const x of items ) {", "    items.push(x);", "  }", "}"].join(
			"\n",
		);
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: matches a for-of header where the keyword sits directly against the loop variable", () => {
		const code = [
			"function bug(items) {",
			"  for ( constx of items ) {",
			"    items.push(x);",
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: matches a for-of header with extra whitespace before the collection name", () => {
		const code = [
			"function bug(items) {",
			"  for ( const x of  items ) {",
			"    items.push(x);",
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: matches a for-of header whose loop variable is array-destructured (internal comma+space)", () => {
		// The var-name char class must include a literal whitespace char to
		// span the ", " inside `[x, y]` — a class swap to \S there would stop
		// short at the space and break the whole header match.
		const code = [
			"function bug(items) {",
			"  for (const [x, y] of items) {",
			"    items.push(x);",
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: matches a for-of header whose loop variable is object-destructured (internal comma+space)", () => {
		const code = [
			"function bug(items) {",
			"  for (const { a, b } of items) {",
			"    items.push(a);",
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("N: does NOT match a header with unskippable garbage between `(` and an optional keyword", () => {
		// Only whitespace is skippable there; "xyz" is neither a keyword nor
		// part of the loop-variable pattern at that position, so the header
		// must fail to match at all — nothing to iterate over, nothing to flag.
		const code = ["function ok(items) {", "  for (xyz const x of items) {", "    items.push(1);", "  }", "}"].join(
			"\n",
		);
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("P: matches a forEach header with whitespace around the `.`", () => {
		const code = [
			"function bug(items) {",
			"  items . forEach ((x) => {",
			"    items.push(x);",
			"  });",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: matches a forEach header with whitespace before the call's opening paren", () => {
		const code = [
			"function bug(items) {",
			"  items. forEach ((x) => {",
			"    items.push(x);",
			"  });",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

// ===========================================
// checkFreshCollectionKeyLookup — extension gate
// ===========================================

describe("checkFreshCollectionKeyLookup — extension gate", () => {
	it("N: does not analyze a non-JS/TS file even when the content would otherwise flag", () => {
		const code = ["const m = new Map();", "m.set({}, 1);"].join("\n");
		expect(checkFreshCollectionKeyLookup(code, "src/lib/foo.md")).toEqual([]);
	});
});

// ===========================================
// checkFreshCollectionKeyLookup — usesKeyedCollection gate-regex boundaries
// ===========================================

describe("checkFreshCollectionKeyLookup — `new Map(...)` gate whitespace boundaries", () => {
	it("N: two spaces between `new` and `Map` do NOT satisfy an exactly-one-whitespace class", () => {
		// If `\s+` (one-or-more) ever regresses to `\s` (exactly one), this
		// still-valid `new  Map()` construct would fail the gate and the
		// detector would wrongly return [] instead of flagging the fresh key.
		const code = ["const m = new  Map();", "m.set({}, 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: `new Map<T>()` with real whitespace on both sides of the generic still gates correctly", () => {
		const code = ["const m = new Map <T> ();", "m.set({}, 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: `new Map ()` with a space before the call parens still gates correctly", () => {
		const code = ["const m = new Map ();", "m.set({}, 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkFreshCollectionKeyLookup — type-annotation gate whitespace/anchor boundaries", () => {
	// A parameter-position type annotation (`m: Map<...>`) never satisfies
	// this regex — a word character always sits right before the `:` there.
	// The regex is reachable only via a return-type annotation (`): Map<...>`,
	// non-word `)` before `:`) or a `:` at the very start of the file (the
	// `^` alternative). Fixtures below use those two shapes deliberately.
	it("N: a `:` at the very start of the file satisfies the `^` alternative, not `[^\\w$]`", () => {
		const code = [":Map<string, number>", "m.set({}, 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: a return-type annotation with zero whitespace anywhere around `:`/`<` still gates", () => {
		const code = ["function f():Map<string,number>{return null;}", "m.set({}, 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: a return-type annotation with a space only after `:` still gates", () => {
		const code = ["function f(): Map<string, number> { return null; }", "m.set({}, 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: a return-type annotation with a space only before `<` still gates", () => {
		const code = ["function f():Map <string, number> { return null; }", "m.set({}, 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

// ===========================================
// checkFreshCollectionKeyLookup — FRESH_KEY_PATTERNS whitespace boundaries
// ===========================================

describe("checkFreshCollectionKeyLookup — fresh-key pattern whitespace boundaries", () => {
	it("P: flags `.set({})` with irregular whitespace around every token of the call", () => {
		const code = ["const m = new Map();", "m. set ( { }, 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: flags `.set ( [ ] )` (empty array key) with irregular whitespace", () => {
		const code = ["const m = new Map();", "m.set ( [ ], 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: flags a spread-object key with irregular whitespace around the call", () => {
		const code = ["const m = new Map();", "const x = {a:1};", "m. set ( { ...x }, 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: flags a spread-object key with the brace tight against `...`", () => {
		const code = ["const m = new Map();", "const x = {a:1};", "m. set ( {...x }, 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: flags a multi-char object-literal key (`{abc: 1}`) — the `[^{}]*:` branch needs 0-or-more, not exactly one", () => {
		const code = ["const m = new Map();", "m.set({abc: 1}, 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: flags a spread-array key with irregular whitespace around the call", () => {
		const code = ["const m = new Map();", "const a = [1];", "m.set ( [ ...a ], 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: flags a spread-array key with the bracket tight against `...`", () => {
		const code = ["const m = new Map();", "const a = [1];", "m. set ( [...a ], 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: flags `Symbol(...)` as a key with irregular whitespace around the call", () => {
		const code = ["const m = new Map();", 'm. set ( Symbol ("k"), 1);'].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: flags `NaN` as a key with irregular whitespace around the call", () => {
		const code = ["const m = new Map();", "m. set ( NaN, 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: flags `new Date()` as a key with irregular whitespace, including a doubled space before `Date`", () => {
		const code = ["const m = new Map();", "m. set ( new  Date(), 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: flags a TIGHT (zero-whitespace) empty array key `.set([])`", () => {
		// Every gap in the empty-array pattern (verb-to-paren, paren-to-bracket,
		// inside the brackets) is `\s*` (zero-or-more) in real code, so the most
		// common real-world call shape — no whitespace anywhere — must match.
		const code = ["const m = new Map();", "m.set([], 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: flags an empty array key with a space between `.` and the verb", () => {
		const code = ["const m = new Map();", "m. set([], 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("P: flags a TIGHT (zero-whitespace) fresh spread-array key `.set([...a])`", () => {
		const code = ["const m = new Map();", "const a = [1];", "m.set([...a], 1);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

// ===========================================
// checkFreshCollectionKeyLookup — dedup and report-line truncation
// ===========================================

describe("checkFreshCollectionKeyLookup — cap, dedup, and report formatting", () => {
	it("P: more than 10 fresh-key hits from a single pattern are capped at 10", () => {
		const code = [
			"const m = new Map();",
			...Array.from({ length: 12 }, (_, i) => `m.set({}, ${i});`),
		].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBe(10);
	});

	it("P: a matching line longer than the 150-char report cap is truncated in the reported text", () => {
		const code = ["const m = new Map();", `m.set({}, 1); ${"z".repeat(200)}`].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text.length).toBe(150);
	});

	it("P: the reported text has leading/trailing whitespace stripped", () => {
		const code = ["const m = new Map();", "   m.set({}, 1);   "].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toBe("m.set({}, 1);");
	});

	it("P: reports the line the match is actually on, not the file's total line count", () => {
		// A line-number computation that slices the WHOLE stripped content
		// instead of the prefix up to the match would always report the
		// file's last line. Every existing fixture happens to put its match
		// on the last line, which hides that bug — this fixture doesn't.
		const code = [
			"const m = new Map();",
			"m.set({}, 1);",
			"// trailing comment one",
			"// trailing comment two",
			"// trailing comment three",
		].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).line).toBe(2);
	});
});
