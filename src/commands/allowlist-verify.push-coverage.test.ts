import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifyAllowlistCommand } from "./allowlist-verify.js";

const race = vi.hoisted(() => ({ path: "", checks: 0 }));
vi.mock("node:fs", async importOriginal => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return { ...actual, existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
        if (String(path) === race.path && ++race.checks > 1) return false;
        return actual.existsSync(path);
    } };
});

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "allowlist-push-"));
    race.path = "";
    race.checks = 0;
    process.exitCode = undefined;
});
afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(root, { recursive: true, force: true });
});

it("bounds transitive dependency diagnostics while reporting every omitted package", () => {
    const packages = Object.fromEntries(Array.from({ length: 28 }, (_, index) =>
        [`node_modules/unapproved-${index}`, { version: "1.0.0" }]));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    verifyAllowlistCommand({ cwd: root });
    const text = out.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(text.match(/ — transitive in package-lock.json:/g)).toHaveLength(25);
    expect(text).toContain("3 more unapproved transitive package(s) in package-lock.json");
    expect(text).toContain("interlinked allowlist snapshot --lockfile package-lock.json");
    expect(process.exitCode).toBe(1);
});

it("reports a lockfile that vanishes between discovery and reading as unscreened", () => {
    race.path = join(root, "package-lock.json");
    writeFileSync(race.path, JSON.stringify({ lockfileVersion: 3, packages: {} }));
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    verifyAllowlistCommand({ cwd: root });
    expect(out.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("could not parse package-lock.json — its transitive packages are NOT screened");
    expect(process.exitCode).toBe(1);
});
