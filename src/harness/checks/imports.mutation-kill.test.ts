import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _resetPackageNameCacheForTests, checkImportFromOwnBarrel } from "./imports.js";

let sandbox = "";

beforeEach(() => {
	sandbox = mkdtempSync(join(process.cwd(), "scratch", "imports-mutkill-"));
	TS = join(sandbox, "foo.ts");
	writeFileSync(TS, "export const Foo = 1;");
	writeFileSync(join(sandbox, "many.ts"), "export const v = 1;");
	for (const extension of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
		writeFileSync(join(sandbox, `index.${extension}`), 'export * from "./foo.js";\nexport * from "./many.js";');
	}
	_resetPackageNameCacheForTests();
});

afterEach(() => {
	_resetPackageNameCacheForTests();
	rmSync(sandbox, { recursive: true, force: true });
});

function dirAt(...parts: string[]): string {
	const dir = join(sandbox, ...parts);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function packageAt(dir: string, name: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
}

let TS: string;

describe("nearestPackageName — ancestor-walk bound (i < 6) and increment direction", () => {
	// test-contract: boundary — the loop checks the file's own directory plus five
	// parents (six directories total); a package.json at the sixth must be found.
	it("finds a package.json exactly at the 6th checked ancestor (5 hops up)", () => {
		const deepDir = dirAt("a", "b", "c", "d", "e");
		packageAt(sandbox, "widget-owner");
		const file = join(deepDir, "widget.ts");
		expect(checkImportFromOwnBarrel('import { x } from "widget-owner";', file)).toEqual([
			{
				line: 1,
				text: `imports from own package 'widget-owner' — use a deep submodule path instead: import { x } from "widget-owner";`,
			},
		]);
	});

	// test-contract: boundary — a package.json one hop beyond the bounded walk must
	// never be found; this also demonstrates the walk advances forward (not backward).
	it("does not walk past the sixth checked ancestor (6 hops up is out of range)", () => {
		const deepDir = dirAt("a", "b", "c", "d", "e", "f");
		packageAt(sandbox, "widget-owner");
		const file = join(deepDir, "widget.ts");
		expect(checkImportFromOwnBarrel('import { x } from "widget-owner";', file)).toEqual([]);
	});
});

describe("nearestPackageName — package.json only found further up, not at the file's own directory", () => {
	// test-contract: invariant — `existsSync` must gate the read (a forced-true
	// existsSync would throw/short-circuit on the first, package-less directory),
	// and the ancestor-equality break must not fire before an ancestor with a real
	// package.json has been checked.
	it("skips a directory with no package.json and finds the real one one hop up", () => {
		const parentDir = dirAt("pkgup");
		packageAt(parentDir, "up-one");
		const childDir = dirAt("pkgup", "child");
		const file = join(childDir, "widget.ts");
		expect(checkImportFromOwnBarrel('import { x } from "up-one";', file)).toEqual([
			{
				line: 1,
				text: `imports from own package 'up-one' — use a deep submodule path instead: import { x } from "up-one";`,
			},
		]);
	});
});

describe("nearestPackageName — invocation-local identity", () => {
	// test-contract: invariant — a later invocation observes changed package identity.
	it("reads a changed package name without requiring a reset", () => {
		const dir = dirAt("pkgcache");
		packageAt(dir, "name-v1");
		const file = join(dir, "widget.ts");

		expect(checkImportFromOwnBarrel('import x from "name-v1";', file)).toEqual([
			{ line: 1, text: `imports from own package 'name-v1' — use a deep submodule path instead: import x from "name-v1";` },
		]);

		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "name-v2" }));
		expect(checkImportFromOwnBarrel('import x from "name-v1";', file)).toEqual([]);

		// After the explicit reset, the fresh on-disk name is picked up.
		_resetPackageNameCacheForTests();
		expect(checkImportFromOwnBarrel('import x from "name-v2";', file)).toEqual([
			{ line: 1, text: `imports from own package 'name-v2' — use a deep submodule path instead: import x from "name-v2";` },
		]);
	});
});

describe("checkImportFromOwnBarrel — index-file exemption", () => {
	// test-contract: boundary — `base === "index"` (compared against the literal
	// "index") is the only thing exempting the barrel file itself; a real index.ts
	// must be skipped and never produce a finding.
	it("does not skip a genuine index.ts file when the exemption check is broken", () => {
		const content = 'import { Foo } from "./index";\n';
		expect(checkImportFromOwnBarrel(content, "src/lib/index.ts")).toEqual([]);
	});
});

