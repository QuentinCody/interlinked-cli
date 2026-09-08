import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSuggestions } from "./suggestions.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "verify-suggestions-w55-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
	const p = join(dir, name);
	writeFileSync(p, content, "utf-8");
	return p;
}

function runOn(files: string[]) {
	return runSuggestions({ files, cwd: dir, limit: 100, threshold: 0 });
}

// --- buildChecks: exact "check" and "source" string literals -------------

describe("buildChecks — positive (must fire)", () => {
	// test-contract: public-api — runSuggestions() must label sql-injection findings
	// with the literal check id "sql-injection" and source "security".
	it("sql-injection fires with check='sql-injection' and source='security'", () => {
		const f = writeFile(
			"sql.ts",
			`function run(id) {\n\tdb.query("SELECT * FROM users WHERE id=" + id);\n}\n`,
		);
		const result = runOn([f]);
		const findings = result.get("sql.ts") ?? [];
		expect(findings.some((x) => x.check === "sql-injection")).toBe(true);
		expect(findings.some((x) => x.source === "security")).toBe(true);
	});

	// test-contract: public-api — findings for a DB query call inside a loop
	// carry the literal check id "perf-query-in-loop" and source "performance".
	it("perf-query-in-loop fires with check='perf-query-in-loop' and source='performance'", () => {
		const f = writeFile(
			"queryloop.ts",
			`function run(items) {\n\tfor (const item of items) {\n\t\tdb.query("SELECT 1");\n\t}\n}\n`,
		);
		const result = runOn([f]);
		const findings = result.get("queryloop.ts") ?? [];
		expect(findings.some((x) => x.check === "perf-query-in-loop")).toBe(true);
		expect(findings.some((x) => x.source === "performance")).toBe(true);
	});

	// test-contract: public-api — findings for an `await` inside a loop body
	// carry the literal check id "perf-await-in-loop" and source "performance".
	it("perf-await-in-loop fires with check='perf-await-in-loop' and source='performance'", () => {
		const f = writeFile(
			"awaitloop.ts",
			`async function run(items) {\n\tfor (const item of items) {\n\t\tawait doThing(item);\n\t}\n}\n`,
		);
		const result = runOn([f]);
		const findings = result.get("awaitloop.ts") ?? [];
		expect(findings.some((x) => x.check === "perf-await-in-loop")).toBe(true);
		expect(findings.some((x) => x.source === "performance")).toBe(true);
	});

	// test-contract: public-api — findings for an empty catch block carry
	// the literal check id "silent-catch" and source "quality".
	it("silent-catch fires with check='silent-catch' and source='quality'", () => {
		const f = writeFile(
			"catch.ts",
			`function run() {\n\ttry {\n\t\tdoThing();\n\t} catch (e) {}\n}\n`,
		);
		const result = runOn([f]);
		const findings = result.get("catch.ts") ?? [];
		expect(findings.some((x) => x.check === "silent-catch")).toBe(true);
		expect(findings.some((x) => x.source === "quality")).toBe(true);
	});

	// test-contract: public-api — findings for code after `return` carry the
	// literal check id "unreachable-code" and source "quality".
	it("unreachable-code fires with check='unreachable-code' and source='quality'", () => {
		const f = writeFile(
			"unreach.ts",
			`function run() {\n\treturn 1;\n\tconsole.log("dead");\n}\n`,
		);
		const result = runOn([f]);
		const findings = result.get("unreach.ts") ?? [];
		expect(findings.some((x) => x.check === "unreachable-code")).toBe(true);
		expect(findings.some((x) => x.source === "quality")).toBe(true);
	});

	// test-contract: public-api — findings for a function that both throws and
	// returns an error object carry the literal check id "mixed-error-strategy"
	// and source "quality".
	it("mixed-error-strategy fires with check='mixed-error-strategy' and source='quality'", () => {
		const f = writeFile(
			"mixed.ts",
			`function doWork(x) {\n\tif (x) {\n\t\tthrow new Error("bad");\n\t}\n\treturn { error: "oops" };\n}\n`,
		);
		const result = runOn([f]);
		const findings = result.get("mixed.ts") ?? [];
		expect(findings.some((x) => x.check === "mixed-error-strategy")).toBe(true);
		expect(findings.some((x) => x.source === "quality")).toBe(true);
	});
});

