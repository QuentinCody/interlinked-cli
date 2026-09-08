import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanSelfImports } from "./self-import-scan.js";

const roots = {
	commonjs: mkdtempSync(join(tmpdir(), "self-import-usage-cjs-")),
	module: mkdtempSync(join(tmpdir(), "self-import-usage-esm-")),
};
for (const [type, root] of Object.entries(roots)) {
	writeFileSync(join(root, "package.json"), JSON.stringify({ type }));
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
		compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
		include: ["*.ts"],
	}));
}
afterAll(() => {
	for (const root of Object.values(roots)) rmSync(root, { recursive: true, force: true });
});

describe("self-import resolution uses each reference's import/require mode", () => {
	it("does not treat an extensionless dynamic import in CommonJS as a resolved self-import", () => {
		expect(scanSelfImports('void import("./widget");', join(roots.commonjs, "widget.ts"))).toEqual([]);
	});

	it("still detects a CommonJS static import and an explicit dynamic self-import", () => {
		const source = 'import "./widget";\nvoid import("./widget.js");';
		expect(scanSelfImports(source, join(roots.commonjs, "widget.ts"))).toEqual([
			{ line: 1, text: 'import "./widget";' },
			{ line: 2, text: 'void import("./widget.js");' },
		]);
	});

	it("resolves import-equals as require inside an ES module", () => {
		const source = 'import self = require("./widget");';
		expect(scanSelfImports(source, join(roots.module, "widget.ts"))).toEqual([{ line: 1, text: source }]);
	});

	it("keeps extensionless ES module static imports unresolved", () => {
		expect(scanSelfImports('import "./widget";', join(roots.module, "widget.ts"))).toEqual([]);
	});

	it("honors an explicit require resolution mode on a type import in ESM", () => {
		const source = 'import type { Value } from "./widget" with { "resolution-mode": "require" };';
		expect(scanSelfImports(source, join(roots.module, "widget.ts"))).toEqual([{ line: 1, text: source }]);
	});

	it("honors an explicit import resolution mode on a type import in CommonJS", () => {
		const source = 'import type { Value } from "./widget" with { "resolution-mode": "import" };';
		expect(scanSelfImports(source, join(roots.commonjs, "widget.ts"))).toEqual([]);
	});
});
