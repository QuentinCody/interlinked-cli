// Adversarial (independent) false-positive review of `migration_ordering`
// (pre_block). Each N case is legitimate migration code the detector fired on
// before the 2026-10-21 refinement (comment blanking, ALTER clause scanning,
// LIKE / INHERITS bodies, interpolated index columns); the P cases pin that
// the refinement did not weaken the gate.
// Probe: scratch/2026-10-21-adversarial/migration_ordering.probe.mts (+ .cases.json).

import { describe, expect, it } from "vitest";
import { checkMigrationOrdering } from "../../checks/sql-migrations.js";

const TS = "src/do/migrations.ts";
const SQL = "migrations/0007_users.sql";

describe("migration_ordering — negative (must not fire)", () => {
	it("N1: Postgres ADD COLUMN IF NOT EXISTS declares the indexed column", () => {
		const content = [
			"CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);",
			"ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;",
			"CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);",
		].join("\n");
		expect(checkMigrationOrdering(content, SQL)).toEqual([]);
	});

	it("N2: multi-column ALTER (ADD COLUMN a, ADD COLUMN b) declares the second column", () => {
		const content = [
			"CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);",
			"ALTER TABLE users ADD COLUMN email TEXT, ADD COLUMN phone TEXT;",
			"CREATE INDEX idx_users_phone ON users(phone);",
		].join("\n");
		expect(checkMigrationOrdering(content, SQL)).toEqual([]);
	});

	it("N3: a trailing -- comment with a comma inside the CREATE TABLE body", () => {
		const content = [
			"sql.exec(`",
			"  CREATE TABLE IF NOT EXISTS users (",
			"    id TEXT PRIMARY KEY,",
			"    email TEXT, -- lowercased, unique per tenant",
			"    name TEXT",
			"  );",
			"  CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);",
			"`);",
		].join("\n");
		expect(checkMigrationOrdering(content, TS)).toEqual([]);
	});

	it("N4: a stale migration kept inside a /* */ block without * line prefixes (.sql and .ts)", () => {
		const sql = [
			"/*",
			"Superseded by 0008 - kept for history:",
			"CREATE TABLE users (id TEXT PRIMARY KEY);",
			"CREATE INDEX idx_users_email ON users(email);",
			"*/",
			"CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, owner TEXT);",
			"CREATE INDEX idx_accounts_owner ON accounts(owner);",
		].join("\n");
		expect(checkMigrationOrdering(sql, SQL)).toEqual([]);
		const ts = [
			"/*",
			"  v1 schema (superseded):",
			"  CREATE TABLE users (id TEXT PRIMARY KEY);",
			"  CREATE INDEX idx_users_email ON users(email);",
			"*/",
			"export const V2 = `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, owner TEXT)`;",
		].join("\n");
		expect(checkMigrationOrdering(ts, TS)).toEqual([]);
	});

	it("N5: RENAME COLUMN introduces the indexed column name", () => {
		const content = [
			"CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, mail TEXT);",
			"ALTER TABLE users RENAME COLUMN mail TO email;",
			"CREATE INDEX idx_users_email ON users(email);",
		].join("\n");
		expect(checkMigrationOrdering(content, SQL)).toEqual([]);
	});

	it("N6: MySQL/Oracle parenthesized multi-add ALTER TABLE t ADD COLUMN (a, b)", () => {
		const content = [
			"CREATE TABLE IF NOT EXISTS users (id VARCHAR(36) PRIMARY KEY);",
			"ALTER TABLE users ADD COLUMN (email VARCHAR(255), phone VARCHAR(32));",
			"CREATE INDEX idx_users_email ON users(email);",
		].join("\n");
		expect(checkMigrationOrdering(content, SQL)).toEqual([]);
	});

	it("N7: an interpolated column list in CREATE INDEX is unknown, not demonstrably absent", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)`);",
			"for (const col of extraColumns) {",
			"  addColumnIfNotExists('users', col, 'TEXT');",
			"  sql.exec(`CREATE INDEX IF NOT EXISTS idx_dyn ON users(${col})`);",
			"}",
		].join("\n");
		expect(checkMigrationOrdering(content, TS)).toEqual([]);
	});

	it("N8: a trailing -- comment with an unbalanced ) inside the CREATE TABLE body", () => {
		const content = [
			"CREATE TABLE IF NOT EXISTS users (",
			"  id TEXT PRIMARY KEY, -- step 1) assigned by the app",
			"  email TEXT",
			");",
			"CREATE INDEX idx_users_email ON users(email);",
		].join("\n");
		expect(checkMigrationOrdering(content, SQL)).toEqual([]);
	});

	it("N9: Postgres (LIKE parent) and INHERITS bodies copy columns the file cannot see", () => {
		const like = [
			"CREATE TABLE users_archive (LIKE users INCLUDING ALL);",
			"CREATE INDEX idx_users_archive_email ON users_archive(email);",
		].join("\n");
		expect(checkMigrationOrdering(like, SQL)).toEqual([]);
		const inherits = [
			"CREATE TABLE eu_users (region TEXT) INHERITS (users);",
			"CREATE INDEX idx_eu_users_email ON eu_users(email);",
		].join("\n");
		expect(checkMigrationOrdering(inherits, SQL)).toEqual([]);
	});

	it("N10: an inline /* */ comment with a comma inside the CREATE TABLE body", () => {
		const content = [
			"CREATE TABLE IF NOT EXISTS users (",
			"  id TEXT PRIMARY KEY,",
			"  email TEXT, /* unique, lowercased */ name TEXT",
			");",
			"CREATE INDEX idx_users_name ON users(name);",
		].join("\n");
		expect(checkMigrationOrdering(content, SQL)).toEqual([]);
	});

	it("N11: SQLite table rebuild — ALTER TABLE users_new RENAME TO users carries the new columns (round 2)", () => {
		const content = [
			"CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);",
			"CREATE TABLE users_new (id TEXT PRIMARY KEY, email TEXT);",
			"INSERT INTO users_new (id) SELECT id FROM users;",
			"DROP TABLE users;",
			"ALTER TABLE users_new RENAME TO users;",
			"CREATE INDEX idx_users_email ON users(email);",
		].join("\n");
		expect(checkMigrationOrdering(content, SQL)).toEqual([]);
	});

	it("N12: Durable Object loop with an interpolated ADD COLUMN name (round 2)", () => {
		const content = [
			'const NEW_COLUMNS = { email: "TEXT", phone: "TEXT" };',
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)`);",
			"for (const [name, type] of Object.entries(NEW_COLUMNS)) {",
			"  try { sql.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`); } catch {}",
			"}",
			"sql.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);",
		].join("\n");
		expect(checkMigrationOrdering(content, TS)).toEqual([]);
	});

	it("N13: ON DELETE / ON UPDATE CASCADE in a multi-ADD ALTER does not end the statement (round 2)", () => {
		for (const action of ["ON DELETE CASCADE", "ON UPDATE CASCADE"]) {
			const content = [
				"CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY);",
				`ALTER TABLE orders ADD COLUMN user_id TEXT REFERENCES users(id) ${action}, ADD COLUMN email TEXT;`,
				"CREATE INDEX idx_orders_email ON orders(email);",
			].join("\n");
			expect(checkMigrationOrdering(content, SQL)).toEqual([]);
		}
	});

	it("N14: ADD COLUMN key — with the COLUMN keyword (or quoting), key is a column name (round 2)", () => {
		for (const add of ["ADD COLUMN key TEXT", 'ADD "key" TEXT']) {
			const content = [
				"CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, value TEXT);",
				`ALTER TABLE settings ${add};`,
				"CREATE INDEX idx_settings_key ON settings(key);",
			].join("\n");
			expect(checkMigrationOrdering(content, SQL)).toEqual([]);
		}
	});

	it("N15: a CREATE TABLE body built by string concatenation is unknown (round 2)", () => {
		const content = [
			'const COLUMNS = ["id TEXT PRIMARY KEY", "email TEXT"];',
			'db.exec("CREATE TABLE IF NOT EXISTS users (" + COLUMNS.join(", ") + ")");',
			'db.exec("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)");',
		].join("\n");
		expect(checkMigrationOrdering(content, "src/db/schema.ts")).toEqual([]);
	});

	it("N16: column helpers with a handle argument or another name declare the column (round 2)", () => {
		for (const call of [
			'addColumnIfNotExists(sql, "users", "email", "TEXT");',
			'ensureColumn(this.sql, "users", "email", "TEXT");',
			"add_column(db, 'users', 'email', 'TEXT');",
		]) {
			const content = [
				"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)`);",
				call,
				"sql.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);",
			].join("\n");
			expect(checkMigrationOrdering(content, TS)).toEqual([]);
		}
	});
});

