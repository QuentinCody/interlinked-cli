import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import { _resetPackageNameCacheForTests, checkImportFromOwnBarrel } from "./imports.js";

let sandbox: string;
let TS: string;
beforeEach(() => {
	sandbox = mkdtempSync(join(process.cwd(), "scratch", "imports-api-"));
	TS = join(sandbox, "foo.ts");
	writeFileSync(TS, "export const Foo = 1;");
	writeFileSync(join(sandbox, "index.ts"), 'export * from "./foo.js";');
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

describe("checkImportFromOwnBarrel — positive cases", () => {
	it("flags `from './index'` in a non-barrel file", () => {
		const code = `import { Foo } from "./index";\nexport function bar() {}\n`;
		const out = checkImportFromOwnBarrel(code, TS);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toMatch(/own-directory barrel/);
	});

	it("flags `from './'`", () => {
		const code = `import { Foo } from "./";\n`;
		const out = checkImportFromOwnBarrel(code, TS);
		expect(out.length).toBe(1);
	});

	it("flags `from './index.js'`", () => {
		const code = `import { Foo } from "./index.js";\n`;
		const out = checkImportFromOwnBarrel(code, TS);
		expect(out.length).toBe(1);
	});

	it("flags `from './index.ts'`", () => {
		const code = `import { Foo } from "./index.ts";\n`;
		const out = checkImportFromOwnBarrel(code, TS);
		expect(out.length).toBe(1);
	});

	it("flags `export { Foo } from './index'` (re-export)", () => {
		const code = `export { Foo } from "./index";\n`;
		const out = checkImportFromOwnBarrel(code, TS);
		expect(out.length).toBe(1);
	});
});

describe("checkImportFromOwnBarrel — negative cases (must NOT fire)", () => {
	it("does NOT flag imports from sibling submodules", () => {
		const code = `import { Foo } from "./foo";\nimport { Bar } from "./bar/index";\n`;
		const out = checkImportFromOwnBarrel(code, TS);
		expect(out).toEqual([]);
	});

	it("does NOT flag the barrel file itself re-exporting siblings", () => {
		const code = `export { Foo } from "./foo";\nexport { Bar } from "./bar";\n`;
		const out = checkImportFromOwnBarrel(code, "src/lib/index.ts");
		expect(out).toEqual([]);
	});

	it("does NOT flag external-package imports", () => {
		const code = `import { z } from "zod";\nimport * as fs from "node:fs";\n`;
		const out = checkImportFromOwnBarrel(code, TS);
		expect(out).toEqual([]);
	});

	it("does NOT flag relative paths into a different directory's index", () => {
		const code = `import { Foo } from "../other/index";\n`;
		const out = checkImportFromOwnBarrel(code, TS);
		expect(out).toEqual([]);
	});

	it("does NOT flag `from '.'` inside an `index.ts`", () => {
		const code = `import { Foo } from "./other";\n`;
		const out = checkImportFromOwnBarrel(code, "src/lib/index.ts");
		expect(out).toEqual([]);
	});

	it("does NOT flag bare imports that happen to look like a barrel string in a comment", () => {
		const code = `// from "./index"\nimport { Foo } from "./foo";\n`;
		const out = checkImportFromOwnBarrel(code, TS);
		expect(out).toEqual([]);
	});

	it("skips test files entirely", () => {
		const code = `import { Foo } from "./index";\n`;
		const out = checkImportFromOwnBarrel(code, "src/lib/foo.test.ts");
		expect(out).toEqual([]);
	});

	it("skips non-JS/TS extensions", () => {
		const code = `import { Foo } from "./index";\n`;
		const out = checkImportFromOwnBarrel(code, "README.md");
		expect(out).toEqual([]);
	});
});

describe("checkImportFromOwnBarrel — cache reset helper", () => {
	it("exports a cache-reset hook", () => {
		expect(() => _resetPackageNameCacheForTests()).not.toThrow();
	});
});
