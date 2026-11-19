import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _resetPackageNameCacheForTests, checkImportFromOwnBarrel } from "./imports.js";

let sandbox = "";

beforeEach(() => {
	sandbox = mkdtempSync(join(process.cwd(), "scratch", "imports-check-"));
	_resetPackageNameCacheForTests();
});

afterEach(() => {
	_resetPackageNameCacheForTests();
	rmSync(sandbox, { recursive: true, force: true });
});

function sourcePath(...parts: string[]): string {
	const dir = join(sandbox, ...parts.slice(0, -1));
	mkdirSync(dir, { recursive: true });
	const file = parts.at(-1) ?? "widget.ts";
	for (const extension of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
		writeFileSync(join(dir, `index.${extension}`), `export * from "./${file.replace(/\.[^.]+$/, ".js")}";`);
	}
	return join(sandbox, ...parts);
}

function packageAt(dir: string, name: unknown, raw = false): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), raw ? String(name) : JSON.stringify({ name }));
}

function finding(line: number, text: string) {
	return { line, text };
}

describe("checkImportFromOwnBarrel package resolution", () => {
	it("walks from a nested source directory to the nearest package root", () => {
		// test-contract: public-api — a source six directory levels below a package root still uses that package name for own-package detection.
		const root = sandbox;
		packageAt(root, "@scope/widget");
		const file = sourcePath("a", "b", "c", "d", "e", "widget.ts");

		expect(checkImportFromOwnBarrel('import { x } from "@scope/widget";', file)).toEqual([
			finding(1, `imports from own package '@scope/widget' — use a deep submodule path instead: import { x } from "@scope/widget";`),
		]);
	});

	it("does not walk beyond the bounded ancestor search", () => {
		// test-contract: boundary — a package root more than five parent hops away is outside the bounded lookup contract and must not create a false own-package finding.
		packageAt(sandbox, "deep-package");
		const file = sourcePath("a", "b", "c", "d", "e", "f", "widget.ts");
		expect(checkImportFromOwnBarrel('import { x } from "deep-package";', file)).toEqual([]);
	});

	it("distinguishes missing, invalid, empty, and non-string package names", () => {
		// test-contract: security — malformed package metadata must fail closed, never treating an absent, invalid, empty, or non-string name as an owned package.
		const cases: Array<[string, string]> = [
			["missing", ""],
			["invalid", "{"],
			["empty", JSON.stringify({ name: "" })],
			["number", JSON.stringify({ name: 42 })],
		];
		for (const [name, metadata] of cases) {
			const dir = join(sandbox, name);
			if (metadata) packageAt(dir, metadata, true);
			const file = sourcePath(name, "widget.ts");
			expect(checkImportFromOwnBarrel(`import { x } from "${name}";`, file)).toEqual([]);
		}
	});

	it("observes package identity changes in the next invocation", () => {
		// test-contract: invariant — package identity changes cannot leave stale own-package claims.
		const dir = join(sandbox, "cached");
		packageAt(dir, "before-name");
		const file = sourcePath("cached", "widget.ts");
		expect(checkImportFromOwnBarrel('import value from "before-name";', file)).toEqual([
			finding(1, `imports from own package 'before-name' — use a deep submodule path instead: import value from "before-name";`),
		]);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "after-name" }));
		expect(checkImportFromOwnBarrel('import value from "before-name";', file)).toEqual([]);
		_resetPackageNameCacheForTests();
		expect(checkImportFromOwnBarrel('import value from "after-name";', file)).toEqual([
			finding(1, `imports from own package 'after-name' — use a deep submodule path instead: import value from "after-name";`),
		]);
	});
});

