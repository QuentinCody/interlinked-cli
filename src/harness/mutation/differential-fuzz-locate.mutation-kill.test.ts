import { describe, expect, it } from "vitest";
import { loadTsModule } from "./differential-fuzz-deps.js";
import { FUZZ_TARGET_EXPORT, findExportedFunction, parseSource } from "./differential-fuzz-locate.js";

function locate(content: string) {
	const ts = loadTsModule();
	if (ts === null) throw new Error("typescript is required for this suite");
	return findExportedFunction(ts, parseSource(ts, "m.ts", content), content.indexOf("<"));
}

describe("findExportedFunction — export aliases", () => {
	// test-contract: bug — a type-only export list does not export the runtime function
	it("ignores `export type { f as g }`", () => {
		const r = locate("function f(a: number) { return a < 2; }\nexport type { f as g };\n");
		expect(r).toMatchObject({ ok: true, exportName: FUZZ_TARGET_EXPORT, exported: false });
	});

	// test-contract: bug — a re-export from another module does not export the local function
	it("ignores `export { f as g } from './other.js'`", () => {
		const r = locate("function f(a: number) { return a < 2; }\nexport { f as g } from './other.js';\n");
		expect(r).toMatchObject({ ok: true, exportName: FUZZ_TARGET_EXPORT, exported: false });
	});

	// test-contract: invariant — a local value export list still names the alias
	it("honors `export { f as g }`", () => {
		const r = locate("function f(a: number) { return a < 2; }\nexport { f as g };\n");
		expect(r).toMatchObject({ ok: true, exportName: "g", exported: true });
	});
});
