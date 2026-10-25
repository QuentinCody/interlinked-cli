import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { copyVitestRuntime } from "./coverage-index/__tests__/fixtures/vitest-runtime.js";
import { cpSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hashBytes } from "../lib/metrics/inventory.js";
import { nonNull } from "../lib/non-null.js";
import { testsCommand } from "../commands/tests.js";

const SCOPE_REPORTER = fileURLToPath(new URL("../../scripts/pre-push-coverage.mjs", import.meta.url));

/** A small project the copied vitest runtime can run with coverage; sources under src/ so the scope reporter records them. */
function seedProject(root: string): void {
    copyVitestRuntime(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "vitest.config.ts"), 'export default {test:{include:["src/*.test.ts"]}};');
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(root, "src", "a.test.ts"), 'import {test,expect} from "vitest"; import {a} from "./a"; test("a",()=>expect(a).toBe(1));');
}

// test-contract: regression — Vitest filters the coordinator's heap flag out of fork execArgv, while threads inherit
// its V8 limit and reject that flag in execArgv. Measure the actual worker heap without allocating it, in both pools.
it.each([
    { pool: "forks", heapArgs: ["--max-old-space-size=3072"], ceiling: 1664, nodeOptions: "" },
    { pool: "threads", heapArgs: [], ceiling: 1664, nodeOptions: "" },
    { pool: "forks", heapArgs: ["--max_old_space_size", "512"], ceiling: 640, nodeOptions: "" },
    { pool: "forks", heapArgs: [], ceiling: 640, nodeOptions: "--no-warnings --max-old-space-size=512" },
])("bounds the actual $pool worker heap ($ceiling MiB) and preserves configured arguments", async ({ pool, heapArgs, ceiling, nodeOptions }) => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "test-worker-heap-")));
    const root = join(workspace, "project"), store = join(workspace, "store");
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", join(workspace, "stages.jsonl"));
    vi.stubEnv("NODE_OPTIONS", nodeOptions);
    try {
        mkdirSync(root, { recursive: true });
        seedProject(root);
        const execArgv = ["--no-warnings", ...heapArgs];
        writeFileSync(join(root, "vitest.config.ts"), `export default ${JSON.stringify({ test: { include: ["src/*.test.ts"], pool, execArgv } })};`);
        writeFileSync(join(root, "src", "heap.test.ts"), `import { test, expect } from "vitest";
import { getHeapStatistics } from "node:v8";
test("worker heap is bounded", () => {
    expect(getHeapStatistics().heap_size_limit).toBeLessThanOrEqual(${ceiling} * 1024 ** 2);
    expect(process.execArgv).toContain("--no-warnings");
});`);
        const plan = await loadTestPlan(root, [], 120_000, true);
        const result = await executeTestPlan(plan, { root, deadline: Date.now() + 120_000, maxWorkers: 1, receiptStore: store });
        expect(result.status, result.reason + result.output).toBe("passed");
        expect(result.plan.tests.map(test => test.path).sort()).toEqual(["src/a.test.ts", "src/heap.test.ts"]);
    } finally {
        vi.unstubAllEnvs();
        rmSync(workspace, { recursive: true, force: true });
    }
}, 150_000);

// test-contract: regression — percentage flags outrank absolute limits in Node; unsupported overrides are unavailable,
// never a failed assertion or reusable pass, and no test body starts under a falsely claimed heap cap.
it("defers a percentage worker heap override before tests run", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "test-worker-percentage-")));
    const root = join(workspace, "project"), store = join(workspace, "store"), marker = join(workspace, "test-started");
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", join(workspace, "stages.jsonl"));
    try {
        mkdirSync(root, { recursive: true });
        seedProject(root);
        writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { include: ["src/*.test.ts"], execArgv: ["--max-old-space-size-percentage=50"] } };');
        writeFileSync(join(root, "src", "a.test.ts"), `import { test } from "vitest"; import { writeFileSync } from "node:fs"; test("must not start", () => writeFileSync(${JSON.stringify(marker)}, "started"));`);
        const plan = await loadTestPlan(root, [], 120_000, true);
        const result = await executeTestPlan(plan, { root, deadline: Date.now() + 120_000, maxWorkers: 1, receiptStore: store });
        expect(result).toMatchObject({ status: "deferred", reused: false, reason: expect.stringContaining("percentage") });
        expect(existsSync(marker)).toBe(false);
        expect(readdirSync(store).filter(name => name.endsWith(".json"))).toEqual([]);
    } finally {
        vi.unstubAllEnvs();
        rmSync(workspace, { recursive: true, force: true });
    }
}, 150_000);

