import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { packageCoworkPlugin } from "./package.js";
import { DEFAULT_COWORK_POLICY } from "./policy.js";
import { digest } from "./receipts.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(source: string) {
    const root = mkdtempSync(join(tmpdir(), "cowork-package-")); roots.push(root);
    const runtime = join(root, "runtime.js"); writeFileSync(runtime, source);
    return packageCoworkPlugin({ output: root, runtime, policy: DEFAULT_COWORK_POLICY });
}
function invoke(directory: string, input = "{}") {
    return spawnSync("sh", [join(directory, "scripts/cowork-hook.sh"), "PreToolUse"], { input, encoding: "utf8", timeout: 16000 });
}
describe("portable Cowork plugin archive and launcher", () => {
    it("packages only explicit assets and preserves standard input", () => {
        const result = fixture('for await (const part of process.stdin) process.stdout.write(part);');
        const entries = execFileSync("unzip", ["-Z1", result.archive], { encoding: "utf8" }).trim().split("\n");
        expect(entries.sort()).toEqual([...result.files].sort());
        expect(result.sha256).toBe(digest(readFileSync(result.archive)));
        expect(invoke(result.directory, '{"synthetic":true}').stdout).toBe('{"synthetic":true}');
        expect(() => packageCoworkPlugin({ output: join(result.directory, ".."), runtime: "unused", policy: DEFAULT_COWORK_POLICY })).toThrow("already exists");
    });
    it.each(['process.exit(1);', 'invalid syntax here', 'process.stdout.write("partial"); process.exit(2);'])("converts failed runtime output to a single explicit veto", source => {
        const result = invoke(fixture(source).directory);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
        expect(result.stdout).not.toContain("partial");
    });
    it("emits a veto before the native deadline for a hung runtime", () => {
        const started = Date.now();
        const result = invoke(fixture('setInterval(() => {}, 1000);').directory);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
        expect(Date.now() - started).toBeLessThan(15000);
    }, 20000);
    it("denies when Node cannot be found", () => {
        const packaged = fixture('process.exit(0);');
        const result = spawnSync("/bin/sh", [join(packaged.directory, "scripts/cowork-hook.sh"), "PreToolUse"], { input: "{}", encoding: "utf8", env: { ...process.env, PATH: "/nonexistent-interlinked-synthetic-path" } });
        expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
        expect(result.status).toBe(0);
    });
});
