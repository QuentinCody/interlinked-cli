import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";

it("bundles a stable process-independent identity without a lockfile or dist directory scan", () => {
    const root = mkdtempSync(join(tmpdir(), "evidence-package-"));
    try {
        const compile = (id: string): string => buildSync({
            entryPoints: [fileURLToPath(new URL("./evidence-runtime-identity.ts", import.meta.url))],
            bundle: true, write: false, platform: "node", format: "esm",
            define: { __INTERLINKED_EVIDENCE_BUILD__: JSON.stringify(id) },
        }).outputFiles[0]!.text;
        const script = join(root, "identity.mjs");
        writeFileSync(script, compile("a".repeat(64)) + '\nconsole.log(evidenceRuntimeIdentity());');
        const run = (): string => execFileSync(process.execPath, [script], { cwd: root, encoding: "utf8" }).trim();
        const first = run();
        expect(first).toMatch(/^build:[a-f0-9]{64}$/);
        expect(run()).toBe(first);
        writeFileSync(script, compile("b".repeat(64)) + '\nconsole.log(evidenceRuntimeIdentity());');
        expect(run()).not.toBe(first);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
