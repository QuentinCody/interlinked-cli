// Behavioral tests for cross-language SQL-injection detection.
// Source: ./cross-language.ts (checkSqlInjection).
//
// checkSqlInjection runs on COMMENT-stripped content (strings are kept), so we
// assert both that genuine string-interpolation sink shapes fire and that the
// catalog of safe-pattern exclusions stays silent. Reported line numbers are
// 1-based and point at the original (un-stripped) line.

import { describe, expect, it } from "vitest";
import { checkSqlInjection } from "./cross-language.js";

const TS = "src/db/queries.ts";
const PY = "src/db/queries.py";
const SWIFT = "Sources/App/Store.swift";

describe("checkSqlInjection — JS/TS template-literal interpolation", () => {
	it("flags .query() with template-literal interpolation", () => {
		const code = "db.query(`SELECT * FROM users WHERE id = ${userId}`);";
		const matches = checkSqlInjection(code, TS);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(1);
		expect(matches[0]?.text).toContain("db.query");
	});

	it("flags .execute(), .raw(), .prepare(), and .exec() the same way", () => {
		for (const method of ["execute", "raw", "prepare", "exec"]) {
			const code = `conn.${method}(\`SELECT * FROM t WHERE c = \${val}\`);`;
			const matches = checkSqlInjection(code, TS);
			expect(matches).toHaveLength(1);
			expect(matches[0]?.text).toContain(`conn.${method}`);
		}
	});

	it("fires across the full JS/TS extension set", () => {
		for (const path of [
			"a.ts",
			"a.tsx",
			"a.js",
			"a.jsx",
			"a.mjs",
			"a.cjs",
		]) {
			const code = "x.query(`DELETE FROM t WHERE k = ${k}`)";
			expect(checkSqlInjection(code, path)).toHaveLength(1);
		}
	});

	it("reports the correct 1-based line within a multi-line file", () => {
		const code = [
			"function run(userId) {",
			"  const ok = true;",
			"  return db.execute(`SELECT * FROM u WHERE id = ${userId}`);",
			"}",
		].join("\n");
		const matches = checkSqlInjection(code, TS);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(3);
	});

	it("truncates the reported text to 150 chars and trims it", () => {
		const tail = "x".repeat(300);
		const code = `      db.query(\`SELECT ${"${userId}"} -- ${tail}\`)`;
		const matches = checkSqlInjection(code, TS);
		expect(matches).toHaveLength(1);
		// Leading indentation is trimmed, then sliced to 150.
		expect(matches[0]?.text.length).toBe(150);
		expect(matches[0]?.text.startsWith("db.query")).toBe(true);
	});

	it("does not fire on a parameterized query (placeholder + args, no interpolation)", () => {
		const code = "db.query('SELECT * FROM users WHERE id = ?', [userId]);";
		expect(checkSqlInjection(code, TS)).toEqual([]);
	});

	it("does not fire on a template literal with no interpolation", () => {
		const code = "db.query(`SELECT * FROM users`);";
		expect(checkSqlInjection(code, TS)).toEqual([]);
	});

	it("does not fire when the interpolation is inside a comment", () => {
		// stripComments blanks the // tail, so the sink shape disappears.
		const code = "const sql = 1; // db.query(`SELECT ${x}`)";
		expect(checkSqlInjection(code, TS)).toEqual([]);
	});
});

describe("checkSqlInjection — JS/TS safe-pattern exclusions", () => {
	it("skips PRAGMA statements (schema introspection)", () => {
		const code = "db.exec(`PRAGMA table_info(${tbl})`);";
		expect(checkSqlInjection(code, TS)).toEqual([]);
	});

	it("skips DDL with code-controlled identifiers (ALTER/DROP/CREATE TABLE|INDEX|TRIGGER)", () => {
		for (const ddl of [
			"db.exec(`ALTER TABLE ${name} ADD COLUMN x`)",
			"db.exec(`DROP INDEX ${name}`)",
			"db.exec(`CREATE TRIGGER ${name} AFTER INSERT`)",
		]) {
			expect(checkSqlInjection(ddl, TS)).toEqual([]);
		}
	});

	it("skips SQL-fragment helper calls — ${UPPER_NAME(...)}", () => {
		const code = "db.query(`SELECT * FROM t WHERE ${ARCHIVED_FILTER()}`)";
		expect(checkSqlInjection(code, TS)).toEqual([]);
	});

	it('skips double-quoted identifier interpolation — "${tableName}"', () => {
		// The double-quote exclusion fires before the generic table/column one,
		// but use a name that wouldn't match the later identifier rule anyway.
		const code = 'db.query(`SELECT * FROM "${entity}"`)';
		expect(checkSqlInjection(code, TS)).toEqual([]);
	});

	it("skips dynamic column building via ${...join(...)}", () => {
		const code = "db.query(`SELECT ${cols.join(', ')} FROM t`)";
		expect(checkSqlInjection(code, TS)).toEqual([]);
	});

	it("skips the FTS rebuild command VALUES('rebuild')", () => {
		const code = "db.exec(`INSERT INTO fts(fts) VALUES('rebuild') -- ${x}`)";
		expect(checkSqlInjection(code, TS)).toEqual([]);
	});

	it("skips simple identifier interpolation referencing table/column names", () => {
		for (const safe of [
			"db.query(`SELECT * FROM ${tableName}`)",
			"db.query(`SELECT ${columnName} FROM t`)",
			"db.query(`SELECT * FROM ${tbl}`)",
			"db.query(`SELECT ${col} FROM t`)",
			"db.query(`... ${idx} ...`)",
			"db.query(`... ${spec} ...`)",
		]) {
			expect(checkSqlInjection(safe, TS)).toEqual([]);
		}
	});

	it("still fires for a value-name interpolation that matches no exclusion", () => {
		// `userId` contains none of table/column/tbl/col/idx/spec → not excluded.
		const code = "db.query(`SELECT * FROM users WHERE id = ${userId}`)";
		expect(checkSqlInjection(code, TS)).toHaveLength(1);
	});
});

