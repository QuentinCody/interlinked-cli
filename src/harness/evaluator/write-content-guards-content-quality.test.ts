// Co-located tests for the content-quality guard's A5 JSON.parse heuristic.
// Regression coverage for the false positive where a JSON.parse guarded by an
// ENCLOSING try block (with the catch many lines below) was flagged, and where a
// JSON.parse mentioned only in a string/comment fired. The detector now delegates
// to the brace-tracked checkJsonParseUnsafe (stripped content + try-depth scan)
// instead of the old "is there a `try {` in the 5 lines directly above" window.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	INJECTION_SCAN_MIN_CHARS,
	collectContentQualityWarnings,
	isContentScanExempt,
} from "./write-content-guards-content-quality.js";

const JP = "JSON.parse() without try-catch";

/** Content-quality warnings for a proposed TS file, filtered to the A5 line. */
function jsonParseWarnings(fileName: string, content: string): string[] {
	return collectContentQualityWarnings(`/repo/src/${fileName}`, content, "/repo").filter((w) =>
		w.includes(JP),
	);
}

describe("collectContentQualityWarnings — A5 JSON.parse enclosing-try", () => {
	it("does NOT flag a JSON.parse guarded by an enclosing try whose opener is >5 lines above", () => {
		const content = [
			"export function load(raw: string): unknown {",
			"  try {",
			"    step1();",
			"    step2();",
			"    step3();",
			"    step4();",
			"    step5();",
			"    step6();",
			"    const parsed = JSON.parse(raw);",
			"    return parsed;",
			"  } catch {",
			"    return null;",
			"  }",
			"}",
		].join("\n");
		expect(jsonParseWarnings("load.ts", content)).toEqual([]);
	});

	it("does NOT flag a JSON.parse still inside the outer try after an inline try/catch (the hooks-template shape)", () => {
		const content = [
			"export function flush(raw: string): unknown {",
			"  try {",
			"    if (cond) {",
			"      try { cleanup(); } catch (_e) { /* ignore */ }",
			"    }",
			"    const parsed = JSON.parse(raw);",
			"    return parsed;",
			"  } catch {",
			"    return null;",
			"  }",
			"}",
		].join("\n");
		expect(jsonParseWarnings("flush.ts", content)).toEqual([]);
	});

	it("does NOT flag JSON.parse mentioned only in a string or comment", () => {
		const content = [
			"// remember to wrap JSON.parse(x) in a try",
			'const help = "call JSON.parse(raw) carefully";',
			"export const x = 1;",
		].join("\n");
		expect(jsonParseWarnings("doc.ts", content)).toEqual([]);
	});

	it("still flags a bare unguarded JSON.parse", () => {
		const content = ["export function p(raw: string): unknown {", "  return JSON.parse(raw);", "}"].join("\n");
		expect(jsonParseWarnings("bare.ts", content).length).toBe(1);
	});

	it("still flags an unguarded JSON.parse AFTER an enclosing try has closed", () => {
		const content = [
			"export function f(a: string, b: string): unknown {",
			"  try {",
			"    return JSON.parse(a);",
			"  } catch {",
			"    /* fall through */",
			"  }",
			"  return JSON.parse(b);",
			"}",
		].join("\n");
		expect(jsonParseWarnings("after.ts", content).length).toBe(1);
	});
});

// Field report 2026-07-06: the console.log debug-logging warning fired on CLI
// entrypoints whose console.log IS their output. Exempt: shebang first line,
// nearest package.json bin target, scripts|bin path segment. Ordinary library
// files must keep firing.
describe("collectContentQualityWarnings — console.log entrypoint exemption", () => {
	const THREE_LOGS = 'console.log("a");\nconsole.log("b");\nconsole.log("c");\nexport const n = 1;\n';
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-ep-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function consoleWarnings(filePath: string, content: string, cwd?: string): string[] {
		return collectContentQualityWarnings(filePath, content, cwd).filter((w) =>
			w.includes("console.log statements"),
		);
	}

	// --- entrypoints: must NOT fire ---

	it("does NOT flag a file whose first line is a shebang", () => {
		expect(consoleWarnings("/repo/src/tool.ts", `#!/usr/bin/env node\n${THREE_LOGS}`, "/repo")).toEqual([]);
	});

	it("does NOT flag a file under a scripts/ path segment", () => {
		expect(consoleWarnings("/repo/scripts/migrate.ts", THREE_LOGS, "/repo")).toEqual([]);
	});

	it("does NOT flag a file under a bin/ path segment", () => {
		expect(consoleWarnings("/repo/bin/runner.ts", THREE_LOGS, "/repo")).toEqual([]);
	});

	it("does NOT flag the target of a string-form package.json bin", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./cli.mjs" }));
		expect(consoleWarnings(join(dir, "cli.mjs"), THREE_LOGS, dir)).toEqual([]);
	});

	it("does NOT flag a target of an object-form package.json bin (nested path)", () => {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "t", bin: { mytool: "./nested/entry.js" } }),
		);
		mkdirSync(join(dir, "nested"), { recursive: true });
		expect(consoleWarnings(join(dir, "nested", "entry.js"), THREE_LOGS, dir)).toEqual([]);
	});

	// --- ordinary library/source files: must keep firing ---

	it("still flags an ordinary library file with 3+ console.log", () => {
		expect(consoleWarnings("/repo/src/lib/util.ts", THREE_LOGS, "/repo").length).toBe(1);
	});

	it("still flags when the nearest package.json has NO bin field", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
		mkdirSync(join(dir, "src"), { recursive: true });
		expect(consoleWarnings(join(dir, "src", "service.ts"), THREE_LOGS, dir).length).toBe(1);
	});

	it("still flags when the bin map points at a DIFFERENT file", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: { t: "./cli.js" } }));
		mkdirSync(join(dir, "src"), { recursive: true });
		expect(consoleWarnings(join(dir, "src", "other.ts"), THREE_LOGS, dir).length).toBe(1);
	});
});

