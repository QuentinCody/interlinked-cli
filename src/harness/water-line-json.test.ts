// Pins for the ONE strict water-line parser (water-line-json.ts). The parser
// must read exactly what strict JSON.parse reads, name why a text does not
// parse, and report every repeated object key.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeJsonParse } from "./evaluator/config-loosening-gate.js";
import { canonicalWaterLineText, parseWaterLineJson, readWaterLineFile } from "./water-line-json.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseWaterLineJson — positive (must fire: the text is refused)", () => {
	it("P1: a trailing comma is a syntax error, not a repair", () => {
		const result = parseWaterLineJson('{"a": 1,}');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/JSON/);
	});

	it("P2: a // comment line is refused", () => {
		expect(parseWaterLineJson('// ledger\n{"a": 1}').ok).toBe(false);
	});

	it("P3: an empty or whitespace-only text names the empty file", () => {
		for (const text of ["", " \n"]) {
			const result = parseWaterLineJson(text);
			expect(result).toEqual({ ok: false, error: "the file is empty" });
		}
	});

	it("P4: a byte-order mark is named", () => {
		const result = parseWaterLineJson('﻿{"a": 1}');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/byte-order mark/);
	});

	it("P5: a duplicated key is reported with its path, and the value is JSON.parse's (last wins)", () => {
		const text = '{"src/m.ts": {"f": 1}, "a/*": 0, "src/m.ts": {"f": 0.1}, "b*/": 0, "x": {"k": 1, "k": 2}}';
		const result = parseWaterLineJson(text);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.duplicateKeys).toEqual(['$["src/m.ts"]', '$["x"]["k"]']);
		expect(result.value).toEqual(JSON.parse(text));
	});

	it("P6: a duplicate inside an array element is located by index", () => {
		const result = parseWaterLineJson('{"files": [{"p": 1}, {"p": 1, "p": 2}]}');
		expect(result.ok && result.duplicateKeys).toEqual(['$["files"][1]["p"]']);
	});
});

describe("parseWaterLineJson — negative (must not fire: strict JSON parses clean)", () => {
	it("N1: runtime-written JSON parses to JSON.parse's value with no duplicates", () => {
		const text = `${JSON.stringify({ "src/a.ts": { f: 0.9, scope: "full", hw: 1 }, list: [1, { a: "x,}" }] }, null, 2)}\n`;
		expect(parseWaterLineJson(text)).toEqual({ ok: true, value: JSON.parse(text), duplicateKeys: [] });
	});

	it("N2: the same key in sibling objects and an escaped quote in a key are not duplicates", () => {
		const result = parseWaterLineJson('{"a": {"k": 1}, "b": {"k": 2}, "q\\"k": 3, "q": 4}');
		expect(result.ok && result.duplicateKeys).toEqual([]);
	});
});

describe("readWaterLineFile", () => {
	it("P1: an existing unparseable file is a failed parse, not an absent file", () => {
		const dir = mkdtempSync(join(tmpdir(), "water-line-json-"));
		dirs.push(dir);
		const path = join(dir, "metric-caps.json");
		writeFileSync(path, '{"max_cyclomatic": 16,}');
		expect(readWaterLineFile(path)?.ok).toBe(false);
	});

	it("N1: an absent file reads as null", () => {
		const dir = mkdtempSync(join(tmpdir(), "water-line-json-"));
		dirs.push(dir);
		expect(readWaterLineFile(join(dir, "missing.json"))).toBeNull();
	});
});

describe("canonicalWaterLineText", () => {
	it("P1: a JSONC-tolerant reader decodes the canonical text to the strict value", () => {
		const value = { "a/*": 0, "src/m.ts": { f: 0.1 }, "b*/": 0, "c//d": "x,}", e: ["/,]"] };
		const text = canonicalWaterLineText(value);
		expect(text).not.toMatch(/\//);
		expect(safeJsonParse(text)).toEqual(value);
		expect(JSON.parse(text)).toEqual(value);
	});

	it("N1: a value with no sensitive characters serializes as plain JSON", () => {
		expect(canonicalWaterLineText({ a: 1, b: [true, null] })).toBe('{"a":1,"b":[true,null]}');
	});
});
