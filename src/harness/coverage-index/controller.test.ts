import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoverageRunResult } from "../coverage-runner.js";
import type { CoverageIndexContext } from "./context.js";
import type { CoverageIndexManifest } from "./types.js";

// Real store, staging, aggregation, stability and capture parsing run against a temporary tree; only the vitest
// child process, the runtime-snapshot verifier and per-shard dependency hashing are replaced.
interface CaptureSpec { tests: string[]; passed?: boolean; hits?: number; finalHits?: number; ok?: boolean; error?: string; degraded?: string | null }
type CaptureOptions = { captureDir: string; selectedTests?: string[]; maxWorkers?: number };
let captureImpl: (options: CaptureOptions) => Promise<unknown> = async () => ({});
vi.mock("../coverage-shards/vitest.js", async importOriginal => ({ ...await importOriginal<typeof import("../coverage-shards/vitest.js")>(), captureVitestShards: (options: CaptureOptions) => captureImpl(options) }));
const verifyIndexRuntime = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("./runtime-context.js", async importOriginal => ({ ...await importOriginal<typeof import("./runtime-context.js")>(), verifyIndexRuntime: (...args: unknown[]) => verifyIndexRuntime(...args) }));
vi.mock("./staged-state.js", async importOriginal => ({ ...await importOriginal<typeof import("./staged-state.js")>(), promoteMatchingProposal: async () => false }));
vi.mock("./context.js", async importOriginal => ({ ...await importOriginal<typeof import("./context.js")>(),
    dependencyHashes: (context: CoverageIndexContext, tests: string[]) => Object.fromEntries(context.inventory.files.filter(file => tests.includes(file.path)).map(file => [file.path, file.sha256])) }));

const { runIndexedCoverage, coverageIndexStatus } = await import("./controller.js");
const { indexStore } = await import("./staged-state.js");
const { promoteManifest, readAcceptedManifest } = await import("./store.js");
const { checkIndexStability } = await import("./stability.js");
const { hashBytes } = await import("../../lib/metrics/inventory.js");