describe("checkSqlInjection — Python f-string sinks", () => {
	it("flags .execute() with an f-string", () => {
		const code = 'cursor.execute(f"SELECT * FROM t WHERE id = {uid}")';
		const matches = checkSqlInjection(code, PY);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(1);
	});

	it("flags .executemany() with an f-string (single-quoted too)", () => {
		const code = "cursor.executemany(f'INSERT INTO t VALUES ({v})', rows)";
		expect(checkSqlInjection(code, PY)).toHaveLength(1);
	});

	it("does not fire on a parameterized Python execute", () => {
		const code = 'cursor.execute("SELECT * FROM t WHERE id = %s", (uid,))';
		expect(checkSqlInjection(code, PY)).toEqual([]);
	});

	it("does not treat the JS template-literal rule as active for .py files", () => {
		// `.query(\`...${}\`)` in a .py file must not fire via the JS branch.
		const code = "obj.query(`SELECT ${x}`)";
		expect(checkSqlInjection(code, PY)).toEqual([]);
	});
});

describe("checkSqlInjection — Swift interpolation sinks", () => {
	it("flags .execute/.run/.prepare/.query/.fetch with Swift interpolation", () => {
		for (const method of ["execute", "run", "prepare", "query", "fetch"]) {
			const code = `try db.${method}("SELECT * FROM t WHERE id = \\(userId)")`;
			const matches = checkSqlInjection(code, SWIFT);
			expect(matches).toHaveLength(1);
			expect(matches[0]?.line).toBe(1);
		}
	});

	it("flags the labeled sql: argument form", () => {
		const code = 'try db.execute(sql: "DELETE FROM t WHERE k = \\(key)")';
		expect(checkSqlInjection(code, SWIFT)).toHaveLength(1);
	});

	it("flags NSPredicate(format:) with Swift interpolation", () => {
		const code = 'let p = NSPredicate(format: "name == \\(name)")';
		expect(checkSqlInjection(code, SWIFT)).toHaveLength(1);
	});

	it("does not fire on parameterized Swift (? placeholder + bindings)", () => {
		const code = 'try db.execute("SELECT * FROM t WHERE id = ?", [userId])';
		expect(checkSqlInjection(code, SWIFT)).toEqual([]);
	});

	it("does not fire on NSPredicate with %@ format args", () => {
		const code = 'let p = NSPredicate(format: "name == %@", name)';
		expect(checkSqlInjection(code, SWIFT)).toEqual([]);
	});
});

describe("checkSqlInjection — generic string-concatenation sink", () => {
	it("flags .query() with double-quoted string concatenation", () => {
		const code = 'db.query("SELECT * FROM t WHERE id = " + userId)';
		const matches = checkSqlInjection(code, TS);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(1);
	});

	it("flags .execute() with single-quoted string concatenation", () => {
		const code = "db.execute('DELETE FROM t WHERE id = ' + id)";
		expect(checkSqlInjection(code, TS)).toHaveLength(1);
	});

	it("fires on the concat shape regardless of extension (no ext gate)", () => {
		// The generic concat branch is the last check and is not ext-guarded.
		const code = 'obj.query("SELECT " + col)';
		expect(checkSqlInjection(code, "anything.go")).toHaveLength(1);
		expect(checkSqlInjection(code, "noext")).toHaveLength(1);
	});

	it("does not fire on a plain string-literal argument without concatenation", () => {
		const code = 'db.query("SELECT * FROM t")';
		expect(checkSqlInjection(code, TS)).toEqual([]);
	});
});

describe("checkSqlInjection — match cap and edge cases", () => {
	it("caps at 10 matches even when more sink lines exist", () => {
		const lines: string[] = [];
		for (let i = 0; i < 25; i++) {
			lines.push("db.query(`SELECT * FROM t WHERE id = ${userId}`)");
		}
		const matches = checkSqlInjection(lines.join("\n"), TS);
		expect(matches).toHaveLength(10);
		// The cap stops scanning, so only the first 10 lines are reported.
		expect(matches[0]?.line).toBe(1);
		expect(matches[9]?.line).toBe(10);
	});

	it("returns an empty array for empty content", () => {
		expect(checkSqlInjection("", TS)).toEqual([]);
	});

	it("returns an empty array for unrelated code with no DB sinks", () => {
		const code = [
			"export function add(a: number, b: number): number {",
			"  return a + b;",
			"}",
		].join("\n");
		expect(checkSqlInjection(code, TS)).toEqual([]);
	});

	it("collects independent matches from multiple distinct sink shapes", () => {
		const code = [
			"db.query(`SELECT * FROM u WHERE id = ${userId}`)", // template-literal branch
			'db.execute("DELETE FROM t WHERE id = " + id)', // concat branch
		].join("\n");
		const matches = checkSqlInjection(code, TS);
		expect(matches).toHaveLength(2);
		expect(matches.map((m) => m.line)).toEqual([1, 2]);
	});
});
