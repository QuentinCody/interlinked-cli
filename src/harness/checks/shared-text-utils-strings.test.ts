// Companion tests for the nested-template/interpolation string stripper in
// shared-text-utils-strings.ts, consumed by `stripStrings` in
// shared-text-utils.ts.
//
// Bug this fixes: the old line-by-line `stripStrings` tracked "am I inside a
// multi-line template" with a single backtick counter per line. A nested
// template literal inside a `${...}` interpolation of a multi-line template
// (e.g. a template-literal argument built from another template literal)
// desynced that counter's parity, so the outer template never appeared to
// close — every following line of the file was then blanked to "".
//
// Fix: `${...}` interpolation content is now scanned as CODE (a brace-depth
// stack, itself running the same string/template/regex dispatch
// recursively) instead of being counted as raw template-body characters.

import { describe, expect, it } from "vitest";
import { stripCommentsAndStrings, stripStrings } from "./shared-text-utils.js";

describe("stripStrings — nested template/interpolation tracking", () => {
	it("P1: a nested template inside a ${} interpolation of a multi-line template does not corrupt later lines", () => {
		const input = [
			"appendFileSync(",
			"  target,",
			"  `${serializeRecord(",
			"    rec({ uuid: `grow-${growSeq}`, seq: growSeq }),",
			"  )}\\n`,",
			");",
			'const cwd = mkdtempSync(join(tmpdir(), "tlrw-"));',
			"const z = after();",
		].join("\n");

		const out = stripStrings(input);
		const lines = out.split("\n");

		expect(lines).toHaveLength(8);
		expect(lines[5]).toBe(");");
		expect(lines[6]).toBe('const cwd = mkdtempSync(join(tmpdir(), ""));');
		expect(lines[7]).toBe("const z = after();");
	});

	it("P2: a single-line template with a nested template in ${} followed by more code on the same line", () => {
		const input = "const s = `outer-${`inner-${x}`}end`; after();";

		const out = stripStrings(input);

		expect(out.split("\n")).toHaveLength(1);
		expect(out).not.toContain("outer-");
		expect(out).not.toContain("inner-");
		expect(out).toContain("x");
		expect(out).toContain("after();");
	});

	it("P3: a multi-line template with ${} spanning lines and a } inside a nested string in the interior", () => {
		const input = ['const s = `head${fn("a}b",', "  1)}tail`;", "const after = 1;"].join("\n");

		const out = stripStrings(input);
		const lines = out.split("\n");

		expect(lines).toHaveLength(3);
		expect(lines[2]).toBe("const after = 1;");
	});

	it("N1: a plain multi-line template still blanks its content lines and keeps the backticks", () => {
		const input = "const a = `line one\nline two`;\nafter();";

		const out = stripStrings(input);
		const lines = out.split("\n");

		expect(lines).toHaveLength(3);
		expect(out).not.toContain("line one");
		expect(out).not.toContain("line two");
		expect(lines[0]).toBe("const a = `");
		expect(lines[1]).toBe("`;");
		expect(lines[2]).toBe("after();");
	});

	it("N2: a backtick inside a double-quoted string does not open a template", () => {
		const input = 'const s = "a`b";\nconst after = 1;';

		const out = stripStrings(input);
		const lines = out.split("\n");

		expect(lines).toHaveLength(2);
		expect(lines[1]).toBe("const after = 1;");
	});

	it("N3: a regex literal containing a backtick is left intact", () => {
		const input = "const re = /a`b/;\nconst after = 1;";

		expect(stripStrings(input)).toBe(input);
	});

	it("N4: existing stripCommentsAndStrings behavior is unchanged for plain cases", () => {
		const out1 = stripCommentsAndStrings(
			'const x = "STRMARKER"; // LINECOMMENT\nconst y = /* BLKCOMMENT */ "STR2";',
		);
		expect(out1).not.toContain("STRMARKER");
		expect(out1).not.toContain("LINECOMMENT");
		expect(out1).not.toContain("BLKCOMMENT");
		expect(out1).not.toContain("STR2");

		const out2 = stripCommentsAndStrings('fetch("https://api.example.com"); cleanup();');
		expect(out2).toContain("cleanup()");
		expect(out2).toContain("fetch(");
		expect(out2).not.toContain("api.example.com");
	});
});
