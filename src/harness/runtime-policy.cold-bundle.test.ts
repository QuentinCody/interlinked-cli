import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("MUST-FIRE/MUST-NOT-FIRE: generated cold .mjs retains opt-in Git discovery guard after bundling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "il-cold-policy-"));
    try {
        const renderer = await build({ stdin: { contents: `export { buildHookScript } from ${JSON.stringify(resolve("src/lib/hooks-template.ts"))};`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
        const rendererPath = join(dir, "renderer.mjs"); writeFileSync(rendererPath, renderer.outputFiles[0]!.text);
        const { buildHookScript } = await import(pathToFileURL(rendererPath).href);
        const script: string = buildHookScript("policy-test");
        // Execute the actual generated prefix before it reads configuration or launches a daemon.
        const prefix = script.slice(0, script.indexOf("const CWD = process.cwd();"));
        expect(prefix).toContain("local-restricted");
        expect(script).toContain("guardDecision = localRuntimePolicy.agentToolDecision(harnessEvent,");
        const cold = join(dir, "cold.mjs"); writeFileSync(cold, prefix + '\nexport const privateAgentDecision = localRuntimePolicy.agentToolDecision;');
        const probe = `import { createRequire } from 'node:module';
const cp=createRequire(import.meta.url)('node:child_process');
cp.execFileSync=()=> 'ALLOWED_SENTINEL';
const {privateAgentDecision}=await import(${JSON.stringify(pathToFileURL(cold).href)});
if(process.env.INTERLINKED_RUNTIME_POLICY==='local-restricted' && privateAgentDecision({hook_event:'PreToolUse',tool_input:{command:'cat .interlinked/config.local.json'}},true)?.decision!=='block') throw Error('MISSING_PRIVATE_GUARD');
const out=[]; for(const command of ['git','node']) { try { out.push(cp.execFileSync(command,['status'])); } catch(e) { out.push(e.message); } }
process.stdout.write(JSON.stringify(out));`;
        for (const enabled of [true, false]) {
            const env = { ...process.env }; if (enabled) env.INTERLINKED_RUNTIME_POLICY = "local-restricted"; else delete env.INTERLINKED_RUNTIME_POLICY;
            const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8", timeout: 5000 }));
            expect(result).toEqual([enabled ? "Local runtime policy: external command unavailable" : "ALLOWED_SENTINEL", "ALLOWED_SENTINEL"]);
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
