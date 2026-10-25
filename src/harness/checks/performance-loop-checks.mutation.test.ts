// Mutation-hardening tests for performance-loop-checks.ts. Each test pins one
// observable behavior of a loop-body detector that the sibling test file does
// not distinguish. Basis for behaviors: the JSDoc on each exported detector in
// performance-loop-checks.ts (e.g. checkAwaitInLoop "Detect await inside
// for/while loops", findQueryFedIterable "up to 8 lines above ... up to 40
// lines above the head ... assignment whose LHS binds the iterable").

import { describe, expect, it } from "vitest";
import {
	checkAwaitInLoop,
	checkMallocInLoop,
	checkQueryInLoop,
	checkSortInLoop,
	checkStringConcatInLoop,
} from "./performance-loop-checks.js";

const filler = (n: number): string =>
	Array.from({ length: n }, (_, i) => `doStep${i}();`).join("\n");

describe("checkAwaitInLoop — one finding per loop", () => {
	it("reports only the first await when a single loop body awaits twice", () => {
		const code = "for (const x of xs) {\n  await a(x);\n  await b(x);\n}";
		const out = checkAwaitInLoop(code, "a.ts");
		expect(out.map((m) => m.line)).toEqual([2]);
	});

	it("does not treat identifiers that merely start with 'await' as an await expression", () => {
		const code = "for (const x of xs) {\n  const awaiter = x;\n  awaitable(awaiter);\n}";
		expect(checkAwaitInLoop(code, "a.ts")).toEqual([]);
	});
});

describe("checkStringConcatInLoop — Go backtick literal", () => {
	it("flags += of a backtick raw string inside a Go loop", () => {
		const code = "for _, s := range xs {\n\tout += `row`\n}";
		expect(checkStringConcatInLoop(code, "a.go").map((m) => m.line)).toEqual([2]);
	});
});

describe("checkMallocInLoop — per-loop free check and one finding per loop", () => {
	it("still flags a later leaking loop after an earlier loop that frees", () => {
		const code =
			"for (i = 0; i < n; i++) {\n  free(p);\n}\nfor (j = 0; j < n; j++) {\n  q = malloc(8);\n}";
		expect(checkMallocInLoop(code, "a.c").map((m) => m.line)).toEqual([5]);
	});

	it("reports one finding for a loop body that allocates twice", () => {
		const code = "for (i = 0; i < n; i++) {\n  a = malloc(8);\n  b = calloc(1, 8);\n}";
		expect(checkMallocInLoop(code, "a.c").map((m) => m.line)).toEqual([2]);
	});
});

describe("checkSortInLoop — Rust sort_unstable", () => {
	it("flags .sort_unstable() inside a Rust loop", () => {
		const code = "for v in vs {\n    v.sort_unstable();\n}";
		expect(checkSortInLoop(code, "a.rs").map((m) => m.line)).toEqual([2]);
	});
});

describe("checkQueryInLoop — query call names per language", () => {
	it.each([
		["supabase.select in TS", "for (const x of xs) {\n  supabase.select(x);\n}", "a.ts"],
		["db.raw in TS", "for (const x of xs) {\n  db.raw(x);\n}", "a.ts"],
		["cursor.fetchone in Python", "for x in xs:\n    cursor.fetchone()\n", "a.py"],
		["db.NamedExec in Go", "for _, x := range xs {\n\tdb.NamedExec(q, x)\n}", "a.go"],
		["fetch_optional in Rust", "for x in xs {\n    q.fetch_optional(&pool)\n}", "a.rs"],
		[
			"capitalised Statement.executeQuery in Java (case-insensitive receiver)",
			"for (String x : xs) {\n  Statement.executeQuery(x);\n}",
			"A.java",
		],
		["context.count in Swift", "for x in xs {\n  let n = context.count(x)\n}", "a.swift"],
	])("flags %s", (_name, code, file) => {
		expect(checkQueryInLoop(code, file).map((m) => m.line)).toEqual([2]);
	});
});

