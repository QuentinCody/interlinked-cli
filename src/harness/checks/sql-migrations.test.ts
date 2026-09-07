// Evidence suite for the three SQL schema checks (sql-migrations.ts), written
// before the implementation per the red/green gate. Labeled per the Check
// Evidence Contract (P = must fire, N = must not fire).
//
// N1–N4 for checkMigrationOrdering are absorbed verbatim from
// compat-stubs.test.ts (authored 2026-08-09 by the evidence-backfill fleet
// while the detector was still a stub); that file is deleted with the stubs.

import { describe, expect, it } from "vitest";
import {
	checkMigrationOrdering,
	checkSqlSchemaConsistency,
	checkVisibilityFilterMissing,
} from "./sql-migrations.js";

const FILE = "src/do/migrations.ts";

describe("checkMigrationOrdering — positive (must fire)", () => {
	it("P1: CREATE INDEX on a column missing from the same-block CREATE TABLE", () => {
		const content = [
			"sql.exec(`",
			"  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);",
			"  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);",
			"`);",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([
			{ line: 3, text: "CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);" },
		]);
	});

	it("P2: composite UNIQUE index where one referenced column is undeclared", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT, state TEXT)`);",
			"sql.exec(`CREATE UNIQUE INDEX idx_jobs ON jobs(state, priority)`);",
		].join("\n");
		const res = checkMigrationOrdering(content, FILE);
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});

	it("P3: fires in a raw .sql migration file too", () => {
		const content = [
			"CREATE TABLE widgets (id TEXT PRIMARY KEY);",
			"CREATE INDEX idx_widgets_owner ON widgets(owner);",
		].join("\n");
		const res = checkMigrationOrdering(content, "migrations/0002_widgets.sql");
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});
});

describe("checkMigrationOrdering — negative (must NOT fire)", () => {
	it("does not infer missing columns from an interpolated schema", () => {
		const content = [
			'const sql = `CREATE TABLE records (id TEXT, ${columns.map(column => `${column} TEXT`).join(",")});',
			'CREATE INDEX records_tenant ON records(tenant);`;',
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("retains findings for literal tables beside an interpolated schema", () => {
		const content = [
			'const sql = `CREATE TABLE dynamic_records (id TEXT, ${columns});',
			'CREATE TABLE records (id TEXT);',
			'CREATE INDEX records_tenant ON records(tenant);`;',
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([
			{ line: 3, text: 'CREATE INDEX records_tenant ON records(tenant);`;' },
		]);
	});

	it("N1: CREATE INDEX on a column already declared in the same-block CREATE TABLE", () => {
		const content = `
sql.exec(\`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
\`);
`.trim();
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N2: addColumnIfNotExists() runs BEFORE CREATE INDEX in a separate sql.exec() call (the recommended fix pattern)", () => {
		const content = `
sql.exec(\`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)\`);
addColumnIfNotExists("users", "email", "TEXT");
sql.exec(\`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)\`);
`.trim();
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N3: CREATE TABLE / CREATE INDEX text appears only inside a comment, not executable migration code", () => {
		const content = `
// Example migration shape (do not copy verbatim):
// CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY);
// CREATE INDEX IF NOT EXISTS idx_widgets_owner ON widgets(owner);
export function noop(): void {}
`.trim();
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N4: file with no SQL migration content at all", () => {
		const content = `
export function add(a: number, b: number): number {
  return a + b;
}
`.trim();
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N5: expression index (parens in the column list) is skipped, never guessed at", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT)`);",
			"sql.exec(`CREATE INDEX idx_users_email ON users(lower(email))`);",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N6: index on a table whose CREATE TABLE lives in another file stays silent", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS local_only (id TEXT)`);",
			"sql.exec(`CREATE INDEX idx_remote ON remote_table(anything)`);",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N7: ALTER TABLE ADD COLUMN before the index declares the column", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT)`);",
			"sql.exec(`ALTER TABLE users ADD COLUMN email TEXT`);",
			"sql.exec(`CREATE INDEX idx_users_email ON users(email)`);",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});
});

describe("checkSqlSchemaConsistency — positive (must fire)", () => {
	it("P1: INSERT column list names a column the same-file CREATE TABLE lacks", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)`);",
			'sql.exec(`INSERT INTO users (id, email) VALUES (?, ?)`, [id, email]);',
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});

	it("P2: UPDATE SET targets a column the same-file schema does not declare", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT, name TEXT)`);",
			"sql.exec(`UPDATE users SET nickname = ? WHERE id = ?`, [nick, id]);",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});

	it("P3: fires in a raw .sql file with an undeclared INSERT column", () => {
		const content = [
			"CREATE TABLE logs (id TEXT, at TEXT);",
			"INSERT INTO logs (id, level) VALUES ('a', 'info');",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, "migrations/0003_logs.sql");
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});
});