describe("collectContentQualityWarnings — scoping fixes (2026-07 dogfood)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-cq-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// #1 hardcoded-URL heuristic: exempt .claude/workflows tooling scripts.
	const FOUR_URLS =
		'const r = ["https://github.com/a/b","https://github.com/c/d","https://github.com/e/f","https://github.com/g/h"];\n';
	const urlHits = (filePath: string): string[] =>
		collectContentQualityWarnings(filePath, FOUR_URLS, "/repo").filter((w) => w.includes("hardcoded URLs"));
	it("does NOT flag hardcoded URLs in a .claude/workflows script", () => {
		expect(urlHits("/repo/.claude/workflows/cross-repo.js")).toEqual([]);
	});
	it("does NOT flag hardcoded URLs in a session-persisted .claude/**/workflows script", () => {
		expect(urlHits("/home/u/.claude/projects/x/workflows/scripts/wf.js")).toEqual([]);
	});
	it("STILL flags hardcoded URLs in an ordinary source file", () => {
		expect(urlHits("/repo/src/net.ts").length).toBe(1);
	});

	// #2 task-marker heuristic: a marker documented inside backticks/quotes (a
	// detector's own patterns) is not a real marker; a genuine // TODO: still is.
	const markerHits = (content: string): string[] =>
		collectContentQualityWarnings("/repo/src/detector.ts", content, "/repo").filter((w) =>
			w.includes("task marker"),
		);
	it("does NOT flag markers documented inside backticks in a comment", () => {
		expect(markerHits("// matches \x60TODO:\x60 / \x60TODO(x):\x60 / \x60FIXME\x60\nexport const a = 1;\n")).toEqual([]);
	});
	it("does NOT flag markers inside a quoted string in a comment", () => {
		expect(markerHits('// the "TODO:" and "FIXME" detector kinds\nexport const a = 1;\n')).toEqual([]);
	});
	it("STILL flags a genuine // TODO: comment", () => {
		expect(markerHits("// TODO: wire this up\nexport const a = 1;\n").length).toBe(1);
	});
	it("STILL flags a genuine // FIXME comment", () => {
		expect(markerHits("// FIXME broken here\nexport const a = 1;\n").length).toBe(1);
	});

	// #3 console.log heuristic: exempt CLI command modules of a bin package.
	const THREE_LOGS = 'console.log("a");\nconsole.log("b");\nconsole.log("c");\nexport const n = 1;\n';
	const logHits = (filePath: string, cwd: string): string[] =>
		collectContentQualityWarnings(filePath, THREE_LOGS, cwd).filter((w) => w.includes("console.log statements"));
	it("does NOT flag a commands/ module when the package declares a bin", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./cli.js" }));
		mkdirSync(join(dir, "src", "commands"), { recursive: true });
		expect(logHits(join(dir, "src", "commands", "reload.ts"), dir)).toEqual([]);
	});
	it("STILL flags a commands/ module when the package has NO bin (not a CLI)", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
		mkdirSync(join(dir, "src", "commands"), { recursive: true });
		expect(logHits(join(dir, "src", "commands", "svc.ts"), dir).length).toBe(1);
	});
	it("STILL flags a non-commands module in a bin package", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./cli.js" }));
		mkdirSync(join(dir, "src", "lib"), { recursive: true });
		expect(logHits(join(dir, "src", "lib", "util.ts"), dir).length).toBe(1);
	});
});

// Field report 2026-07-06: A4 flagged statement-position calls whose rejection
// IS handled at the call site by a `.catch(...)` on a LATER line of the same
// chain (multi-line chains). Same-line handling was already exempt.
describe("collectContentQualityWarnings — A4 floating promise chain handling", () => {
	function floatingWarnings(content: string): string[] {
		return collectContentQualityWarnings("/repo/src/boot.ts", content, "/repo").filter((w) =>
			w.includes("potential floating promise"),
		);
	}

	// --- handled at the call site: must NOT fire ---

	it("does NOT flag a call handled by .catch on the same line", () => {
		expect(floatingWarnings("mainAsync().catch((err) => { report(err); });")).toEqual([]);
	});

	it("does NOT flag a multi-line chain ending in .catch", () => {
		const content = ["mainAsync()", "  .catch((err) => {", "    report(err);", "  });"].join("\n");
		expect(floatingWarnings(content)).toEqual([]);
	});

	it("does NOT flag a multi-line .then chain that ends in .catch (multi-line callbacks)", () => {
		const content = [
			"loadAsync()",
			"  .then((cfg) => {",
			"    apply(cfg);",
			"  })",
			"  .catch((err) => {",
			"    report(err);",
			"  });",
		].join("\n");
		expect(floatingWarnings(content)).toEqual([]);
	});

	it("does NOT flag a call whose argument list spans lines and closes into .catch", () => {
		const content = ["runAsync(", "  config,", ").catch(handleErr);"].join("\n");
		expect(floatingWarnings(content)).toEqual([]);
	});

	it("does NOT flag a void-prefixed call", () => {
		expect(floatingWarnings("void mainAsync();")).toEqual([]);
	});

	// --- genuinely floating: must keep firing ---

	it("still flags a bare async-named statement call", () => {
		expect(floatingWarnings("startAsync();\n").length).toBe(1);
	});

	it("still flags a bare call mid-function with no handling", () => {
		const content = ["function boot() {", "  doAsync();", "  finish();", "}"].join("\n");
		expect(floatingWarnings(content).length).toBe(1);
	});

	it("still flags a multi-line chain that ends in .then only (rejection unhandled)", () => {
		const content = ["runAsync()", "  .then((x) => use(x));"].join("\n");
		expect(floatingWarnings(content).length).toBe(1);
	});
});

