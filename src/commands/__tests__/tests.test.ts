import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { formatTestPlan, testsCommand } from "../tests.js";
import { scheduleTests } from "../../harness/test-scheduler.js";
import { hashBytes } from "../../lib/metrics/inventory.js";
import type { RunArtifacts } from "../../harness/test-run-receipt.js";

vi.mock("../../harness/test-scheduler.js", () => ({ scheduleTests: vi.fn() }));
vi.mock("../../lib/output.js", () => ({ getOutputMode: () => "json", output: vi.fn(), outputError: (message: string) => { throw new Error(message); } }));
afterEach(() => { vi.clearAllMocks(); });

it("explains selected tests, unknown cost, and conditional reuse without claiming a pass", () => {
    const text = formatTestPlan({ version: 1, snapshot: "abc", changedPaths: ["a.ts"], mode: "selected",
        tests: [{ path: "a.test.ts", reasons: ["Transitive dependency changed: a.ts"], durationMs: null }], omitted: ["b.test.ts"], reasons: [], estimatedSerialMs: null, reusable: true });
    expect(text).toContain("1 test files; 1 omitted; estimated serial time unmeasured");
    expect(text).toContain("eligible after runtime validation");
    expect(text).toContain("a.test.ts: Transitive dependency changed: a.ts");
});

// test-contract: invariant — a reused coverage summary belongs to its producing checkout even without a scope reporter; export relocates JSON paths without interpreting quotes, backslashes or replacement tokens.
it.each([false, true])("exports reused coverage with scope=%s and JSON-special checkout names", async scoped => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "coverage-export-")));
    const root = join(workspace, 'consumer"$&\\tree'), original = join(workspace, 'producer"$&\\tree');
    const store = join(workspace, "store"), out = join(workspace, "out");
    mkdirSync(root);
    mkdirSync(store);
    const summary = { total: { lines: { pct: 100 } }, [join(original, "src/a.ts")]: { lines: { pct: 75 } },
        [join(`${original}-other`, "src/a.ts")]: { lines: { pct: 50 } } };
    const artifacts: RunArtifacts = {};
    const add = (name: string, path: string, value: unknown): void => {
        const bytes = JSON.stringify(value);
        writeFileSync(join(store, path), bytes);
        artifacts[name] = { path, sha256: hashBytes(bytes) };
    };
    add("coverage_summary", "coverage-summary.json", summary);
    if (scoped) add("coverage_scope", "scope.json", { version: 1, root: original, included: { "src/a.ts": true } });
    vi.mocked(scheduleTests).mockResolvedValue({ status: "passed", reused: true, runId: "r", durationMs: 0, reason: "", output: "",
        plan: { version: 1, snapshot: "s", changedPaths: [], mode: "full", tests: [], omitted: [], reasons: [], estimatedSerialMs: 0, reusable: true },
        artifacts, artifactStore: store, artifactRoot: original });
    try {
        await testsCommand("run", [], { cwd: root, all: true, coverage: true, receiptStore: join(workspace, "subscriber-store"), artifactsOut: out, json: true });
        expect(JSON.parse(readFileSync(join(out, "coverage-summary.json"), "utf8"))).toEqual({
            total: summary.total, [join(root, "src/a.ts")]: { lines: { pct: 75 } }, [join(`${original}-other`, "src/a.ts")]: { lines: { pct: 50 } },
        });
        expect(JSON.parse(readFileSync(join(store, "coverage-summary.json"), "utf8"))).toEqual(summary);
        if (scoped) expect(JSON.parse(readFileSync(join(out, "scope.json"), "utf8"))).toEqual({ version: 1, root, included: { "src/a.ts": true } });
    } finally { rmSync(workspace, { recursive: true, force: true }); }
});
