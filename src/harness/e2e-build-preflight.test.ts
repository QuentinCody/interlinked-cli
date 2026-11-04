import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertE2eReportDestination } from "../../scripts/e2e-evidence.mjs";
import { assertE2eSourceMaps } from "./e2e-build-preflight.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "e2e-build-preflight-"));
    roots.push(root);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/index.js"), "export const value = 1;\n");
    writeFileSync(join(root, "dist/index.js.map"), JSON.stringify({ version: 3, mappings: "AAAA", sources: ["../src/hook-entry.ts"] }));
    const metafile = { outputs: { ".dist-build-test/index.js": { entryPoint: "src/index.ts" } } };
    return { root, metafile };
}

describe("E2E build prerequisites", () => {
    it("locates published maps from the build's temporary output root", () => {
        const { root, metafile } = fixture();
        expect(() => assertE2eSourceMaps(root, metafile, ["src/hook-entry.ts"])).not.toThrow();
        expect(() => assertE2eSourceMaps(root, metafile, ["src/harness/server.ts"])).toThrow("absent from built bundle maps");
    });

    it("refuses missing or malformed maps before a runner can start", () => {
        const { root, metafile } = fixture();
        const path = join(root, "dist/index.js.map");
        writeFileSync(path, JSON.stringify({ version: 3, sources: [42] }));
        expect(() => assertE2eSourceMaps(root, metafile, [])).toThrow("Malformed");
        rmSync(path);
        expect(() => assertE2eSourceMaps(root, metafile, [])).toThrow();
    });

    it("refuses output paths outside the recorded build stage", () => {
        const { root, metafile } = fixture();
        expect(() => assertE2eSourceMaps(root, { outputs: {} }, [])).toThrow("entrypoint");
        expect(() => assertE2eSourceMaps(root, { outputs: { ...metafile.outputs, "../outside.js": {} } }, [])).toThrow("escapes");
    });

    it("permits a fresh report directory without creating reports", () => {
        const { root } = fixture();
        expect(() => assertE2eReportDestination(root)).not.toThrow();
        expect(() => readFileSync(join(root, "coverage-e2e/run.json"))).toThrow();
        writeFileSync(join(root, "coverage-e2e"), "not a directory");
        expect(() => assertE2eReportDestination(root)).toThrow("real directory");
    });

    it("refuses report symlinks, including dangling destinations", () => {
        const { root } = fixture();
        mkdirSync(join(root, "coverage-e2e"));
        symlinkSync(join(root, "absent.json"), join(root, "coverage-e2e/run.json"));
        expect(() => assertE2eReportDestination(root)).toThrow("regular file");
    });
});