// test-contract: invariant — every identity input is re-read after the run: an external reporter dependency rewritten between hashing and loading makes the run STALE at the executor (no receipt), so nothing certifies bytes that never executed
it("marks a run stale when a bound reporter dependency changes during execution and certifies nothing", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "reporter-revalidate-")));
    const root = join(workspace, "project"), store = join(workspace, "store");
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", join(workspace, "stages.jsonl"));
    vi.stubEnv("INTERLINKED_STAGE", "");
    try {
        mkdirSync(root, { recursive: true });
        seedProject(root);
        const helper = join(workspace, "helper.mjs"), reporter = join(workspace, "reporter.mjs");
        writeFileSync(helper, "export default function helper() { return 'before'; }\n");
        // A PURE reporter (no runtime read, so it is eligible for reuse); the test rewrites its bound helper while the run
        // is in flight — the run directory appears only after the identity was hashed over the old bytes.
        writeFileSync(reporter, 'import helper from "./helper.mjs";\nexport default class Reporter { onInit() { helper(); } }\n');
        const runDirectories = (): number => existsSync(store) ? readdirSync(store, { withFileTypes: true }).filter(entry => entry.isDirectory()).length : 0;
        // The run directory is created at launch, after the binding was hashed and before the post-run re-binding.
        const rewriteHelperOnceRunning = async (): Promise<void> => {
            const known = runDirectories(), deadline = Date.now() + 60_000;
            while (runDirectories() === known && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
            expect(runDirectories()).toBeGreaterThan(known);
            writeFileSync(helper, "export default function helper() { return 'after'; }\n");
        };
        // These cases pin the opt-in reuse path (static selection is off by default since 2026-10-06).
        const plan = await loadTestPlan(root, [], 120_000, true, { staticSelection: true });
        expect(plan.reusable).toBe(true);
        const options = { root, deadline: Date.now() + 120_000, maxWorkers: 1, coverage: { reporters: [reporter] }, receiptStore: store };
        const [first] = await Promise.all([executeTestPlan(plan, options), rewriteHelperOnceRunning()]);
        expect(first.status, first.reason + first.output).toBe("stale");
        expect(existsSync(store) ? readdirSync(store).filter(name => name.endsWith(".json") && name !== "latest.json") : []).toEqual([]);
        // The rewritten helper is a different identity: the next run is fresh, not a reuse of anything.
        const second = await executeTestPlan(await loadTestPlan(root, [], 120_000, true, { staticSelection: true }), options);
        expect(second.status, second.reason + second.output).toBe("passed");
        expect(second.reused).toBe(false);
        // Through the SCHEDULER the same event is a stale batch followed by an automatic re-run: the caller receives the
        // re-run's fresh result, the ledger shows both batches, and the receipt written binds the bytes that ran.
        writeFileSync(helper, "export default function helper() { return 'before'; }\n");
        const ledger = join(workspace, "stages.jsonl");
        const rowsBefore = existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").length : 0;
        const [scheduled] = await Promise.all([scheduleTests({ root, paths: [], full: true, timeoutMs: 120_000, maxWorkers: 1, coverage: { reporters: [reporter] }, receiptStore: store, staticSelection: true }), rewriteHelperOnceRunning()]);
        expect(scheduled.status, scheduled.reason + scheduled.output).toBe("passed");
        // The re-run's identity is the 'after' bytes, which `second` certified above — so it is a legitimate reuse of THAT run.
        expect(scheduled.reused).toBe(true);
        expect(scheduled.runId).toBe(second.runId);
        // SAFETY: the ledger is written only by recordVerificationStage, one JSON object per line.
        const rows = readFileSync(ledger, "utf8").trim().split("\n").slice(rowsBefore).map(line => JSON.parse(line) as { check: string; status: string; reuse_denied_reason?: string });
        const batches = rows.filter(row => row.check === "vitest:full");
        expect(batches.map(row => row.status)).toEqual(["stale", "passed"]);
        expect(batches[0]?.reuse_denied_reason).toBe("stale-inputs");
        expect(readFileSync(helper, "utf8")).toContain("'after'");
    } finally {
        vi.unstubAllEnvs();
        rmSync(workspace, { recursive: true, force: true });
    }
}, 240_000);