// ===========================================
// A11 — JSDoc closed early by an embedded glob
// ===========================================
// Two false positives fixed here:
//   1. The matcher was GREEDY, spanning the first opener to the last terminator
//      on a line, so two valid single-line JSDocs reported each other.
//   2. It ran on EVERY file type. JSDoc is a JS/TS construct; it fired on a
//      .json manifest whose string values held comment text.

/** A11 warnings only, for a proposed file. */
function jsdocWarnings(fileName: string, content: string): string[] {
	return collectContentQualityWarnings(`/repo/src/${fileName}`, content, "/repo").filter((w) =>
		w.includes("closed early"),
	);
}

describe("content-quality A11 — premature JSDoc close", () => {
	it("flags a glob that terminates the comment and orphans the rest of the line", () => {
		const content = '/** Glob pattern (uses "dir/**", "**/*.ext") */\nexport const glob = 1;';
		expect(jsdocWarnings("types.ts", content).length).toBe(1);
	});

	it("flags a glob mid-sentence", () => {
		expect(jsdocWarnings("types.ts", "/** see src/**/*.spec.ts */\nexport const x = 1;").length).toBe(
			1,
		);
	});

	it("reports the 1-based line number of the offending comment", () => {
		const content = ["export const a = 1;", "/** see src/**/*.spec.ts */", "export const b = 2;"].join(
			"\n",
		);
		expect(jsdocWarnings("types.ts", content)[0]).toContain("line 2");
	});

	it("does not flag a normal single-line JSDoc", () => {
		expect(jsdocWarnings("types.ts", "/** a normal comment */\nexport const x = 1;").length).toBe(0);
	});

	it("does not flag two valid single-line JSDocs sharing a line", () => {
		expect(jsdocWarnings("types.ts", "/** first */ /** second */\nexport const x = 1;").length).toBe(
			0,
		);
	});

	it("does not flag a decorative doubled-star close", () => {
		expect(jsdocWarnings("types.ts", "/** doc **/\nexport const x = 1;").length).toBe(0);
	});

	it("does not run on non-JS/TS files", () => {
		const manifest = '{"new_string": "/** doc **/*.ts trailing */"}';
		expect(jsdocWarnings("manifest.json", manifest).length).toBe(0);
		expect(jsdocWarnings("notes.md", manifest).length).toBe(0);
	});
});

// ===========================================================================
// Survivor-elimination campaign (2026-07-31)
// ===========================================================================
// Every content-quality family below is a WRITE-GATE surface: the string the
// agent reads when its edit is warned about is the whole product here, so each
// block pins the load-bearing phrase of its warning (the detector's name for
// the problem AND the suggested fix), not merely "something fired".
//
// Naming: `P<n>` = MUST-FIRE, `N<n>` = MUST-NOT-FIRE.

/** Every content-quality warning for a proposed file (default repo root `/repo`,
 *  which deliberately does not exist so the package.json bin lookups fail soft). */
const cq = (filePath: string, content: string, cwd: string | undefined = "/repo"): string[] =>
	collectContentQualityWarnings(filePath, content, cwd);

/** Content-quality warnings narrowed to the one family under test. */
const only = (
	filePath: string,
	content: string,
	needle: string,
	cwd: string | undefined = "/repo",
): string[] => cq(filePath, content, cwd).filter((w) => w.includes(needle));

describe("isContentScanExempt — path-based scan exemption", () => {
	it("P1: normalizes backslashes, so a Windows .claude\\workflows path is exempt", () => {
		expect(isContentScanExempt("C:\\repo\\.claude\\workflows\\wf.js", undefined)).toBe(true);
	});

	it("P2: exempts a POSIX .claude/workflows orchestration script", () => {
		expect(isContentScanExempt("/repo/.claude/workflows/cross-repo.js", undefined)).toBe(true);
	});

	it("P3: exempts every prose extension", () => {
		for (const ext of ["md", "mdx", "markdown", "txt", "rst", "adoc"]) {
			expect(isContentScanExempt(`/repo/docs/notes.${ext}`, undefined)).toBe(true);
		}
	});

	it("P4: exempts *.config.* and *.fixture.* sentinels", () => {
		expect(isContentScanExempt("/repo/vite.config.ts", undefined)).toBe(true);
		expect(isContentScanExempt("/repo/data.fixture.json", undefined)).toBe(true);
	});

	it("P5: exempts a companion test file", () => {
		expect(isContentScanExempt("/repo/src/foo.test.ts", undefined)).toBe(true);
	});

	it("P6: exempts a RELATIVE path that only looks like a test path once resolved against cwd", () => {
		expect(isContentScanExempt("__tests__/helpers.ts", "/repo")).toBe(true);
	});

	it("N1: does not exempt an ordinary RELATIVE source path resolved against cwd", () => {
		expect(isContentScanExempt("src/app.ts", "/repo")).toBe(false);
	});

	it("N2: does not exempt an ordinary absolute source path", () => {
		expect(isContentScanExempt("/repo/src/app.ts", "/repo")).toBe(false);
	});

	it("N3: the prose-extension match is anchored at the END of the path", () => {
		expect(isContentScanExempt("/repo/src/foo.md.ts", undefined)).toBe(false);
	});

	it("N4: the config/fixture match is anchored at the END of the path", () => {
		expect(isContentScanExempt("/repo/a.config.ts.bak", undefined)).toBe(false);
	});

	it("N5: a relative test-shaped path is not exempt with no cwd to resolve against", () => {
		expect(isContentScanExempt("__tests__/helpers.ts", undefined)).toBe(false);
	});
});