// --- runSuggestions control flow ------------------------------------------

describe("runSuggestions — extension filter (must not fire)", () => {
	// test-contract: boundary — runSuggestions() must skip a file whose
	// extension is not in JS_TS_CODE_EXTS, regardless of content shape.
	it("skips a non-JS/TS extension even with sql-injection-shaped content", () => {
		const f = writeFile(
			"notes.txt",
			`db.query("SELECT * FROM users WHERE id=" + id);\n`,
		);
		const result = runOn([f]);
		expect(result.has("notes.txt")).toBe(false);
		expect(result.size).toBe(0);
	});
});

describe("runSuggestions — test-file filter (must not fire)", () => {
	// test-contract: boundary — runSuggestions() must skip test files
	// (isTestFile(file)) regardless of content shape.
	it("skips a *.test.ts file even with sql-injection-shaped content", () => {
		const f = writeFile(
			"sql.test.ts",
			`function run(id) {\n\tdb.query("SELECT * FROM users WHERE id=" + id);\n}\n`,
		);
		const result = runOn([f]);
		expect(result.has("sql.test.ts")).toBe(false);
		expect(result.size).toBe(0);
	});
});

describe("runSuggestions — empty findings short-circuit (must not fire)", () => {
	// test-contract: invariant — findings.length === 0 must short-circuit
	// before scoring, so a clean file never appears in the result map.
	it("clean file with no findings produces no entry in the result map", () => {
		const f = writeFile("clean.ts", `export function add(a: number, b: number) {\n\treturn a + b;\n}\n`);
		const result = runOn([f]);
		expect(result.has("clean.ts")).toBe(false);
		expect(result.size).toBe(0);
	});
});

describe("runSuggestions — scored.length > 0 gate", () => {
	// test-contract: invariant — scored.length > 0 gates inclusion in the
	// result map; a non-empty scored array must be included.
	it("a finding scored above threshold is included", () => {
		const f = writeFile(
			"sql.ts",
			`function run(id) {\n\tdb.query("SELECT * FROM users WHERE id=" + id);\n}\n`,
		);
		const result = runOn([f]);
		expect(result.has("sql.ts")).toBe(true);
		expect((result.get("sql.ts") ?? []).length).toBeGreaterThan(0);
	});

	// test-contract: boundary — a threshold above every finding's score yields
	// scored.length === 0, so runSuggestions() must exclude the file entirely.
	it("a finding scored below/equal threshold via a very high threshold is excluded", () => {
		const f = writeFile(
			"sql2.ts",
			`function run(id) {\n\tdb.query("SELECT * FROM users WHERE id=" + id);\n}\n`,
		);
		const result = runSuggestions({ files: [f], cwd: dir, limit: 100, threshold: 999999 });
		expect(result.has("sql2.ts")).toBe(false);
		// Prove the exclusion is the threshold, not a broken finder: the same
		// file with a default threshold=0 must be included.
		const unfiltered = runOn([f]);
		expect(unfiltered.has("sql2.ts")).toBe(true);
	});
});

// --- JS_TS_CODE_EXTS — exact extension list --------------------------------

describe("JS_TS_CODE_EXTS — each listed extension is accepted (must fire)", () => {
	const cases: Array<[string, string]> = [
		["a.tsx", "tsx.tsx"],
		["a.js", "js.js"],
		["a.jsx", "jsx.jsx"],
		["a.mjs", "mjs.mjs"],
		["a.mts", "mts.mts"],
		["a.cjs", "cjs.cjs"],
		["a.cts", "cts.cts"],
	];

	for (const [_label, filename] of cases) {
		// test-contract: public-api — every extension listed in JS_TS_CODE_EXTS
		// must be accepted by runSuggestions()'s extension filter.
		it(`accepts extension of ${filename}`, () => {
			const f = writeFile(
				filename,
				`function run(id) {\n\tdb.query("SELECT * FROM users WHERE id=" + id);\n}\n`,
			);
			const result = runOn([f]);
			expect(result.has(filename)).toBe(true);
		});
	}
});