// test-contract: invariant — with static selection OFF (the default since 2026-10-06) a coverage run still validates its
// runtime before and after and binds measured sources (the commit coverage gate reads them), but certifies nothing
// reusable: a second identical run executes again
it("binds measured sources but never reuses a run when static selection is off (default)", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "coverage-default-")));
    const local = join(workspace, "local"), store = join(workspace, "store");
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", join(workspace, "stages.jsonl"));
    vi.stubEnv("INTERLINKED_STAGE", "");
    try {
        mkdirSync(local, { recursive: true });
        seedProject(local);
        // A clock read makes the result unrepeatable (never reusable) but the measured bytes are still bindable: source
        // binding depends on a runtime snapshot being available, not on reuse eligibility (review 2026-10-06).
        writeFileSync(join(local, "src", "clock.test.ts"), 'import {test,expect} from "vitest"; import {a} from "./a"; test("clock",()=>expect(Date.now()+a).toBeGreaterThan(0));');
        const request = { root: local, paths: [], full: true, timeoutMs: 120_000, maxWorkers: 1, coverage: { reporters: [] }, receiptStore: store };
        const first = await scheduleTests(request);
        expect(first.status, first.reason + first.output).toBe("passed");
        expect(Object.keys(first.artifacts ?? {}).sort()).toEqual(["coverage_sources", "coverage_summary"]);
        const second = await scheduleTests(request);
        expect(second.status, second.reason + second.output).toBe("passed");
        expect(second.reused).toBe(false);
        expect(second.runId).not.toBe(first.runId);
    } finally {
        vi.unstubAllEnvs();
        rmSync(workspace, { recursive: true, force: true });
    }
}, 300_000);

// test-contract: invariant — a FAILED execution stays failed when inputs drift during the run: drift invalidates a pass, but
// a failure is evidence a caller must see, not a retryable stale result (review 2026-10-06: a test that wrote a file and
// failed came back `stale`, so the scheduler retried instead of reporting the failure)
it("keeps a failed execution failed when the run itself changes its inputs", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "failed-drift-")));
    const root = join(workspace, "project");
    try {
        mkdirSync(root, { recursive: true });
        seedProject(root);
        writeFileSync(join(root, "src", "writer.test.ts"), 'import {test,expect} from "vitest"; import {writeFileSync} from "node:fs"; test("writes then fails",()=>{ writeFileSync("sample.txt", String(Date.now())); expect(1).toBe(2); });');
        const plan = await loadTestPlan(root, [], 120_000, true);
        const result = await executeTestPlan(plan, { root, deadline: Date.now() + 120_000, maxWorkers: 1 });
        expect(result.status, result.reason).toBe("failed");
        expect(result.reason).toMatch(/Inputs changed during execution/);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
}, 300_000);

