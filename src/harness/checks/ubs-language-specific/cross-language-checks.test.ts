// Smoke tests for the cross-language UBS detectors. The exhaustive red/green
// suites live in src/harness/__tests__/ubs-sql-string-concat.test.ts and
// ubs-hardcoded-localhost.test.ts and exercise these via the
// ubs-language-specific.ts barrel; this colocated file covers the module
// surface directly and satisfies the colocation gate.

import { describe, expect, it } from "vitest";
import {
	checkSqlEscapeHatchNonLiteral,
	checkSqlStringConcat,
	checkUbsHardcodedLocalhost,
} from "./cross-language-checks.js";

describe("ubs-language-specific/cross-language-checks", () => {
	describe("checkSqlStringConcat", () => {
		it("flags `\"SELECT ... FROM \" + table`", () => {
			const code = 'const q = "SELECT * FROM " + table;';
			expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
		});

		it("flags a template literal with interpolation", () => {
			const code = "const q = `SELECT * FROM users WHERE id = ${userId}`;";
			expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
		});

		it("does not flag a parameterized query (`$1` placeholder)", () => {
			const code = 'db.query("SELECT * FROM users WHERE id = $1", [id]);';
			expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
		});

		it("flags a Swift string with `\\(...)` interpolation around a SELECT", () => {
			const code = 'let q = "SELECT * FROM users WHERE id = \\(userId)"';
			expect(checkSqlStringConcat(code, "DB.swift").length).toBeGreaterThan(0);
		});

		it("does not flag a Swift parameterized query (`?` placeholder)", () => {
			const code = 'db.execute("SELECT * FROM users WHERE id = ?", arguments: [id])';
			expect(checkSqlStringConcat(code, "DB.swift")).toEqual([]);
		});
	});

	describe("checkUbsHardcodedLocalhost", () => {
		it("flags a hardcoded localhost URL in source", () => {
			const code = 'const api = "http://localhost:3000/api";';
			expect(checkUbsHardcodedLocalhost(code, "src/client.ts").length).toBeGreaterThan(0);
		});

		it("does not flag a fallback default after `||`", () => {
			const code = 'const url = process.env.URL || "http://localhost:8787";';
			expect(checkUbsHardcodedLocalhost(code, "src/client.ts")).toEqual([]);
		});

		it("does not flag non-source extensions", () => {
			expect(checkUbsHardcodedLocalhost("uses localhost here", "notes.md")).toEqual([]);
		});
	});

	describe("checkSqlEscapeHatchNonLiteral (Effect §2.6)", () => {
		it("flags `sql.unsafe(<identifier>)` (Effect SQL)", () => {
			const code = "const q = sql.unsafe(tableName);";
			expect(checkSqlEscapeHatchNonLiteral(code, "db.ts").length).toBeGreaterThan(0);
		});

		it("flags `sql.raw(<identifier>)` (Drizzle)", () => {
			const code = "const q = sql.raw(userInput);";
			expect(checkSqlEscapeHatchNonLiteral(code, "db.ts").length).toBeGreaterThan(0);
		});

		it("flags `sql.lit(<expression>)` (Kysely)", () => {
			const code = "const q = sql.lit(getName());";
			expect(checkSqlEscapeHatchNonLiteral(code, "db.ts").length).toBeGreaterThan(0);
		});

		it("does NOT flag `sql.unsafe(\"<string literal>\")`", () => {
			const code = 'const q = sql.unsafe("public.users");';
			expect(checkSqlEscapeHatchNonLiteral(code, "db.ts")).toEqual([]);
		});

		it("does NOT flag `sql.raw('<single-quoted>')`", () => {
			const code = "const q = sql.raw('public');";
			expect(checkSqlEscapeHatchNonLiteral(code, "db.ts")).toEqual([]);
		});

		it("does NOT flag `sql.unsafe(`<template literal>`)`", () => {
			const code = "const q = sql.unsafe(`public.users`);";
			expect(checkSqlEscapeHatchNonLiteral(code, "db.ts")).toEqual([]);
		});

		it("skips test files entirely", () => {
			const code = "const q = sql.unsafe(tableName);";
			expect(checkSqlEscapeHatchNonLiteral(code, "db.test.ts")).toEqual([]);
		});

		it("skips non-source files", () => {
			const code = "const q = sql.unsafe(tableName);";
			expect(checkSqlEscapeHatchNonLiteral(code, "notes.md")).toEqual([]);
		});
	});
});