describe("checkSqlSchemaConsistency — negative (must NOT fire)", () => {
	it("N1: INSERT whose column list matches the declared schema exactly", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT, email TEXT)`);",
			"sql.exec(`INSERT INTO users (id, email) VALUES (?, ?)`, [id, email]);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N2: UPDATE SET on declared columns only", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT, name TEXT)`);",
			"sql.exec(`UPDATE users SET name = ? WHERE id = ?`, [name, id]);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N3: INSERT into a table with no same-file CREATE TABLE stays silent", () => {
		const content = 'sql.exec(`INSERT INTO external_table (whatever) VALUES (1)`);';
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N4: INSERT without a column list carries no checkable reference", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT)`);",
			"sql.exec(`INSERT INTO users VALUES (?)`, [id]);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N5: a column declared via addColumnIfNotExists counts as declared", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT)`);",
			'addColumnIfNotExists("users", "email", "TEXT");',
			"sql.exec(`INSERT INTO users (id, email) VALUES (?, ?)`, [id, email]);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});
});

describe("checkVisibilityFilterMissing — positive (must fire)", () => {
	it("P1: SELECT from a soft-delete table with no deleted_at mention in the statement", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT, deleted_at TEXT)`);",
			"const rows = sql.exec(`SELECT id FROM docs WHERE owner = ?`, [owner]);",
		].join("\n");
		const res = checkVisibilityFilterMissing(content, FILE);
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});

	it("P2: COUNT query on a soft-delete table without the filter", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT, archived_at TEXT)`);",
			"const n = sql.exec(`SELECT COUNT(*) AS n FROM docs`);",
		].join("\n");
		const res = checkVisibilityFilterMissing(content, FILE);
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});

	it("P3: is_deleted flag column counts as a soft-delete marker", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS notes (id TEXT, is_deleted INTEGER)`);",
			"const rows = sql.exec(`SELECT id FROM notes ORDER BY id`);",
		].join("\n");
		const res = checkVisibilityFilterMissing(content, FILE);
		expect(res).toHaveLength(1);
		expect(res[0]?.line).toBe(2);
	});
});