describe("collectContentQualityWarnings — clean input produces an EMPTY list", () => {
	it("N1: a clean TS module yields exactly zero warnings", () => {
		expect(cq("/repo/src/clean.ts", "export const answer = 42;\n")).toEqual([]);
	});

	it("N2: a clean non-JS/TS file yields exactly zero warnings", () => {
		expect(cq("/repo/src/clean.py", "answer = 42\n")).toEqual([]);
	});

	it("N3: an exempt file yields zero warnings even when it carries dangerous-looking data", () => {
		expect(cq("/repo/docs/notes.md", "chmod 777 /tmp then eval(x) then 0o777\n")).toEqual([]);
	});
});

describe("collectContentQualityWarnings — the TS/JS scan gate", () => {
	const asrt = (filePath: string, content: string): string[] =>
		only(filePath, content, "assertion(s)");

	it("N1: content of exactly INJECTION_SCAN_MIN_CHARS characters is NOT scanned", () => {
		const content = "x as any;\n";
		expect(content.length).toBe(INJECTION_SCAN_MIN_CHARS);
		expect(asrt("/repo/src/tiny.ts", content)).toEqual([]);
	});

	it("P1: one character past the threshold IS scanned", () => {
		const content = "xy as any;\n";
		expect(content.length).toBe(INJECTION_SCAN_MIN_CHARS + 1);
		expect(asrt("/repo/src/tiny.ts", content).length).toBe(1);
	});

	it("N2: a .py file is not scanned by the TS/JS-only heuristics", () => {
		expect(asrt("/repo/src/mod.py", "value = cast(x as any) # long enough\n")).toEqual([]);
	});

	it("P2: a plain .js file IS scanned by the TS/JS-only heuristics", () => {
		expect(asrt("/repo/src/mod.js", "const a = x as any;\n").length).toBe(1);
	});
});

describe("content-quality A7 — hardcoded URLs", () => {
	const FOUR =
		'const a = ["https://a.example.com/1","https://b.example.com/2","https://c.example.com/3","https://d.example.com/4"];\n';
	const THREE =
		'const a = ["https://a.example.com/1","https://b.example.com/2","https://c.example.com/3"];\n';
	const urls = (filePath: string, content: string = FOUR): string[] =>
		only(filePath, content, "hardcoded URLs");

	it("P1: reports the exact URL count and the offending path", () => {
		expect(urls("/repo/src/net.ts")[0]).toContain("4 hardcoded URLs in /repo/src/net.ts");
	});

	it("P2: suggests configuration or environment variables", () => {
		expect(urls("/repo/src/net.ts")[0]).toContain(
			"Consider using configuration or environment variables.",
		);
	});

	it("P3: counts http:// URLs, not only https://", () => {
		expect(urls("/repo/src/net.ts", FOUR.replace(/https:/g, "http:"))[0]).toContain(
			"4 hardcoded URLs",
		);
	});

	it("P4: each match runs to the delimiter, so a concatenated run counts ONCE", () => {
		const content = FOUR.replace('/4"', '/4https://e.example.com/5"');
		expect(urls("/repo/src/net.ts", content)[0]).toContain("4 hardcoded URLs");
	});

	it("N1: exactly three URLs sits under the threshold", () => {
		expect(urls("/repo/src/net.ts", THREE)).toEqual([]);
	});

	it("N2: localhost and 127.0.0.1 URLs are never counted", () => {
		const local =
			'const a = ["http://localhost:3000/1","http://localhost:3000/2","http://127.0.0.1:8080/3","http://127.0.0.1:8080/4"];\n';
		expect(urls("/repo/src/net.ts", local)).toEqual([]);
	});

	// isUrlDataFile: an EXACT const/consts/constant/constants stem holds URLs as
	// committed data, so A7's "move it to env vars" advice does not apply.
	it("N3: a const.ts data module is exempt", () => {
		expect(urls("/repo/src/const.ts")).toEqual([]);
	});

	it("N4: a consts.ts data module is exempt", () => {
		expect(urls("/repo/src/consts.ts")).toEqual([]);
	});

	it("N5: a constant.ts data module is exempt", () => {
		expect(urls("/repo/src/constant.ts")).toEqual([]);
	});

	it("N6: a constants.ts data module is exempt", () => {
		expect(urls("/repo/src/constants.ts")).toEqual([]);
	});

	it("N7: the data-module exemption survives a Windows-style path", () => {
		expect(urls("C:\\repo\\src\\constants.ts")).toEqual([]);
	});

	it("P5: the data-module stem must match EXACTLY — app-constants.ts still fires", () => {
		expect(urls("/repo/src/app-constants.ts").length).toBe(1);
	});

	it("P6: the data-module stem is case-folded but not extension-folded — constants.d.ts fires", () => {
		expect(urls("/repo/src/constants.d.ts").length).toBe(1);
	});
});

