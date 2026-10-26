import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBoundaryFile, isProductSource, LEDGER_WRITERS } from "./e2e-boundary.js";

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? sources(path) : [path];
    });
}

describe("e2e boundary inventory", () => {
    it("includes adapters, transport, templates, installers and ledger wrappers", () => {
        for (const path of ["src/harness/adapters/types.ts", "src/hook-entry-transport.ts", "src/lib/hooks-template.ts", "src/lib/hook-installers.ts", "src/lib/local-activity.ts", "src/lib/collection/writer.ts"])
            expect(isBoundaryFile(path), path).toBe(true);
        expect(isBoundaryFile("src/hook-entry.test.ts")).toBe(false);
        expect(isBoundaryFile("src/harness/server/fixtures/a.ts")).toBe(true);
        expect(isBoundaryFile("src/lib/format.ts")).toBe(false);
    });
    it("keeps Vitest setup and replay helpers outside the product boundary", () => {
        expect(isProductSource("src/test-setup/fast-check-examples.ts")).toBe(false);
        expect(isBoundaryFile("src/test-setup/fast-check-examples.ts")).toBe(false);
        expect(isProductSource("src/test-setup/home-sandbox.ts")).toBe(false);
        expect(isProductSource("src/harness/test-setup-policy.ts")).toBe(true);
    });
    it("excludes only the source-checkout Jev entry modules while retaining runtime shadow writers", () => {
        for (const path of ["src/commands/jev.ts", "src/harness/jev/internal-cli.ts"]) {
            expect(isProductSource(path), path).toBe(false);
            expect(isBoundaryFile(path), path).toBe(false);
        }
        for (const path of ["src/harness/jev/decision-shadow.ts", "src/harness/jev/edit-shadow.ts"]) {
            expect(isProductSource(path), path).toBe(true);
            expect(isBoundaryFile(path), path).toBe(true);
        }
        expect(isProductSource("src/commands/jev-plugin.ts")).toBe(true);
        expect(isProductSource("src/harness/jev/internal-cli-helper.ts")).toBe(true);
    });
    it("requires every source append writer to be explicitly inventoried", () => {
        const writers = sources("src").filter(isProductSource).filter((path) => /\b(?:appendFileSync|appendFile|appendFileWithMutationLock)\s*\(/.test(readFileSync(path, "utf8")));
        expect(writers.filter((path) => !isBoundaryFile(path))).toEqual([]);
        expect(writers).toEqual(expect.arrayContaining([...LEDGER_WRITERS]));
    });
});