describe("checkVisibilityFilterMissing — negative (must NOT fire)", () => {
	it("N1: the statement filters on deleted_at", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT, deleted_at TEXT)`);",
			"const rows = sql.exec(`SELECT id FROM docs WHERE deleted_at IS NULL`);",
		].join("\n");
		expect(checkVisibilityFilterMissing(content, FILE)).toEqual([]);
	});

	it("N2: table without any soft-delete column is out of scope", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT, title TEXT)`);",
			"const rows = sql.exec(`SELECT id FROM docs`);",
		].join("\n");
		expect(checkVisibilityFilterMissing(content, FILE)).toEqual([]);
	});

	it("N3: SELECT from a table with no same-file CREATE TABLE stays silent", () => {
		const content = "const rows = sql.exec(`SELECT id FROM remote_docs`);";
		expect(checkVisibilityFilterMissing(content, FILE)).toEqual([]);
	});

	it("N4: DELETE statements are out of scope — only SELECT is judged", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT, deleted_at TEXT)`);",
			"sql.exec(`DELETE FROM docs WHERE id = ?`, [id]);",
		].join("\n");
		expect(checkVisibilityFilterMissing(content, FILE)).toEqual([]);
	});
});

// ============================================================================
// Mutation-hardening: skipFile gate, blankCommentLines, unquoteIdentifier.
// Survivor-kill wave targeting scratch/fleet-r2/kill-briefs/
// src_harness_checks_sql-migrations.ts.json.
// ============================================================================

describe("skipFile — gate is per-file-type, not a blanket skip", () => {
	const violating = [
		"CREATE TABLE users (id TEXT PRIMARY KEY);",
		"CREATE INDEX idx_users_email ON users(email);",
	].join("\n");

	it("N1: unrecognized extension (.txt) is skipped despite a real violation", () => {
		expect(checkMigrationOrdering(violating, "notes.txt")).toEqual([]);
	});

	it("N2: *.test.ts path is skipped despite a real violation", () => {
		expect(checkMigrationOrdering(violating, "src/do/migrations.test.ts")).toEqual([]);
	});

	it("N3: vendored node_modules path is skipped despite a real violation", () => {
		expect(checkMigrationOrdering(violating, "node_modules/pkg/migrations.ts")).toEqual([]);
	});

	it("P1: an ordinary .sql file with the SAME violation still fires", () => {
		const res = checkMigrationOrdering(violating, "migrations/0001_users.sql");
		expect(res).toEqual([{ line: 2, text: "CREATE INDEX idx_users_email ON users(email);" }]);
	});

	it("N4: a *.test.ts path skips ALL THREE checks, not just checkMigrationOrdering", () => {
		const content = [
			"CREATE TABLE docs (id TEXT, deleted_at TEXT);",
			"CREATE INDEX idx_bad ON docs(bogus_col);",
			"INSERT INTO docs (id, bogus2) VALUES (1,2);",
			"const r = sql.exec(`SELECT id FROM docs`);",
		].join("\n");
		const path = "src/do/migrations.test.ts";
		expect(checkMigrationOrdering(content, path)).toEqual([]);
		expect(checkSqlSchemaConsistency(content, path)).toEqual([]);
		expect(checkVisibilityFilterMissing(content, path)).toEqual([]);
	});
});

describe("blankCommentLines — every comment marker is recognized, trimStart matters", () => {
	it("N1: a -- comment indented with leading whitespace is still blanked", () => {
		const content = [
			"CREATE TABLE users (id TEXT PRIMARY KEY);",
			"  -- CREATE INDEX idx_bad ON users(email);",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N2: a // comment is blanked", () => {
		const content = [
			"CREATE TABLE users (id TEXT PRIMARY KEY);",
			"// CREATE INDEX idx_bad ON users(email);",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N3: a # comment is blanked", () => {
		const content = [
			"CREATE TABLE users (id TEXT PRIMARY KEY);",
			"# CREATE INDEX idx_bad ON users(email);",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N4: a leading-* jsdoc-continuation line is blanked", () => {
		const content = [
			"CREATE TABLE users (id TEXT PRIMARY KEY);",
			" * CREATE INDEX idx_bad ON users(email);",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N5: a /* comment opener is blanked", () => {
		const content = [
			"CREATE TABLE users (id TEXT PRIMARY KEY);",
			"/* CREATE INDEX idx_bad ON users(email); */",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N6: a comment mid-column-list must blank to empty, not leak an identifier", () => {
		const content = [
			"sql.exec(`",
			"CREATE TABLE users (",
			"id TEXT,",
			"-- a comment right here at the top of a new segment",
			"email TEXT",
			")`);",
			"sql.exec(`CREATE INDEX idx_users_email ON users(email)`);",
		].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});
});

