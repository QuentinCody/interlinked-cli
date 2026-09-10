import { existsSync, readdirSync } from "node:fs";
import { parse, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkProjectSetup } from "./project-setup.js";

vi.mock("node:fs", async importOriginal => ({
    ...await importOriginal<typeof import("node:fs")>(),
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
}));

describe("project setup at a filesystem root", () => {
    it("terminates ancestor discovery at the root and leaves an empty non-TypeScript directory clean", () => {
        const root = parse(process.cwd()).root;
        expect(checkProjectSetup(root)).toEqual([]);
        expect(vi.mocked(existsSync).mock.calls.filter(([path]) => path === resolve(root, "tsconfig.json"))).toHaveLength(1);
        expect(readdirSync).toHaveBeenCalledWith(root, { withFileTypes: true });
    });
});