describe("content-quality A8 — SQL injection via template interpolation", () => {
	const sqlWarn = (filePath: string, content: string): string[] =>
		only(filePath, content, "Possible SQL injection");

	it("P1: flags .exec() with an interpolated template literal", () => {
		const r = sqlWarn("/repo/src/db.ts", "db.exec(`SELECT * FROM t WHERE id = ${id}`);\n");
		expect(r.length).toBe(1);
		expect(r[0]).toContain("Possible SQL injection in /repo/src/db.ts");
		expect(r[0]).toContain("Use parameterized queries instead of template literal interpolation.");
	});

	it("P2: flags .query() with an interpolated template literal", () => {
		expect(
			sqlWarn("/repo/src/db.ts", "pool.query(`SELECT * FROM t WHERE id = ${id}`);\n").length,
		).toBe(1);
	});

	it("P3: flags a sql`` tagged template with interpolation", () => {
		expect(sqlWarn("/repo/src/db.ts", "const q = sql`SELECT * FROM t WHERE id = ${id}`;\n").length).toBe(
			1,
		);
	});

	it("P4: tolerates whitespace around .exec's argument list", () => {
		expect(sqlWarn("/repo/src/db.ts", "db.exec ( `SELECT ${id}` );\n").length).toBe(1);
	});

	it("P5: tolerates whitespace around .query's argument list", () => {
		expect(sqlWarn("/repo/src/db.ts", "pool.query ( `SELECT ${id}` );\n").length).toBe(1);
	});

	it("P6: tolerates whitespace between the sql tag and its template", () => {
		expect(sqlWarn("/repo/src/db.ts", "const q = sql `SELECT ${id}`;\n").length).toBe(1);
	});

	it("P7: fires on a .js file too", () => {
		expect(sqlWarn("/repo/src/db.js", "db.exec(`SELECT * FROM t WHERE id = ${id}`);\n").length).toBe(1);
	});

	it("P8: fires on a .py file too", () => {
		expect(sqlWarn("/repo/src/db.py", "cur.query(`SELECT * FROM t WHERE id = ${id}`)\n").length).toBe(
			1,
		);
	});

	it("N1: a template literal with no interpolation is not flagged", () => {
		expect(sqlWarn("/repo/src/db.ts", "db.exec(`SELECT 1 FROM t`);\n")).toEqual([]);
	});

	it("N2: a method merely PREFIXED with exec is not .exec", () => {
		expect(sqlWarn("/repo/src/db.ts", "db.execFoo(`${id}`);\n")).toEqual([]);
	});

	it("N3: a method merely PREFIXED with query is not .query", () => {
		expect(sqlWarn("/repo/src/db.ts", "db.queryFoo(`${id}`);\n")).toEqual([]);
	});

	it("N4: an identifier merely PREFIXED with sql is not the sql tag", () => {
		expect(sqlWarn("/repo/src/db.ts", "const q = sqlFoo`${id}`;\n")).toEqual([]);
	});

	it("N5: a tagged template passed INTO .exec is not the flagged shape", () => {
		expect(sqlWarn("/repo/src/db.ts", "db.exec(tag`${id}`);\n")).toEqual([]);
	});

	it("N6: a tagged template passed INTO .query is not the flagged shape", () => {
		expect(sqlWarn("/repo/src/db.ts", "db.query(tag`${id}`);\n")).toEqual([]);
	});

	it("N7: the language gate is anchored — a .py.bak file is not scanned", () => {
		expect(sqlWarn("/repo/src/legacy.py.bak", "cur.query(`SELECT ${id}`)\n")).toEqual([]);
	});

	it("N8: an unsupported language is not scanned even with the flagged shape", () => {
		expect(sqlWarn("/repo/src/db.rb", "conn.query(`SELECT ${id}`)\n")).toEqual([]);
	});
});

describe("content-quality A9 — wildcard CORS", () => {
	const cors = (content: string): string[] => only("/repo/src/server.ts", content, "Wildcard CORS");

	it("P1: flags a raw header value with a space after the colon", () => {
		const r = cors('res.setHeader("Access-Control-Allow-Origin: *");\n');
		expect(r.length).toBe(1);
		expect(r[0]).toContain(
			"Wildcard CORS (Access-Control-Allow-Origin: *) in /repo/src/server.ts",
		);
		expect(r[0]).toContain("Restrict to specific origins in production.");
	});

	it("P2: flags a raw header value with NO space after the colon", () => {
		expect(cors('const h = "Access-Control-Allow-Origin:*";\n').length).toBe(1);
	});

	it("P3: flags a quoted header/value pair with canonical spacing", () => {
		expect(cors('const h = { "Access-Control-Allow-Origin": "*" };\n').length).toBe(1);
	});

	it("P4: flags a quoted pair with a space BEFORE the separator", () => {
		expect(cors('const h = { "Access-Control-Allow-Origin" : "*" };\n').length).toBe(1);
	});

	it("P5: flags a quoted pair with no spaces at all", () => {
		expect(cors('const h = {"Access-Control-Allow-Origin":"*"};\n').length).toBe(1);
	});

	it("N1: a specific origin is not flagged", () => {
		expect(cors('const h = { "Access-Control-Allow-Origin": "https://app.example.com" };\n')).toEqual(
			[],
		);
	});
});

describe("content-quality A9 — chmod 777 / 0o777", () => {
	const perms = (content: string): string[] =>
		only("/repo/src/setup.ts", content, "chmod 777 / 0o777");

	it("P1: flags `chmod 777`", () => {
		const r = perms('run("chmod 777 /tmp/x");\n');
		expect(r.length).toBe(1);
		expect(r[0]).toContain("chmod 777 / 0o777 in /repo/src/setup.ts");
		expect(r[0]).toContain("Use more restrictive permissions.");
	});

	it("P2: flags chmod written with several spaces", () => {
		expect(perms('run("chmod   777 /tmp/x");\n').length).toBe(1);
	});

	it("P3: flags a bare 0o777 octal literal with no chmod nearby", () => {
		expect(perms("chmodSync(target, 0o777);\n").length).toBe(1);
	});

	it("N1: chmod 755 is not flagged", () => {
		expect(perms('run("chmod 755 /tmp/x");\n')).toEqual([]);
	});
});