describe("unquoteIdentifier — every quote form normalizes to the same name", () => {
	it("P1: a backtick-quoted CREATE TABLE name is recognized by an unquoted reference", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS `users` (id TEXT PRIMARY KEY)`);",
			"sql.exec(`CREATE INDEX idx_users_email ON users(email)`);",
		].join("\n");
		const res = checkMigrationOrdering(content, FILE);
		expect(res).toEqual([{ line: 2, text: "sql.exec(`CREATE INDEX idx_users_email ON users(email)`);" }]);
	});

	it("P2: a double-quoted CREATE TABLE name is recognized by an unquoted reference", () => {
		const content = [
			'sql.exec(`CREATE TABLE IF NOT EXISTS "users" (id TEXT PRIMARY KEY)`);',
			"sql.exec(`CREATE INDEX idx_users_email ON users(email)`);",
		].join("\n");
		const res = checkMigrationOrdering(content, FILE);
		expect(res).toEqual([{ line: 2, text: "sql.exec(`CREATE INDEX idx_users_email ON users(email)`);" }]);
	});

	it("P3: a bracket-quoted CREATE TABLE name is recognized by an unquoted reference", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS [users] (id TEXT PRIMARY KEY)`);",
			"sql.exec(`CREATE INDEX idx_users_email ON users(email)`);",
		].join("\n");
		const res = checkMigrationOrdering(content, FILE);
		expect(res).toEqual([{ line: 2, text: "sql.exec(`CREATE INDEX idx_users_email ON users(email)`);" }]);
	});

	it("N1: a stray mid-token backtick is left alone, not silently stripped (fails the identifier filter)", () => {
		const content = ["CREATE TABLE t (id TEXT);", "INSERT INTO t (id, e`mail) VALUES (1, 2);"].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("P4: a double leading backtick leaves one residual quote char, so the token is rejected as a target", () => {
		const content = ["CREATE TABLE t (id TEXT);", "INSERT INTO t (id, ``email) VALUES (1, 2);"].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT INTO t (id, ``email) VALUES (1, 2);" }]);
	});

	it("N2: a stray mid-token trailing-side backtick is left alone, not silently stripped", () => {
		const content = ["CREATE TABLE t (id TEXT);", "INSERT INTO t (id, email`s) VALUES (1, 2);"].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("P5: a double trailing backtick leaves one residual quote char, so the token is rejected as a target", () => {
		const content = ["CREATE TABLE t (id TEXT);", "INSERT INTO t (id, email``) VALUES (1, 2);"].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT INTO t (id, email``) VALUES (1, 2);" }]);
	});
});

describe("topLevelSegments — paren-depth-aware comma splitting", () => {
	it("P1: the seed segments array must not phantom-declare a column that was never written", () => {
		const content = ["CREATE TABLE t (id TEXT);", "INSERT INTO t (id, stryker) VALUES (?, ?);"].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT INTO t (id, stryker) VALUES (?, ?);" }]);
	});

	it("N1: a comma nested inside NUMERIC(10,2) is not a top-level column separator", () => {
		const content = [
			"CREATE TABLE t (price NUMERIC(10,2), id TEXT);",
			"INSERT INTO t (price, id) VALUES (?, ?);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("P2: an identifier-shaped token inside a nested paren group must not leak as a declared column", () => {
		const content = [
			"CREATE TABLE t (amount NUMERIC(10, extra) DEFAULT 0, id TEXT);",
			"INSERT INTO t (amount, extra) VALUES (1, 2);",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT INTO t (amount, extra) VALUES (1, 2);" }]);
	});

	it("N2: three columns are each independently sliced by their own comma, not just the first", () => {
		const content = [
			"CREATE TABLE t (id TEXT, name TEXT, email TEXT);",
			"INSERT INTO t (id, name, email) VALUES (?, ?, ?);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("P3: the SECOND top-level comma's slice must start after the first comma, not restart from position 0", () => {
		const content = [
			"CREATE TABLE t (id TEXT, name TEXT, email TEXT);",
			"INSERT INTO t (id, name) VALUES (?, ?);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});
});

describe("segmentColumnName — leading anchor and constraint-keyword recognition", () => {
	it("N1: a segment starting with a digit never matches, even when a real identifier follows later", () => {
		const content = ["CREATE TABLE t (1id TEXT, name TEXT);", "INSERT INTO t (name) VALUES (?);"].join(
			"\n",
		);
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("P1: a mid-segment identifier after skipped junk must not leak in as a declared column", () => {
		const content = ["CREATE TABLE t (id TEXT, 123abc);", "INSERT INTO t (id, abc) VALUES (1,2);"].join(
			"\n",
		);
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT INTO t (id, abc) VALUES (1,2);" }]);
	});

	it("P2: PRIMARY KEY (…) is a table-level constraint, not a phantom column named 'primary'", () => {
		const content = [
			"CREATE TABLE t (id TEXT, name TEXT, PRIMARY KEY (id));",
			"INSERT INTO t (id, primary) VALUES (?, ?);",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT INTO t (id, primary) VALUES (?, ?);" }]);
	});

	it("N2: a backtick-quoted column name is still recognized as a real column", () => {
		const content = ["CREATE TABLE t (`nm` TEXT);", "INSERT INTO t (nm) VALUES (1);"].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N3: a segment with no identifier at all (leading digit only) does not throw and declares nothing", () => {
		const content = ["CREATE TABLE t (id TEXT, 123);", "INSERT INTO t (id) VALUES (?);"].join("\n");
		expect(() => checkSqlSchemaConsistency(content, FILE)).not.toThrow();
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});
});

describe("parenGroupBody — balanced/unbalanced paren tracking", () => {
	it("N1: an unbalanced (unterminated) CREATE TABLE yields no schema, so a same-name reference stays silent", () => {
		const content = ["CREATE TABLE t (id TEXT;", "INSERT INTO t (id, bogus) VALUES (?, ?);"].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N2: deeply nested balanced parens still resolve to the correct outer close (both columns match)", () => {
		const content = [
			"CREATE TABLE t (id TEXT, calc NUMERIC(((1+2)),2));",
			"INSERT INTO t (id, calc) VALUES (?, ?);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});
});

describe("collectCreateTables — malformed matches and constraint-only segments", () => {
	it("N1: an empty (malformed) table name is never registered as created", () => {
		const content = ["CREATE TABLE `` (id TEXT);", "INSERT INTO users (id, bogus) VALUES (1, 2);"].join(
			"\n",
		);
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N2: an unterminated CREATE TABLE (no closing paren) registers no columns at all", () => {
		const content = ["CREATE TABLE t (id TEXT;", "INSERT INTO t (id, bogus) VALUES (1, 2);"].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N3: a table-constraint-only trailing segment declares no column of its own", () => {
		const content = [
			"CREATE TABLE t (id TEXT, PRIMARY KEY (id));",
			"UPDATE t SET id = ? WHERE id = ?;",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N4: a table created with one genuine column declares exactly that column", () => {
		const content = ["CREATE TABLE t (id TEXT);", "UPDATE t SET id = ? WHERE id = ?;"].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});
});

describe("collectColumnAdditions — ALTER TABLE ADD COLUMN and the addColumnIfNotExists helper", () => {
	it("N1: ALTER TABLE ADD COLUMN with a real column name declares it", () => {
		const content = [
			"CREATE TABLE t (id TEXT);",
			"ALTER TABLE t ADD COLUMN email TEXT;",
			"INSERT INTO t (id, email) VALUES (?, ?);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it('P1: ALTER TABLE ADD COLUMN naming the literal word "constraint" is excluded from declaration', () => {
		const content = [
			"CREATE TABLE t (id TEXT);",
			"ALTER TABLE t ADD COLUMN constraint TEXT;",
			"INSERT INTO t (id, constraint) VALUES (?, ?);",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 3, text: "INSERT INTO t (id, constraint) VALUES (?, ?);" }]);
	});

	it("N2: addColumnIfNotExists() declares its column", () => {
		const content = [
			"CREATE TABLE t (id TEXT);",
			'addColumnIfNotExists("t", "email", "TEXT");',
			"INSERT INTO t (id, email) VALUES (?, ?);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N3: a matching ALTER ADD followed by a matching UPDATE SET is clean", () => {
		const content = [
			"CREATE TABLE t (id TEXT);",
			"ALTER TABLE t ADD COLUMN email TEXT;",
			"UPDATE t SET email = ? WHERE id = ?;",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});
});

describe("pushFinding — MATCH_LIMIT cap and 150-char text truncation", () => {
	it("P1: exactly 10 findings are reported even when 15 violations exist", () => {
		const content = Array.from(
			{ length: 15 },
			(_, i) => `CREATE TABLE t${i} (id TEXT); CREATE INDEX ix${i} ON t${i}(bogus${i});`,
		).join("\n");
		const res = checkMigrationOrdering(content, FILE);
		expect(res).toHaveLength(10);
		expect(res.map((m) => m.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it("P2: finding text longer than 150 chars is sliced to exactly 150, not left full-length", () => {
		const longCol =
			"bogus_column_name_padding_to_make_this_line_extremely_long_so_it_exceeds_one_hundred_and_fifty_characters_total_length_for_sure_yes_indeed_it_does";
		const line = `CREATE INDEX ix ON t(${longCol});`;
		expect(line.length).toBeGreaterThan(150);
		const content = ["CREATE TABLE t (id TEXT);", line].join("\n");
		const res = checkMigrationOrdering(content, FILE);
		expect(res).toHaveLength(1);
		expect(res[0]?.text).toHaveLength(150);
		expect(res[0]?.text).toBe(line.slice(0, 150));
	});
});

describe("checkMigrationOrdering — referenced-column extraction edge cases", () => {
	it("N1: CREATE INDEX with an empty column list must not phantom-satisfy the check", () => {
		const content = ["CREATE TABLE t (id TEXT);", "CREATE INDEX ix ON t();"].join("\n");
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});

	it("N2: a same-file table with a matching multi-column index is clean", () => {
		const content = ["CREATE TABLE t (id TEXT, name TEXT);", "CREATE INDEX ix ON t(id, name);"].join(
			"\n",
		);
		expect(checkMigrationOrdering(content, FILE)).toEqual([]);
	});
});

describe("setClauseText — statement-terminator boundary (WHERE / ; / backtick)", () => {
	it("P1: with no WHERE/;/backtick anywhere ahead, the whole remainder is the clause (real target still flagged)", () => {
		const content = ["CREATE TABLE t (id TEXT);", "UPDATE t SET nam="].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "UPDATE t SET nam=" }]);
	});

	it("N1: a WHERE-bounded clause must not leak a later comma-prefixed token as a SET target", () => {
		const content = [
			"CREATE TABLE t (id TEXT, name TEXT);",
			"UPDATE t SET name = ? WHERE id = ?;",
			", bogus = 1;",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});
});

describe("statementExtent — statement-terminator boundary (;/backtick) for SELECT scanning", () => {
	it("N1: with no ;/backtick within reach, the unbounded extent still sees a trailing filter mention", () => {
		const content = [
			"CREATE TABLE docs (id TEXT, deleted_at TEXT);",
			"const rows = sql.exec(`SELECT id FROM docs WHERE x = deleted_at",
		].join("\n");
		expect(checkVisibilityFilterMissing(content, FILE)).toEqual([]);
	});

	it("P1: a terminator-bounded extent must NOT see a filter mention that comes after the terminator", () => {
		const content = [
			"CREATE TABLE docs (id TEXT, deleted_at TEXT);",
			"const rows = sql.exec(`SELECT id FROM docs WHERE owner = ?`);",
			"deleted_at",
		].join("\n");
		const res = checkVisibilityFilterMissing(content, FILE);
		expect(res).toEqual([
			{ line: 2, text: "const rows = sql.exec(`SELECT id FROM docs WHERE owner = ?`);" },
		]);
	});
});

describe("insertViolations — table tracking and identifier-anchor edge cases", () => {
	it("N1: a table with no same-file CREATE TABLE stays silent even when other tables exist", () => {
		const content = ["CREATE TABLE users (id TEXT);", "INSERT INTO other_table (bogus) VALUES (1);"].join(
			"\n",
		);
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N2: a trailing empty column-list entry (dangling comma) is not treated as a target", () => {
		const content = ["CREATE TABLE t (id TEXT);", "INSERT INTO t (id, ) VALUES (?, ?);"].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N3: trailing garbage after a valid identifier prefix fails the full-match identifier filter", () => {
		const content = ["CREATE TABLE t (id TEXT);", "INSERT INTO t (id!) VALUES (?);"].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N4: leading garbage before a valid identifier suffix fails the full-match identifier filter", () => {
		const content = ["CREATE TABLE t (id TEXT);", "INSERT INTO t (!id) VALUES (?);"].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});
});

describe("updateViolations — table tracking and every-vs-some target checking", () => {
	it("N1: a table with no same-file CREATE TABLE stays silent even when other tables exist", () => {
		const content = ["CREATE TABLE users (id TEXT);", "UPDATE other_table SET bogus = 1;"].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("P1: ALL SET targets must be declared — one declared target must not mask an undeclared sibling", () => {
		const content = [
			"CREATE TABLE t (id TEXT, name TEXT);",
			"UPDATE t SET name = ?, bogus = ? WHERE id = ?;",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "UPDATE t SET name = ?, bogus = ? WHERE id = ?;" }]);
	});
});

describe("checkSqlSchemaConsistency — line-split precision and ascending sort", () => {
	it("P1: the finding text is read from the correctly newline-split original line, not a mangled split", () => {
		const content = ["CREATE TABLE t (id TEXT);", "INSERT INTO t (id, bogus) VALUES (1, 2);"].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT INTO t (id, bogus) VALUES (1, 2);" }]);
	});

	it("P2: an UPDATE violation on an earlier line and an INSERT violation on a later line are sorted ascending", () => {
		const content = [
			"CREATE TABLE t (id TEXT);",
			"UPDATE t SET bogus1 = 1 WHERE id = 1;",
			"INSERT INTO t (id, bogus2) VALUES (1, 2);",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res.map((m) => m.line)).toEqual([2, 3]);
		expect(res).toEqual([
			{ line: 2, text: "UPDATE t SET bogus1 = 1 WHERE id = 1;" },
			{ line: 3, text: "INSERT INTO t (id, bogus2) VALUES (1, 2);" },
		]);
	});
});

describe("checkVisibilityFilterMissing — line-split precision and phantom-column safety", () => {
	it("P1: the finding text is read from the correctly newline-split original line, not a mangled split", () => {
		const content = [
			"CREATE TABLE docs (id TEXT, deleted_at TEXT);",
			"const r = sql.exec(`SELECT id FROM docs`);",
		].join("\n");
		const res = checkVisibilityFilterMissing(content, FILE);
		expect(res).toEqual([{ line: 2, text: "const r = sql.exec(`SELECT id FROM docs`);" }]);
	});

	it("N1: ALTER TABLE on a table with no same-file CREATE TABLE must not leak a phantom filter column", () => {
		const content = [
			"CREATE TABLE docs (id TEXT);",
			"ALTER TABLE other_table ADD COLUMN deleted_at TEXT;",
			"const r = sql.exec(`SELECT id FROM other_table`);",
		].join("\n");
		expect(checkVisibilityFilterMissing(content, FILE)).toEqual([]);
	});
});

// ============================================================================
// Module-level regex robustness: generous internal whitespace (\s+ vs \s) and
// quoted identifiers (leading/trailing optional-quote character classes) must
// keep matching. Each fixture is built so ANY single-position defect in the
// corresponding regex makes it fail to match ENTIRELY (not just differently),
// suppressing a finding that should fire — the strongest possible signal.
// ============================================================================

describe("CREATE_TABLE_RE — generous whitespace and quoted names", () => {
	it("P1: extra internal whitespace and a backtick-quoted name with IF NOT EXISTS still resolve", () => {
		const content = [
			"CREATE  TABLE  IF  NOT  EXISTS  `t`  (id TEXT);",
			"INSERT INTO t (id, bogus) VALUES (1, 2);",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT INTO t (id, bogus) VALUES (1, 2);" }]);
	});
});

describe("ALTER_ADD_RE — generous whitespace, quoted names, and the optional COLUMN keyword", () => {
	it("N1: extra internal whitespace and backtick-quoted table+column names still resolve", () => {
		const content = [
			"CREATE TABLE t (id TEXT);",
			"ALTER  TABLE  `t`  ADD  COLUMN  `e`  TEXT;",
			"INSERT INTO t (id, e) VALUES (1, 2);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});

	it("N2: the COLUMN keyword is optional, not mandatory — the bare form still declares the column", () => {
		const content = [
			"CREATE TABLE t (id TEXT);",
			"ALTER TABLE t ADD email TEXT;",
			"INSERT INTO t (id, email) VALUES (1, 2);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});
});

describe("ADD_COLUMN_HELPER_RE — generous internal whitespace inside the call", () => {
	it("N1: extra whitespace around every argument (paren, quotes, comma) still resolves the call", () => {
		const content = [
			"CREATE TABLE t (id TEXT);",
			'addColumnIfNotExists  (  "t"  ,  "email"  );',
			"INSERT INTO t (id, email) VALUES (1, 2);",
		].join("\n");
		expect(checkSqlSchemaConsistency(content, FILE)).toEqual([]);
	});
});

describe("CREATE_INDEX_RE — UNIQUE/IF NOT EXISTS, generous whitespace, and quoted names", () => {
	it("P1: extra internal whitespace and backtick-quoted index+table names still resolve", () => {
		const content = [
			"CREATE TABLE t (id TEXT);",
			"CREATE  UNIQUE  INDEX  IF  NOT  EXISTS  `ix`  ON  `t`(bogus_col);",
		].join("\n");
		const res = checkMigrationOrdering(content, FILE);
		expect(res).toEqual([
			{ line: 2, text: "CREATE  UNIQUE  INDEX  IF  NOT  EXISTS  `ix`  ON  `t`(bogus_col);" },
		]);
	});
});

describe("INSERT_RE — with and without the optional conflict clause, generous whitespace", () => {
	it("P1: no conflict-clause form with extra whitespace and a backtick-quoted table still resolves", () => {
		const content = ["CREATE TABLE t (id TEXT);", "INSERT  INTO  `t`  (bogus);"].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT  INTO  `t`  (bogus);" }]);
	});

	it("P2: the OR REPLACE conflict-clause form with extra whitespace still resolves", () => {
		const content = ["CREATE TABLE t (id TEXT);", "INSERT  OR  REPLACE  INTO  t(bogus);"].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT  OR  REPLACE  INTO  t(bogus);" }]);
	});
});

describe("UPDATE_RE — generous whitespace and a backtick-quoted table name", () => {
	it("P1: extra internal whitespace and a backtick-quoted table name still resolve", () => {
		const content = ["CREATE TABLE t (id TEXT);", "UPDATE  `t`  SET  bogus = 1;"].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "UPDATE  `t`  SET  bogus = 1;" }]);
	});
});

describe("SET_TARGET_RE — quoted targets and zero-whitespace-before-equals", () => {
	it("P1: a double-quoted SET target is fully consumed (both quote chars), not left dangling", () => {
		const content = ["CREATE TABLE t (id TEXT);", 'UPDATE t SET "bogus" = 1;'].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: 'UPDATE t SET "bogus" = 1;' }]);
	});

	it("P2: zero whitespace between the target and = still matches", () => {
		const content = ["CREATE TABLE t (id TEXT);", "UPDATE t SET bogus=1;"].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "UPDATE t SET bogus=1;" }]);
	});
});

describe("SELECT_FROM_RE — generous whitespace and a bracket-quoted table name", () => {
	it("P1: extra internal whitespace and a bracket-quoted table name still resolve", () => {
		const content = [
			"CREATE TABLE docs (id TEXT, deleted_at TEXT);",
			"const r = sql.exec(`SELECT id  FROM  [docs]`);",
		].join("\n");
		const res = checkVisibilityFilterMissing(content, FILE);
		expect(res).toEqual([{ line: 2, text: "const r = sql.exec(`SELECT id  FROM  [docs]`);" }]);
	});
});

describe("TABLE_CONSTRAINT_KEYWORDS — every keyword excludes its segment from column declaration", () => {
	it("P1: PRIMARY is a recognized constraint keyword, not a phantom column", () => {
		const content = [
			"CREATE TABLE t (id TEXT, PRIMARY KEY (id));",
			"INSERT INTO t (id, primary) VALUES (1, 2);",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT INTO t (id, primary) VALUES (1, 2);" }]);
	});

	it("P2: UNIQUE is a recognized constraint keyword, not a phantom column", () => {
		const content = ["CREATE TABLE t (id TEXT, UNIQUE (id));", "INSERT INTO t (id, unique) VALUES (1, 2);"].join(
			"\n",
		);
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT INTO t (id, unique) VALUES (1, 2);" }]);
	});

	it("P3: CHECK is a recognized constraint keyword, not a phantom column", () => {
		const content = [
			"CREATE TABLE t (id TEXT, CHECK (id > 0));",
			"INSERT INTO t (id, check) VALUES (1, 2);",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT INTO t (id, check) VALUES (1, 2);" }]);
	});

	it("P4: FOREIGN is a recognized constraint keyword, not a phantom column", () => {
		const content = [
			"CREATE TABLE t (id TEXT, FOREIGN KEY (id) REFERENCES x(id));",
			"INSERT INTO t (id, foreign) VALUES (1, 2);",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT INTO t (id, foreign) VALUES (1, 2);" }]);
	});

	it("P5: CONSTRAINT is a recognized constraint keyword, not a phantom column", () => {
		const content = [
			"CREATE TABLE t (id TEXT, CONSTRAINT pk_t PRIMARY KEY (id));",
			"INSERT INTO t (id, constraint) VALUES (1, 2);",
		].join("\n");
		const res = checkSqlSchemaConsistency(content, FILE);
		expect(res).toEqual([{ line: 2, text: "INSERT INTO t (id, constraint) VALUES (1, 2);" }]);
	});
});