const VALIDITY = { runnerId: "vitest-exact-v1", runnerVersion: "1", coverageEngine: "engine", coverageConfigHash: "c", testDiscoveryHash: "t", dependencyGraphVersion: "g", environmentHash: "e", shardBoundary: "file" as const };
const FAR_FUTURE = 4_000_000_000_000;
const BUDGET = { reserveBytes: 1, maxRssBytes: 2 };
const SOURCE = "export const a = 1;\n";
const roots: string[] = [];
beforeEach(() => { verifyIndexRuntime.mockClear(); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "controller-unit-")));
    roots.push(root);
    return root;
}
/** Writes `contents` under `root` and describes them as the measured inventory (a.ts is product, *.test.ts are tests). */
function contextFor(root: string, contents: Record<string, string>, overrides: { fingerprint?: string } = {}): CoverageIndexContext {
    mkdirSync(join(root, "src"), { recursive: true });
    const files = Object.entries(contents).map(([path, content]) => { writeFileSync(join(root, path), content); return { path, role: path.endsWith(".test.ts") ? "test" : "product", sha256: hashBytes(content) }; });
    // SAFETY: the controller reads only inventory, storeRoot, validity, fingerprint, testFiles and runtime.deadline/environment; the rest of the context is never touched here.
    return { inventory: { root, files, gaps: [], issues: [] }, storeRoot: root, validity: VALIDITY, fingerprint: overrides.fingerprint ?? "fp",
        testFiles: files.filter(file => file.role === "test").map(file => file.path), runtime: { deadline: FAR_FUTURE, environment: {} } } as unknown as CoverageIndexContext;
}
const TESTS = { "src/a.ts": SOURCE, "src/z.ts": "export const z = 1;\n", "src/a.test.ts": "test('a', () => {});\n", "src/b.test.ts": "test('b', () => {});\n" };
function istanbulFor(root: string, hits: number): Record<string, unknown> {
    const file = (name: string) => { const path = join(root, name); return [path, { path, statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 19 } } }, s: { 0: hits }, fnMap: {}, f: {}, branchMap: {}, b: {} }]; };
    return Object.fromEntries([file("src/z.ts"), file("src/a.ts")]);
}
function capturing(root: string, spec: CaptureSpec): void {
    captureImpl = async options => {
        mkdirSync(join(options.captureDir, "shards"), { recursive: true });
        mkdirSync(join(options.captureDir, "coverage"), { recursive: true });
        spec.tests.forEach((test, index) => writeFileSync(join(options.captureDir, "shards", `${index}.json`),
            JSON.stringify({ version: 1, testFiles: [join(root, test)], environment: "node", durationMs: 5, passed: spec.passed ?? true, istanbul: istanbulFor(root, spec.hits ?? 1) })));
        writeFileSync(join(options.captureDir, "coverage", "coverage-final.json"), JSON.stringify(istanbulFor(root, spec.finalHits ?? spec.hits ?? 1)));
        const runResult: CoverageRunResult = { ok: spec.ok ?? true, testsPassed: spec.ok === false ? null : true, suiteMs: 1, perFile: new Map(), ...(spec.error ? { error: spec.error } : {}) };
        return { runResult, shards: [], degraded: spec.degraded ?? null, argv: ["vitest", "run"] };
    };
}
function run(context: CoverageIndexContext, extra: { full?: boolean; maxWorkers?: number } = {}): ReturnType<typeof runIndexedCoverage> {
    return runIndexedCoverage({ context, workspace: context.inventory.root, timeoutMs: 60_000, resourceBudget: BUDGET, ...extra });
}
/** Promotes the newest pending proposal to the accepted manifest, the way a successful lazy reconciliation would. */
function accept(context: CoverageIndexContext, edit: (manifest: CoverageIndexManifest) => CoverageIndexManifest = manifest => manifest): CoverageIndexManifest {
    const store = indexStore(context.storeRoot), pending = join(store, "pending");
    const proposals = readdirSync(pending).flatMap(name => readAcceptedManifest(join(pending, name)) ?? []).sort((left, right) => left.generation - right.generation);
    const manifest = edit(proposals[proposals.length - 1]!);
    expect(promoteManifest(store, manifest, manifest.generation === 1 ? null : manifest.generation - 1)).toBe(true);
    rmSync(pending, { recursive: true, force: true });
    return manifest;
}
async function establish(root: string): Promise<CoverageIndexContext> {
    const context = contextFor(root, TESTS);
    capturing(root, { tests: ["src/a.test.ts", "src/b.test.ts"] });
    expect(await run(context, { full: true })).toMatchObject({ indexed: true });
    accept(context);
    return context;
}