describe("content-quality A10 — ReDoS nested quantifiers", () => {
	const redos = (content: string): string[] =>
		only("/repo/src/parse.ts", content, "Potential ReDoS pattern");

	it("P1: flags a nested quantifier with nothing between the inner quantifier and the group close", () => {
		const r = redos("const re = /(\\w+)+$/;\n");
		expect(r.length).toBe(1);
		expect(r[0]).toContain("Potential ReDoS pattern (nested quantifiers) in /repo/src/parse.ts");
		expect(r[0]).toContain("Simplify the regex to avoid catastrophic backtracking.");
	});

	it("P2: flags a nested quantifier with content after the inner quantifier", () => {
		expect(redos("const re = /(a+b)*/;\n").length).toBe(1);
	});

	it("N1: a quantified group with NO inner quantifier is not flagged", () => {
		expect(redos("const re = /(abc)+/;\n")).toEqual([]);
	});

	it("N2: an inner quantifier with no outer quantifier is not flagged", () => {
		expect(redos("const re = /(a+b)/;\n")).toEqual([]);
	});
});

describe("content-quality — as any / as unknown assertions", () => {
	const asrt = (content: string): string[] => only("/repo/src/types.ts", content, "assertion(s)");

	it("P1: reports the exact `as any` count and the offending path", () => {
		const r = asrt("const a = x as any;\nconst b = y as any;\n");
		expect(r.length).toBe(1);
		expect(r[0]).toContain('2 "as any" assertion(s) in /repo/src/types.ts');
		expect(r[0]).toContain("Prefer proper typing (interfaces, generics, branded types).");
	});

	it("P2: counts an `as any` written with more than one space", () => {
		expect(asrt("const a = x as any;\nconst b = y as  any;\n")[0]).toContain('2 "as any"');
	});

	it("P3: reports `as unknown` on its own", () => {
		expect(asrt("const a = x as unknown;\n")[0]).toContain('1 "as unknown" assertion(s)');
	});

	it("P4: counts an `as unknown` written with more than one space", () => {
		expect(asrt("const a = x as unknown;\nconst b = y as  unknown;\n")[0]).toContain(
			'2 "as unknown"',
		);
	});

	it("P5: joins the two kinds with ' + ' inside ONE warning", () => {
		const r = asrt("const a = x as any;\nconst b = y as unknown;\n");
		expect(r.length).toBe(1);
		expect(r[0]).toContain('1 "as any" + 1 "as unknown" assertion(s)');
	});

	it("N1: casts named only inside a comment or a string literal are not counted", () => {
		const content = '// count of `as any` casts\nconst s = "as unknown";\nexport const n = 1;\n';
		expect(asrt(content)).toEqual([]);
	});
});

describe("content-quality — console.log debug logging", () => {
	const THREE_CALLS =
		'console.log("a");\nconsole.debug("b");\nconsole.info("c");\nexport const n = 1;\n';
	const logs = (filePath: string, content: string = THREE_CALLS): string[] =>
		only(filePath, content, "console.log statements");

	it("P1: reports the exact count across log/debug/info and the offending path", () => {
		const r = logs("/repo/src/lib/util.ts");
		expect(r.length).toBe(1);
		expect(r[0]).toContain("3 console.log statements in /repo/src/lib/util.ts");
		expect(r[0]).toContain("Remove debug logging before committing.");
	});

	it("P2: a file whose name merely CONTAINS .test. is not a test file and still fires", () => {
		expect(logs("/repo/src/a.test.b.ts").length).toBe(1);
	});

	it("N1: two console calls sit under the threshold", () => {
		const content = 'console.log("a");\nconsole.log("b");\nexport const n = 1;\n';
		expect(logs("/repo/src/lib/util.ts", content)).toEqual([]);
	});

	it("N2: console calls inside comments or strings are not counted", () => {
		const content =
			'// console.log one\n// console.log two\nconst s = "console.log three";\nexport const n = 1;\n';
		expect(logs("/repo/src/lib/util.ts", content)).toEqual([]);
	});

	// The `!/\.(test|spec)\.\w+$/` conjunct guarding this branch is DEAD: the
	// extension list `isStrictTestFile` recognises is exactly the one
	// JS_TS_EXTENSIONS admits, so every path that conjunct could match is already
	// short-circuited by `isContentScanExempt` before the TS/JS block is entered.
	// That is a CROSS-MODULE premise — nothing in this file pinned it, so a later
	// narrowing of `isTestFile` (dropping .mjs/.cjs, say) would silently promote a
	// never-executed regex to load-bearing. This case pins the premise itself:
	// every JS/TS spelling of a test file must be exempt UPSTREAM.
	it("N3: every JS/TS spelling of a test/spec file is exempt upstream, so this gate is never reached", () => {
		for (const marker of ["test", "spec"]) {
			for (const ext of ["ts", "tsx", "js", "jsx", "mjs", "cjs"]) {
				const filePath = `/repo/src/a.${marker}.${ext}`;
				expect(isContentScanExempt(filePath, "/repo")).toBe(true);
				expect(cq(filePath, THREE_CALLS)).toEqual([]);
			}
		}
	});
});

describe("content-quality — unresolved task markers", () => {
	const marks = (content: string): string[] => only("/repo/src/work.ts", content, "task marker");

	it("P1: singular wording for exactly one marker", () => {
		const r = marks("// TODO: wire this up\nexport const a = 1;\n");
		expect(r.length).toBe(1);
		expect(r[0]).toContain("1 unresolved task marker in /repo/src/work.ts");
		expect(r[0]).toContain("Resolve before committing or create a tracking issue.");
	});

	it("P2: plural wording — and an exact count — for two markers", () => {
		expect(marks("// TODO: a\n// FIXME: b\nexport const a = 1;\n")[0]).toContain(
			"2 unresolved task markers in",
		);
	});

	it("P3: flags a marker with NO space after the comment lead-in", () => {
		expect(marks("//TODO\nexport const a = 1;\n").length).toBe(1);
	});

	it("P4: flags a mid-comment marker that is followed by a colon", () => {
		expect(marks("// handle the TODO: cases here\nexport const a = 1;\n").length).toBe(1);
	});

	it("P5: flags a mid-comment marker separated from its colon by a space", () => {
		expect(marks("// handle the TODO : cases here\nexport const a = 1;\n").length).toBe(1);
	});

	it("N1: a marker word mid-enumeration with no colon or paren is narration, not a task", () => {
		expect(marks("// scans for TODO and FIXME markers\nexport const a = 1;\n")).toEqual([]);
	});
});

