// Unit tests for performance-loop-checks.ts — loop-body performance
// anti-pattern detectors (await/query/sort/json/regex/clone/malloc/sprintf/
// string-concat in loops).
//
// Coverage focus: per-language pattern-dispatch branches, the "unsupported
// extension" early-return branches, the shared 10-match-per-file cap, and
// the isAwaitInNestedAsync backward brace scan. Basic single-language
// positive/negative cases already live in
// src/harness/__tests__/perf-checks.test.ts (imported via the generic-checks
// barrel) — this file targets the branches that suite doesn't reach.

import { describe, expect, it } from "vitest";
import {
	checkAwaitInLoop,
	checkCloneInLoop,
	checkJsonInLoop,
	checkMallocInLoop,
	checkQueryInLoop,
	checkRegexInLoop,
	checkSortInLoop,
	checkSprintfInLoop,
	checkStringConcatInLoop,
} from "./performance-loop-checks.js";

/** N standalone brace-delimited loops, each with one `line(i)` body line. */
function manyLoops(n: number, line: (i: number) => string): string {
	return Array.from({ length: n }, (_, i) => `for (const x${i} of xs) {\n    ${line(i)}\n}`).join(
		"\n\n",
	);
}

/** One brace-delimited loop with N matching body lines. */
function oneLoopManyLines(n: number, line: (i: number) => string): string {
	const body = Array.from({ length: n }, (_, i) => `    ${line(i)}`).join("\n");
	return `for (const x of xs) {\n${body}\n}`;
}

