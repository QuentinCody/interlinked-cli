import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

/** Load the same source preflight from Node's script lane without a persistent generated artifact. */
export async function preflightE2e(root, options = {}) {
    const result = await build({ absWorkingDir: root, entryPoints: ["src/harness/e2e-preflight.ts"], bundle: true,
        write: false, platform: "node", format: "esm", packages: "external",
        // This runtime resolves its own compiler helper relative to import.meta.url.
        // Keep its real file identity instead of substituting the preflight entrypoint.
        plugins: [{ name: "preflight-script-runtime", setup(build) {
            build.onResolve({ filter: /(?:^|\/)e2e-evidence\.mjs$/ }, () => ({
                path: pathToFileURL(join(root, "scripts/e2e-evidence.mjs")).href, external: true,
            }));
        } }],
        define: { "import.meta.url": JSON.stringify(pathToFileURL(join(root, "src/harness/e2e-preflight.ts")).href) } });
    const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
    return module.preflightE2eRun(root, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const { values } = parseArgs({ options: { base: { type: "string" } } });
    const result = await preflightE2e(realpathSync(process.cwd()), { base: values.base });
    process.stdout.write(`E2e prerequisites passed for ${result.inventory.length} boundary files; coverage remains unmeasured.\n`);
}