describe("content-quality — empty catch block", () => {
	const empties = (content: string): string[] =>
		only("/repo/src/io.ts", content, "Empty catch block");

	it("P1: flags `catch (e) {}` with canonical spacing", () => {
		const r = empties("try { work(); } catch (e) {}\n");
		expect(r.length).toBe(1);
		expect(r[0]).toContain("Empty catch block in /repo/src/io.ts");
		expect(r[0]).toContain("Silent error swallowing hides bugs — at minimum log the error.");
	});

	it("P2: flags `catch(e){}` with no spacing at all", () => {
		expect(empties("try { work(); } catch(e){}\n").length).toBe(1);
	});

	it("P3: flags a multi-character catch parameter", () => {
		expect(empties("try { work(); } catch (error) {}\n").length).toBe(1);
	});

	it("P4: flags a catch body holding only whitespace", () => {
		expect(empties("try { work(); } catch (e) { }\n").length).toBe(1);
	});

	it("N1: a catch that logs the error is not flagged", () => {
		expect(empties("try { work(); } catch (e) { report(e); }\n")).toEqual([]);
	});
});

describe("content-quality A2 — eval() / new Function()", () => {
	const injects = (content: string): string[] =>
		only("/repo/src/run.ts", content, "eval() or new Function()");

	it("P1: flags eval()", () => {
		const r = injects("const r = eval(src);\n");
		expect(r.length).toBe(1);
		expect(r[0]).toContain("eval() or new Function() in /repo/src/run.ts");
		expect(r[0]).toContain("These enable code injection — use safer alternatives.");
	});

	it("P2: flags new Function()", () => {
		expect(injects('const f = new Function("return 1");\n').length).toBe(1);
	});

	it("P3: flags new Function written with several spaces", () => {
		expect(injects('const f = new  Function("return 1");\n').length).toBe(1);
	});

	it("N1: a function merely NAMED evaluate() is not eval()", () => {
		expect(injects("const r = evaluate(src);\n")).toEqual([]);
	});

	it("N2: `new FunctionFactory()` is not `new Function()`", () => {
		expect(injects("const f = new FunctionFactory();\n")).toEqual([]);
	});

	it("N3: eval( in a doc comment is not eval() (2026-10-21 FP on claim-evidence.ts)", () => {
		expect(injects("/** Operating points from the eval (see header). */\nconst x = 1;\n")).toEqual([]);
	});

	it("N4: eval( and new Function( inside string literals are not calls", () => {
		expect(injects('const a = "eval(x)";\nconst b = \'new Function("y")\';\n')).toEqual([]);
	});

	it("P4: eval() inside a template interpolation is still code", () => {
		expect(injects("const r = `${eval(src)}`;\n").length).toBe(1);
	});
});

describe("content-quality A3 — Math.random() deriving a security-sensitive value", () => {
	const insecure = (content: string): string[] =>
		only("/repo/src/auth.ts", content, "Math.random() used to derive");

	it("P1: reports the 1-based line of the Math.random() call itself", () => {
		const content =
			"const a = 1;\nconst sessionToken = Math.random().toString(36);\nconst b = 2;\n";
		const r = insecure(content);
		expect(r.length).toBe(1);
		expect(r[0]).toContain("in /repo/src/auth.ts (line 2)");
		expect(r[0]).toContain("Use crypto.randomUUID() or crypto.getRandomValues() instead.");
	});

	it("P2: a keyword on the line ABOVE the call still counts as context", () => {
		expect(insecure("const secret =\n  Math.random().toString(36);\n")[0]).toContain("(line 2)");
	});

	// Each compound keyword must match with AND without its separator — the
	// `[_-]?` in A3_SECURITY_CONTEXT is what makes `apikey` and `api_key` both
	// security context.
	for (const keyword of [
		"apikey",
		"api_key",
		"privatekey",
		"private_key",
		"signingkey",
		"signing_key",
		"accesskey",
		"access_key",
		"sessionid",
		"session_id",
	]) {
		it(`P3: recognises ${keyword} as security context`, () => {
			expect(insecure(`const ${keyword} = Math.random().toString(36);\n`).length).toBe(1);
		});
	}

	it("N1: Math.random() with no security keyword nearby is not flagged", () => {
		expect(insecure("const bucket = Math.random() < 0.5;\n")).toEqual([]);
	});

	it("N2: a security keyword with no Math.random() on the line is not flagged", () => {
		expect(insecure("const password = readPassword();\nconst token = fetchToken();\n")).toEqual([]);
	});
});

describe("content-quality — code inside ${...} interpolations is scanned as code", () => {
	it("P1: an `as any` appearing ONLY inside an interpolation is still counted", () => {
		const content = "const msg = `v=${JSON.stringify(payload as any)}`;\nexport const m = msg;\n";
		expect(only("/repo/src/msg.ts", content, "assertion(s)")[0]).toContain('1 "as any"');
	});

	it("P2: each interpolation becomes its own LINE, so per-line checks see them separately", () => {
		const content = "const s = `a${runAsync()}b${loadAsync()}c`;\nexport const t = s;\n";
		expect(only("/repo/src/boot.ts", content, "floating promise")[0]).toContain(
			"2 potential floating promise(s)",
		);
	});
});

