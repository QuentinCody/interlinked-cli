import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureEvidenceEnvironment } from "../../lib/metrics/evidence-environment.js";
import { discoverVitestTests } from "./discovery.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "index-discovery-"))); roots.push(root);
    symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    return root;
}
it("uses native include/exclude and includeSource without counting or executing setup/helpers", async () => {
    const root = fixture(); mkdirSync(join(root, "__tests__"));
    writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { include: ["__tests__/*.test.ts"], exclude: ["**/excluded.test.ts"], includeSource: ["inline.ts"], setupFiles: ["./setup.ts"] } };');
    writeFileSync(join(root, "setup.ts"), 'throw new Error("setup must not run during file discovery");');
    writeFileSync(join(root, "__tests__/helper.ts"), 'export const value = 1;');
    writeFileSync(join(root, "__tests__/actual.test.ts"), 'import { writeFileSync } from "node:fs"; writeFileSync("executed", "yes");');
    writeFileSync(join(root, "__tests__/excluded.test.ts"), 'import { test } from "vitest"; test("excluded", () => {});');
    writeFileSync(join(root, "inline.ts"), 'export const value = 1; if (import.meta.vitest) { const { test } = import.meta.vitest; test("inline", () => {}); }');
    expect(await discoverVitestTests(root, Date.now() + 20_000, captureEvidenceEnvironment().environment)).toEqual(["__tests__/actual.test.ts", "inline.ts"]);
    expect(existsSync(join(root, "executed"))).toBe(false);
}, 30_000);
it("refuses configured typecheck specifications instead of certifying an execution universe", async () => {
    const root = fixture();
    writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { typecheck: { enabled: true }, include: ["*.test.ts"] } };');
    writeFileSync(join(root, "a.test.ts"), 'import { test } from "vitest"; test("a", () => {});');
    await expect(discoverVitestTests(root, Date.now() + 20_000, captureEvidenceEnvironment().environment)).rejects.toThrow("typecheck");
}, 30_000);
it("loads config with Vitest runtime defaults even when the calling shell has none", async () => {
    const root = fixture();
    writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { include: process.env.VITEST === "true" && process.env.TEST === "true" && process.env.NODE_ENV === "test" ? ["real.test.ts"] : ["helper.test.ts"] } };');
    for (const name of ["real", "helper"]) writeFileSync(join(root, `${name}.test.ts`), 'import { test } from "vitest"; test("works", () => {});');
    const environment = captureEvidenceEnvironment().environment;
    delete environment.VITEST; delete environment.TEST; delete environment.NODE_ENV;
    expect(await discoverVitestTests(root, Date.now() + 20_000, environment)).toEqual(["real.test.ts"]);
}, 30_000);
it.each(["commonjs", "mixed"])("preserves native bundled %s configuration semantics", async mode => {
    const root = fixture();
    writeFileSync(join(root, "config-input.cjs"), 'module.exports = { include: ["real.test.ts"] };');
    if (mode === "commonjs") writeFileSync(join(root, "vitest.config.cjs"), 'module.exports = { test: require("./config-input.cjs") };');
    else writeFileSync(join(root, "vitest.config.ts"), 'import input from "./config-input.cjs"; export default { test: input };');
    writeFileSync(join(root, "real.test.ts"), 'import { test } from "vitest"; test("works", () => {});');
    expect(await discoverVitestTests(root, Date.now() + 20_000, captureEvidenceEnvironment().environment)).toEqual(["real.test.ts"]);
}, 30_000);