describe("migration_ordering — positive (must fire)", () => {
	it("P1: a comma-bearing trailing comment does not hide a genuinely missing column", () => {
		const content = [
			"CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT -- a, b",
			");",
			"CREATE INDEX idx_users_phone ON users(phone);",
		].join("\n");
		expect(checkMigrationOrdering(content, SQL)).toEqual([
			{ line: 3, text: "CREATE INDEX idx_users_phone ON users(phone);" },
		]);
	});

	it("P2: glob strings containing /* do not open a block comment that swallows the schema", () => {
		const content = [
			'const globs = ["src/**/*.ts", "lib/*"];',
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)`);",
			"sql.exec(`CREATE INDEX idx_users_email ON users(email)`);",
			"/** done */",
		].join("\n");
		expect(checkMigrationOrdering(content, TS)).toHaveLength(1);
	});

	it("P3: a multi-ADD ALTER that never names the indexed column still fires", () => {
		const content = [
			"CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);",
			"ALTER TABLE users ADD COLUMN email TEXT, ADD CONSTRAINT users_email_uq UNIQUE (email);",
			"CREATE INDEX idx_users_phone ON users(phone);",
		].join("\n");
		expect(checkMigrationOrdering(content, SQL)).toHaveLength(1);
	});

	it("P5: MySQL ADD KEY (no COLUMN keyword) adds an index, not a column (round 2)", () => {
		const content = [
			"CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, value TEXT);",
			"ALTER TABLE settings ADD KEY idx_value (value);",
			"CREATE INDEX idx_settings_key ON settings(key);",
		].join("\n");
		expect(checkMigrationOrdering(content, SQL)).toEqual([
			{ line: 3, text: "CREATE INDEX idx_settings_key ON settings(key);" },
		]);
	});

	it("P6: a rename from a table that lacks the column still fires (round 2)", () => {
		const content = [
			"CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);",
			"CREATE TABLE users_new (id TEXT PRIMARY KEY);",
			"ALTER TABLE users_new RENAME TO users;",
			"CREATE INDEX idx_users_email ON users(email);",
		].join("\n");
		expect(checkMigrationOrdering(content, SQL)).toHaveLength(1);
	});

	it("P7: a column helper on another table does not declare the column (round 2)", () => {
		const content = [
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)`);",
			'ensureColumn(sql, "accounts", "email", "TEXT");',
			"sql.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);",
		].join("\n");
		expect(checkMigrationOrdering(content, TS)).toHaveLength(1);
	});

	it("P4: a decrement is not a SQL comment: `i--` before the schema leaves it intact", () => {
		const content = [
			"let i = 3; i--;",
			"sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)`);",
			"sql.exec(`CREATE INDEX idx_users_email ON users(email)`);",
		].join("\n");
		expect(checkMigrationOrdering(content, TS)).toHaveLength(1);
	});
});