// test-contract: invariant — a coverage run through the scheduler is keyed by its check identity: an identical export reuses the local run and its certified artifacts are exported byte-for-byte, while a run driven by an OPAQUE external reporter (the pre-push scope reporter reads the process and the file system) passes, exports its artifacts and certifies nothing reusable
it("reuses a local full coverage run from a byte-identical export and exports its verified artifacts", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "coverage-reuse-")));
    const local = join(workspace, "local"), exported = join(workspace, "export"), store = join(workspace, "store"), out = join(workspace, "out");
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", join(workspace, "stages.jsonl"));
    vi.stubEnv("INTERLINKED_STAGE", "");
    try {
        mkdirSync(local, { recursive: true });
        seedProject(local);
        // Coverage with vitest's own json-summary only: no external reporter, so the run is eligible for reuse.
        const request = { paths: [], full: true, timeoutMs: 120_000, maxWorkers: 1, coverage: { reporters: [] }, receiptStore: store, staticSelection: true };
        const first = await scheduleTests({ ...request, root: local });
        expect(first.status, first.reason + first.output).toBe("passed");
        expect(first.reused).toBe(false);
        expect(Object.keys(first.artifacts ?? {}).sort()).toEqual(["coverage_sources", "coverage_summary"]);
        for (const artifact of Object.values(first.artifacts ?? {})) expect(hashBytes(readFileSync(join(store, artifact.path)))).toBe(artifact.sha256);
        // H3c: the run binds every measured file to the exact bytes it read, so a commit gate can match staged blobs.
        const sources: { files: Record<string, { sha256: string }> } = JSON.parse(readFileSync(join(store, nonNull(first.artifacts?.coverage_sources).path), "utf8"));
        expect(Object.keys(sources.files).length).toBeGreaterThan(0);
        for (const [path, measured] of Object.entries(sources.files)) expect(measured.sha256).toBe(hashBytes(readFileSync(join(local, path))));
        // The export: the same bytes in another directory with node_modules SYMLINKED to the source checkout's, exactly as the
        // pre-push hook builds it (`git worktree add` + `ln -s`). The runtime snapshot hashes the canonical path of the mounted
        // dependency tree, so a copied node_modules would be a different runtime — the link is what makes the identity match.
        cpSync(local, exported, { recursive: true, verbatimSymlinks: true, filter: source => !source.startsWith(join(local, "node_modules")) });
        symlinkSync(join(local, "node_modules"), join(exported, "node_modules"));
        const second = await scheduleTests({ ...request, root: exported });
        expect(second.reused, second.reason + second.output).toBe(true);
        expect(second.runId).toBe(first.runId);
        expect(second.artifacts).toEqual(first.artifacts);
        // The pre-push SCOPE reporter reads the process environment and the file system, so under the eligibility rule
        // tests obey its execution is OPAQUE: the run passes and exports its artifacts, but certifies nothing reusable.
        const scoped = await scheduleTests({ ...request, root: local, coverage: { reporters: [SCOPE_REPORTER] } });
        expect(scoped.status, scoped.reason + scoped.output).toBe("passed");
        expect(scoped.reused).toBe(false);
        expect(scoped.reason).toContain("Reporter execution opaque");
        expect(Object.keys(scoped.artifacts ?? {}).sort()).toEqual(["coverage_scope", "coverage_sources", "coverage_summary"]);
        const scopedAgain = await scheduleTests({ ...request, root: exported, coverage: { reporters: [SCOPE_REPORTER] } });
        expect(scopedAgain.reused).toBe(false);
        // The CLI route the hook calls: a fresh scoped run plus verified artifact export into the consumer's directory.
        await testsCommand("run", [], { cwd: exported, all: true, coverage: true, coverageReporter: [SCOPE_REPORTER], receiptStore: store, artifactsOut: out, timeout: "120000", workers: "1", json: true });
        expect(existsSync(join(out, "coverage-summary.json"))).toBe(true);
        expect(existsSync(join(out, "scope.json"))).toBe(true);
        // Re-rooted to the consuming export: the scope names it and the summary's file keys live under it, not under `local`.
        // SAFETY: scope.json is written by scripts/pre-push-coverage.mjs's reporter with exactly {version, root, included}.
        const scope = JSON.parse(readFileSync(join(out, "scope.json"), "utf8")) as { version: number; root: string; included: Record<string, boolean> };
        expect(scope).toMatchObject({ version: 1, root: exported, included: { "src/a.ts": true } });
        expect(typeof scope.included["src/a.test.ts"]).toBe("boolean");
        // SAFETY: vitest's json-summary reporter writes an object keyed by absolute file path plus "total".
        const summary = JSON.parse(readFileSync(join(out, "coverage-summary.json"), "utf8")) as Record<string, unknown>;
        expect(summary).toHaveProperty("total");
        const fileKeys = Object.keys(summary).filter(key => key !== "total");
        expect(fileKeys).toContain(join(exported, "src", "a.ts"));
        expect(fileKeys.some(key => key.startsWith(`${local}/`))).toBe(false);
        // …and the REAL membership gate the pre-push hook runs accepts them for this export.
        // SAFETY: the module is this repository's own scripts/pre-push-coverage.mjs, whose named export has this signature.
        const gate = await import(pathToFileURL(SCOPE_REPORTER).href) as { assertCoverageMembership: (root: string, report: string, baseline: string, changed: string[], scope: string) => number };
        writeFileSync(join(out, "baseline.json"), JSON.stringify({ version: 1, updated_at: "1970-01-01T00:00:00.000Z", files: {} }));
        expect(gate.assertCoverageMembership(exported, join(out, "coverage-summary.json"), join(out, "baseline.json"), ["src/a.ts"], join(out, "scope.json"))).toBe(1);
        // A changed source byte in the export is a different identity: no reuse.
        writeFileSync(join(exported, "src", "a.ts"), "export const a = 1; // touched");
        const changed = await scheduleTests({ ...request, root: exported });
        expect(changed.reused).toBe(false);
    } finally {
        vi.unstubAllEnvs();
        rmSync(workspace, { recursive: true, force: true });
    }
}, 240_000);
import { scheduleTests } from "./test-scheduler.js";
import { loadTestPlan } from "./test-plan-inputs.js";
import { executeTestPlan } from "./test-execution.js";
import { readTestRunObservation } from "./test-run-observation.js";

// Exercise runner behavior under a controlled one-worker resource plan.
vi.mock("./resource-memory.js", () => ({ readResourceMemory: () => ({ totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 }) }));
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), loadavg: () => [0, 0, 0] }));