describe("runIndexedCoverage — positive (must fire)", () => {
    // test-contract: public-api — a full capture is certified when every shard passed, the test universe matches discovery and the per-shard aggregate equals the full report: it yields per-file coverage, per-dimension metrics, the evidence artifact and one pending proposal
    it("P1: certifies a full capture and stages a proposal", async () => {
        const root = workspace(), context = contextFor(root, TESTS);
        capturing(root, { tests: ["src/a.test.ts", "src/b.test.ts"] });
        const outcome = await run(context, { full: true, maxWorkers: 1 });
        expect(outcome).toMatchObject({ indexed: true, reason: null, selectedTests: undefined, artifact: { argv: ["vitest", "run"], root } });
        expect([...outcome.result.perFile.keys()]).toEqual(["src/a.ts", "src/z.ts"]);
        expect(outcome.metrics?.get("src/a.ts")).toMatchObject({ lines: { covered: 1, total: 1 }, statements: { covered: 1, total: 1 } });
        expect(readdirSync(join(indexStore(root), "pending"))).toHaveLength(1);
        expect(readdirSync(root).some(name => name.startsWith(".interlinked-coverage-capture-"))).toBe(false);
    });
    // test-contract: invariant — with an accepted index and nothing changed the run re-executes NO test: the aggregate is the retained shards plus the accepted denominators
    it("P2: an unchanged tree re-runs nothing and reports the accepted aggregate", async () => {
        const root = workspace(), context = await establish(root);
        captureImpl = async () => { throw new Error("must not capture"); };
        const outcome = await run(context);
        expect(outcome).toMatchObject({ indexed: true, selectedTests: [], reason: null, result: { ok: true, testsPassed: true, suiteMs: 0 } });
        expect(outcome.metrics?.get("src/a.ts")?.lines).toMatchObject({ covered: 1, total: 1 });
    });
    // test-contract: invariant — an incremental run re-executes only the shards whose recorded dependencies changed, folds the retained shards from their blobs and passes the selection and worker cap to the capture
    it("P3: re-runs only the shard whose inputs changed", async () => {
        const root = workspace(), accepted = await establish(root);
        const changed = contextFor(root, { ...TESTS, "src/b.test.ts": "test('b', () => { /* edited */ });\n" });
        let seen: CaptureOptions | undefined;
        capturing(root, { tests: ["src/b.test.ts"] });
        const inner = captureImpl;
        captureImpl = async options => { seen = options; return inner(options); };
        const outcome = await run(changed, { maxWorkers: 2 });
        expect(accepted.storeRoot).toBe(changed.storeRoot);
        expect(outcome).toMatchObject({ indexed: true, selectedTests: ["src/b.test.ts"] });
        expect(seen).toMatchObject({ selectedTests: ["src/b.test.ts"], maxWorkers: 2 });
        expect(outcome.metrics?.get("src/a.ts")?.lines.covered).toBe(1);
    });
    // test-contract: boundary — an accepted index built for another fingerprint with no changed shard cannot be reused: the run falls back to a full capture
    it("P4: a fingerprint mismatch with unchanged shards forces a full capture", async () => {
        const root = workspace();
        await establish(root);
        const moved = contextFor(root, TESTS, { fingerprint: "another-fingerprint" });
        capturing(root, { tests: ["src/a.test.ts", "src/b.test.ts"] });
        expect(await run(moved)).toMatchObject({ indexed: true, selectedTests: undefined });
    });
});

