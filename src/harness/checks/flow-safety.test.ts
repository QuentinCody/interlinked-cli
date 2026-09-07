import { describe, expect, it } from "vitest";
import {
	checkAwaitStateToctou,
	checkBoundaryCopyNoRevalidation,
	checkCleanupReentrancy,
} from "./flow-safety.js";

const TS = "src/lib/foo.ts";

// ===========================================
// checkAwaitStateToctou
// ===========================================

describe("checkAwaitStateToctou — positive cases", () => {
	it("flags `if (state.x) { await ...; state.x.foo() }` same-field deref across await", () => {
		const code = [
			"async function bug(state: any) {",
			"  if (state.entry) {",
			"    await sync();",
			"    state.entry.touch();",
			"  }",
			"}",
		].join("\n");
		const out = checkAwaitStateToctou(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags `if (this.conn) { await this.send(); this.conn.close(); }`", () => {
		const code = [
			"class Bug {",
			"  conn: any;",
			"  async run() {",
			"    if (this.conn) {",
			"      await this.send();",
			"      this.conn.close();",
			"    }",
			"  }",
			"  async send() {}",
			"}",
		].join("\n");
		const out = checkAwaitStateToctou(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags `if (cache.foo) { await delay(); cache.foo.update(); }`", () => {
		const code = [
			"async function bug(cache: any) {",
			"  if (cache.foo) {",
			"    await delay();",
			"    cache.foo.update();",
			"  }",
			"}",
		].join("\n");
		const out = checkAwaitStateToctou(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags a same-field deref with no whitespace between if/paren and paren/brace", () => {
		const code = [
			"async function bug(state: any) {",
			"  if(state.entry){",
			"    await sync();",
			"    state.entry.touch();",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags a three-level dotted path across await", () => {
		const code = [
			"async function bug(obj: any) {",
			"  if (obj.state.entry) {",
			"    await sync();",
			"    obj.state.entry.touch();",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags a same-field deref with whitespace before the if's closing paren", () => {
		const code = [
			"async function bug(state: any) {",
			"  if (state.entry ) {",
			"    await sync();",
			"    state.entry.touch();",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags a same-field deref when await sits at offset zero in the if body", () => {
		const code =
			"async function bug(state: any) {\n  if (state.entry) {await sync(); state.entry.touch();}\n}";
		expect(checkAwaitStateToctou(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags the first vulnerable use even when a recheck appears later in the block", () => {
		const code = [
			"async function bug(state: any) {",
			"  if (state.entry) {",
			"    await sync();",
			"    state.entry.touch();",
			"    if (state.entry) { state.entry.other(); }",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("still finds the vulnerable use past a matching nested if-block inside the body", () => {
		const code = [
			"async function bug(state: any) {",
			"  if (state.entry) {",
			"    if (x) {}",
			"    await sync();",
			"    state.entry.touch();",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("reports the exact source line and text at the reported offset, not a shifted one", () => {
		const code = [
			"async function bug(state: any) {",
			"  if (state.entry) {",
			"    // comment 1",
			"    // comment 2",
			"    await x();",
			"    // comment 3",
			"    state.entry.touch();",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, TS)).toEqual([{ line: 7, text: "state.entry.touch();" }]);
	});

	it("reports the line the use actually sits on when it starts right after a newline", () => {
		const code = [
			"async function bug(state: any) {",
			"  if (state.entry) {",
			"  await sync();",
			"state.entry.touch();",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, TS)).toEqual([{ line: 4, text: "state.entry.touch();" }]);
	});
});

describe("checkAwaitStateToctou — negative cases (must NOT fire)", () => {
	it("ignores re-check after await", () => {
		const code = [
			"async function ok(state: any) {",
			"  if (state.entry) {",
			"    await sync();",
			"    if (state.entry) state.entry.touch();",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, TS)).toEqual([]);
	});

	it("ignores when there's no await between check and use", () => {
		const code = [
			"function ok(state: any) {",
			"  if (state.entry) {",
			"    state.entry.touch();",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, TS)).toEqual([]);
	});

	it("ignores when a different field is used after the await", () => {
		const code = [
			"async function ok(state: any) {",
			"  if (state.entry) {",
			"    await sync();",
			"    state.other.touch();",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, TS)).toEqual([]);
	});

	it("continues past an if-block whose brace never closes within budget", () => {
		const code = `if (state.entry) {${"x".repeat(6000)}`;
		expect(checkAwaitStateToctou(code, TS)).toEqual([]);
	});

	it("ignores an if-block whose brace never closes even when await+use both appear inside", () => {
		const code = `if (state.entry) { await sync(); state.entry.touch(); ${"x".repeat(6000)}`;
		expect(checkAwaitStateToctou(code, TS)).toEqual([]);
	});

	it("does not flag past the brace-matching scan budget even when a real close brace follows", () => {
		// IF_BODY_SCAN_BUDGET is 5000; a close brace landing exactly at that
		// offset must NOT be found (budget is exclusive of the boundary char).
		const prefix = "async function bug(state: any) {\n  if (state.entry) { await sync(); state.entry.touch(); ";
		const openBraceIdx = prefix.indexOf("{", prefix.indexOf("if"));
		const targetClose = openBraceIdx + 5000;
		const filler = "x".repeat(targetClose - prefix.length);
		const code = `${prefix}${filler}}\n}`;
		expect(checkAwaitStateToctou(code, TS)).toEqual([]);
	});

	it("ignores files with a non-JS/TS extension even when the content would otherwise match", () => {
		const code = [
			"async function bug(state: any) {",
			"  if (state.entry) {",
			"    await sync();",
			"    state.entry.touch();",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, "src/lib/foo.py")).toEqual([]);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) when 10+ distinct blocks match", () => {
		const blocks: string[] = [];
		for (let i = 0; i < 12; i++) {
			blocks.push(`if (s${i}.entry) { await sync(); s${i}.entry.touch(); }`);
		}
		const out = checkAwaitStateToctou(blocks.join("\n"), TS);
		expect(out.length).toBe(10);
	});

	it("dedupes two matches landing on the same reported line", () => {
		const code =
			"if (a.b) { await c(); a.b.d(); } if (a.b) { await c(); a.b.e(); }";
		const out = checkAwaitStateToctou(code, TS);
		expect(out.length).toBe(1);
		expect(out[0]?.line).toBe(1);
	});

	it("keeps scanning after a same-line dedupe skip instead of stopping there", () => {
		const code = [
			"if (a.b) { await c(); a.b.d(); } if (a.b) { await c(); a.b.e(); }",
			"if (x.y) { await c(); x.y.z(); }",
		].join("\n");
		const out = checkAwaitStateToctou(code, TS);
		expect(out).toEqual([
			{ line: 1, text: "if (a.b) { await c(); a.b.d(); } if (a.b) { await c(); a.b.e(); }" },
			{ line: 2, text: "if (x.y) { await c(); x.y.z(); }" },
		]);
	});

	it("truncates an overly long matched line to REPORT_LINE_TRUNC (150) chars", () => {
		const code = `if (state.entry) { await sync(); state.entry.touch(); /* ${"y".repeat(300)} */ }`;
		const out = checkAwaitStateToctou(code, TS);
		expect(out[0]?.text.length).toBe(150);
	});
});

// ===========================================
// checkCleanupReentrancy
// ===========================================

describe("checkCleanupReentrancy — positive cases", () => {
	it("flags dispose() that calls this.dispose()", () => {
		const code = [
			"class Bug {",
			"  dispose() {",
			"    this.dispose();",
			"  }",
			"}",
		].join("\n");
		const out = checkCleanupReentrancy(code, TS);
		expect(out).toEqual([{ line: 3, text: "this.dispose();" }]);
	});

	it("flags destroy() that calls this.destroy()", () => {
		const code = [
			"class Bug {",
			"  destroy() {",
			"    this.cleanup();",
			"    this.destroy();",
			"  }",
			"  cleanup() {}",
			"}",
		].join("\n");
		const out = checkCleanupReentrancy(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags useEffect cleanup that calls setState", () => {
		const code = [
			"function Comp() {",
			"  useEffect(() => {",
			"    return () => {",
			"      setState({ count: 0 });",
			"    };",
			"  }, []);",
			"}",
		].join("\n");
		const out = checkCleanupReentrancy(code, TS);
		expect(out).toEqual([{ line: 4, text: "setState({ count: 0 });" }]);
	});

	it("reports the line the recursive call actually sits on when it starts right after a newline", () => {
		const code = [
			"class Bug {",
			"  dispose() {",
			"  this.foo();",
			"this.dispose();",
			"  }",
			"}",
		].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([{ line: 4, text: "this.dispose();" }]);
	});

	it("flags a recursing method even with a space between the method name and its argument list", () => {
		const code = "function Comp() {\n  useEffect (() => {\n    return () => {\n      setState(1);\n    };\n  }, []);\n}";
		expect(checkCleanupReentrancy(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags useEffect with a space after the outer callback's opening paren and a real param name", () => {
		const code =
			"function Comp() {\n  useEffect( (state) => {\n    return () => {\n      setState(1);\n    };\n  }, []);\n}";
		expect(checkCleanupReentrancy(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags useEffect with a real statement between the effect body and the return", () => {
		const code =
			"function Comp() {\n  useEffect(() => {\n    doSetup();\n    return () => {\n      setState(1);\n    };\n  }, []);\n}";
		expect(checkCleanupReentrancy(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags useEffect with no whitespace between the callback's close paren and arrow", () => {
		const code = "function Comp() {\n  useEffect(()=>{\n    return () => {\n      setState(1);\n    };\n  }, []);\n}";
		expect(checkCleanupReentrancy(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags useEffect with no whitespace around the return's arrow function", () => {
		const code =
			"function Comp() {\n  useEffect(() => {\n    return()=>{\n      setState(1);\n    };\n  }, []);\n}";
		expect(checkCleanupReentrancy(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags useEffect whose return has whitespace inside its empty parameter parens", () => {
		const code =
			"function Comp() {\n  useEffect(() => {\n    return ( ) => {\n      setState(1);\n    };\n  }, []);\n}";
		expect(checkCleanupReentrancy(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags a cleanup body with a space between the state mutator name and its argument list", () => {
		const code = [
			"function Comp() {",
			"  useEffect(() => {",
			"    return () => {",
			"      setState (0);",
			"    };",
			"  }, []);",
			"}",
		].join("\n");
		expect(checkCleanupReentrancy(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("reports the correct line for a state mutator call at the very start of its line", () => {
		const code = [
			"function Comp() {",
			"  useEffect(() => {",
			"    return () => {",
			"setState(0);",
			"    };",
			"  }, []);",
			"}",
		].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([{ line: 4, text: "setState(0);" }]);
	});
});

describe("checkCleanupReentrancy — negative cases (must NOT fire)", () => {
	it("ignores dispose() that doesn't recurse", () => {
		const code = [
			"class Ok {",
			"  dispose() {",
			"    this.subscription.unsubscribe();",
			"  }",
			"}",
		].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([]);
	});

	it("ignores useEffect cleanup with pure cleanup calls", () => {
		const code = [
			"function Comp() {",
			"  useEffect(() => {",
			"    const id = setInterval(tick, 1000);",
			"    return () => {",
			"      clearInterval(id);",
			"    };",
			"  }, []);",
			"}",
		].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([]);
	});

	it("ignores destroy() that delegates without recursing", () => {
		const code = [
			"class Ok {",
			"  destroy() {",
			"    this.parent.deregister(this);",
			"  }",
			"}",
		].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([]);
	});

	it("continues past a method header whose brace never closes within budget", () => {
		const code = `dispose() {${"x".repeat(9000)}`;
		expect(checkCleanupReentrancy(code, TS)).toEqual([]);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) for 10+ recursing methods", () => {
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) {
			lines.push("dispose() { this.dispose(); }");
		}
		const out = checkCleanupReentrancy(lines.join("\n"), TS);
		expect(out.length).toBe(10);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) for 10+ useEffect state-mutating cleanups", () => {
		const blocks: string[] = [];
		for (let i = 0; i < 12; i++) {
			blocks.push(
				[
					"useEffect(() => {",
					"  return () => {",
					`    setState(${i});`,
					"  };",
					"}, []);",
				].join("\n"),
			);
		}
		const out = checkCleanupReentrancy(blocks.join("\n"), TS);
		expect(out.length).toBe(10);
	});

	it("scopes the recursion search to the method's own body, not the whole file", () => {
		const code = [
			"class Ok {",
			"  dispose() {",
			"    this.cleanup();",
			"  }",
			"  other() {",
			"    this.dispose();",
			"  }",
			"}",
		].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([]);
	});

	it("ignores an unclosed method body even when a recursive call appears inside it", () => {
		const code = `dispose() { this.dispose(); ${"x".repeat(9000)}`;
		expect(checkCleanupReentrancy(code, TS)).toEqual([]);
	});

	it("ignores a non-cleanup method name that recurses (CLEANUP_METHOD_NAMES regression guard)", () => {
		const code = ["class Ok {", "  process() {", "    this.process();", "  }", "}"].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([]);
	});

	it("ignores files with a non-JS/TS extension even when the content would otherwise match", () => {
		const code = ["class Bug {", "  dispose() {", "    this.dispose();", "  }", "}"].join("\n");
		expect(checkCleanupReentrancy(code, "src/lib/foo.py")).toEqual([]);
	});
});

// ===========================================
// checkBoundaryCopyNoRevalidation
// ===========================================

describe("checkBoundaryCopyNoRevalidation — positive cases", () => {
	it("flags Object.assign(slot, req.body) without validator", () => {
		const code = [
			"function bug(slot: any, req: any) {",
			"  Object.assign(slot, req.body);",
			"}",
		].join("\n");
		const out = checkBoundaryCopyNoRevalidation(code, TS);
		expect(out).toEqual([{ line: 2, text: "Object.assign(slot, req.body);" }]);
	});

	it("flags Object.assign(config, JSON.parse(stdin))", () => {
		const code = [
			"function bug(config: any, stdin: string) {",
			"  Object.assign(config, JSON.parse(stdin));",
			"}",
		].join("\n");
		const out = checkBoundaryCopyNoRevalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags spread copy `{ ...defaults, ...req.body }` without validator", () => {
		const code = [
			"function bug(req: any) {",
			"  const merged = { foo: 1, ...req.body };",
			"  return merged;",
			"}",
		].join("\n");
		const out = checkBoundaryCopyNoRevalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags Object.assign with a space between the call name and its argument list", () => {
		const code = [
			"function bug(slot: any, req: any) {",
			"  Object.assign (slot, req.body);",
			"}",
		].join("\n");
		expect(checkBoundaryCopyNoRevalidation(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags Object.assign whose source clears a nested unrelated call before the real external arg", () => {
		const code = "function bug(slot: any, req: any) {\n  Object.assign(slot, wrap(y), req.body);\n}";
		expect(checkBoundaryCopyNoRevalidation(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags Object.assign copying from process.env", () => {
		const code = "function bug() {\n  Object.assign(slot, process.env.FOOBAR);\n}";
		expect(checkBoundaryCopyNoRevalidation(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags Object.assign(slot, JSON.parse (raw)) with a space before JSON.parse's paren", () => {
		const code = "function bug(slot: any, raw: string) {\n  Object.assign(slot, JSON.parse (raw));\n}";
		expect(checkBoundaryCopyNoRevalidation(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags a spread copy with extra whitespace after the `...` operator", () => {
		const code = "function bug(req: any) {\n  const merged = { foo: 1, ...  req.body };\n  return merged;\n}";
		expect(checkBoundaryCopyNoRevalidation(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags a spread copy of process.argv with no trailing property access", () => {
		const code = "function bug() {\n  const a = { ...process.argv };\n}";
		expect(checkBoundaryCopyNoRevalidation(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags Object.assign with a leading (empty first-arg) comma, since the source is still unvalidated", () => {
		const code = "function bug(req: any) {\n  Object.assign(, req.body);\n}";
		expect(checkBoundaryCopyNoRevalidation(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("still flags a spread copy when an unrelated validator sits outside the local suppression window", () => {
		const code = `schema.validate(y); ${"z".repeat(120)}\nconst merged = { ...req.body };`;
		expect(checkBoundaryCopyNoRevalidation(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("flags a copy from an unvalidated source even when the target of the copy is itself validated", () => {
		// The target's own `.validate(` call must not leak into the SOURCE scan
		// — only the source (everything after the first comma) counts.
		const code = "function bug(req: any) {\n  Object.assign(schema.validate(x), req.body);\n}";
		expect(checkBoundaryCopyNoRevalidation(code, TS).length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkBoundaryCopyNoRevalidation — negative cases (must NOT fire)", () => {
	it("ignores Object.assign with internal-only data", () => {
		const code = [
			"function ok(slot: any, defaults: any) {",
			"  Object.assign(slot, defaults);",
			"}",
		].join("\n");
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores when source goes through schema parser", () => {
		const code = [
			'import { z } from "zod";',
			"const Body = z.object({ name: z.string() });",
			"function ok(slot: any, req: any) {",
			"  Object.assign(slot, Body.parse(req.body));",
			"}",
		].join("\n");
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores plain spread of internal value", () => {
		const code = [
			"function ok(defaults: any) {",
			"  return { ...defaults, computed: true };",
			"}",
		].join("\n");
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores Object.assign whose closing paren never appears within budget", () => {
		const code = `Object.assign(${"a,".repeat(3000)}`;
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores Object.assign with a single argument (no comma, no source)", () => {
		const code = "Object.assign(slot);";
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores spread when the enclosing call is a validator", () => {
		const code = "function ok(req: any) { return schema.validate({ ...req.body }); }";
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) for 10+ Object.assign hits", () => {
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) {
			lines.push(`Object.assign(slot${i}, req.body);`);
		}
		const out = checkBoundaryCopyNoRevalidation(lines.join("\n"), TS);
		expect(out.length).toBe(10);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) for 10+ spread hits", () => {
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) {
			lines.push(`const m${i} = { ...req.body };`);
		}
		const out = checkBoundaryCopyNoRevalidation(lines.join("\n"), TS);
		expect(out.length).toBe(10);
	});

	it("ignores Object.assign when validated via safeParse with no whitespace before its paren", () => {
		const code = "function ok(slot: any, req: any) {\n  Object.assign(slot, Schema.safeParse(req.body));\n}";
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores Object.assign when validated via a `.parse(` call with a space before its paren", () => {
		const code = "function ok(slot: any, req: any) {\n  Object.assign(slot, Body.parse (req.body));\n}";
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores Object.assign when validated via safeParse with a space before its paren", () => {
		const code = "function ok(slot: any, req: any) {\n  Object.assign(slot, Schema.safeParse (req.body));\n}";
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores a spread copy validated via `.validate(` with a space before its paren", () => {
		const code = "function ok(req: any) { return schema.validate (req.body); }";
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores an Object.assign call whose closing paren lands exactly at the brace-matching budget boundary", () => {
		// The manual paren-scan budget is 4000 chars; a close paren landing
		// exactly at that offset must NOT be found (budget-exclusive boundary).
		const prefix = "Object.assign(slot, req.body ";
		const openParen = prefix.indexOf("(");
		const targetClose = openParen + 4000;
		const filler = "a".repeat(targetClose - prefix.length);
		const code = `${prefix}${filler});`;
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores an Object.assign call whose close paren sits well beyond the scan budget on a long file", () => {
		const prefix = "Object.assign(slot, req.body ";
		const openParen = prefix.indexOf("(");
		const targetClose = openParen + 4500;
		const filler = "a".repeat(targetClose - prefix.length);
		const code = `${prefix}${filler});`;
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores Object.assign with a single external-input argument (no separate source to copy)", () => {
		const code = "function bug(req: any) {\n  Object.assign(req.body);\n}";
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("scopes the source scan to this Object.assign call's own args, not the whole file", () => {
		const code = [
			"function bug(x: any) {",
			"  Object.assign(x.slot, x.defaults);",
			"}",
			"function unrelated(req: any) {",
			"  return req.body;",
			"}",
		].join("\n");
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores files with a non-JS/TS extension even when the content would otherwise match", () => {
		const code = ["function bug(slot: any, req: any) {", "  Object.assign(slot, req.body);", "}"].join("\n");
		expect(checkBoundaryCopyNoRevalidation(code, "src/lib/foo.py")).toEqual([]);
	});
});

describe("checkCleanupReentrancy — every CLEANUP_METHOD_NAMES entry is live (P: must fire)", () => {
	it("P: close() that calls this.close()", () => {
		const code = ["class Bug {", "  close() {", "    this.close();", "  }", "}"].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([{ line: 3, text: "this.close();" }]);
	});
	it("P: teardown() that calls this.teardown()", () => {
		const code = ["class Bug {", "  teardown() {", "    this.teardown();", "  }", "}"].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([{ line: 3, text: "this.teardown();" }]);
	});
	it("P: unmount() that calls this.unmount()", () => {
		const code = ["class Bug {", "  unmount() {", "    this.unmount();", "  }", "}"].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([{ line: 3, text: "this.unmount();" }]);
	});
	it("P: cleanup() that calls this.cleanup()", () => {
		const code = ["class Bug {", "  cleanup() {", "    this.cleanup();", "  }", "}"].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([{ line: 3, text: "this.cleanup();" }]);
	});
});

describe("checkBoundaryCopyNoRevalidation — .validate call-shape whitespace boundary (N: must not fire)", () => {
	// A bare schema.validate call never calls Object.assign or spreads anything, so
	// isValidated() is never invoked at all — it is vacuous with respect to
	// VALIDATOR_RES regardless of the `.validate` regex's exact whitespace
	// handling. This one actually routes the space-before-paren `.validate`
	// call through Object.assign's source-validation check.
	it("N: Object.assign source wrapped in `.validate (x)` with a space is still recognized (must actually invoke isValidated)", () => {
		const code = "function bug(slot: any, req: any) { Object.assign(slot, schema.validate (req.body)); }";
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});
});