describe("checkSqlStringConcat — extension coverage", () => {
	const concat = 'const q = "SELECT * FROM " + table;';

	it("flags .tsx", () => {
		expect(checkSqlStringConcat(concat, "Component.tsx").length).toBeGreaterThan(0);
	});
	it("flags .js", () => {
		expect(checkSqlStringConcat(concat, "db.js").length).toBeGreaterThan(0);
	});
	it("flags .jsx", () => {
		expect(checkSqlStringConcat(concat, "Component.jsx").length).toBeGreaterThan(0);
	});
	it("flags .mjs", () => {
		expect(checkSqlStringConcat(concat, "db.mjs").length).toBeGreaterThan(0);
	});
	it("flags .cjs", () => {
		expect(checkSqlStringConcat(concat, "db.cjs").length).toBeGreaterThan(0);
	});
	it("flags .py", () => {
		expect(checkSqlStringConcat(concat, "db.py").length).toBeGreaterThan(0);
	});
	it("flags .go", () => {
		expect(checkSqlStringConcat(concat, "db.go").length).toBeGreaterThan(0);
	});
	it("flags .rs", () => {
		expect(checkSqlStringConcat(concat, "db.rs").length).toBeGreaterThan(0);
	});
	it("does NOT flag an unsupported extension", () => {
		expect(checkSqlStringConcat(concat, "notes.txt")).toEqual([]);
	});
	it("skips test files", () => {
		expect(checkSqlStringConcat(concat, "db.test.ts")).toEqual([]);
	});
});

describe("checkSqlStringConcat — verb coverage", () => {
	it("flags SELECT DISTINCT ... FROM concatenation", () => {
		const code = 'const q = "SELECT DISTINCT " + col + " FROM users";';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags INSERT INTO concatenation", () => {
		const code = 'const q = "INSERT INTO users VALUES (" + values + ")";';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags UPDATE ... SET concatenation", () => {
		const code = 'const q = "UPDATE users SET name = " + name;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags DELETE FROM concatenation", () => {
		const code = 'const q = "DELETE FROM users WHERE id = " + id;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags DROP TABLE concatenation", () => {
		const code = 'const q = "DROP TABLE " + tableName;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags DROP INDEX concatenation", () => {
		const code = 'const q = "DROP INDEX " + idxName;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags DROP DATABASE concatenation", () => {
		const code = 'const q = "DROP DATABASE " + dbName;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags DROP SCHEMA concatenation", () => {
		const code = 'const q = "DROP SCHEMA " + schemaName;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags DROP VIEW concatenation", () => {
		const code = 'const q = "DROP VIEW " + viewName;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("flags TRUNCATE TABLE concatenation", () => {
		const code = 'const q = "TRUNCATE TABLE " + tableName;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
	it("does NOT flag plain English containing 'update'/'drop' without SQL syntax", () => {
		const code = 'const msg = "dirty update: " + name;\nconst note = "drop the file: " + name;';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
	it("flags the selectConcatPrefix shape (SELECT immediately followed by concat, no FROM on the line)", () => {
		const code = 'let sql = "SELECT" + col;';
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
});

describe("checkSqlStringConcat — interpolation & exemptions", () => {
	it("does NOT flag a comma inside a column list literal", () => {
		const code = 'const q = "SELECT id, name FROM users";';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
	it("does NOT flag a plain literal with no concatenation", () => {
		const code = 'const q = "SELECT * FROM users";';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
	it("does NOT flag a `?` placeholder", () => {
		const code = 'db.query("SELECT * FROM users WHERE id = ?", [id]);';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
	it("does NOT flag a `:name` named placeholder even with concatenation elsewhere on the line", () => {
		const code = 'db.query("SELECT * FROM users WHERE id = :id " + extra, {id});';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
	it("does NOT flag an event-listener callback shape", () => {
		const code = 'el.on("SELECT * FROM " + name);';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
});

describe("checkSqlStringConcat — match cap and exact shape", () => {
	it("caps at 10 matches and preserves the boundary", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `const q${i} = "SELECT * FROM t" + id${i};`);
		const code = lines.join("\n");
		const matches = checkSqlStringConcat(code, "db.ts");
		expect(matches).toHaveLength(10);
		expect(matches[9]?.line).toBe(10);
	});

	it("returns exact line number and trimmed/truncated text", () => {
		const longIdent = "x".repeat(200);
		const code = `\n   const q = "SELECT * FROM users WHERE id = " + ${longIdent};   \n`;
		const matches = checkSqlStringConcat(code, "db.ts");
		const rawLine = (code.split("\n")[1] ?? "");
		expect(matches).toEqual([{ line: 2, text: rawLine.trim().slice(0, 150) }]);
	});
});

describe("checkSqlEscapeHatchNonLiteral — extension coverage", () => {
	const code = "const q = sql.unsafe(tableName);";

	it("flags .tsx", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "Component.tsx").length).toBeGreaterThan(0);
	});
	it("flags .js", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "db.js").length).toBeGreaterThan(0);
	});
	it("flags .jsx", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "Component.jsx").length).toBeGreaterThan(0);
	});
	it("flags .mjs", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "db.mjs").length).toBeGreaterThan(0);
	});
	it("flags .cjs", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "db.cjs").length).toBeGreaterThan(0);
	});
	it("flags .mts", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "db.mts").length).toBeGreaterThan(0);
	});
	it("flags .cts", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "db.cts").length).toBeGreaterThan(0);
	});
	it("does NOT flag an unsupported extension", () => {
		expect(checkSqlEscapeHatchNonLiteral(code, "notes.txt")).toEqual([]);
	});
});

