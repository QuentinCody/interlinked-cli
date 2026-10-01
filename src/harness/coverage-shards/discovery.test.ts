import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureEvidenceEnvironment } from "../../lib/metrics/evidence-environment.js";
import { captureVitestEnvironment, coverageIndexSpawn, discoverVitestTests } from "./discovery.js";

// test-contract: invariant — the supervising route's own variables (a bounded runner's per-export outcome record, lease ancestry, one run's scope file, a capacity scope) never reach the test child: they are absent from the captured environment, so the identity stays exact and equal across pushes, while a variable a test could read still separates
it("removes supervisor-only variables from the coverage child environment instead of hashing them", () => {
    const base = { PATH: "/usr/bin", HOME: "/home/dev", INTERLINKED_STAGE: "push" };
    const one = captureVitestEnvironment({ ...base, INTERLINKED_BOUNDED_OUTCOME: "/tmp/prepush-one/bounded-outcome.json", INTERLINKED_LEASE_ANCESTORS: "1,2", INTERLINKED_COVERAGE_SCOPE_FILE: "/tmp/one/scope.json", INTERLINKED_TEST_CAPACITY_SCOPE: "a" });
    const two = captureVitestEnvironment({ ...base, INTERLINKED_BOUNDED_OUTCOME: "/tmp/prepush-two/bounded-outcome.json" });
    expect(one.environmentHash).toBe(two.environmentHash);
    expect(one.environmentHash).toBe(captureVitestEnvironment(base).environmentHash);
    for (const name of ["INTERLINKED_BOUNDED_OUTCOME", "INTERLINKED_LEASE_ANCESTORS", "INTERLINKED_COVERAGE_SCOPE_FILE", "INTERLINKED_TEST_CAPACITY_SCOPE"]) expect(name in one.environment).toBe(false);
    expect(one.environment.INTERLINKED_STAGE).toBe("push");
    expect(captureVitestEnvironment({ ...base, INTERLINKED_STAGE: "cli" }).environmentHash).not.toBe(one.environmentHash);
});

// test-contract: invariant — the shell's working-directory bookkeeping (PWD/OLDPWD/INIT_CWD) is removed before hashing: two byte-identical exports of one revision live in different directories, and their index identities must be equal (review 2026-09-30); the child's own cwd is the workspace regardless
it("removes export-local working-directory variables so two exports of one revision share an identity", () => {
    const base = { PATH: "/usr/bin", HOME: "/home/dev" };
    const one = captureVitestEnvironment({ ...base, PWD: "/tmp/prepush-one/tree", OLDPWD: "/repo", INIT_CWD: "/tmp/prepush-one/tree" });
    const two = captureVitestEnvironment({ ...base, PWD: "/tmp/prepush-two/tree", OLDPWD: "/tmp/prepush-two", INIT_CWD: "/tmp/prepush-two/tree" });
    expect(one.environmentHash).toBe(two.environmentHash);
    expect(one.environmentHash).toBe(captureVitestEnvironment(base).environmentHash);
    for (const name of ["PWD", "OLDPWD", "INIT_CWD"]) expect(name in one.environment).toBe(false);
});

// test-contract: invariant — the indexed capture child is SUPERVISED like the scheduler's runner (review 2026-09-30): it receives exactly the identity environment plus this process's lease ancestry (a test that takes the host lease is not deadlocked by the run hosting it), its exit code passes through, and an interrupted child (timeout) is an error, never a failed-test status
it("spawns the capture child with the exact environment, lease ancestry and supervision", async () => {
    const root = fixture();
    const budget = { reserveBytes: 1, maxRssBytes: 4 * 1024 ** 3 };
    const spawn = coverageIndexSpawn({ PATH: process.env.PATH ?? "", ONLY: "identity" }, budget);
    const script = 'process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd() })); process.exitCode = 3;';
    const echoed = await spawn(process.execPath, ["-e", script], { cwd: root, timeout: 20_000, encoding: "utf-8" });
    expect(echoed.status).toBe(3);
    expect(echoed.error).toBeUndefined();
    // SAFETY: the child printed exactly one JSON object built from its own process.env and cwd.
    const seen = JSON.parse(echoed.stdout) as { env: Record<string, string>; cwd: string };
    expect(seen.env.ONLY).toBe("identity");
    expect(seen.env.INTERLINKED_LEASE_ANCESTORS?.split(",").map(Number)).toContain(process.pid);
    // Exact, not merged: nothing of this process's own environment leaks in (macOS adds __CF_USER_TEXT_ENCODING to every child; HOME is the tell).
    expect("HOME" in seen.env).toBe(false);
    expect(seen.cwd).toBe(root);
    const stalled = await spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { cwd: root, timeout: 300, encoding: "utf-8" });
    expect(stalled.error?.message).toContain("Coverage child interrupted");
}, 30_000);

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
