import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Public API wrapper keeps cache output inside the caller-owned capture directory. */
export function indexedVitestCommand(root: string, capture: string, selected: string[] = []): string[] {
    const module = pathToFileURL(createRequire(join(root, "package.json")).resolve("vitest/node")).href;
    const options = { root, watch: false, run: true, cache: false, coverage: { enabled: true, provider: "custom",
        customProviderModule: join(capture, "capture-provider.mjs"), reporter: ["json"], reportOnFailure: true, reportsDirectory: join(capture, "coverage") } };
    const script = `import { startVitest } from ${JSON.stringify(module)};
const ctx = await startVitest("test", ${JSON.stringify(selected)}, ${JSON.stringify(options)}, { cacheDir: ${JSON.stringify(join(capture, "vite"))} });
if (ctx) await ctx.close(); else process.exitCode = 1;
`;
    return [process.execPath, "--input-type=module", "--eval", script];
}
