import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { measureStandardsCompiler } from "./compiler.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string { const root = mkdtempSync(join(tmpdir(), "standards-compiler-")); roots.push(root); return root; }

it("reads inherited JSON compiler settings with provenance and leaves absent flags unknown", () => {
	const root = fixture();
	writeFileSync(join(root, "base.json"), '{ "compilerOptions": { "strict": true, "noImplicitOverride": false } }');
	writeFileSync(join(root, "tsconfig.json"), '{ "extends": "./base.json", "compilerOptions": { "noUncheckedIndexedAccess": true }, "files": ["source.ts"] }');
	writeFileSync(join(root, "source.ts"), "export {};");
	const result = measureStandardsCompiler(root, ["tsconfig.json"]);
	expect(result.state).toBe("measured");
	expect(result.configs[0]?.settings).toEqual({ strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: null, noImplicitOverride: false, noFallthroughCasesInSwitch: null });
	expect(result.inputs.map(input => input.file)).toContain("base.json");
	expect(result.configs[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
});

it("retains missing configuration and compiler availability as distinct unknown states", () => {
	const root = fixture();
	expect(measureStandardsCompiler(root, []).state).toBe("missing");
	expect(measureStandardsCompiler(root, ["tsconfig.json"], () => null).state).toBe("unsupported");
});

it("keeps invalid JSON diagnostics and a null setting observation", () => {
	const root = fixture();
	writeFileSync(join(root, "tsconfig.json"), '{ "compilerOptions": { "strict": "yes" } }');
	const result = measureStandardsCompiler(root, ["tsconfig.json"]);
	expect(result.state).toBe("inconclusive");
	expect(result.configs[0]?.diagnostics.length).toBeGreaterThan(0);
	expect(result.configs[0]?.settings.strict).toBeNull();
});
