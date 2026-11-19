// Tests for the corpus detector identity: the detector's own static import closure.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureDetectorSources, MAX_DETECTOR_CLOSURE, resolveInFileSet } from "./detector-closure.js";

let root: string;

function write(rel: string, content: string): void {
	const full = join(root, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cec-closure-"));
	write("package-lock.json", '{"lockfileVersion":3}');
	write("src/checks/detector.ts", [
		'import { helper } from "./helper.js";',
		'import type { Shape } from "./shape.js";',
		"export function detectFake(content: string): Shape[] { return helper(content); }",
	].join("\n"));
	write("src/checks/helper.ts", 'import { deep } from "../lib/deep.js";\nexport function helper(c: string) { return deep(c); }');
	write("src/lib/deep.ts", "export function deep(c: string) { return c ? [] : []; }");
	write("src/checks/shape.ts", "export interface Shape { line: number }");
	write("src/unrelated.ts", "export const unrelated = 1;");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("captureDetectorSources — positive (an edit inside the closure must change the identity)", () => {
	it("P1: an edit to a file the detector imports transitively", () => {
		const identity = captureDetectorSources(root);
		write("src/lib/deep.ts", "export function deep(c: string) { return c ? [1] : []; }");
		const after = identity("detectFake");
		expect(after.loaded).not.toBe("unavailable");
		expect(after.current).not.toBe(after.loaded);
	});

	it("P2: an edit to the detector module itself", () => {
		const identity = captureDetectorSources(root);
		write("src/checks/detector.ts", 'import { helper } from "./helper.js";\nexport function detectFake(c: string) { return helper(c + "x"); }');
		const after = identity("detectFake");
		expect(after.current).not.toBe(after.loaded);
	});

	it("P3: a lockfile edit", () => {
		const identity = captureDetectorSources(root);
		write("package-lock.json", '{"lockfileVersion":3,"packages":{}}');
		const after = identity("detectFake");
		expect(after.current).not.toBe(after.loaded);
	});
});

describe("captureDetectorSources — negative (an edit outside the closure must not change it)", () => {
	it("N1: an edit to an unrelated src file leaves the identity unchanged", () => {
		const identity = captureDetectorSources(root);
		const before = identity("detectFake");
		write("src/unrelated.ts", "export const unrelated = 2;");
		const after = identity("detectFake");
		expect(after.current).toBe(after.loaded);
		expect(after.loaded).toBe(before.loaded);
	});

	it("N2: an edit to a type-only import target leaves the identity unchanged", () => {
		const identity = captureDetectorSources(root);
		write("src/checks/shape.ts", "export interface Shape { line: number; text: string }");
		const after = identity("detectFake");
		expect(after.current).toBe(after.loaded);
	});

	it("N3: an unknown detector name is unavailable, never a binding", () => {
		expect(captureDetectorSources(root)("detectMissing")).toEqual({ loaded: "unavailable", current: "unavailable" });
	});

	it("N4: a closure over the cap is unavailable, never a partial binding", () => {
		const count = MAX_DETECTOR_CLOSURE + 2;
		for (let i = 0; i < count; i++) {
			const next = i + 1 < count ? `import { c${i + 1} } from "./c${i + 1}.js";\n` : "";
			write(`src/chain/c${i}.ts`, `${next}export function c${i}() { return ${i}; }`);
		}
		expect(captureDetectorSources(root)("c0").loaded).toBe("unavailable");
	});

	it("N5: a tree with no src directory makes every identity unavailable", () => {
		rmSync(join(root, "src"), { recursive: true, force: true });
		expect(captureDetectorSources(root)("detectFake").current).toBe("unavailable");
	});
});

describe("resolveInFileSet", () => {
	const files = new Set(["src/a/b.ts", "src/a/dir/index.ts", "src/c.tsx"]);

	it("P1: maps a .js specifier to its .ts source", () => {
		expect(resolveInFileSet("src/a/x.ts", "./b.js", files)).toBe("src/a/b.ts");
	});

	it("P2: resolves a directory specifier to its index file", () => {
		expect(resolveInFileSet("src/a/x.ts", "./dir", files)).toBe("src/a/dir/index.ts");
	});

	it("P3: climbs with ../ and tries .tsx", () => {
		expect(resolveInFileSet("src/a/x.ts", "../c.js", files)).toBe("src/c.tsx");
	});

	it("N1: returns null for a file outside the captured set", () => {
		expect(resolveInFileSet("src/a/x.ts", "./missing.js", files)).toBeNull();
	});
});