describe("checkSqlEscapeHatchNonLiteral — cap and exact shape", () => {
	it("caps at MATCH_LIMIT (10) matches", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `const q${i} = sql.unsafe(name${i});`);
		const code = lines.join("\n");
		const matches = checkSqlEscapeHatchNonLiteral(code, "db.ts");
		expect(matches).toHaveLength(10);
	});

	it("produces the exact line number and message, trimming trailing whitespace inside the match", () => {
		const code = "\nconst q = sql.unsafe(   tableName);\n";
		const matches = checkSqlEscapeHatchNonLiteral(code, "db.ts");
		expect(matches).toEqual([
			{
				line: 2,
				text: "SQL escape hatch (sql.unsafe() called with non-literal argument — should only wrap compile-time constants (schema names, etc.): const q = sql.unsafe(   tableName);",
			},
		]);
	});

	it("trims the quoted source line in the message body", () => {
		const code = "\n\t  const q = sql.unsafe(tableName);  \t\n";
		const matches = checkSqlEscapeHatchNonLiteral(code, "db.ts");
		expect(matches).toEqual([
			{
				line: 2,
				text: "SQL escape hatch (sql.unsafe() called with non-literal argument — should only wrap compile-time constants (schema names, etc.): const q = sql.unsafe(tableName);",
			},
		]);
	});

	it("attributes the message to the correct source line, not an off-by-one neighbor", () => {
		const code = ["const a = 1;", "const q = sql.unsafe(name);", "const c = 3;"].join("\n");
		const matches = checkSqlEscapeHatchNonLiteral(code, "db.ts");
		expect(matches).toEqual([
			{
				line: 2,
				text: "SQL escape hatch (sql.unsafe() called with non-literal argument — should only wrap compile-time constants (schema names, etc.): const q = sql.unsafe(name);",
			},
		]);
	});
});

