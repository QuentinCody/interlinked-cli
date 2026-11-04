import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { buildAtomically } from "./build-atomic.mjs";
import { buildEntryPoints, COWORK_ENTRY_POINT, fingerprintBuildInputs } from "./build-input-fingerprint.mjs";
import { assertE2eBuild } from "./e2e-evidence.mjs";
import { copyRuntimeAssets } from "./copy-runtime-assets.mjs";

const roots = [];
const runtime = "src/nested/.interlinked/hook-runtime.json";
const put = (root, path, text = "{}\n") => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
};
const git = (root, ...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });

function fixture(withGit = true) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "build-fingerprint-")));
    roots.push(root);
    put(root, "package.json", '{"type":"module"}\n');
    put(root, "tsconfig.json");
    for (const path of [...buildEntryPoints("e2e"), COWORK_ENTRY_POINT]) put(root, path, "export const fixture = 1;\n");
    put(root, ".gitignore", "**/.interlinked/\nsrc/generated/\n");
    if (withGit) git(root, "init", "--quiet");
    return root;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("build fingerprints exclude only proven non-input runtime state", () => {
    it.each(["index.js", "harness/server.js"])("preserves source fingerprint behavior in the packaged %s layout", (entry) => {
        const root = fixture();
        const packageRoot = fileURLToPath(new URL("../", import.meta.url));
        put(root, "tsconfig.json", '{"compilerOptions":{"types":[]}}\n');
        symlinkSync(join(packageRoot, "node_modules"), join(root, "node_modules"), "dir");
        put(root, runtime);
        const expected = fingerprintBuildInputs(root);
        copyRuntimeAssets(join(root, "dist"), packageRoot);
        const output = join(root, "dist", entry);
        buildSync({ entryPoints: [fileURLToPath(new URL("./build-input-fingerprint.mjs", import.meta.url))],
            outfile: output, bundle: true, platform: "node", format: "esm", packages: "external" });
        const coverageDirectory = join(root, "raw-coverage");
        const fingerprint = () => execFileSync(process.execPath, ["--input-type=module", "--eval",
            `import { fingerprintBuildInputs } from ${JSON.stringify(pathToFileURL(output).href)}; process.stdout.write(fingerprintBuildInputs(${JSON.stringify(root)}));`],
            { encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory } });
        expect(fingerprint()).toBe(expected);
        put(root, runtime, '{"unrelated":"changed"}\n');
        expect(fingerprint()).toBe(expected);
        const coveredScripts = readdirSync(coverageDirectory).flatMap(file =>
            JSON.parse(readFileSync(join(coverageDirectory, file), "utf8")).result.map(script => script.url));
        expect(coveredScripts).toContain(pathToFileURL(output).href);
        expect(coveredScripts.some(url => url.endsWith("/e2e-declaration-inputs.mjs"))).toBe(false);
        rmSync(join(root, "dist/e2e-declaration-inputs.mjs"));
        expect(fingerprint()).not.toBe(expected);
    });

    it.each(["standard", "e2e"])("keeps %s identity stable when runtime receipts are created, rewritten or removed", (mode) => {
        const root = fixture();
        const before = fingerprintBuildInputs(root, { mode });
        for (const path of [runtime, "src/.interlinked/payload-keys.json", "src/harness/.interlinked/hook-transport.jsonl", "src/lib/.interlinked/verify-runs.jsonl"])
            put(root, path);
        expect(fingerprintBuildInputs(root, { mode })).toBe(before);
        put(root, runtime, '{"last_hook":"changed"}\n');
        expect(fingerprintBuildInputs(root, { mode })).toBe(before);
        rmSync(join(root, "src/nested/.interlinked"), { recursive: true });
        expect(fingerprintBuildInputs(root, { mode })).toBe(before);
    });

    it("retains tracked runtime-looking files even when Git ignore rules match", () => {
        const root = fixture();
        put(root, runtime);
        git(root, "add", "--force", runtime);
        const before = fingerprintBuildInputs(root);
        put(root, runtime, '{"tracked":"changed"}\n');
        expect(fingerprintBuildInputs(root)).not.toBe(before);
    });

    it.each(["src/index.ts", COWORK_ENTRY_POINT, "src/harness/agent-io/store.ts"])("retains ignored runtime JSON imported by %s", (entry) => {
        const root = fixture();
        const target = "src/.interlinked/hook-runtime.json";
        const specifier = entry === "src/harness/agent-io/store.ts" ? "../../.interlinked/hook-runtime.json" : "./.interlinked/hook-runtime.json";
        put(root, target, '{"value":1}\n');
        put(root, entry, `import data from ${JSON.stringify(specifier)}; console.log(data);\n`);
        const before = fingerprintBuildInputs(root, { mode: "e2e" });
        put(root, target, '{"value":2}\n');
        expect(fingerprintBuildInputs(root, { mode: "e2e" })).not.toBe(before);
    });

    it("follows configured import aliases instead of guessing relevance from import text", () => {
        const root = fixture();
        put(root, runtime, '{"value":1}\n');
        put(root, "tsconfig.json", '{"compilerOptions":{"baseUrl":".","paths":{"runtime-config":["./src/nested/.interlinked/hook-runtime.json"]}}}\n');
        put(root, "src/index.ts", 'import data from "runtime-config"; console.log(data);\n');
        const before = fingerprintBuildInputs(root);
        put(root, runtime, '{"value":2}\n');
        expect(fingerprintBuildInputs(root)).not.toBe(before);
    });

    it("retains declaration inputs erased from the JavaScript graph", () => {
        const root = fixture();
        put(root, runtime);
        put(root, "src/.interlinked/types.ts", "export interface PublicShape { before: string }\n");
        put(root, "src/index.ts", 'export type { PublicShape } from "./.interlinked/types.js";\n');
        const before = fingerprintBuildInputs(root);
        put(root, "src/.interlinked/types.ts", "export interface PublicShape { after: number }\n");
        expect(fingerprintBuildInputs(root)).not.toBe(before);
    });

    it("retains JSON whose shape is exported only through declarations", () => {
        const root = fixture();
        const target = "src/.interlinked/hook-runtime.json";
        put(root, target, '{"before":"value"}\n');
        put(root, "tsconfig.json", '{"compilerOptions":{"resolveJsonModule":true,"moduleResolution":"bundler","module":"esnext"}}\n');
        put(root, "src/index.ts", 'import type data from "./.interlinked/hook-runtime.json"; export type PublicShape = typeof data;\n');
        const before = fingerprintBuildInputs(root);
        put(root, target, '{"after":42}\n');
        expect(fingerprintBuildInputs(root)).not.toBe(before);
    });

    it.each(["external package declaration", "triple-slash path"])("follows %s to a JSON declaration input", (route) => {
        const root = fixture();
        const target = "src/.interlinked/public-shape.json";
        put(root, target, '{"before":"value"}\n');
        put(root, runtime);
        put(root, "tsconfig.json", '{"compilerOptions":{"resolveJsonModule":true,"moduleResolution":"bundler","module":"esnext"}}\n');
        if (route === "external package declaration") {
            put(root, "node_modules/runtime-shape/package.json", '{"name":"runtime-shape","types":"index.d.ts"}\n');
            put(root, "node_modules/runtime-shape/index.d.ts", 'import type data from "../../src/.interlinked/public-shape.json"; export type PublicShape = typeof data;\n');
            put(root, "src/index.ts", 'export type { PublicShape } from "runtime-shape";\n');
        } else {
            put(root, "types/ambient.d.ts", 'import type data from "../src/.interlinked/public-shape.json"; declare global { type PublicShape = typeof data; }\n');
            put(root, "src/index.ts", '/// <reference path="../types/ambient.d.ts" />\nexport type Public = PublicShape;\n');
        }
        const before = fingerprintBuildInputs(root);
        put(root, runtime, '{"unrelated":"changed"}\n');
        expect(fingerprintBuildInputs(root)).toBe(before);
        put(root, target, '{"after":42}\n');
        expect(fingerprintBuildInputs(root)).not.toBe(before);
    });

    it.each(["src/generated/runtime.json", "src/.interlinked-cache/data.json", "skills/fixture/.interlinked/settings.json", "src/lib/viz/web/index.html", "tsconfig.json"])("retains legitimate source, declared assets, skills and configuration: %s", (path) => {
        const root = fixture();
        put(root, runtime);
        put(root, path, "{}\n");
        const before = fingerprintBuildInputs(root);
        put(root, path, '{"version":2}\n');
        expect(fingerprintBuildInputs(root)).not.toBe(before);
    });

    it.each(["unresolved import", "missing entrypoint", "unavailable git", "custom tsup config", "package tsup config"])("retains candidate bytes when relevance is unknown: %s", (failure) => {
        const root = fixture(failure !== "unavailable git");
        put(root, runtime);
        if (failure === "unresolved import") put(root, "src/index.ts", 'import "./missing-module.js";\n');
        if (failure === "missing entrypoint") rmSync(join(root, COWORK_ENTRY_POINT));
        if (failure === "custom tsup config") put(root, "tsup.config.mjs", "export default {};\n");
        if (failure === "package tsup config") put(root, "package.json", '{"type":"module","tsup":{"noExternal":["runtime-config"]}}\n');
        const before = fingerprintBuildInputs(root);
        put(root, runtime, '{"unknown":"changed"}\n');
        expect(fingerprintBuildInputs(root)).not.toBe(before);
    });

    it("includes a custom root build recipe even without runtime candidates", () => {
        const root = fixture();
        put(root, "tsup.config.mjs", "export default {};\n");
        const before = fingerprintBuildInputs(root);
        put(root, "tsup.config.mjs", "export default { minify: true };\n");
        expect(fingerprintBuildInputs(root)).not.toBe(before);
    });

    it("still refuses symlinks inside candidate runtime directories", () => {
        const root = fixture();
        put(root, "outside.json");
        mkdirSync(dirname(join(root, runtime)), { recursive: true });
        symlinkSync(join(root, "outside.json"), join(root, runtime));
        expect(() => fingerprintBuildInputs(root)).toThrow("symbolic links");
    });

    it("keeps a measured E2E build current after a runtime-only write, but rejects a source change", () => {
        const root = fixture();
        put(root, "dist/.build-input-fingerprint", fingerprintBuildInputs(root, { mode: "e2e" }));
        put(root, runtime);
        expect(() => assertE2eBuild(root)).not.toThrow();
        put(root, "src/index.ts", "export const fixture = 2;\n");
        expect(() => assertE2eBuild(root)).toThrow("Stale");
    });

    it("publishes a frozen build when only generated runtime state changes while bundling", async () => {
        const root = fixture();
        let published = false;
        await buildAtomically({ root,
            populateStage: (_root, stage) => { put(root, runtime); put(stage, "index.js", "export {};\n"); },
            validateStage: () => {},
            publishStage: (_root, stage) => { expect(readFileSync(join(stage, "index.js"), "utf8")).toBe("export {};\n"); published = true; },
        });
        expect(published).toBe(true);
        expect(existsSync(join(root, ".build-input-scan"))).toBe(false);
    });
});
