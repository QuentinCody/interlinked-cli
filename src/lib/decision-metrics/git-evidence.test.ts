import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collectChange, resolveRevision } from "./git-evidence.js";

it("extracts a real git change without checking out or mutating the repository", () => {
    const root = mkdtempSync(join(tmpdir(), "decision-git-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    try {
        git("init", "-q");
        git("config", "user.name", "Fixture");
        git("config", "user.email", "fixture@example.test");
        writeFileSync(join(root, "a.ts"), "export function value() { return 1; }\n");
        git("add", ".");
        git("commit", "-qm", "initial");
        const base = resolveRevision(root, "HEAD");
        writeFileSync(join(root, "a.ts"), "export function value() { return 2; }\n");
        const rows = collectChange(root, { base, files: ["a.ts"] });
        expect(
            rows.some((row) => row.evidence.body === "export function value() { return 2; }"),
        ).toBe(true);
        expect(resolveRevision(root, "HEAD")).toBe(base);
        writeFileSync(join(root, "new.ts"), "export function added() { return true; }\n");
        expect(
            collectChange(root, { base }).some(
                (row) => row.file === "new.ts" && row.unit === "function",
            ),
        ).toBe(true);
        expect(() => resolveRevision(root, "--help")).toThrow();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