describe("checkImportFromOwnBarrel — five-finding cap boundary", () => {
	// test-contract: boundary — the `matches.length >= 5` break must fire once five
	// findings exist, before a sixth is pushed; an off-by-one or disabled cap would
	// let a sixth finding through.
	it("caps at exactly five findings out of six candidate lines", () => {
		const content = Array.from({ length: 6 }, (_, index) => ` import { v } from "./index"; // ${index + 1}`).join("\n");
		const out = checkImportFromOwnBarrel(content, join(sandbox, "many.ts"));
		expect(out).toHaveLength(5);
		expect(out.map((m) => m.line)).toEqual([1, 2, 3, 4, 5]);
	});
});

describe("checkImportFromOwnBarrel — keyword-line detection requires trim + start anchor", () => {
	// test-contract: invariant — the keyword regex is tested against a TRIMMED
	// line; without the trim, leading indentation would push "import" past the ^
	// anchor and the line would be skipped entirely.
	it("flags an indented import line (leading whitespace must not block the keyword check)", () => {
		const content = '  import { Foo } from "./index";\n';
		const out = checkImportFromOwnBarrel(content, TS);
		expect(out).toHaveLength(1);
	});

	// test-contract: security — without the `^` anchor, "export" appearing after an
	// unrelated leading statement would still match, spuriously flagging the line.
	it("recognizes an actual export declaration after another statement", () => {
		const content = 'doStuff(); export { X } from "./index";\n';
		const out = checkImportFromOwnBarrel(content, TS);
		expect(out).toHaveLength(1);
	});
});

describe("checkImportFromOwnBarrel — from-clause whitespace requires one-or-more, not exactly-one", () => {
	// test-contract: invariant — `\s+` must tolerate more than one space between
	// "from" and the opening quote; `\s` (exactly one) would fail to match and the
	// specifier would never be extracted.
	it("still matches a from-clause with multiple spaces before the quote", () => {
		const content = 'import { Foo } from   "./index";\n';
		const out = checkImportFromOwnBarrel(content, TS);
		expect(out).toHaveLength(1);
	});
});

describe("checkImportFromOwnBarrel — reported line number", () => {
	// test-contract: invariant — `line: i + 1` must point at the actual matching
	// source line; a sign error (i - 1) would report a different (or invalid) line.
	it("reports the one-based line of the matching line, not an adjacent one", () => {
		const content = 'const noop = 1;\nimport { Foo } from "./index";\n';
		const out = checkImportFromOwnBarrel(content, TS);
		expect(out).toEqual([
			{
				line: 2,
				text: `imports from own-directory barrel './index' — import from the sibling submodule directly: import { Foo } from "./index";`,
			},
		]);
	});
});

describe("checkImportFromOwnBarrel — finding text is trimmed and truncated from the real source line", () => {
	// test-contract: invariant — the embedded source excerpt must be trimmed;
	// without the trim, leading/trailing whitespace from the raw line would leak
	// into the finding text (also exercises `originalLines[i] ?? ""` staying the
	// real content rather than being swapped for "" by a `&&` mutation).
	it("trims leading and trailing whitespace out of the embedded source text", () => {
		const content = '  import { Foo } from "./index"; \n';
		const out = checkImportFromOwnBarrel(content, TS);
		expect(out).toEqual([
			{
				line: 1,
				text: `imports from own-directory barrel './index' — import from the sibling submodule directly: import { Foo } from "./index";`,
			},
		]);
	});

	// test-contract: boundary — the embedded excerpt must be sliced to 120 chars;
	// without the slice, a long line would be embedded in full instead.
	it("truncates a long matching line to 120 characters in the finding text", () => {
		const longLine = `import { ${"a".repeat(200)} } from "./index";`;
		const out = checkImportFromOwnBarrel(`${longLine}\n`, TS);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toBe(
			`imports from own-directory barrel './index' — import from the sibling submodule directly: ${longLine.trim().slice(0, 120)}`,
		);
	});
});

describe("checkImportFromOwnBarrel — module-level barrel specifier set, extension variants", () => {
	// test-contract: public-api — each documented barrel specifier (including the
	// bare "." form and every index.* extension) must independently be recognized;
	// a gutted string literal in the Set would silently stop matching just that one.
	it("flags every extension-variant local barrel spelling individually", () => {
		const specifiers = [".", "./index.mjs", "./index.cjs", "./index.jsx", "./index.tsx"];
		for (const specifier of specifiers) {
			const content = `import { value } from "${specifier}";\n`;
			const out = checkImportFromOwnBarrel(content, TS);
			expect(out).toEqual([
				{
					line: 1,
					text: `imports from own-directory barrel '${specifier}' — import from the sibling submodule directly: import { value } from "${specifier}";`,
				},
			]);
		}
	});
});