describe("checkUbsHardcodedLocalhost — scannable extensions", () => {
	const exts = [
		".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
		".py", ".pyi",
		".go", ".rs",
		".java", ".kt", ".swift",
		".rb", ".php",
		".c", ".cc", ".cpp", ".cxx",
		".h", ".hpp", ".hxx",
	];
	it.each(exts)("flags a hardcoded localhost endpoint in %s", (ext) => {
		const code = 'const url = "http://localhost:3000";';
		const matches = checkUbsHardcodedLocalhost(code, `src/lib/client${ext}`);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag an unsupported extension", () => {
		const code = 'const url = "http://localhost:3000";';
		expect(checkUbsHardcodedLocalhost(code, "notes.txt")).toEqual([]);
	});

	it("does NOT fire on test files", () => {
		const code = 'const url = "http://localhost:3000";';
		expect(checkUbsHardcodedLocalhost(code, "src/foo.test.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — path normalization", () => {
	it("does NOT fire when a Windows-style backslash path lands in an examples/ segment", () => {
		const code = 'const url = "http://localhost:3000";';
		expect(checkUbsHardcodedLocalhost(code, "src\\examples\\dev.ts")).toEqual([]);
	});

	it("does NOT fire when an uppercase path segment matches an exemption case-insensitively", () => {
		const code = 'const url = "http://localhost:3000";';
		expect(checkUbsHardcodedLocalhost(code, "EXAMPLES/dev.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — path exemptions", () => {
	const code = 'const url = "http://localhost:3000";';

	it("does NOT fire in an examples/ directory", () => {
		expect(checkUbsHardcodedLocalhost(code, "examples/dev.ts")).toEqual([]);
	});
	it("does NOT fire in a singular example/ directory", () => {
		expect(checkUbsHardcodedLocalhost(code, "example/dev.ts")).toEqual([]);
	});
	it("does NOT fire in a /fixtures/ directory", () => {
		expect(checkUbsHardcodedLocalhost(code, "src/fixtures/db.ts")).toEqual([]);
	});
	it("does NOT fire in a dev/ directory", () => {
		expect(checkUbsHardcodedLocalhost(code, "dev/client.ts")).toEqual([]);
	});
	it("does NOT fire when the path contains 'config'", () => {
		expect(checkUbsHardcodedLocalhost(code, "src/config.ts")).toEqual([]);
	});
	it("does NOT fire for a .env file", () => {
		expect(checkUbsHardcodedLocalhost(code, "secrets/.env")).toEqual([]);
	});
	it("does NOT fire for a .env.example file", () => {
		expect(checkUbsHardcodedLocalhost(code, "secrets/.env.example")).toEqual([]);
	});

	it("STILL fires when 'examples' merely prefixes a filename (not a path segment)", () => {
		expect(checkUbsHardcodedLocalhost(code, "examplesx.ts").length).toBeGreaterThan(0);
	});
	it("STILL fires when 'dev' merely prefixes a directory name (devops/)", () => {
		expect(checkUbsHardcodedLocalhost(code, "devops/client.ts").length).toBeGreaterThan(0);
	});
	it("STILL fires for a file merely containing 'env' in its name", () => {
		expect(checkUbsHardcodedLocalhost(code, "environment.ts").length).toBeGreaterThan(0);
	});
});

describe("checkUbsHardcodedLocalhost — endpoint regex shapes", () => {
	it("flags a `//host` URL shape", () => {
		expect(checkUbsHardcodedLocalhost('fetch("http://localhost/api");', "src/x.ts").length).toBeGreaterThan(0);
	});
	it("flags an `@host` shape (connection string)", () => {
		expect(
			checkUbsHardcodedLocalhost('const dsn = "postgres://user:pass@localhost/db";', "src/x.ts").length,
		).toBeGreaterThan(0);
	});
	it("flags a bare host:port endpoint without quotes", () => {
		expect(checkUbsHardcodedLocalhost("const target = localhost:9000;", "src/x.ts").length).toBeGreaterThan(0);
	});
	it("does NOT flag localhost followed by non-digit punctuation with no other endpoint shape", () => {
		const code = 'log("info: localhost: reachable");';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT flag localhost embedded mid-identifier inside a string (not a bare quoted token)", () => {
		const code = 'const name = "xlocalhost";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT flag localhost with trailing characters inside a string (not a bare quoted token)", () => {
		const code = 'const name = "localhostx";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("STILL fires on a bare quoted host and a host:port endpoint", () => {
		expect(checkUbsHardcodedLocalhost('const h = "localhost";', "src/x.ts").length).toBeGreaterThan(0);
		expect(
			checkUbsHardcodedLocalhost("const u = `http://localhost:9229`;", "src/x.ts").length,
		).toBeGreaterThan(0);
	});
});

describe("checkUbsHardcodedLocalhost — per-line exemptions", () => {
	it("does NOT fire on a metadata-shaped assignment (description:)", () => {
		const code = 'const meta = { description: "http://localhost:3000" };';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT fire on a fix_instruction metadata field", () => {
		const code = 'fix_instruction: "set a clear default for local dev: http://localhost:8787"';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT fire inside a RegExp constructor call", () => {
		const code = 'const re = new RegExp("localhost");';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT fire on a `??` fallback default", () => {
		const code = 'const url = configured ?? "http://127.0.0.1:8787";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT fire on a `.includes()` membership test", () => {
		const code = 'if (url.includes("localhost")) { return; }';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT fire on a strict-equality test", () => {
		const code = 'const isLocal = host === "localhost";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("does NOT fire on a fallback-named declaration", () => {
		const code = 'const fallbackHost = "127.0.0.1";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("STILL fires on a plain baked endpoint constant that is not a default", () => {
		const code = 'const apiUrl = "http://localhost:3000";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts").length).toBeGreaterThan(0);
	});
});

describe("checkUbsHardcodedLocalhost — regex-literal self-detection guard", () => {
	it("does NOT fire on a single-line regex literal containing the token", () => {
		const code = "if (/https?:\\/\\/(localhost|127\\.0\\.0\\.1):\\d+/.test(line)) { /* … */ }";
		expect(checkUbsHardcodedLocalhost(code, "src/lib/check.ts")).toEqual([]);
	});
	it("does NOT fire on `new RegExp(...)` pattern-building templates", () => {
		const code = 'const pattern = new RegExp(`(?:curl|wget).*(?:localhost|127\\.0\\.0\\.1):${port}`, "i");';
		expect(checkUbsHardcodedLocalhost(code, "src/harness/evaluator/pre-tool.ts")).toEqual([]);
	});
	it("does NOT fire on a multi-line `new RegExp(` argument continuation", () => {
		const code = [
			"const pattern = new RegExp(",
			'\t`(?:curl|wget|fetch).*(?:localhost|127\\.0\\.0\\.1):${port}`,',
			'\t"i",',
			");",
		].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/harness/evaluator/pre-tool.ts")).toEqual([]);
	});
	it("STILL fires on a real fetch() endpoint even though a RegExp construction exists elsewhere in the file", () => {
		const code = [
			'const pattern = new RegExp("localhost", "i");',
			'await fetch("http://localhost:3000/api");',
		].join("\n");
		const matches = checkUbsHardcodedLocalhost(code, "src/lib/client.ts");
		expect(matches).toEqual([{ line: 2, text: 'await fetch("http://localhost:3000/api");' }]);
	});
});

describe("checkUbsHardcodedLocalhost — dev-gated exemption", () => {
	it("does NOT fire on a guarded dev-mode resolver branch", () => {
		const code = [
			"function resolveServerUrl(config, devMode) {",
			"  if (devMode && config.devPort) {",
			"    return `http://localhost:${config.devPort}/mcp`;",
			"  }",
			"  return config.url;",
			"}",
		].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/bio/servers.ts")).toEqual([]);
	});
	it("does NOT fire when the guarding conditional (within 3 lines) names a dev token", () => {
		const code = ["if (isDev) {", "  // route everything locally", '  url = "http://localhost:3000";', "}"].join(
			"\n",
		);
		expect(checkUbsHardcodedLocalhost(code, "src/lib/router.ts")).toEqual([]);
	});
	it("does NOT fire when the line itself names a DEV_ constant", () => {
		const code = 'registerServer(DEV_GATEWAY, "http://127.0.0.1:8080/gateway");';
		expect(checkUbsHardcodedLocalhost(code, "src/lib/register.ts")).toEqual([]);
	});
	it("STILL fires when the nearby identifier merely starts with dev-like letters (deviceUrl)", () => {
		const code = 'const deviceUrl = "http://localhost:3000/devices";';
		expect(checkUbsHardcodedLocalhost(code, "src/lib/devices.ts").length).toBeGreaterThan(0);
	});
	it("STILL fires on an unguarded endpoint even when a dev-gated block exists earlier", () => {
		const code = [
			"if (devMode) {",
			'  a = "http://localhost:1111";',
			"}",
			"const x = 1;",
			"const y = 2;",
			"const z = 3;",
			'const leaked = "http://localhost:9999/api";',
		].join("\n");
		const matches = checkUbsHardcodedLocalhost(code, "src/lib/mixed.ts");
		expect(matches).toEqual([{ line: 7, text: 'const leaked = "http://localhost:9999/api";' }]);
	});
	it("STILL fires when the preceding dev mention is not a conditional guard", () => {
		const code = ['const devNote = "see docs";', 'const url = "http://localhost:4000";'].join("\n");
		const matches = checkUbsHardcodedLocalhost(code, "src/lib/notes.ts");
		expect(matches).toEqual([{ line: 2, text: 'const url = "http://localhost:4000";' }]);
	});
});

describe("checkUbsHardcodedLocalhost — match cap and exact shape", () => {
	it("caps at 10 matches", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `const q${i} = "http://localhost:300${i}";`);
		const code = lines.join("\n");
		const matches = checkUbsHardcodedLocalhost(code, "src/x.ts");
		expect(matches).toHaveLength(10);
	});
	it("returns the exact 1-based line number and trimmed text", () => {
		const code = '\n   const url = "http://localhost:3000";   \n';
		const matches = checkUbsHardcodedLocalhost(code, "src/x.ts");
		expect(matches).toEqual([{ line: 2, text: 'const url = "http://localhost:3000";' }]);
	});
});

// ===========================================================================
// Mutation-kill regression suite (fleet M5, 2026-08-10). Each case pins a
// whitespace/char-class boundary the regex-level survivor report showed was
// unguarded — a mutant that loosens or tightens one of these boundaries
// (`\s+`→`\s`, a negated character class, a dropped `*`/`?`) changes the
// verdict for the EXACT input below. Grouped by the sqlVerb/interpolation/
// exemption regex each targets; see mutant location in the summary comment.
// ===========================================================================

describe("checkSqlStringConcat — sqlVerb: repeated-whitespace still fires (P: must fire)", () => {
	// Each kills the `\s+`→`\s` (or the overlapping [\w,\s] column-list class)
	// mutation on that verb's line in `sqlVerb` — a single required whitespace
	// position that a naive `\s` cannot stretch across two real spaces.
	it("P: SELECT with 2 spaces before *", () => {
		expect(checkSqlStringConcat('const q = "SELECT  * FROM " + t;', "db.ts").length).toBeGreaterThan(0);
	});
	it("P: SELECT column-list with 2 spaces after the comma", () => {
		expect(
			checkSqlStringConcat('const q = "SELECT id,  name FROM " + t;', "db.ts").length,
		).toBeGreaterThan(0);
	});
	it("P: SELECT column-list with 2 spaces before FROM", () => {
		expect(
			checkSqlStringConcat('const q = "SELECT id, name  FROM " + t;', "db.ts").length,
		).toBeGreaterThan(0);
	});
	it("P: INSERT with 2 spaces before INTO", () => {
		expect(
			checkSqlStringConcat('const q = "INSERT  INTO users VALUES (" + v + ")";', "db.ts").length,
		).toBeGreaterThan(0);
	});
	it("P: UPDATE with 2 spaces before the table name", () => {
		expect(checkSqlStringConcat('const q = "UPDATE  users SET x = " + v;', "db.ts").length).toBeGreaterThan(0);
	});
	it("P: DELETE with 2 spaces before FROM", () => {
		expect(
			checkSqlStringConcat('const q = "DELETE  FROM users WHERE id = " + id;', "db.ts").length,
		).toBeGreaterThan(0);
	});
	it("P: DELETE FROM with 2 spaces before the table name", () => {
		expect(
			checkSqlStringConcat('const q = "DELETE FROM  users WHERE id = " + id;', "db.ts").length,
		).toBeGreaterThan(0);
	});
	it("P: DROP with 2 spaces before TABLE", () => {
		expect(checkSqlStringConcat('const q = "DROP  TABLE " + t;', "db.ts").length).toBeGreaterThan(0);
	});
	it("P: TRUNCATE with 2 spaces before TABLE", () => {
		expect(checkSqlStringConcat('const q = "TRUNCATE  TABLE " + t;', "db.ts").length).toBeGreaterThan(0);
	});
});

describe("checkSqlStringConcat — selectConcatPrefix whitespace boundary (P: must fire)", () => {
	it("P: no whitespace at all between SELECT, quote, and operator", () => {
		expect(checkSqlStringConcat('let sql = "SELECT"+col;', "db.ts").length).toBeGreaterThan(0);
	});
	it("P: exactly one space between SELECT and the opening quote", () => {
		expect(checkSqlStringConcat('let sql = "SELECT "+col;', "db.ts").length).toBeGreaterThan(0);
	});
});

describe("checkSqlStringConcat — interpolation whitespace/identifier boundary (P: must fire)", () => {
	it("P: 2 spaces between the closing quote and the concat operator", () => {
		expect(
			checkSqlStringConcat('const q = "SELECT * FROM x"  + y;', "db.ts").length,
		).toBeGreaterThan(0);
	});
	it("P: 2 spaces between the concat operator and a single-char identifier", () => {
		expect(
			checkSqlStringConcat('const q = "SELECT * FROM x" +  col;', "db.ts").length,
		).toBeGreaterThan(0);
	});
	it("P: single-char identifier right after the operator (no trailing ident chars to spare)", () => {
		expect(checkSqlStringConcat('const q = "SELECT * FROM x" + y;', "db.ts").length).toBeGreaterThan(0);
	});
	it("P: template literal with extra text between the interpolation and the closing backtick", () => {
		const code = "const q = `SELECT * FROM users WHERE id = ${uid}xyz`;";
		expect(checkSqlStringConcat(code, "db.ts").length).toBeGreaterThan(0);
	});
});

describe("checkSqlStringConcat — placeholder exemption boundary (N: must not fire)", () => {
	// Both kill a mutation that narrows the placeholder regex just enough to
	// miss a still-parameterized shape, which would wrongly turn the
	// exemption off and flag a safe parameterized query.
	it("N: a 2-digit numbered placeholder ($12) is still recognized as parameterized", () => {
		const code = 'db.query("SELECT * FROM t WHERE id = $12" + extra, [id]);';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
	it("N: a `?` placeholder followed by a space before the closing quote is still recognized", () => {
		const code = 'db.query("SELECT * FROM t WHERE id = ? " + extra, [id]);';
		expect(checkSqlStringConcat(code, "db.ts")).toEqual([]);
	});
});

describe("checkSqlStringConcat — eventListener exemption boundary (N: must not fire)", () => {
	it("N: a space between the dot and the listener method name is still exempt", () => {
		expect(checkSqlStringConcat('el. on("SELECT * FROM " + name);', "db.ts")).toEqual([]);
	});
	it("N: a space between the listener method name and its call parens is still exempt", () => {
		expect(checkSqlStringConcat('el.on ("SELECT * FROM " + name);', "db.ts")).toEqual([]);
	});
});

describe("checkSqlEscapeHatchNonLiteral — call-shape whitespace boundary (P: must fire)", () => {
	it("P: a space between the escape-hatch method name and its call parens still flags", () => {
		const matches = checkSqlEscapeHatchNonLiteral("const q = sql.unsafe (tableName);", "db.ts");
		expect(matches.length).toBeGreaterThan(0);
	});
	it("P: truncates the quoted source line in the message to 120 chars", () => {
		const longIdent = "y".repeat(200);
		const code = `const q = sql.unsafe(${longIdent});`;
		const matches = checkSqlEscapeHatchNonLiteral(code, "db.ts");
		expect(matches).toHaveLength(1);
		const msg = matches[0]?.text ?? "";
		const quotedPart = msg.slice(msg.indexOf("): ") + 3);
		expect(quotedPart.length).toBe(120);
	});
});

describe("checkUbsHardcodedLocalhost — path-exemption endsWith boundary (N/P pairs)", () => {
	it("N: a filename that merely ends in .env (not the bare dotfile) is still exempt", () => {
		const code = 'const url = "http://localhost:3000";';
		expect(checkUbsHardcodedLocalhost(code, "secrets/prod.env")).toEqual([]);
	});
	it("N: a filename ending in .env.example (not just .env) is still exempt", () => {
		const code = 'const url = "http://localhost:3000";';
		expect(checkUbsHardcodedLocalhost(code, "secrets/prod.env.example")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — metadataAssignment colon-spacing boundary (N: must not fire)", () => {
	it("N: no space at all between the field name's colon and the opening quote", () => {
		const code = 'description:"http://localhost:3000"';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — regExpConstructor call-shape boundary (N: must not fire)", () => {
	it("N: a space between RegExp and its call parens is still recognized as a constructor", () => {
		const code = 'const re = new RegExp ("localhost");';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — localhostAsDefault boundary (N: must not fire)", () => {
	it("N: no space between `||` and the fallback string literal is still a default", () => {
		const code = 'const url = flag ||"http://localhost:8787";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — localhostAsTest boundary (N: must not fire)", () => {
	it("N: a space between .includes and its call parens is still a membership test", () => {
		const code = 'if (url.includes ("localhost")) { x(); }';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: double-equals (==), not just triple-equals, is still an equality test", () => {
		const code = 'const isLocal = host == "localhost";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: non-quote prose text between the quote and the localhost token is still exempt", () => {
		const code = 'const isLocal = host === "is-localhost";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — localhostNamedDefault boundary (N: must not fire)", () => {
	it("N: 2 spaces after const is still a named-default declaration", () => {
		const code = 'const  fallbackHost = "127.0.0.1";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: a word-char prefix before Fallback (xFallbackHost) is still a named default", () => {
		const code = 'const xFallbackHost = "127.0.0.1";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: no space before the `=` is still a named-default declaration", () => {
		const code = 'const fallbackHost="127.0.0.1";';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — regex-pattern-naming exemption (isRegexPatternLocalhostLine)", () => {
	// The naming-convention branch of the pattern-building exemption was only
	// ever reached, before this suite, via lines that ALSO tripped the earlier
	// `RegExp(` constructor exemption — so the branch itself (and the whole
	// function body / return expression) could be gutted with no test noticing.
	it("N: an UPPER_RE-named template assignment is exempt even with no RegExp( on the line", () => {
		const code = "const HOST_RE = `localhost`;";
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("P: a lowercase-leading identifier does NOT satisfy the _RE naming convention (still fires)", () => {
		const code = "const host_RE = `localhost`;";
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts").length).toBeGreaterThan(0);
	});
	it("N: extra text on both sides of localhost inside the template is still exempt via _RE naming", () => {
		const code = "const XX_RE = `see localhost xx`;";
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: a *Pattern-suffixed identifier (not _RE) also satisfies the naming convention", () => {
		const code = "myPattern = `localhost`;";
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: a backslash-d regex escape sequence signals a regex-building line", () => {
		const code = "const p = `port \\\\d+ on localhost`;";
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: a `.test(` call signals a regex-building line even with a space before `test`", () => {
		const code = "if (pattern. test(`has localhost in it`)) { x(); }";
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: a `.match(` call with a space before its parens also signals a regex-building line", () => {
		const code = "const m = line.match (`localhost` + suffix);";
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — multi-line RegExp( continuation (isPrevLineRegExpOpen)", () => {
	// Regression for a coverage gap: the ONLY existing multi-line test used a
	// localhost token that never satisfied LOCALHOST_ENDPOINT_RE in the first
	// place (not `//`/`@`-prefixed, not colon-digit, not quote-adjacent), so
	// it passed vacuously without ever reaching isPrevLineRegExpOpen. These
	// use a backtick-adjacent token so the endpoint gate is actually crossed.
	it("N: previous non-blank line ending in RegExp( exempts a backtick-adjacent localhost token", () => {
		const code = ["const pattern = new RegExp(", "  `localhost`,", '  "i",', ");"].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: a blank line between RegExp( and the localhost continuation is still skipped over", () => {
		const code = ["const pattern = new RegExp(", "", "  `localhost`,", '  "i",', ");"].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — dev-token guard boundary (isDevGuardedLocalhostLine)", () => {
	it("N: a bare `dev` token (no suffix) in the guarding conditional still exempts", () => {
		const code = ["if (dev) {", '  url = "http://localhost:3000";', "}"].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: a bare `DEV` token (no suffix) in the guarding conditional still exempts", () => {
		const code = ["if (DEV) {", '  url = "http://localhost:3000";', "}"].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: a dev-gated conditional exactly 3 non-blank lines back still exempts", () => {
		const code = [
			"if (devMode) {",
			"  const a = 1;",
			"  const b = 2;",
			'  url = "http://localhost:3000";',
			"}",
		].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("P: a dev-gated conditional 4 non-blank lines back is past the lookback window (still fires)", () => {
		const code = [
			"if (devMode) {",
			"  const a = 1;",
			"  const b = 2;",
			"  const c = 3;",
			'  url = "http://localhost:3000";',
			"}",
		].join("\n");
		const matches = checkUbsHardcodedLocalhost(code, "src/x.ts");
		expect(matches).toEqual([{ line: 5, text: 'url = "http://localhost:3000";' }]);
	});
});

// ===========================================================================
// Round 2 (fleet M5): the after-measure re-run showed these specific
// whitespace/char-class boundaries were NOT actually exercised by round 1 —
// several round-1 additions targeted a same-shaped but DIFFERENT regex (e.g.
// `isExemptStrippedLocalhostLine`'s regExpConstructor vs
// `isPrevLineRegExpOpen`'s own end-anchored regex), or hit an escape hatch
// the mutant could still reach via a different alternative/restart position.
// ===========================================================================

describe("checkSqlStringConcat — sqlVerb: second whitespace run per verb (round 2)", () => {
	it("P: 2 spaces between INTO and the table name", () => {
		expect(
			checkSqlStringConcat('const q = "INSERT INTO  users VALUES (" + v + ")";', "db.ts").length,
		).toBeGreaterThan(0);
	});
	it("P: 2 spaces between the table name and SET", () => {
		expect(checkSqlStringConcat('const q = "UPDATE users  SET x = " + v;', "db.ts").length).toBeGreaterThan(0);
	});
});

describe("checkUbsHardcodedLocalhost — metadataAssignment: space before the colon (round 2)", () => {
	it("N: a space before the colon, no space after, is still a metadata assignment", () => {
		const code = 'description :"http://localhost:3000"';
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — isPrevLineRegExpOpen: its OWN end-anchored regex (round 2)", () => {
	// Distinct from the regExpConstructor exemption (`\bRegExp\s*\(/`, no end
	// anchor) tested earlier — this one requires "RegExp(" to be the LAST
	// thing on the previous line (`\bRegExp\s*\(\s*$/`), only reachable via a
	// genuine multi-line continuation.
	it("N: a space between RegExp and its opening paren on the continuation-opening line", () => {
		const code = ["const pattern = new RegExp (", "  `localhost`,", '  "i",', ");"].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: trailing whitespace after the opening paren on the continuation-opening line", () => {
		const code = ["const pattern = new RegExp( ", "  `localhost`,", '  "i",', ");"].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: a whitespace-only (not empty) line between RegExp( and the localhost continuation", () => {
		const code = ["const pattern = new RegExp(", "   ", "  `localhost`,", '  "i",', ");"].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — isDevGuardedLocalhostLine: blank lines inside the lookback (round 2)", () => {
	it("N: a blank line inside the 3-line lookback does not consume a slot (dev token still reached)", () => {
		const code = [
			"if (devMode) {",
			"",
			"  const a = 1;",
			"  const b = 2;",
			'  url = "http://localhost:3000";',
			"}",
		].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: a whitespace-only line inside the 3-line lookback does not consume a slot either", () => {
		const code = [
			"if (devMode) {",
			"   ",
			"  const a = 1;",
			"  const b = 2;",
			'  url = "http://localhost:3000";',
			"}",
		].join("\n");
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
});

describe("checkUbsHardcodedLocalhost — final match text truncation to 150 chars (round 2)", () => {
	it("P: a long localhost line truncates the reported text to exactly 150 chars", () => {
		const pad = "x".repeat(200);
		const code = `const url = "http://localhost:3000"; // ${pad}`;
		const matches = checkUbsHardcodedLocalhost(code, "src/x.ts");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text.length).toBe(150);
	});
});

describe("checkUbsHardcodedLocalhost — regex-pattern-naming: character-level boundaries (round 2)", () => {
	// Round 1's HOST_RE/myPattern/XX_RE tests exercised the ALTERNATIVE choice
	// (which branch of the big OR fires) but several mutants sit INSIDE one
	// alternative's character class or quantifier, where the mutant can still
	// match by restarting the naming-convention scan at a later uppercase
	// letter immediately before the "_RE"/"Re" suffix. These pin the exact
	// boundary so that escape hatch is closed off.
	it("N: a single-uppercase-letter _RE identifier (no room to restart mid-name)", () => {
		expect(checkUbsHardcodedLocalhost("const X_RE = `localhost`;", "src/x.ts")).toEqual([]);
	});
	it("N: an uppercase-then-lowercase _RE identifier (restart position is not uppercase)", () => {
		expect(checkUbsHardcodedLocalhost("const Xa_RE = `localhost`;", "src/x.ts")).toEqual([]);
	});
	it("N: a single-lowercase-letter Re-suffixed identifier (no room to restart mid-name)", () => {
		expect(checkUbsHardcodedLocalhost("hRe = `localhost`;", "src/x.ts")).toEqual([]);
	});
	it("N: an underscore immediately before Re blocks the mid-name restart (my_Re)", () => {
		expect(checkUbsHardcodedLocalhost("my_Re = `localhost`;", "src/x.ts")).toEqual([]);
	});
	it("N: no whitespace at all before the `=` is still a Re-suffixed declaration", () => {
		expect(checkUbsHardcodedLocalhost("hostRegex=`localhost`", "src/x.ts")).toEqual([]);
	});
	it("N: a literal `[a-z]`-shaped character class signals a regex-building line", () => {
		expect(checkUbsHardcodedLocalhost("const p = `[a-z] on localhost`;", "src/x.ts")).toEqual([]);
	});
	it("N: a literal `[^a-z]`-shaped (negated) character class also signals one", () => {
		expect(checkUbsHardcodedLocalhost("const p = `[^a-z] on localhost`;", "src/x.ts")).toEqual([]);
	});
	it("N: a `.test(` call with no space before its parens signals a regex-building line", () => {
		const code = "const p = `has localhost`; p.test(p);";
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: a `.test(` call with a space before its parens also signals one", () => {
		const code = "const p = `has localhost`; p.test (p);";
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
	it("N: a `.test(` call with 2 spaces before its parens also signals one", () => {
		const code = "const p = `has localhost`; p.test  (p);";
		expect(checkUbsHardcodedLocalhost(code, "src/x.ts")).toEqual([]);
	});
});