describe("runIndexedCoverage — negative (must not fire)", () => {
    // test-contract: invariant — an index quarantined for unstable coverage refuses incremental use; a full run is still ATTEMPTED (it is the way out) but stays unindexed until three full runs agree
    it("N1: a quarantined index refuses an incremental run", async () => {
        const root = workspace(), context = await establish(root);
        checkIndexStability(root, { fingerprint: "fp", signature: "one", priorSignature: null });
        expect(() => checkIndexStability(root, { fingerprint: "fp", signature: "two", priorSignature: "one" })).toThrow("quarantined");
        await expect(run(context)).rejects.toThrow("Coverage index quarantined; run metrics coverage warm to establish stability");
        capturing(root, { tests: ["src/a.test.ts", "src/b.test.ts"] });
        expect(await run(context, { full: true })).toMatchObject({ indexed: false, reason: "Coverage changed under identical inputs; index quarantined until three full warm runs agree" });
    });
    // test-contract: invariant — a quarantined or never-passed accepted shard cannot be reused incrementally: the caller must warm the index again
    it("N2: refuses to reuse an unstable accepted shard", async () => {
        const root = workspace(), context = contextFor(root, TESTS);
        capturing(root, { tests: ["src/a.test.ts", "src/b.test.ts"] });
        await run(context, { full: true });
        accept(context, manifest => ({ ...manifest, shards: { ...manifest.shards, "src/a.test.ts": { ...manifest.shards["src/a.test.ts"]!, instability: { events: [], consecutiveStableRuns: 0, quarantined: true } } } }));
        await expect(run(context)).rejects.toThrow("Unstable or incomplete shard requires a full warm run");
    });
    // test-contract: invariant — a capture whose tests differ from the discovered universe is NOT indexed: the reason says so and no proposal is staged
    it("N3: refuses a capture that misses a discovered test", async () => {
        const root = workspace(), context = contextFor(root, TESTS);
        capturing(root, { tests: ["src/a.test.ts"] });
        expect(await run(context, { full: true })).toMatchObject({ indexed: false, reason: "Captured test universe differs from discovered/selected tests" });
        expect(readdirSync(indexStore(root)).includes("pending")).toBe(false);
    });
    // test-contract: invariant — a runner that rewrote a measured input invalidates the whole capture, naming the file
    it("N4: refuses when the run changed a measured input", async () => {
        const root = workspace(), context = contextFor(root, TESTS);
        capturing(root, { tests: ["src/a.test.ts", "src/b.test.ts"] });
        const inner = captureImpl;
        captureImpl = async options => { writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n"); return inner(options); };
        expect(await run(context, { full: true })).toMatchObject({ indexed: false, reason: "Runner changed measured input: src/a.ts" });
    });
    // test-contract: invariant — per-shard evidence that disagrees with the full coverage report is refused: a line a shard claims covered but the full run left uncovered is never accepted
    it("N5: refuses an aggregate that differs from the full report", async () => {
        const root = workspace(), context = contextFor(root, TESTS);
        capturing(root, { tests: ["src/a.test.ts", "src/b.test.ts"], hits: 1, finalHits: 0 });
        expect(await run(context, { full: true })).toMatchObject({ indexed: false, reason: "Per-shard aggregate differs from the full coverage report" });
    });
    // test-contract: bug — a failed capture names its cause: the runner's degradation first, then its error, then the failing shard files, and only then the bare verdict
    it("N6: explains why a failed capture is not indexed", async () => {
        const root = workspace(), context = contextFor(root, TESTS);
        capturing(root, { tests: ["src/a.test.ts"], ok: false, degraded: "capture degraded (unreadable marker)" });
        expect(await run(context, { full: true })).toMatchObject({ indexed: false, reason: "capture degraded (unreadable marker)" });
        capturing(root, { tests: ["src/a.test.ts"], ok: false, error: "vitest exited 1" });
        expect(await run(context, { full: true })).toMatchObject({ indexed: false, reason: "vitest exited 1" });
        capturing(root, { tests: ["src/a.test.ts", "src/b.test.ts"], ok: false, passed: false });
        expect(await run(context, { full: true })).toMatchObject({ indexed: false, reason: "Tests did not pass: src/a.test.ts, src/b.test.ts" });
        capturing(root, { tests: [], ok: false });
        expect(await run(context, { full: true })).toMatchObject({ indexed: false, reason: "Tests did not pass" });
    });
    // test-contract: boundary — a validation failure that is not an Error object still degrades to an unindexed result with a stable reason
    it("N7: a non-Error validation failure gets the generic reason", async () => {
        const root = workspace(), context = contextFor(root, TESTS);
        capturing(root, { tests: ["src/a.test.ts", "src/b.test.ts"] });
        verifyIndexRuntime.mockResolvedValueOnce(undefined).mockRejectedValueOnce("runtime changed");
        expect(await run(context, { full: true })).toMatchObject({ indexed: false, reason: "Index validation failed" });
    });
});

describe("coverageIndexStatus", () => {
    // test-contract: public-api — no accepted manifest is reported as absent; an accepted, unchanged one as present and valid with its generation and shard count
    it("P1: reports absent and then valid", async () => {
        const root = workspace(), context = contextFor(root, TESTS);
        expect(await coverageIndexStatus(context)).toEqual({ present: false, generation: null, valid: false, reasons: ["No accepted index"], shards: 0, changedShards: 0 });
        capturing(root, { tests: ["src/a.test.ts", "src/b.test.ts"] });
        await run(context, { full: true });
        accept(context);
        expect(await coverageIndexStatus(context)).toEqual({ present: true, generation: 1, valid: true, reasons: [], shards: 2, changedShards: 0 });
    });
    // test-contract: invariant — a shard whose dependency changed, or an index quarantined for this fingerprint, makes the index invalid with each cause named
    it("N1: names stale shards and quarantine", async () => {
        const root = workspace(), accepted = await establish(root);
        const changed = contextFor(root, { ...TESTS, "src/b.test.ts": "test('b', () => { /* edited */ });\n" });
        expect(await coverageIndexStatus(changed)).toMatchObject({ valid: false, changedShards: 1, reasons: ["1 stale test shards"] });
        checkIndexStability(root, { fingerprint: "fp", signature: "one", priorSignature: null });
        expect(() => checkIndexStability(root, { fingerprint: "fp", signature: "two", priorSignature: "one" })).toThrow("quarantined");
        expect(await coverageIndexStatus(accepted)).toMatchObject({ valid: false, changedShards: 0, reasons: ["Index quarantined for unstable coverage"] });
    });
});