describe("checkImportFromOwnBarrel public spellings and findings", () => {
	it("flags every supported local barrel spelling with exact line and text", () => {
		// test-contract: public-api — all documented local barrel spellings are rejected consistently, including extension variants and the bare dot forms.
		// One call per specifier: the checker caps a single file at five findings (pinned below), so a
		// nine-line fixture can never surface the last four spellings.
		const specifiers = [".", "./", "./index", "./index.js", "./index.ts", "./index.mjs", "./index.cjs", "./index.jsx", "./index.tsx"];
		const file = sourcePath("spellings.ts");
		for (const specifier of specifiers) {
			const content = `  import { value } from "${specifier}";`;
			expect(checkImportFromOwnBarrel(content, file)).toEqual([
				finding(1, `imports from own-directory barrel '${specifier}' — import from the sibling submodule directly: import { value } from "${specifier}";`),
			]);
		}
	});

	it("caps findings at five while preserving the first five source lines", () => {
		// test-contract: invariant — the checker reports at most five findings, and each retained finding uses its one-based original line and trimmed source text.
		const file = sourcePath("many.ts");
		const content = Array.from({ length: 6 }, (_, index) => ` import { v } from "./index"; // ${index + 1}`).join("\n");
		const output = checkImportFromOwnBarrel(content, file);
		expect(output).toHaveLength(5);
		expect(output.map((match) => match.line)).toEqual([1, 2, 3, 4, 5]);
		expect(output[4]?.text).toBe("imports from own-directory barrel './index' — import from the sibling submodule directly: import { v } from \"./index\"; // 5");
	});

	it("reports imports and re-exports, but not declarations or foreign packages", () => {
		// test-contract: public-api — only import/export-from statements for a local or owned barrel are findings; declarations and unrelated package imports remain clean.
		const file = sourcePath("mixed.ts");
		const content = [
			"export { a } from './index';",
			"import b from './index.js';",
			"export function notAnImport() {}",
			"import c from 'other-package';",
		].join("\n");
		expect(checkImportFromOwnBarrel(content, file)).toEqual([
			finding(1, "imports from own-directory barrel './index' — import from the sibling submodule directly: export { a } from './index';"),
			finding(2, "imports from own-directory barrel './index.js' — import from the sibling submodule directly: import b from './index.js';"),
		]);
	});

	it("ignores comments and strings while recognizing the actual multiline declaration", () => {
		// test-contract: security — only the actual declaration supplies the forward edge.
		const file = sourcePath("noise.ts");
		const content = [
			"const comment = 'import x from \\\"./index\\\"';",
			"// import x from './index'",
			"/* export { x } from './index' */",
			"import {",
			"  x,",
			"} from './index';",
			"import y from './sibling';",
		].join("\n");
		expect(checkImportFromOwnBarrel(content, file)).toEqual([expect.objectContaining({ line: 4 })]);
	});
});

describe("checkImportFromOwnBarrel path and file boundaries", () => {
	it("skips test files, non-JS/TS files, and the index barrel itself", () => {
		// test-contract: boundary — exemptions are based on the source file path and extension, so tests, non-code assets, and the barrel file itself cannot emit findings.
		const content = `import { x } from "./index";`;
		expect(checkImportFromOwnBarrel(content, sourcePath("widget.test.ts"))).toEqual([]);
		expect(checkImportFromOwnBarrel(content, sourcePath("widget.spec.tsx"))).toEqual([]);
		expect(checkImportFromOwnBarrel(content, sourcePath("README.md"))).toEqual([]);
		expect(checkImportFromOwnBarrel(content, sourcePath("index.ts"))).toEqual([]);
	});

	it("keeps source path boundaries distinct from a different directory's index", () => {
		// test-contract: boundary — only the current directory's barrel aliases are owned; parent and sibling directory index paths are ordinary deep imports.
		const file = sourcePath("lib", "widget.ts");
		expect(checkImportFromOwnBarrel('import "../index";\nimport "./other/index";', file)).toEqual([]);
	});

	it("flags scoped and unscoped own-package names but not near matches", () => {
		// test-contract: boundary — package identity requires exact equality, preserving scoped names and rejecting prefixes, suffixes, and similarly named foreign packages.
		const scopedDir = join(sandbox, "scoped");
		packageAt(scopedDir, "@acme/widget");
		const scopedFile = sourcePath("scoped", "widget.ts");
		expect(checkImportFromOwnBarrel('import value from "@acme/widget";\nimport value from "@acme/widget-extra";', scopedFile)).toEqual([
			finding(1, "imports from own package '@acme/widget' — use a deep submodule path instead: import value from \"@acme/widget\";"),
		]);

		const plainDir = join(sandbox, "plain");
		packageAt(plainDir, "widget");
		const plainFile = sourcePath("plain", "widget.ts");
		expect(checkImportFromOwnBarrel('import value from "widget";\nimport value from "widget/subpath";', plainFile)).toEqual([
			finding(1, "imports from own package 'widget' — use a deep submodule path instead: import value from \"widget\";"),
		]);
	});
});