describe("checkAwaitInLoop — positive (must fire)", () => {
	it("P1: await after a closing brace earlier in the same body (backward brace scan)", () => {
		const code = `for (const item of items) {\n    if (skip) {\n        continue;\n    }\n    await doThing(item);\n}`;
		const out = checkAwaitInLoop(code, "worker.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("await doThing");
	});

	it("P2: caps at 10 findings across many separate loops", () => {
		const code = manyLoops(11, (i) => `await doThing${i}();`);
		const out = checkAwaitInLoop(code, "worker.ts");
		expect(out.length).toBe(10);
	});
});

describe("checkAwaitInLoop — negative (must NOT fire)", () => {
	it("N1: await inside a nested async arrow is not sequential", () => {
		const code = `for (const item of items) {\n    promises.push(async () => {\n        await doWork(item);\n    });\n}`;
		expect(checkAwaitInLoop(code, "worker.ts")).toEqual([]);
	});

	it("N2: non-JS/TS file is out of scope", () => {
		const code = `for x in items:\n    await do_thing(x)`;
		expect(checkAwaitInLoop(code, "worker.py")).toEqual([]);
	});
});

describe("checkQueryInLoop — positive (must fire)", () => {
	it("P1: db.Query(...) inside a Go loop", () => {
		const code = `for _, id := range ids {\n    row := db.Query("SELECT * FROM users WHERE id = ?", id)\n}`;
		expect(checkQueryInLoop(code, "users.go").length).toBeGreaterThan(0);
	});

	it("P2: sqlx::query(...) inside a Rust loop", () => {
		const code = `for id in &ids {\n    sqlx::query("SELECT * FROM users").fetch_one(&pool).await;\n}`;
		expect(checkQueryInLoop(code, "users.rs").length).toBeGreaterThan(0);
	});

	it("P3: statement.executeQuery(...) inside a Java loop", () => {
		const code = `for (String id : ids) {\n    statement.executeQuery("SELECT * FROM users");\n}`;
		expect(checkQueryInLoop(code, "Users.java").length).toBeGreaterThan(0);
	});

	it("P4: caps at 10 findings across many separate loops", () => {
		const code = manyLoops(11, (i) => `db.query("SELECT ${i}")`);
		expect(checkQueryInLoop(code, "users.ts").length).toBe(10);
	});
});

describe("checkQueryInLoop — negative (must NOT fire)", () => {
	it("N1: an extension supported for loop-extraction but not for query patterns (.c)", () => {
		const code = `for (int i = 0; i < n; i++) {\n    db_query("SELECT 1");\n}`;
		expect(checkQueryInLoop(code, "main.c")).toEqual([]);
	});

	it("N2: no loop bodies at all", () => {
		expect(checkQueryInLoop(`const row = await db.query("SELECT 1");`, "users.ts")).toEqual([]);
	});
});

describe("checkStringConcatInLoop — positive (must fire)", () => {
	it("P1: accumulates multiple matches from one loop body (no per-loop cap) up to 10", () => {
		// Python-style loop body (indent-based extraction) with 11 concatenations.
		const pyCode = `for x in xs:\n${Array.from({ length: 11 }, (_, i) => `    result += f"chunk-${i}"`).join("\n")}`;
		const out = checkStringConcatInLoop(pyCode, "builder.py");
		expect(out.length).toBe(10);
	});
});

describe("checkStringConcatInLoop — negative (must NOT fire)", () => {
	it("N1: unsupported extension (JS has a different perf profile)", () => {
		expect(checkStringConcatInLoop(`for(;;){ s += "x"; }`, "builder.ts")).toEqual([]);
	});
});

describe("checkRegexInLoop — positive (must fire)", () => {
	it("P1: NSRegularExpression inside a Swift loop", () => {
		const code = `for line in lines {\n    let re = NSRegularExpression(pattern: "\\\\d+")\n}`;
		expect(checkRegexInLoop(code, "Parser.swift").length).toBeGreaterThan(0);
	});

	it("P2: accumulates matches up to the 10-cap within one loop", () => {
		const code = oneLoopManyLines(11, (i) => `const re${i} = new RegExp(pattern${i});`);
		expect(checkRegexInLoop(code, "parser.ts").length).toBe(10);
	});
});

describe("checkRegexInLoop — negative (must NOT fire)", () => {
	it("N1: an extension supported for loop-extraction but not for regex patterns (.go)", () => {
		const code = `for _, s := range strings {\n    re := compilePattern(s)\n}`;
		expect(checkRegexInLoop(code, "parser.go")).toEqual([]);
	});
});

describe("checkCloneInLoop — positive (must fire)", () => {
	it("P1: accumulates matches up to the 10-cap within one loop", () => {
		const code = oneLoopManyLines(11, (i) => `let c${i} = item.clone();`);
		expect(checkCloneInLoop(code, "process.rs").length).toBe(10);
	});
});

describe("checkCloneInLoop — negative (must NOT fire)", () => {
	it("N1: non-Rust file is out of scope entirely", () => {
		expect(checkCloneInLoop(`for (const x of xs) {\n    const c = x.clone();\n}`, "process.ts")).toEqual(
			[],
		);
	});
});

describe("checkSortInLoop — positive (must fire)", () => {
	it("P1: sorted()/.sort() inside a Python loop", () => {
		const code = `for x in items:\n    sorted(items)\n`;
		expect(checkSortInLoop(code, "sorter.py").length).toBeGreaterThan(0);
	});

	it("P2: .sort()/.sort_by() inside a Rust loop", () => {
		const code = `for x in &items {\n    v.sort();\n}`;
		expect(checkSortInLoop(code, "sorter.rs").length).toBeGreaterThan(0);
	});

	it("P3: sort.Strings(...) inside a Go loop", () => {
		const code = `for _, v := range items {\n    sort.Strings(v)\n}`;
		expect(checkSortInLoop(code, "sorter.go").length).toBeGreaterThan(0);
	});

	it("P4: qsort(...) inside a C loop", () => {
		const code = `for (int i = 0; i < n; i++) {\n    qsort(arr, n, sizeof(int), cmp);\n}`;
		expect(checkSortInLoop(code, "sorter.c").length).toBeGreaterThan(0);
	});

	it("P5: caps at 10 findings across many separate loops", () => {
		const code = manyLoops(11, () => "arr.sort();");
		expect(checkSortInLoop(code, "sorter.ts").length).toBe(10);
	});
});

describe("checkSortInLoop — negative (must NOT fire)", () => {
	it("N1: an extension supported for loop-extraction but not for sort patterns (.java)", () => {
		const code = `for (String s : list) {\n    Collections.sort(list);\n}`;
		expect(checkSortInLoop(code, "Sorter.java")).toEqual([]);
	});
});

describe("checkJsonInLoop — positive (must fire)", () => {
	it("P1: caps at 10 findings within one loop body", () => {
		const code = oneLoopManyLines(11, (i) => `const o${i} = JSON.parse(input${i});`);
		expect(checkJsonInLoop(code, "parser.ts").length).toBe(10);
	});
});

describe("checkJsonInLoop — negative (must NOT fire)", () => {
	it("N1: no loop bodies at all", () => {
		expect(checkJsonInLoop(`const obj = JSON.parse(input);`, "parser.ts")).toEqual([]);
	});

	it("N2: an extension supported for loop-extraction but not for JSON patterns (.go)", () => {
		const code = `for _, s := range strings {\n    obj := decode(s)\n}`;
		expect(checkJsonInLoop(code, "parser.go")).toEqual([]);
	});
});

describe("checkMallocInLoop — positive (must fire)", () => {
	it("P1: caps at 10 findings across many separate loops, each leak-free-checked independently", () => {
		const code = manyLoops(11, (i) => `char *buf${i} = malloc(256);`);
		expect(checkMallocInLoop(code, "alloc.c").length).toBe(10);
	});
});

describe("checkMallocInLoop — negative (must NOT fire)", () => {
	it("N1: unsupported extension short-circuits before scanning for loops", () => {
		const code = `for (let i = 0; i < n; i++) {\n    const buf = malloc(256);\n}`;
		expect(checkMallocInLoop(code, "alloc.ts")).toEqual([]);
	});
});

describe("checkSprintfInLoop — positive (must fire)", () => {
	it("P1: accumulates matches up to the 10-cap within one loop", () => {
		const code = oneLoopManyLines(11, (i) => `s${i} := fmt.Sprintf("%d", ${i})`);
		expect(checkSprintfInLoop(code, "format.go").length).toBe(10);
	});
});

describe("checkSprintfInLoop — negative (must NOT fire)", () => {
	it("N1: non-Go file is out of scope entirely", () => {
		expect(checkSprintfInLoop(`for(;;){ fmt.Sprintf("%d", 1); }`, "format.ts")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Mutation-hardening additions (mutation-testing pass): full-array toEqual
// assertions (kill ObjectLiteral/ArithmeticOperator/MethodExpression on the
// match-building code), per-extension StringLiteral coverage for extension
// arrays, ext-dispatch-chain branch isolation, no-match full-traversal
// fixtures (kill the loop-bound EqualityOperator + forced-match-true
// mutants), and distinguishing regex-spacing probes.
// ---------------------------------------------------------------------------

describe("isAwaitInNestedAsync (via checkAwaitInLoop) — brace-scan internals", () => {
	it("kills c>=0 boundary: nested async recognized when opening brace is at column 0", () => {
		// The async arrow's "{" sits at column 0 of its own line — the reverse
		// char scan must include index 0 or it misses the brace entirely.
		const code = `for (const item of items) {\npromises.push(async () =>\n{\n    await doWork(item);\n});\n}`;
		expect(checkAwaitInLoop(code, "worker.ts")).toEqual([]);
	});

	it("kills '}'/'{' branch + depth<0 boundary: a sibling async decl with a self-closed brace pair must NOT read as enclosing", () => {
		// `async function helper() {}` closes its own brace on the same line —
		// net brace delta is exactly 0. A correct scan must NOT treat this as
		// "depth < 0" (enclosing); several mutants (force '}' to never match,
		// force '{' to always match, flip depth++ /depth--, force depth<0
		// true, or weaken depth<0 to depth<=0) all wrongly conclude the await
		// is nested inside this unrelated sibling declaration.
		const code = `for (const item of items) {\n    async function helper() {}\n    await doThing(item);\n}`;
		const out = checkAwaitInLoop(code, "worker.ts");
		expect(out).toEqual([{ line: 3, text: "await doThing(item);" }]);
	});

	it("kills k<awaitIdx short-circuit: an await line that itself looks like an async-arrow opener must not self-flag as nested", () => {
		// Single-line body: the await line IS the only line scanned (k ===
		// awaitIdx always), so "k < awaitIdx" must be false and gate the
		// whole condition off — even though depth<0 and the regex both hold
		// after scanning this line's own trailing "{}".
		const code = `for (const item of items) {\n    await async () => {}\n}`;
		const out = checkAwaitInLoop(code, "worker.ts");
		expect(out).toEqual([{ line: 2, text: "await async () => {}" }]);
	});

	it("kills k<awaitIdx forced-true / k<=awaitIdx: a self-referential await line with an unmatched trailing brace must not self-flag", () => {
		const code = `for (const item of items) {\n    await doThing(async () => {\n});\n}`;
		const out = checkAwaitInLoop(code, "worker.ts");
		expect(out).toEqual([{ line: 2, text: "await doThing(async () => {" }]);
	});

	it("kills async-regex \\s (single) vs \\s+ (one-or-more): double space after 'async' still opens a nested scope", () => {
		const code = `for (const item of items) {\n    promises.push(async  () => {\n        await doWork(item);\n    });\n}`;
		expect(checkAwaitInLoop(code, "worker.ts")).toEqual([]);
	});

	it("kills async-regex identifier-class negation/quantifier variants: single- and multi-char arrow params", () => {
		const single = `for (const item of items) {\n    promises.push(async x => {\n        await doWork(item);\n    });\n}`;
		expect(checkAwaitInLoop(single, "worker.ts")).toEqual([]);

		const multi = `for (const item of items) {\n    promises.push(async xy => {\n        await doWork(item);\n    });\n}`;
		expect(checkAwaitInLoop(multi, "worker.ts")).toEqual([]);
	});

	it("kills the \\s*=> quantifier mutants: zero spaces before the arrow still opens a nested scope", () => {
		const code = `for (const item of items) {\n    promises.push(async x=>{\n        await doWork(item);\n    });\n}`;
		expect(checkAwaitInLoop(code, "worker.ts")).toEqual([]);
	});
});

describe("checkAwaitInLoop — additional mutation-hardening", () => {
	it("kills the !/\\bawait\\b/ skip-guard: a non-await line ahead of the real await must be skipped, not misreported", () => {
		const code = `for (const item of items) {\n    doSomethingElse();\n    await realWork(item);\n}`;
		expect(checkAwaitInLoop(code, "worker.ts")).toEqual([{ line: 3, text: "await realWork(item);" }]);
	});

	it("kills line/text-building mutants: exact line offset plus trim+slice(0,150) on a long, indented body line", () => {
		const longtext = "x".repeat(200);
		const code = `for (const item of items) {\n    await doThing(${longtext});\n}`;
		const out = checkAwaitInLoop(code, "worker.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.line).toBe(2);
		expect(out[0]?.text.length).toBe(150);
		expect(out[0]?.text.startsWith(" ")).toBe(false);
		expect(out[0]?.text).toBe(`await doThing(${longtext})`.slice(0, 150));
	});

	it.each(["tsx", "js", "jsx", "mjs", "cjs"])(
		"kills per-extension StringLiteral emptying: .%s must still be recognized",
		(ext) => {
			const code = `for (const item of items) {\n    await doThing(item);\n}`;
			expect(checkAwaitInLoop(code, `worker.${ext}`)).toEqual([
				{ line: 2, text: "await doThing(item);" },
			]);
		},
	);
});

describe("checkQueryInLoop — additional mutation-hardening", () => {
	it("kills match-object-building mutants: exact multi-line offset plus trim+slice(0,150)", () => {
		const longq = "x".repeat(200);
		const code = `for (const id of ids) {\n    doNothing();\n    const row = await db.query(${longq});\n}`;
		const out = checkQueryInLoop(code, "users.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.line).toBe(3);
		expect(out[0]?.text.length).toBe(150);
		expect(out[0]?.text).toBe(`const row = await db.query(${longq});`.slice(0, 150));
	});

	it.each(["tsx", "js", "jsx", "mjs", "cjs"])(
		"kills per-extension StringLiteral emptying: .%s must still be recognized",
		(ext) => {
			const code = `for (const id of ids) {\n    const row = await db.query(id);\n}`;
			expect(checkQueryInLoop(code, `users.${ext}`)).toEqual([
				{ line: 2, text: "const row = await db.query(id);" },
			]);
		},
	);

	it("kills the ext===.py branch-disable mutant: Python cursor.execute must still be detected", () => {
		const code = `for user_id in user_ids:\n    cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))\n`;
		expect(checkQueryInLoop(code, "users.py")).toEqual([
			{ line: 2, text: 'cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))' },
		]);
	});

	it("kills the ext===.rs branch bleeding into Java: a Java-only persist() call must use the Java pattern, not the Rust fallback", () => {
		const code = `for (String id : ids) {\n    entityManager.persist(user);\n}`;
		expect(checkQueryInLoop(code, "Users.java")).toEqual([
			{ line: 2, text: "entityManager.persist(user);" },
		]);
	});

	it("kills the ext===.swift branch-disable mutant: a real Swift fetch() must still be detected", () => {
		const code = `for item in items {\n    viewContext.fetch(item)\n}`;
		expect(checkQueryInLoop(code, "Sync.swift")).toEqual([{ line: 2, text: "viewContext.fetch(item)" }]);
	});

	it("kills the ext===.swift branch-forced-true mutant: a swift-shaped call in a .c file (unsupported for query detection) must not fire", () => {
		const code = `for (int i = 0; i < n; i++) {\n    viewContext.fetch(item);\n}`;
		expect(checkQueryInLoop(code, "main.c")).toEqual([]);
	});

	it("kills the pattern.test forced-true + i<=length boundary mutants: a real loop with no query call must return empty, not throw", () => {
		const code = `for (const x of xs) {\n    doSomethingElse();\n}`;
		expect(checkQueryInLoop(code, "users.ts")).toEqual([]);
	});

	it("kills \\S* substitutions in the JS/TS/Go/Rust/Java patterns: spaced-out method calls must still match \\s*", () => {
		expect(checkQueryInLoop(`for (const id of ids) {\n    const row = db . query (id);\n}`, "users.ts")).toEqual(
			[{ line: 2, text: "const row = db . query (id);" }],
		);
		expect(checkQueryInLoop(`for _, id := range ids {\n    row := db . Query (id)\n}`, "users.go")).toEqual([
			{ line: 2, text: "row := db . Query (id)" },
		]);
		expect(checkQueryInLoop(`for id in &ids {\n    conn.execute (id);\n}`, "users.rs")).toEqual([
			{ line: 2, text: "conn.execute (id);" },
		]);
		expect(
			checkQueryInLoop(`for (String id : ids) {\n    statement . executeQuery (id);\n}`, "Users.java"),
		).toEqual([{ line: 2, text: "statement . executeQuery (id);" }]);
	});
});

describe("checkStringConcatInLoop — additional mutation-hardening", () => {
	it("kills the ext-guard forced-false mutant: an unsupported extension (.ts) must not be processed even with += content", () => {
		const code = `for (const x of xs) {\n    result += "chunk";\n}`;
		expect(checkStringConcatInLoop(code, "builder.ts")).toEqual([]);
	});

	it("kills the ext===.go clause mutants (force-true/EqualityOperator/StringLiteral): a real Go += must still fire", () => {
		const code = `for _, item := range items {\n    result += "prefix"\n}`;
		expect(checkStringConcatInLoop(code, "builder.go")).toEqual([{ line: 2, text: 'result += "prefix"' }]);
	});

	it("kills the ext===.py ternary-forced-true mutant: Go's fmt.Sprintf alternative must still fire (Python pattern lacks it)", () => {
		const code = `for _, v := range items {\n    s := fmt.Sprintf("%d", v)\n}`;
		expect(checkStringConcatInLoop(code, "format.go")).toEqual([
			{ line: 2, text: 's := fmt.Sprintf("%d", v)' },
		]);
	});

	it("kills \\W+/\\s/\\S mutants in the Python += regex: tight (no-space) concatenation must still match", () => {
		const code = `for x in xs:\n    result+="x"\n`;
		expect(checkStringConcatInLoop(code, "builder.py").length).toBeGreaterThan(0);
	});

	it("kills the pattern.test forced-true + i<=length boundary mutants: a real Go loop with no concat/Sprintf must return empty, not throw", () => {
		const code = `for _, item := range items {\n    doNothing(item)\n}`;
		expect(checkStringConcatInLoop(code, "builder.go")).toEqual([]);
	});

	it("kills match-object-building mutants: exact line offset for a match", () => {
		const code = `for _, item := range items {\n    doNothing()\n    result += "prefix"\n}`;
		expect(checkStringConcatInLoop(code, "builder.go")).toEqual([{ line: 3, text: 'result += "prefix"' }]);
	});
});

describe("checkRegexInLoop — additional mutation-hardening", () => {
	it.each(["tsx", "js", "jsx", "mjs", "cjs"])(
		"kills per-extension StringLiteral emptying: .%s must still be recognized",
		(ext) => {
			const code = `for (const s of strings) {\n    const re = new RegExp(pattern);\n}`;
			expect(checkRegexInLoop(code, `parser.${ext}`)).toEqual([
				{ line: 2, text: "const re = new RegExp(pattern);" },
			]);
		},
	);

	it("kills the ext===.py branch-disable mutants: Python re.compile must still be detected", () => {
		const code = `for line in lines:\n    pat = re.compile(r"\\d+")\n`;
		expect(checkRegexInLoop(code, "parser.py")).toEqual([{ line: 2, text: 'pat = re.compile(r"\\d+")' }]);
	});

	it("kills the ext===.swift branch-forced-true mutant: a swift-shaped call in a .c file (unsupported) must not fire", () => {
		const code = `for (int i = 0; i < n; i++) {\n    NSRegularExpression(pattern: p);\n}`;
		expect(checkRegexInLoop(code, "main.c")).toEqual([]);
	});

	it("kills \\s vs \\s+ and \\S* substitutions in the new RegExp pattern: irregular spacing must still match", () => {
		expect(checkRegexInLoop(`for (const s of strings) {\n    const re = new  RegExp(pattern);\n}`, "parser.ts"))
			.toEqual([{ line: 2, text: "const re = new  RegExp(pattern);" }]);
		expect(checkRegexInLoop(`for (const s of strings) {\n    const re = new RegExp (pattern);\n}`, "parser.ts"))
			.toEqual([{ line: 2, text: "const re = new RegExp (pattern);" }]);
	});

	it("kills \\S* substitutions in the Swift NSRegularExpression/try Regex pattern: irregular spacing must still match", () => {
		expect(
			checkRegexInLoop(`for line in lines {\n    NSRegularExpression (pattern: p)\n}`, "Parser.swift"),
		).toEqual([{ line: 2, text: "NSRegularExpression (pattern: p)" }]);
		expect(checkRegexInLoop(`for line in lines {\n    try  Regex(p)\n}`, "Parser.swift")).toEqual([
			{ line: 2, text: "try  Regex(p)" },
		]);
		expect(checkRegexInLoop(`for line in lines {\n    try Regex (p)\n}`, "Parser.swift")).toEqual([
			{ line: 2, text: "try Regex (p)" },
		]);
	});

	it("kills the pattern.test forced-true + i<=length boundary mutants: a real loop with no regex compilation must return empty, not throw", () => {
		const code = `for (const x of xs) {\n    doSomethingElse();\n}`;
		expect(checkRegexInLoop(code, "parser.ts")).toEqual([]);
	});

	it("kills match-object-building mutants: exact line offset for a match", () => {
		const code = `for (const s of strings) {\n    doNothing();\n    const re = new RegExp(s);\n}`;
		expect(checkRegexInLoop(code, "parser.ts")).toEqual([{ line: 3, text: "const re = new RegExp(s);" }]);
	});
});

describe("checkCloneInLoop — additional mutation-hardening", () => {
	it("kills \\S* substitutions in the .clone() pattern: irregular spacing must still match", () => {
		expect(checkCloneInLoop(`for item in &items {\n    let c = item.clone ();\n}`, "process.rs")).toEqual([
			{ line: 2, text: "let c = item.clone ();" },
		]);
		expect(checkCloneInLoop(`for item in &items {\n    let c = item.clone(  );\n}`, "process.rs")).toEqual([
			{ line: 2, text: "let c = item.clone(  );" },
		]);
	});

	it("kills the pattern.test forced-true + i<=length boundary mutants: a real loop with no .clone() must return empty, not throw", () => {
		const code = `for item in &items {\n    let x = item.value;\n}`;
		expect(checkCloneInLoop(code, "process.rs")).toEqual([]);
	});

	it("kills match-object-building mutants: exact line offset for a match", () => {
		const code = `for item in &items {\n    let a = 1;\n    let c = item.clone();\n}`;
		expect(checkCloneInLoop(code, "process.rs")).toEqual([{ line: 3, text: "let c = item.clone();" }]);
	});
});

describe("checkSortInLoop — additional mutation-hardening", () => {
	it.each(["tsx", "js", "jsx", "mjs", "cjs"])(
		"kills per-extension StringLiteral emptying: .%s must still be recognized",
		(ext) => {
			const code = `for (let i = 0; i < n; i++) {\n    arr.sort();\n}`;
			expect(checkSortInLoop(code, `sorter.${ext}`)).toEqual([{ line: 2, text: "arr.sort();" }]);
		},
	);

	it("kills the ext===.go branch-forced-true mutant: a Go-shaped sort call in a .c file (unsupported for Go) must not fire", () => {
		const code = `for (int i = 0; i < n; i++) {\n    sort.Strings(v);\n}`;
		expect(checkSortInLoop(code, "main.c")).toEqual([]);
	});

	it.each(["c", "cpp", "cc", "cxx"])(
		"kills per-extension StringLiteral emptying in the C-family array: .%s must still be recognized",
		(ext) => {
			const code = `for (int i = 0; i < n; i++) {\n    qsort(arr, n, sizeof(int), cmp);\n}`;
			expect(checkSortInLoop(code, `sorter.${ext}`)).toEqual([
				{ line: 2, text: "qsort(arr, n, sizeof(int), cmp);" },
			]);
		},
	);

	it("kills the C-family array-check forced-true mutant: qsort() text in an unsupported (.java) file must not fire", () => {
		const code = `for (String s : list) {\n    qsort(arr, n, sz, cmp);\n}`;
		expect(checkSortInLoop(code, "Sorter.java")).toEqual([]);
	});

	it("kills the ext===.swift branch-disable mutants: a real Swift .sorted() must still be detected", () => {
		const code = `for item in items {\n    arr.sorted()\n}`;
		expect(checkSortInLoop(code, "Sorter.swift")).toEqual([{ line: 2, text: "arr.sorted()" }]);
	});

	it("kills \\S* substitutions across the JS/Python/Rust/Go/C patterns: spaced-out calls must still match", () => {
		expect(checkSortInLoop(`for (let i = 0; i < n; i++) {\n    arr.sort (  );\n}`, "sorter.ts")).toEqual([
			{ line: 2, text: "arr.sort (  );" },
		]);
		expect(checkSortInLoop(`for x in items:\n    sorted (items)\n`, "sorter.py")).toEqual([
			{ line: 2, text: "sorted (items)" },
		]);
		expect(checkSortInLoop(`for x in &items {\n    v.sort (  );\n}`, "sorter.rs")).toEqual([
			{ line: 2, text: "v.sort (  );" },
		]);
		expect(checkSortInLoop(`for x in &items {\n     .sort_by ();\n}`, "sorter.rs")).toEqual([
			{ line: 2, text: ".sort_by ();" },
		]);
		expect(checkSortInLoop(`for _, v := range items {\n    sort.Strings (v)\n}`, "sorter.go")).toEqual([
			{ line: 2, text: "sort.Strings (v)" },
		]);
		expect(checkSortInLoop(`for (int i = 0; i < n; i++) {\n    qsort (arr, n, sizeof(int), cmp);\n}`, "sorter.c"))
			.toEqual([{ line: 2, text: "qsort (arr, n, sizeof(int), cmp);" }]);
	});

	it("kills the pattern.test forced-true + i<=length boundary mutants: a real loop with no sort call must return empty, not throw", () => {
		const code = `for (let i = 0; i < n; i++) {\n    doSomethingElse();\n}`;
		expect(checkSortInLoop(code, "sorter.ts")).toEqual([]);
	});

	it("kills match-object-building mutants: exact line offset for a match", () => {
		const code = `for (let i = 0; i < n; i++) {\n    doNothing();\n    arr.sort();\n}`;
		expect(checkSortInLoop(code, "sorter.ts")).toEqual([{ line: 3, text: "arr.sort();" }]);
	});
});

describe("checkJsonInLoop — additional mutation-hardening", () => {
	it.each(["tsx", "js", "jsx", "mjs", "cjs"])(
		"kills per-extension StringLiteral emptying: .%s must still be recognized",
		(ext) => {
			const code = `for (const s of strings) {\n    const obj = JSON.parse(s);\n}`;
			expect(checkJsonInLoop(code, `parser.${ext}`)).toEqual([
				{ line: 2, text: "const obj = JSON.parse(s);" },
			]);
		},
	);

	it("kills the ts-group array-check forced-true mutant: JSON.parse text in an unsupported (.c) file must not fire", () => {
		const code = `for (int i = 0; i < n; i++) {\n    JSON.parse(x);\n}`;
		expect(checkJsonInLoop(code, "main.c")).toEqual([]);
	});

	it("kills the ext===.py branch mutants: Python json.loads must still be detected", () => {
		const code = `for line in lines:\n    data = json.loads(line)\n`;
		expect(checkJsonInLoop(code, "parser.py")).toEqual([{ line: 2, text: "data = json.loads(line)" }]);
	});

	it("kills the ext===.swift branch mutants: a real Swift JSONDecoder().decode must still be detected", () => {
		const code = `for line in lines {\n    let obj = JSONDecoder().decode(line)\n}`;
		expect(checkJsonInLoop(code, "Parser.swift")).toEqual([
			{ line: 2, text: "let obj = JSONDecoder().decode(line)" },
		]);
	});

	it("kills \\S* substitution in the JSON.parse|stringify pattern: spaced-out call must still match", () => {
		const code = `for (const s of strings) {\n    const obj = JSON.parse (s);\n}`;
		expect(checkJsonInLoop(code, "parser.ts")).toEqual([{ line: 2, text: "const obj = JSON.parse (s);" }]);
	});

	it("kills the pattern.test forced-true + i<=length boundary mutants: a real loop with no JSON call must return empty, not throw", () => {
		const code = `for (const x of xs) {\n    doSomethingElse();\n}`;
		expect(checkJsonInLoop(code, "parser.ts")).toEqual([]);
	});

	it("kills match-object-building mutants: exact line offset for a match", () => {
		const code = `for (const s of strings) {\n    doNothing();\n    const obj = JSON.parse(s);\n}`;
		expect(checkJsonInLoop(code, "parser.ts")).toEqual([{ line: 3, text: "const obj = JSON.parse(s);" }]);
	});
});

describe("checkMallocInLoop — additional mutation-hardening", () => {
	it.each(["c", "cpp", "cc", "cxx", "h", "hpp"])(
		"kills per-extension StringLiteral emptying: .%s must still be recognized",
		(ext) => {
			const code = `for (int i = 0; i < n; i++) {\n    char *buf = malloc(256);\n}`;
			expect(checkMallocInLoop(code, `alloc.${ext}`)).toEqual([
				{ line: 2, text: "char *buf = malloc(256);" },
			]);
		},
	);

	it("kills the hasFree forced-false mutant: malloc with a free() in the same loop must NOT be flagged", () => {
		const code = `for (int i = 0; i < n; i++) {\n    char *buf = malloc(256);\n    free(buf);\n}`;
		expect(checkMallocInLoop(code, "alloc.c")).toEqual([]);
	});

	it("kills \\s vs \\S* substitutions in the free()/malloc() patterns: spaced-out calls must still match", () => {
		const code = `for (int i = 0; i < n; i++) {\n    char *buf = malloc (256);\n}`;
		expect(checkMallocInLoop(code, "alloc.c")).toEqual([{ line: 2, text: "char *buf = malloc (256);" }]);
	});

	it("kills the pattern.test forced-true + i<=length boundary mutants: a real loop with no malloc must return empty, not throw", () => {
		const code = `for (int i = 0; i < n; i++) {\n    doSomethingElse();\n}`;
		expect(checkMallocInLoop(code, "alloc.c")).toEqual([]);
	});

	it("kills match-object-building mutants: exact line offset for a match", () => {
		const code = `for (int i = 0; i < n; i++) {\n    int a = 1;\n    char *buf = malloc(256);\n}`;
		expect(checkMallocInLoop(code, "alloc.c")).toEqual([{ line: 3, text: "char *buf = malloc(256);" }]);
	});
});

describe("checkSprintfInLoop — additional mutation-hardening", () => {
	it("kills the ext-guard forced-false mutant: an unsupported extension (.ts) must not be processed even with fmt.Sprintf-shaped content", () => {
		const code = `for (const x of xs) {\n    fmt.Sprintf("%d", x);\n}`;
		expect(checkSprintfInLoop(code, "format.ts")).toEqual([]);
	});

	it("kills \\S* substitution in the fmt.Sprintf pattern: spaced-out call must still match", () => {
		const code = `for _, v := range items {\n    s := fmt.Sprintf (v);\n}`;
		expect(checkSprintfInLoop(code, "format.go")).toEqual([{ line: 2, text: "s := fmt.Sprintf (v);" }]);
	});

	it("kills the pattern.test forced-true + i<=length boundary mutants: a real Go loop with no fmt.Sprintf must return empty, not throw", () => {
		const code = `for _, v := range items {\n    doSomethingElse(v)\n}`;
		expect(checkSprintfInLoop(code, "format.go")).toEqual([]);
	});

	it("kills match-object-building mutants: exact line offset for a match", () => {
		const code = `for _, v := range items {\n    doNothing()\n    s := fmt.Sprintf("%d", v)\n}`;
		expect(checkSprintfInLoop(code, "format.go")).toEqual([{ line: 3, text: 's := fmt.Sprintf("%d", v)' }]);
	});
});

describe("mutation-hardening round 2 — closing remaining survivors", () => {
	it("kills the checkAwaitInLoop ext-guard forced-false mutant: an unsupported extension (.py) with brace-valid await content must not fire", () => {
		const code = `for (const item of items) {\n    await doThing(item);\n}`;
		expect(checkAwaitInLoop(code, "script.py")).toEqual([]);
	});

	it("kills checkStringConcatInLoop's trim+slice(0,150) drop: long, non-whitespace-trimmed body line", () => {
		const longtext = "x".repeat(200);
		const code = `for _, item := range items {\n    result += "${longtext}"\n}`;
		const out = checkStringConcatInLoop(code, "builder.go");
		expect(out.length).toBe(1);
		expect(out[0]?.text.length).toBe(150);
		expect(out[0]?.text).toBe(`result += "${longtext}"`.slice(0, 150));
	});

	it("kills checkRegexInLoop's trim+slice(0,150) drop: long body line", () => {
		const longtext = "x".repeat(200);
		const code = `for (const s of strings) {\n    const re = new RegExp(${longtext});\n}`;
		const out = checkRegexInLoop(code, "parser.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text.length).toBe(150);
		expect(out[0]?.text).toBe(`const re = new RegExp(${longtext});`.slice(0, 150));
	});

	it("kills checkCloneInLoop's trim+slice(0,150) drop: long body line", () => {
		const longtext = "x".repeat(200);
		const code = `for item in &items {\n    let c = item${longtext}.clone();\n}`;
		const out = checkCloneInLoop(code, "process.rs");
		expect(out.length).toBe(1);
		expect(out[0]?.text.length).toBe(150);
		expect(out[0]?.text).toBe(`let c = item${longtext}.clone();`.slice(0, 150));
	});

	it("kills the Python .sort() regex \\s vs \\s* mutants: tight and spaced .sort() calls must both match", () => {
		expect(checkSortInLoop(`for x in items:\n    arr.sort()\n`, "sorter.py")).toEqual([
			{ line: 2, text: "arr.sort()" },
		]);
		expect(checkSortInLoop(`for x in items:\n    arr.sort ()\n`, "sorter.py")).toEqual([
			{ line: 2, text: "arr.sort ()" },
		]);
	});

	it("kills the Rust .sort_by() regex \\s vs \\s* mutant: a tight (no-space) .sort_by() call must still match", () => {
		const code = `for x in &items {\n    v.sort_by(|a,b| a.cmp(b));\n}`;
		expect(checkSortInLoop(code, "sorter.rs")).toEqual([{ line: 2, text: "v.sort_by(|a,b| a.cmp(b));" }]);
	});

	it("kills checkSortInLoop's trim+slice(0,150) drop: long body line", () => {
		const longtext = "x".repeat(200);
		const code = `for (let i = 0; i < n; i++) {\n    arr.sort(${longtext});\n}`;
		const out = checkSortInLoop(code, "sorter.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text.length).toBe(150);
		expect(out[0]?.text).toBe(`arr.sort(${longtext});`.slice(0, 150));
	});

	it("kills checkJsonInLoop's ext===.swift branch-forced-true mutant: JSONDecoder-shaped text in a .c file (unsupported) must not fire", () => {
		const code = `for (int i = 0; i < n; i++) {\n    JSONDecoder().decode(x);\n}`;
		expect(checkJsonInLoop(code, "main.c")).toEqual([]);
	});

	it("kills checkJsonInLoop's trim+slice(0,150) drop: long body line", () => {
		const longtext = "x".repeat(200);
		const code = `for (const s of strings) {\n    const obj = JSON.parse(${longtext});\n}`;
		const out = checkJsonInLoop(code, "parser.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text.length).toBe(150);
		expect(out[0]?.text).toBe(`const obj = JSON.parse(${longtext});`.slice(0, 150));
	});

	it("kills the free() regex \\s* vs \\S* mutant: a spaced free() call must still suppress the malloc finding", () => {
		const code = `for (int i = 0; i < n; i++) {\n    char *buf = malloc(256);\n    free (buf);\n}`;
		expect(checkMallocInLoop(code, "alloc.c")).toEqual([]);
	});

	it("kills checkMallocInLoop's trim+slice(0,150) drop: long body line", () => {
		const longtext = "x".repeat(200);
		const code = `for (int i = 0; i < n; i++) {\n    char *buf = malloc(${longtext});\n}`;
		const out = checkMallocInLoop(code, "alloc.c");
		expect(out.length).toBe(1);
		expect(out[0]?.text.length).toBe(150);
		expect(out[0]?.text).toBe(`char *buf = malloc(${longtext});`.slice(0, 150));
	});

	it("kills checkSprintfInLoop's trim+slice(0,150) drop: long body line", () => {
		const longtext = "x".repeat(200);
		const code = `for _, v := range items {\n    s := fmt.Sprintf(${longtext});\n}`;
		const out = checkSprintfInLoop(code, "format.go");
		expect(out.length).toBe(1);
		expect(out[0]?.text.length).toBe(150);
		expect(out[0]?.text).toBe(`s := fmt.Sprintf(${longtext});`.slice(0, 150));
	});
});

// ---------------------------------------------------------------------------
// mutation-kill-w27: closing the manifest-listed survivor set (regex \s*/\S*
// spacing mutants on the Python/Swift branches of checkQueryInLoop and
// checkJsonInLoop, the Swift checkSortInLoop alternation, the Python
// checkRegexInLoop branch, and the Go checkStringConcatInLoop clause).
// ---------------------------------------------------------------------------

describe("checkQueryInLoop — w27 spacing survivors", () => {
	// test-contract: regex-branch — kills all three \s* positions in the
	// Python cursor/session/db pattern (before-dot, after-dot, before-paren)
	// by requiring each to accept a literal space that \S* cannot.
	it("kills the Python cursor pattern's three \\s* positions: a spaced-out call must still match", () => {
		const code = `for user_id in user_ids:\n    cursor . execute (id)\n`;
		expect(checkQueryInLoop(code, "users.py")).toEqual([{ line: 2, text: "cursor . execute (id)" }]);
	});

	// test-contract: regex-branch — kills the three \s* positions in the
	// Swift context/viewContext/managedObjectContext alternative.
	it("kills the Swift context-branch's three \\s* positions: a spaced-out fetch() must still match", () => {
		const code = `for item in items {\n    viewContext . fetch (item)\n}`;
		expect(checkQueryInLoop(code, "Sync.swift")).toEqual([{ line: 2, text: "viewContext . fetch (item)" }]);
	});

	// test-contract: regex-branch — kills the three \S* (spacing-tolerant)
	// mutants in the Swift db/dbQueue/dbPool alternative.
	it("kills the Swift db-branch's three \\S* positions: a spaced-out read() must still match", () => {
		const code = `for item in items {\n    dbQueue . read (x)\n}`;
		expect(checkQueryInLoop(code, "Sync.swift")).toEqual([{ line: 2, text: "dbQueue . read (x)" }]);
	});

	// test-contract: regex-branch — kills the three mandatory-\s (one-or-
	// exactly-one) mutants in the same Swift db-branch by using zero spacing,
	// which \s* accepts but a mandatory \s does not.
	it("kills the Swift db-branch's three mandatory-\\s positions: a tight read() must still match", () => {
		const code = `for item in items {\n    dbQueue.read(x)\n}`;
		expect(checkQueryInLoop(code, "Sync.swift")).toEqual([{ line: 2, text: "dbQueue.read(x)" }]);
	});
});

describe("checkStringConcatInLoop — w27 Go clause spacing survivors", () => {
	// test-contract: regex-branch — a fully tight Go concatenation (zero
	// spaces anywhere, quote immediately after "+=") simultaneously kills:
	// \w+→\W+ (word char before += must still match), the two mandatory-\s
	// substitutions (before and after +=), and the negated-class substitution
	// (quote char right after += must still match the positive class).
	it("kills the Go clause's \\W+/mandatory-\\s/negated-class mutants: a fully tight concatenation must still match", () => {
		const code = `for _, item := range items {\n    result+="x"\n}`;
		expect(checkStringConcatInLoop(code, "builder.go")).toEqual([{ line: 2, text: 'result+="x"' }]);
	});
});

describe("checkRegexInLoop — w27 Python spacing survivor", () => {
	// test-contract: regex-branch — kills the \s*→\S* mutant on the Python
	// re.compile pattern by requiring a literal space before the paren.
	it("kills the Python re.compile \\s*→\\S* mutant: a spaced-out call must still match", () => {
		const code = `for line in lines:\n    re.compile (r"\\d+")\n`;
		expect(checkRegexInLoop(code, "parser.py")).toEqual([{ line: 2, text: 're.compile (r"\\d+")' }]);
	});
});

describe("checkSortInLoop — w27 Swift alternation survivors", () => {
	// test-contract: regex-branch — kills the first alt's \s*→\S* mutant: a
	// spaced ".sorted (" must still match via the first alternative (the
	// second alternative can't rescue it — "sorted" isn't "sort" followed
	// directly by whitespace/paren).
	it("kills the Swift .sorted() first-alt \\S* mutant: a spaced-out .sorted call must still match", () => {
		const code = `for item in items {\n    arr.sorted (x)\n}`;
		expect(checkSortInLoop(code, "Sorter.swift")).toEqual([{ line: 2, text: "arr.sorted (x)" }]);
	});

	// test-contract: regex-branch — kills the second alt's mandatory-\s
	// mutant: a tight ".sort()" (zero spaces) doesn't satisfy a mandatory
	// single whitespace but does satisfy \s*.
	it("kills the Swift .sort() second-alt mandatory-\\s mutant: a tight .sort() must still match", () => {
		const code = `for (let i = 0; i < n; i++) {\n    arr.sort()\n}`;
		expect(checkSortInLoop(code, "Sorter.swift")).toEqual([{ line: 2, text: "arr.sort()" }]);
	});

	// test-contract: regex-branch — kills the second alt's \s*→\S* mutant: a
	// spaced ".sort (" (not "sorted") must still match via the second
	// alternative.
	it("kills the Swift .sort() second-alt \\S* mutant: a spaced-out .sort call must still match", () => {
		const code = `for (let i = 0; i < n; i++) {\n    arr.sort (x)\n}`;
		expect(checkSortInLoop(code, "Sorter.swift")).toEqual([{ line: 2, text: "arr.sort (x)" }]);
	});
});

describe("checkJsonInLoop — w27 Python and Swift spacing survivors", () => {
	// test-contract: regex-branch — kills the Python json.loads \s*→\S*
	// mutant by requiring a literal space before the paren.
	it("kills the Python json.loads \\s*→\\S* mutant: a spaced-out call must still match", () => {
		const code = `for line in lines:\n    json.loads (line)\n`;
		expect(checkJsonInLoop(code, "parser.py")).toEqual([{ line: 2, text: "json.loads (line)" }]);
	});

	// test-contract: regex-branch — kills the three \S* mutants in the
	// JSONDecoder alternative (before-paren, inside-parens, before-.decode)
	// with one spaced-out fixture.
	it("kills the Swift JSONDecoder alt's three \\S* positions: a spaced-out decode() must still match", () => {
		const code = `for line in lines {\n    JSONDecoder ( ) .decode(line)\n}`;
		expect(checkJsonInLoop(code, "Parser.swift")).toEqual([
			{ line: 2, text: "JSONDecoder ( ) .decode(line)" },
		]);
	});

	// test-contract: regex-branch — kills the three \S* mutants in the
	// JSONEncoder alternative (mandatory-\s siblings still pass since one
	// space also satisfies "exactly one").
	it("kills the Swift JSONEncoder alt's three \\S* positions: a spaced-out encode() must still match", () => {
		const code = `for line in lines {\n    JSONEncoder ( ) .encode(x)\n}`;
		expect(checkJsonInLoop(code, "Parser.swift")).toEqual([
			{ line: 2, text: "JSONEncoder ( ) .encode(x)" },
		]);
	});

	// test-contract: regex-branch — kills the three mandatory-\s mutants in
	// the JSONEncoder alternative: zero spacing satisfies \s* but not a
	// mandatory single whitespace.
	it("kills the Swift JSONEncoder alt's three mandatory-\\s positions: a tight encode() must still match", () => {
		const code = `for line in lines {\n    JSONEncoder().encode(x)\n}`;
		expect(checkJsonInLoop(code, "Parser.swift")).toEqual([{ line: 2, text: "JSONEncoder().encode(x)" }]);
	});

	// test-contract: regex-branch — kills the three \S* mutants in the
	// JSONSerialization alternative (before-dot, after-dot, before-paren).
	it("kills the Swift JSONSerialization alt's three \\S* positions: a spaced-out jsonObject() must still match", () => {
		const code = `for line in lines {\n    JSONSerialization . jsonObject (x)\n}`;
		expect(checkJsonInLoop(code, "Parser.swift")).toEqual([
			{ line: 2, text: "JSONSerialization . jsonObject (x)" },
		]);
	});

	// test-contract: regex-branch — kills the three mandatory-\s mutants in
	// the JSONSerialization alternative with a fully tight fixture.
	it("kills the Swift JSONSerialization alt's three mandatory-\\s positions: a tight jsonObject() must still match", () => {
		const code = `for line in lines {\n    JSONSerialization.jsonObject(x)\n}`;
		expect(checkJsonInLoop(code, "Parser.swift")).toEqual([
			{ line: 2, text: "JSONSerialization.jsonObject(x)" },
		]);
	});
});

describe("checkQueryInLoop n+1 dataflow tag — positive (must fire)", () => {
	it("P1: JS loop over a query result tags the finding with the source line", () => {
		const code = `const users = await db.query("SELECT * FROM users");\nfor (const u of users) {\n    const posts = await db.query(u.id);\n}`;
		const out = checkQueryInLoop(code, "users.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain(
			"[n+1: `users` is loaded by the query at line 1 — batch into one query",
		);
	});

	it("P2: Python loop over cursor.fetchall() result is tagged", () => {
		const code = `rows = cursor.fetchall()\nfor r in rows:\n    cursor.execute("SELECT * FROM posts WHERE uid = %s", (r,))\n`;
		const out = checkQueryInLoop(code, "users.py");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("[n+1: `rows` is loaded by the query at line 1");
	});

	it("P3: Go range over db.Query result (tuple assign rows, err :=) is tagged", () => {
		const code = `rows, err := db.Query("SELECT id FROM users")\nfor _, r := range rows {\n    db.QueryRow("SELECT * FROM posts WHERE uid = ?", r)\n}`;
		const out = checkQueryInLoop(code, "users.go");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("[n+1: `rows` is loaded by the query at line 1");
	});

	it("P4: the source assignment may sit several lines above the loop head", () => {
		const filler = Array.from({ length: 10 }, (_, i) => `doStep${i}();`).join("\n");
		const code = `const users = await db.query("SELECT * FROM users");\n${filler}\nfor (const u of users) {\n    await db.findOne(u.id);\n}`;
		const out = checkQueryInLoop(code, "users.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("[n+1: `users` is loaded by the query at line 1");
	});
});

describe("checkQueryInLoop n+1 dataflow tag — negative (must NOT tag)", () => {
	it("N1: loop over a plain array still fires the base finding, without the tag", () => {
		const code = `const ids = [1, 2, 3];\nfor (const id of ids) {\n    const row = await db.query(id);\n}`;
		const out = checkQueryInLoop(code, "users.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).not.toContain("[n+1:");
	});

	it("N2: index-based for loop carries no iterable to trace — no tag", () => {
		const code = `const users = await db.query("SELECT * FROM users");\nfor (let i = 0; i < users.length; i++) {\n    await db.findOne(i);\n}`;
		const out = checkQueryInLoop(code, "users.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).not.toContain("[n+1:");
	});

	it("N3: a query-fed assignment more than 40 lines above the head is out of scan range — no tag", () => {
		const filler = Array.from({ length: 45 }, (_, i) => `doStep${i}();`).join("\n");
		const code = `const users = await db.query("SELECT * FROM users");\n${filler}\nfor (const u of users) {\n    await db.findOne(u.id);\n}`;
		const out = checkQueryInLoop(code, "users.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).not.toContain("[n+1:");
	});

	it("N4: an iterable assigned from a non-query expression is not tagged even when a query ran nearby", () => {
		const code = `const rows = await db.query("SELECT 1");\nconst names = rows.map(pick);\nfor (const n of names) {\n    await db.findOne(n);\n}`;
		const out = checkQueryInLoop(code, "users.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).not.toContain("[n+1:");
	});
});