describe("checkQueryInLoop n+1 tag — iterable head forms", () => {
	const TAG = "[n+1:";

	it("traces a for...in iterable in JS/TS", () => {
		const code = 'const rows = db.query("x");\nfor (const r in rows) {\n  db.get(r);\n}';
		expect(checkQueryInLoop(code, "a.ts")[0]?.text).toContain(`${TAG} \`rows\``);
	});

	it("traces an iterable written after 'of await'", () => {
		const code = 'const users = db.query("x");\nfor (const u of await users) {\n  db.get(u);\n}';
		expect(checkQueryInLoop(code, "a.ts")[0]?.text).toContain(`${TAG} \`users\``);
	});

	it("traces a Python iterable that is sliced (rows[1:])", () => {
		const code = 'rows = cursor.fetchall()\nfor r in rows[1:]:\n    cursor.execute("q", (r,))\n';
		expect(checkQueryInLoop(code, "a.py")[0]?.text).toContain(`${TAG} \`rows\``);
	});

	it("traces a Rust iterable borrowed with &", () => {
		const code =
			'let rows = sqlx::query("x").fetch_all(&pool);\nfor r in &rows {\n    sqlx::query("y");\n}';
		expect(checkQueryInLoop(code, "a.rs")[0]?.text).toContain(`${TAG} \`rows\``);
	});

	it("traces a Java enhanced-for iterable", () => {
		const code =
			'ResultSet rows = statement.executeQuery("x");\nfor (Row r : rows) {\n  statement.executeUpdate(r);\n}';
		expect(checkQueryInLoop(code, "A.java")[0]?.text).toContain(`${TAG} \`rows\``);
	});

	it("traces an identifier containing '$' in the middle", () => {
		const code = 'const a$b = db.query("x");\nfor (const r of a$b) {\n  db.get(r);\n}';
		expect(checkQueryInLoop(code, "a.ts")[0]?.text).toContain(`${TAG} \`a$b\``);
	});

	it("does not take a comparison (==) as the assignment that feeds the iterable", () => {
		const code = "users == db.get(1);\nfor (const u of users) {\n  db.get(u);\n}";
		expect(checkQueryInLoop(code, "a.ts")[0]?.text).not.toContain(TAG);
	});

	it("accepts a source assignment exactly 40 lines above the loop head", () => {
		const code = `const users = db.query("x");\n${filler(39)}\nfor (const u of users) {\n  db.get(u);\n}`;
		expect(checkQueryInLoop(code, "a.ts")[0]?.text).toContain(`${TAG} \`users\``);
	});

	it("uses the enclosing for-of head when the loop's own head has no iterable (head 7 lines above body)", () => {
		const code = [
			'const users = db.query("x");',
			"for (const u of users) {",
			"  a();",
			"  b();",
			"  c();",
			"  d();",
			"  e();",
			"  for (let i = 0; i < 3; i++) {",
			"    db.get(i);",
			"  }",
			"}",
		].join("\n");
		const out = checkQueryInLoop(code, "a.ts");
		expect(out).toHaveLength(2);
		expect(out[1]?.text).toContain(`${TAG} \`users\``);
	});

	it("uses the loop's own head, not a loop head on the body's first line", () => {
		const code = [
			'const users = db.query("x");',
			"for (const u of users) {",
			"  for (const p of u.posts) {",
			"    db.get(p);",
			"  }",
			"}",
		].join("\n");
		const outer = checkQueryInLoop(code, "a.ts")[0];
		expect(outer?.text).toContain(`${TAG} \`users\``);
	});

	it("stops at the nearest loop head: an untraceable inner iterable is not tagged via an outer head", () => {
		const code = [
			'const users = db.query("x");',
			"for (const u of users) {",
			"  for (const p of u.posts) {",
			"    db.get(p);",
			"  }",
			"}",
		].join("\n");
		const out = checkQueryInLoop(code, "a.ts");
		expect(out).toHaveLength(2);
		expect(out[0]?.text).toContain(`${TAG} \`users\``);
		expect(out[1]?.text).not.toContain(TAG);
	});
});
