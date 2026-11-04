import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("retains the explicit local policy in a sideEffects=false bundle without making a network request", async () => {
    const root = mkdtempSync(join(tmpdir(), "il-policy-bundle-"));
    try {
        const policy = resolve("src/harness/runtime-policy.ts");
        const result = await build({ stdin: { contents: `import { ensureLocalRuntimePolicy } from ${JSON.stringify(policy)}; ensureLocalRuntimePolicy();`,
            resolveDir: process.cwd(), sourcefile: "probe.ts", loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
        const path = join(root, "bundle.mjs"); writeFileSync(path, result.outputFiles[0]!.text);
        const probe = `globalThis.fetch = async () => { throw new Error("UNRESTRICTED_SENTINEL"); };
            await import(${JSON.stringify(pathToFileURL(path).href)});
            try { await globalThis.fetch("https://example.invalid"); } catch (error) { process.stdout.write(error.message); }`;
        const output = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
            encoding: "utf8", timeout: 5000, env: { ...process.env, INTERLINKED_RUNTIME_POLICY: "local-restricted" } });
        expect(output).toBe("Local runtime policy: network unavailable");
    } finally { rmSync(root, { recursive: true, force: true }); }
});


it("MUST-FIRE/MUST-NOT-FIRE: named daemon policy blocks Git discovery while allowing ordinary node execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "il-daemon-policy-"));
    try {
        const result = await build({ stdin: { contents: `import { ensureLocalRuntimePolicy } from ${JSON.stringify(resolve("src/harness/runtime-policy.ts"))}; ensureLocalRuntimePolicy();`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
        const path = join(root, "daemon-policy.mjs"); writeFileSync(path, result.outputFiles[0]!.text);
        const probe = `import {createRequire} from 'node:module'; const cp=createRequire(import.meta.url)('node:child_process');
            cp.execFileSync=()=> 'ALLOWED_SENTINEL'; await import(${JSON.stringify(pathToFileURL(path).href)});
            const results=[]; for (const command of ['git','node']) { try { results.push(cp.execFileSync(command,['status'])); } catch (error) { results.push(error.message); } } process.stdout.write(JSON.stringify(results));`;
        const output = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", timeout: 5000, env: { ...process.env, INTERLINKED_RUNTIME_POLICY: "local-restricted" } });
        expect(JSON.parse(output)).toEqual(["Local runtime policy: external command unavailable", "ALLOWED_SENTINEL"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

// No scanner is executed here: exercise the bundled command policy at its boundary.
it("permits only the daemon's offline redacted Gitleaks invocation", async () => {
    const { restrictedCommand } = await import("./runtime-policy.js");
    const scan = ["detect", "--no-git", "--no-banner", "--redact", "--report-format", "json", "--report-path", "/dev/stdout", "--source", "."];
    expect(restrictedCommand("/opt/bin/gitleaks", ["version"])).toBe(false);
    expect(restrictedCommand("gitleaks", scan)).toBe(false);
    expect(restrictedCommand("gitleaks", scan.filter(arg => arg !== "--redact"))).toBe(true);
    expect(restrictedCommand("gitleaks", ["git"])).toBe(true);
    expect(restrictedCommand("sh", ["-c", scan.join(" ").replace(/^detect/, "gitleaks detect")])).toBe(true);
    expect(restrictedCommand("gitleaks", [...scan, "--config", "https://example.invalid/config"])).toBe(true);
});