describe("content-quality A4 — floating-promise count and chain tracking", () => {
	const floats = (content: string): string[] =>
		only("/repo/src/boot.ts", content, "potential floating promise");

	// Asserted as the WHOLE string, not a substring: a decremented counter renders
	// "-1 potential floating promise(s)", which still *contains* the "1 …" phrase.
	it("P1: renders the exact count, path, and remedies verbatim", () => {
		const r = floats("startAsync();\n");
		expect(r.length).toBe(1);
		expect(r[0]).toBe(
			"[interlinked:content-quality] 1 potential floating promise(s) in /repo/src/boot.ts. Add await, void, or .catch() to handle rejections.",
		);
	});

	it("P2: a name carrying word characters AFTER `Async` still counts", () => {
		expect(floats("runAsyncTask();\n").length).toBe(1);
	});

	it("P3: a same-line handler merely PREFIXED with catch does not exempt the call", () => {
		expect(floats("mainAsync().catchError(report);\n").length).toBe(1);
	});

	it("P4: a statement that has ENDED is floating even when a later line carries .catch", () => {
		const content = ["startAsync();", "other();", "p.catch(report);"].join("\n");
		expect(floats(content).length).toBe(1);
	});

	it("P5: a later-line handler merely PREFIXED with catch does not close the chain", () => {
		const content = ["mainAsync()", "  .catchError(report);"].join("\n");
		expect(floats(content).length).toBe(1);
	});

	it("N1: a property access on an async-named object is not a floating call", () => {
		expect(floats("runAsync.start(cfg);\n")).toEqual([]);
	});

	it("N2: a blank line inside a multi-line chain does not end the statement", () => {
		const content = ["mainAsync()", "", "  .catch(report);"].join("\n");
		expect(floats(content)).toEqual([]);
	});

	it("N3: an object-literal argument keeps the chain open across lines", () => {
		const content = ["seedAsync({", "  a: 1,", "}", ").catch(report);"].join("\n");
		expect(floats(content)).toEqual([]);
	});

	it("N4: an array-literal argument keeps the chain open across lines", () => {
		const content = ["seedAsync([", "  1,", "]", ").catch(report);"].join("\n");
		expect(floats(content)).toEqual([]);
	});

	it("P6: a closed object-literal chain that ENDS is floating, later .catch notwithstanding", () => {
		const content = ["seedAsync({", "  a: 1,", "});", "other();", "p.catch(report);"].join("\n");
		expect(floats(content).length).toBe(1);
	});

	it("P7: a closed array-literal chain that ENDS is floating, later .catch notwithstanding", () => {
		const content = ["seedAsync([", "  1,", "]);", "other();", "p.catch(report);"].join("\n");
		expect(floats(content).length).toBe(1);
	});

	it("P8: a closed parenthesised chain that ENDS is floating, later .catch notwithstanding", () => {
		const content = ["seedAsync(", "  1,", ");", "other();", "p.catch(report);"].join("\n");
		expect(floats(content).length).toBe(1);
	});

	// The chain scan is bounded at CHAIN_SCAN_MAX_LINES (200) continuation lines,
	// measured from the CALL line — not from the top of the file.
	const chain = (continuationLines: number): string =>
		[
			"const p0 = 0;",
			"const p1 = 1;",
			"const p2 = 2;",
			"const p3 = 3;",
			"const p4 = 4;",
			"startAsync(",
			...Array.from({ length: continuationLines - 1 }, () => "  arg,"),
			").catch(report);",
		].join("\n");

	it("N5: a .catch exactly AT the 200-line scan limit is still found", () => {
		expect(floats(chain(200))).toEqual([]);
	});

	it("P9: a .catch one line PAST the scan limit is not found — the call reads as floating", () => {
		expect(floats(chain(201))[0]).toContain("1 potential floating promise(s)");
	});
});

describe("content-quality A6 — mixed import/require", () => {
	const MIXED = 'import { a } from "./a.js";\nconst b = require("./b.js");\n';
	const mixed = (filePath: string, content: string = MIXED): string[] =>
		only(filePath, content, "Mixed import/require");

	it("P1: flags a module using both module systems", () => {
		const r = mixed("/repo/src/mix.ts");
		expect(r.length).toBe(1);
		expect(r[0]).toContain("Mixed import/require in /repo/src/mix.ts");
		expect(r[0]).toContain("Use one module system consistently (prefer ES imports).");
	});

	it("P2: the .cjs exemption is anchored at the END of the path", () => {
		expect(mixed("/repo/src/a.cjs.ts").length).toBe(1);
	});

	it("N1: a .cjs module may use require alongside import syntax", () => {
		expect(mixed("/repo/src/legacy.cjs")).toEqual([]);
	});

	it("N2: require alone is not mixing", () => {
		expect(mixed("/repo/src/only-require.ts", 'const b = require("./b.js");\n')).toEqual([]);
	});

	it("N3: import alone is not mixing", () => {
		expect(mixed("/repo/src/only-import.ts", 'import { a } from "./a.js";\n')).toEqual([]);
	});

	it("N4: an identifier merely BEGINNING with import is not an import statement", () => {
		const content = 'const importMap = 1;\nconst b = require("./b.js");\n';
		expect(mixed("/repo/src/named.ts", content)).toEqual([]);
	});

	it("N5: an identifier merely BEGINNING with require is not a require() call", () => {
		const content = 'import { a } from "./a.js";\nconst b = requireFoo("./b.js");\n';
		expect(mixed("/repo/src/named.ts", content)).toEqual([]);
	});
});
