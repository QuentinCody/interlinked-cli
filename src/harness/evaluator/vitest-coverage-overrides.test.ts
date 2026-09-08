import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { decideVitestCoverageWaterLine } from "./vitest-coverage-water-line.js";

const literal = 'coverage: { include: ["src/**"], exclude: [] }';
const inherited = 'const inherited = { include: ["src/**"], exclude: [] }; const shared = { coverage: inherited };';

describe("effective coverage overrides", () => {
    it.each([
        `${inherited} export default { test: { ${literal}, ...shared } };`,
        `${inherited} export default { test: { ${literal} }, ...{ test: shared } };`,
        `${inherited} const candidate = { ${literal} }; export default { test: { ...candidate, ...shared } };`,
        `${inherited} const candidate = { test: { ${literal} } }; export default { ...candidate, test: shared };`,
        `${inherited} export default (() => ({ test: { ${literal}, ...shared } }))();`,
    ])("does not block an edit to an overridden literal: %s", before => {
        const after = before.replace(literal, literal.replace("exclude: []", 'exclude: ["src/private/**"]'));
        const effective = (source: string): string => JSON.stringify(runInNewContext(source.replace("export default", "globalThis.result =") + "result.test.coverage"));
        expect(effective(after)).toBe(effective(before));
        expect(decideVitestCoverageWaterLine("vitest.config.ts", before, after)).toEqual({ kind: "allow", warning: expect.stringContaining("object spread") });
    });

    it("abstains when only HEAD contains an enclosing override", () => {
        const before = `${inherited} export default { test: { ${literal.replace('"src/**"', '"src/private/**"')}, ...shared } };`;
        const after = `export default { test: { ${literal} } };`;
        expect(decideVitestCoverageWaterLine("vitest.config.ts", before, after)).toEqual({ kind: "allow", warning: expect.stringMatching(/HEAD.*object spread/) });
    });

    it.each([
        `${inherited} export default { test: { ${literal}, coverage: inherited } };`,
        `${inherited} export default { test: { ${literal} }, test: shared };`,
        `${inherited} export default { test: { ${literal}, get coverage() { return inherited; } } };`,
        `${inherited} const coverage = inherited; export default { test: { ${literal}, coverage } };`,
        `${inherited} const unused = { ${literal} }; export default { test: shared };`,
        `${inherited} const defineConfig = () => ({ test: shared }); export default defineConfig({ test: { ${literal} } });`,
    ])("does not certify an overridden or detached candidate: %s", before => {
        const after = before.replace(literal, literal.replace("exclude: []", 'exclude: ["src/private/**"]'));
        const effective = (source: string): string => JSON.stringify(runInNewContext(source.replace("export default", "globalThis.result =") + "result.test.coverage"));
        expect(effective(after)).toBe(effective(before));
        expect(decideVitestCoverageWaterLine("vitest.config.ts", before, after)).toEqual({ kind: "allow", warning: expect.stringContaining("unique literal") });
    });

    it("compares a transparent literal wrapped in an imported defineConfig alias", () => {
        const before = `import { defineConfig as config } from "vitest/config"; export default config(({ test: { ${literal} } } satisfies object));`;
        const after = before.replace("exclude: []", 'exclude: ["src/private/**"]');
        expect(decideVitestCoverageWaterLine("vitest.config.ts", before, after).kind).toBe("block");
    });

    it.each(['import type { defineConfig } from "vitest/config";', 'import { type defineConfig } from "vitest/config";'])("does not mistake a type-only import for a runtime wrapper: %s", declaration => {
        const before = `${declaration} ${inherited} const defineConfig = () => ({ test: shared }); export default defineConfig({ test: { ${literal} } });`;
        const after = before.replace(literal, literal.replace("exclude: []", 'exclude: ["src/private/**"]'));
        expect(decideVitestCoverageWaterLine("vitest.config.ts", before, after)).toEqual({ kind: "allow", warning: expect.stringContaining("unique literal") });
    });
});
