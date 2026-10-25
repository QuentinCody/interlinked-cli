// Independent adversarial review of the `raw_control_bytes` pre_block check
// (2026-10-21). The negatives were probed false positives before the detector
// was refined: `scratch/2026-10-21-adversarial/raw_control_bytes.probe.mts`.
// Bytes are built with String.fromCharCode so this file stays searchable.

import { describe, expect, it } from "vitest";
import { checkRawControlBytes } from "../../checks/control-bytes.js";

const FF = String.fromCharCode(12);
const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);

describe("raw_control_bytes — negative (must not fire)", () => {
	it("N1: a PEP 8 form-feed page separator in Python", () => {
		const src = `import re\n\n${FF}\n# ---- Section 2 ----\ndef parse(): ...\n`;
		expect(checkRawControlBytes(src, "pkg/email_parser.py")).toEqual([]);
	});

	it("N2: a GNU-style ^L page break in C", () => {
		const src = `#include <stdlib.h>\n${FF}\nvoid *xmalloc(size_t n) { return malloc(n); }\n`;
		expect(checkRawControlBytes(src, "lib/alloc.c")).toEqual([]);
	});

	it("N3: a page break with trailing whitespace in a C header", () => {
		const src = `#pragma once\n${FF}  \nvoid *xmalloc(size_t n);\n`;
		expect(checkRawControlBytes(src, "include/alloc.h")).toEqual([]);
	});

	it("N4: a page break in a .pyi stub", () => {
		expect(checkRawControlBytes(`def a() -> int: ...\n${FF}\ndef b() -> str: ...\n`, "pkg/stubs.pyi")).toEqual(
			[],
		);
	});

	it("N5: a page break under CRLF line endings in C++", () => {
		expect(checkRawControlBytes(`int a;\r\n${FF}\r\nint b;\r\n`, "src/a.cpp")).toEqual([]);
	});

	it("N6: a page break in JS / Java / C# (FF is lexical whitespace there)", () => {
		const src = `var a = 1;\n${FF}\nvar b = 2;\n`;
		for (const path of ["src/legacy.js", "src/Main.java", "src/Program.cs"]) {
			expect(checkRawControlBytes(src, path), path).toEqual([]);
		}
	});

	it("N7: a JSON parser negative case under __tests__ (the raw char IS the invalid input)", () => {
		const src = `{"k": "a${String.fromCharCode(31)}b"}\n`;
		expect(checkRawControlBytes(src, "src/json/__tests__/cases/invalid-control-in-string.json")).toEqual([]);
		expect(checkRawControlBytes(`{"a": "${NUL}"}\n`, "tests/jsonc/invalid/raw-nul.jsonc")).toEqual([]);
	});

	it("N8: a golden file of captured ANSI CLI output under test/", () => {
		expect(checkRawControlBytes(`${ESC}[1mUsage${ESC}[0m: tool [opts]\n`, "test/golden/help.md")).toEqual([]);
	});

	it("N9: a YAML loader negative input under __tests__", () => {
		const src = `a: "x${String.fromCharCode(127)}"\n`;
		expect(checkRawControlBytes(src, "src/config/__tests__/inputs/bad-ctrl.yaml")).toEqual([]);
	});
});

describe("raw_control_bytes — positive (must fire)", () => {
	it("P1: a form feed INSIDE a line is a payload byte with an escape, not a page break", () => {
		expect(checkRawControlBytes(`PAGE = "${FF}"\n`, "pkg/fmt.py")).toHaveLength(1);
	});

	it("P2: a form-feed-only line in JSON is not JSON whitespace", () => {
		expect(checkRawControlBytes(`{\n${FF}\n"a": 1}\n`, "data/y.json")).toHaveLength(1);
	});

	it("P3: a form-feed-only line in YAML / TOML / markdown stays flagged", () => {
		const src = `a: 1\n${FF}\nb: 2\n`;
		for (const path of ["conf.yaml", "conf.toml", "notes.md"]) {
			expect(checkRawControlBytes(src, path), path).toHaveLength(1);
		}
	});

	it("P4: a page-break line that also carries another control byte is flagged", () => {
		expect(checkRawControlBytes(`x = 1\n${FF}${ESC}\ny = 2\n`, "pkg/x.py")).toHaveLength(1);
	});

	it("P6: program source under a test tree still fires (its escape is lossless)", () => {
		expect(checkRawControlBytes(`const s = "${ESC}[0m";\n`, "src/x.test.ts")).toHaveLength(1);
		expect(checkRawControlBytes(`S = "${NUL}"\n`, "tests/test_x.py")).toHaveLength(1);
	});

	it("P7: a data file outside any test tree still fires", () => {
		expect(checkRawControlBytes(`{"k": "a${NUL}b"}\n`, "data/x.json")).toHaveLength(1);
		expect(checkRawControlBytes(`${ESC}[32mPASS${ESC}[0m\n`, "docs/terminal.md")).toHaveLength(1);
	});

	it("P5: NUL is never a page break (it is what makes grep skip the file)", () => {
		expect(checkRawControlBytes(`x = 1\n${NUL}\ny = 2\n`, "pkg/x.py")).toHaveLength(1);
	});
});
