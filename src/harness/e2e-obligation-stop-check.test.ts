// Plan 31 §15: the Interlinked-only boundary reminder is confined to the Interlinked checkout (package name
// `interlinked-cli`). A host repository never sees it; its only e2e obligation is its project policy.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatE2eObligationWarning } from "./e2e-obligation-stop-check.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function checkout(name: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "e2e-obligation-"));
    dirs.push(dir);
    if (name !== null) writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
    return dir;
}
const files = (cwd: string) => new Set([join(cwd, "src/hook-entry.ts")]);

describe("session e2e obligation — positive (must fire)", () => {
    it("warns for a boundary edit in the Interlinked checkout despite unit or base test evidence", () => {
        const cwd = checkout("interlinked-cli");
        expect(formatE2eObligationWarning({ cwd, files: files(cwd), lanes: ["unit", "base"] })).toContain("npm run test:e2e");
    });
});
describe("session e2e obligation — negative (must not fire)", () => {
    it("credits only the current session's lane evidence", () => {
        const cwd = checkout("interlinked-cli");
        expect(formatE2eObligationWarning({ cwd, files: files(cwd), lanes: ["e2e"] })).toBeNull();
    });
    it("does not warn for ordinary files or tests", () => {
        const cwd = checkout("interlinked-cli");
        expect(formatE2eObligationWarning({ cwd, files: ["src/lib/format.ts", "src/hook-entry.test.ts"], lanes: ["unit"] })).toBeNull();
    });
    it("is silent in a host repository, even one whose paths happen to match the boundary list, and in a directory without a manifest", () => {
        const host = checkout("some-app");
        expect(formatE2eObligationWarning({ cwd: host, files: files(host), lanes: ["unit"] })).toBeNull();
        const bare = checkout(null);
        expect(formatE2eObligationWarning({ cwd: bare, files: files(bare), lanes: ["unit"] })).toBeNull();
    });
});
