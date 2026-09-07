import { describe, expect, it } from "vitest";
import { checkExportExistenceSmokeTest as check } from "./test-export-existence.js";

describe("export existence — positive (must fire)", () => {
    it.each([
        'expect(typeof api).toBe("function")',
        'expect(typeof api === "function").toBe(true)',
        'expect(api).toBeDefined()',
        'expect(api).toBeTypeOf("function")',
    ])("recognizes %s on a value import", (assertion) => {
        expect(check(`import { api } from "./api.js"; test("exports", () => { ${assertion}; });`, "api.test.ts")).toHaveLength(1);
    });
    it("recognizes namespace members and import aliases", () => {
        const code = 'import * as ns from "./api.js"; import { api as alias } from "./api.js"; test("exports", () => { expect(ns.api).toBeDefined(); expect(alias).toBeDefined(); });';
        expect(check(code, "api.test.ts")[0]?.line).toBe(1);
    });
});

describe("export existence — negative (must not fire)", () => {
    it.each([
        'expect(api()).toBeDefined()',
        'const value = api(); expect(value).toBeDefined()',
        'expect(api).toBeDefined(); expect(api(2)).toBe(3)',
        'expect(api).not.toBeDefined()',
        'const api = local(); expect(api).toBeDefined()',
        'expect(api.result).toBeDefined()',
        'const fixture = "expect(api).toBeDefined()"; expect(fixture.length).toBe(25)',
    ])("does not classify behavioral or unresolved evidence: %s", (body) => {
        expect(check(`import { api } from "./api.js"; it("contract", () => { ${body}; });`, "api.test.ts")).toEqual([]);
    });
    it("ignores skipped ancestors, type imports, and non-test source", () => {
        expect(check('import { api } from "./api.js"; describe.skip("off", () => { it("exports", () => { expect(api).toBeDefined(); }); });', "api.test.ts")).toEqual([]);
        expect(check('import type { api } from "./api.js"; it("exports", () => { expect(api).toBeDefined(); });', "api.test.ts")).toEqual([]);
        expect(check('import { api } from "./api.js"; it("exports", () => { expect(api).toBeDefined(); });', "api.ts")).toEqual([]);
    });
});