it("runs edited tests, reuses exact passing inputs, and invalidates an edited assertion", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "planned-tests-")));
    // The pre-push hook exports INTERLINKED_STAGES_LEDGER / INTERLINKED_STAGE; without a private ledger this run's
    // deliberate failures and reuse would land in the source checkout's real timing data.
    // Outside the fixture root: a ledger inside it would change the repository inventory between runs and defeat the reuse under test.
    const ledgerDir = mkdtempSync(join(tmpdir(), "planned-tests-ledger-"));
    const ledger = join(ledgerDir, "stages.jsonl");
    // A test-owned stand-in for the ledger a pre-push environment would hand down. Only this test knows the path, so
    // "unchanged afterwards" is deterministic — the real shared ledger may legitimately receive rows from a daemon meanwhile.
    const sentinel = join(ledgerDir, "inherited-sentinel.jsonl");
    writeFileSync(sentinel, '{"sentinel":true}\n');
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", sentinel);
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", ledger);
    vi.stubEnv("INTERLINKED_STAGE", "");
    try {
        copyVitestRuntime(root);
        writeFileSync(join(root, "package.json"), '{"type":"module"}');
        writeFileSync(join(root, "vitest.config.ts"), 'export default {test:{include:["*.test.ts"]}};');
        writeFileSync(join(root, "a.ts"), "export const a = 1;");
        writeFileSync(join(root, "a.test.ts"), 'import {test,expect} from "vitest"; import {a} from "./a"; test("a",()=>expect(a).toBe(1));');
        writeFileSync(join(root, "b.test.ts"), 'import {test,expect} from "vitest"; test("b",()=>expect(2+2).toBe(4));');
        const options = { root, paths: ["a.test.ts"], timeoutMs: 60_000, maxWorkers: 1, staticSelection: true };
        const first = await scheduleTests(options);
        expect(first.status, first.reason + first.output).toBe("passed");
        expect(first.plan.tests.map(test => test.path)).toEqual(["a.test.ts"]);
        const reused = await scheduleTests(options);
        expect(reused.reused, reused.reason + reused.output).toBe(true);
        expect(reused.runId).toBe(first.runId);
        // test-contract: invariant — a policy water-line is part of the check identity: changing coverage-baseline.json makes the same test scope a new check that must run again
        mkdirSync(join(root, ".interlinked"), { recursive: true });
        writeFileSync(join(root, ".interlinked", "coverage-baseline.json"), '{"version":1,"updated_at":"1970-01-01T00:00:00.000Z","files":{"a.ts":{"lines":100}}}');
        const policyChanged = await scheduleTests(options);
        expect(policyChanged.reused, policyChanged.reason + policyChanged.output).toBe(false);
        expect(policyChanged.status, policyChanged.reason + policyChanged.output).toBe("passed");
        expect(policyChanged.runId).not.toBe(first.runId);
        const path = join(root, "a.test.ts");
        writeFileSync(path, readFileSync(path, "utf8").replace("toBe(1)", "toBe(9)"));
        const changed = await scheduleTests(options);
        expect(changed.status, changed.reason + changed.output).toBe("failed");
        expect(changed.reused).toBe(false);
        const failedAgain = await scheduleTests(options);
        expect(failedAgain.runId).not.toBe(changed.runId);
        expect(failedAgain.status).toBe("failed");
        expect(readTestRunObservation(root)?.status).toBe("failed");
        const plan = await loadTestPlan(root, ["a.test.ts"], 60_000, false, { staticSelection: true });
        writeFileSync(join(root, ".env"), "MODE=changed-since-planning");
        const stale = await executeTestPlan(plan, { root, deadline: Date.now() + 60_000 });
        expect(stale.status).toBe("stale");
        expect(stale.reason).toBe("Runtime changed since planning");
        // test-contract: invariant — this run's rows (fresh, reused, failed, stale) went to the private ledger, and an inherited ledger is untouched
        // SAFETY: the private ledger is written only by recordVerificationStage, one VerificationStageRow per line.
        const rows = readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line) as { stage: string; reused: boolean; status: string });
        expect(rows.every(row => row.stage === "cli")).toBe(true);
        expect(rows.some(row => row.reused)).toBe(true);
        expect(rows.filter(row => row.status === "failed").length).toBeGreaterThanOrEqual(2);
        expect(readFileSync(sentinel, "utf8")).toBe('{"sentinel":true}\n');
    } finally {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
        rmSync(ledgerDir, { recursive: true, force: true });
    }
}, 120_000);
