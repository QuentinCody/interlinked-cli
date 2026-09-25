// Regressions for the Unit A review (scratch/review-project-e2e-unit-a/REVIEW.md,
// findings R1–R12). Each case is the reviewer's reproduced false pass, now
// asserted to stay red, over real fixture projects and the public engine.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_POLICY } from "../contracts/paths.js";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { readE2eTxns, reduceE2eLedger } from "./ledger.js";
import { digestOf, E2E_POLICY_PATH, loadE2ePolicy } from "./policy.js";
import { readE2eReceipt } from "./receipt.js";
import { runProjectE2e } from "./run.js";
import { proposeExpectationInStore } from "./store.js";

const TIMEOUT = 120_000;
const projects: FixtureProject[] = [];
const roots: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fresh(language: "ts" | "py" = "py"): FixtureProject { const project = fixtureProject(language, { accept: true }); projects.push(project); return project; }
function codes(root: string): string[] { return evaluateE2e({ root, atMs: Date.now() }).verdicts[0]!.reasons.map(row => row.code); }
async function satisfied(project: FixtureProject): Promise<void> {
    const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
    expect(result.verdicts[0]?.satisfied, JSON.stringify(result.verdicts[0]?.reasons)).toBe(true);
}
// SAFETY (test): the policy fixture is a plain JSON object with these keys.
type Raw = Record<string, unknown>;
function editPolicy(root: string, mutate: (raw: Raw) => void): void {
    const raw = JSON.parse(readFileSync(join(root, E2E_POLICY_PATH), "utf8")) as Raw;
    mutate(raw);
    writeFileSync(join(root, E2E_POLICY_PATH), JSON.stringify(raw));
}

describe("R1 — acceptance and cited requirements are inputs", () => {
    it("revoking contract acceptance after a pass leaves check non-zero", async () => {
        const project = fresh();
        await satisfied(project);
        writeFileSync(join(project.root, CONTRACT_POLICY), JSON.stringify({ version: 1, accepted: {} }));
        const evaluation = evaluateE2e({ root: project.root, atMs: Date.now() });
        expect(evaluation.exitCode).not.toBe(0);
        expect(evaluation.verdicts[0]?.reasons.map(row => row.code)).toContain("STALE_GENERATION");
    }, TIMEOUT);
    it("changing the cited REQUIREMENTS.md after a pass leaves check non-zero", async () => {
        const project = fresh();
        await satisfied(project);
        writeFileSync(join(project.root, "REQUIREMENTS.md"), "R1 rewritten.\n");
        expect(evaluateE2e({ root: project.root, atMs: Date.now() }).exitCode).not.toBe(0);
    }, TIMEOUT);
});
describe("R2 — collection limits are gaps, not silent omissions", () => {
    it("a declared shared input over 8 MiB makes scope incomplete and check exit 2", async () => {
        const project = fresh();
        editPolicy(project.root, raw => { ((raw.projects as Raw[])[0]!).sharedInputs = ["large.dat"]; });
        writeFileSync(join(project.root, "large.dat"), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
        const evaluation = evaluateE2e({ root: project.root, atMs: Date.now() });
        expect(evaluation.verdicts[0]?.dimensions.scope).toBe("incomplete");
        expect(evaluation.verdicts[0]?.reasons.map(row => row.code)).toContain("SCOPE_INCOMPLETE");
        expect(evaluation.exitCode).not.toBe(0);
    });
});
describe("R3 — unsupported boundary profiles are refused, not passed", () => {
    it("a policy declaring an HTTP entry or a database component is invalid; an HTTP-runner case is BOUNDARY_UNSUPPORTED", () => {
        const project = fresh();
        editPolicy(project.root, raw => { (((raw.projects as Raw[])[0]!).scenarios as Raw[])[0]!.boundary = { entry: "process", real: ["application", "database"] }; });
        expect(loadE2ePolicy(project.root)).toMatchObject({ status: "invalid", reason: expect.stringMatching(/"database" cannot be established/) });
        expect(evaluateE2e({ root: project.root, atMs: Date.now() }).exitCode).toBe(2);
    });
});
describe("R4 — receipts do not transfer between worktrees", () => {
    it("copying policy, ledger and receipt into an identical project yields RECEIPT_MISMATCH", async () => {
        const project = fresh();
        await satisfied(project);
        const clone = realpathSync(mkdtempSync(join(tmpdir(), "e2e-clone-"))); roots.push(clone);
        cpSync(project.root, clone, { recursive: true });
        const evaluation = evaluateE2e({ root: clone, atMs: Date.now() });
        expect(evaluation.verdicts[0]?.satisfied).toBe(false);
        expect(evaluation.verdicts[0]?.reasons.map(row => row.code)).toContain("RECEIPT_MISMATCH");
        expect(evaluateE2e({ root: project.root, atMs: Date.now() }).exitCode).toBe(0);
    }, TIMEOUT);
});
describe("R5 — malformed receipt states are unavailable, never passed", () => {
    it("a case state edited to skipped makes check exit 2 with RECEIPT_INVALID", async () => {
        const project = fresh();
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const path = join(project.root, result.receipts[0]!.path);
        const tampered = JSON.parse(readFileSync(path, "utf8"));
        tampered.cases[0].state = "skipped";
        writeFileSync(path, JSON.stringify(tampered));
        const evaluation = evaluateE2e({ root: project.root, atMs: Date.now() });
        expect(evaluation.verdicts[0]?.reasons.map(row => row.code)).toEqual(["RECEIPT_INVALID"]);
        expect(evaluation.verdicts[0]?.dimensions.execution).toBe("not-run");
        expect(evaluation.exitCode).toBe(2);
    }, TIMEOUT);
});
describe("R6 — acceptance binds to recomputed expectation content", () => {
    it("editing a statement while keeping the stored revision makes the policy invalid; no decision can accept it", () => {
        const project = fresh();
        proposeExpectationInStore(project.root, { id: "exp", projectId: "orders", scenarioIds: ["order-persists"], statement: "original", origin: "user-requirement", sources: [], assumptions: [], questions: [], examples: { positive: [], negative: [] }, contractIds: ["orders.create"] }, 1);
        editPolicy(project.root, raw => { ((raw.expectations as Raw[])[0]!).statement = "changed after review"; });
        expect(loadE2ePolicy(project.root)).toMatchObject({ status: "invalid", reason: expect.stringMatching(/revision .* does not match the record's content/) });
    });
});
describe("R7 — preparation never touches the live project", () => {
    it("a prepare step that writes a marker writes it in the disposable snapshot only; artifacts still bind from that snapshot", async () => {
        const project = fresh("ts");
        editPolicy(project.root, raw => { ((((raw.projects as Raw[])[0]!).suites as Raw[])[0]!).prepare = [{ argv: ["node", "build.mjs"] }, { argv: ["node", "-e", "require('node:fs').writeFileSync('prepare-marker.txt','x')"] }]; });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.verdicts[0]?.satisfied, JSON.stringify(result.verdicts[0]?.reasons)).toBe(true);
        expect(existsSync(join(project.root, "prepare-marker.txt"))).toBe(false);
        expect(existsSync(join(project.root, "dist"))).toBe(false);
        expect(readE2eReceipt(project.root, result.receipts[0]!.path)?.artifacts.map(row => row.path)).toEqual(["dist/cli.js"]);
    }, TIMEOUT);
});
describe("R8 — native binaries travel through the contract driver", () => {
    it("a non-UTF-8 executable input is copied byte-for-byte with its mode and executes", async () => {
        const project = fresh("py");
        const binary = Buffer.concat([Buffer.from("#!/bin/sh\nprintf '{\"ok\":true,\"order\":{\"id\":1,\"name\":\"widget\"}}'\nmkdir -p data\nprintf '[{\"id\":1,\"name\":\"widget\"}]' > data/orders.json\nexit 0\n# "), Buffer.from([0xff, 0xfe, 0x00, 0x80])]);
        writeFileSync(join(project.root, "orders_bin"), binary, { mode: 0o755 });
        const manifest = JSON.parse(readFileSync(join(project.root, ".interlinked/behavioral-contracts.json"), "utf8"));
        manifest.cases[0].inputs = ["orders_bin"];
        manifest.cases[0].runner.argv = ["./orders_bin", "add", "widget"];
        manifest.cases[0].expect = { exitCode: 0, json: { ok: true, order: { id: 1, name: "widget" } }, files: { "data/orders.json": "[{\"id\":1,\"name\":\"widget\"}]" } };
        manifest.cases.splice(1, 1);
        writeFileSync(join(project.root, ".interlinked/behavioral-contracts.json"), JSON.stringify(manifest));
        editPolicy(project.root, raw => { (((raw.projects as Raw[])[0]!).scenarios as Raw[])[0]!.contractIds = ["orders.create"]; });
        writeFileSync(join(project.root, CONTRACT_POLICY), JSON.stringify({ version: 1, accepted: { [digestOf(JSON.stringify(manifest.cases[0]))]: "x" } }));
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const receipt = readE2eReceipt(project.root, result.receipts[0]!.path)!;
        expect(receipt.cases[0]?.details.join(" ")).not.toMatch(/not UTF-8/);
        expect(receipt.cases[0]?.state).toBe("passed");
    }, TIMEOUT);
});
describe("R9 — the invoked executable's identity is bound", () => {
    it("replacing an absolute application target after a pass makes check stale", async () => {
        const project = fresh("py");
        const app = join(realpathSync(mkdtempSync(join(tmpdir(), "e2e-app-"))), "app.py"); roots.push(join(app, ".."));
        cpSync(join(project.root, "orders_cli.py"), app);
        const manifest = JSON.parse(readFileSync(join(project.root, ".interlinked/behavioral-contracts.json"), "utf8"));
        for (const row of manifest.cases) { row.inputs = []; row.runner.argv[1] = app; }
        writeFileSync(join(project.root, ".interlinked/behavioral-contracts.json"), JSON.stringify(manifest));
        writeFileSync(join(project.root, CONTRACT_POLICY), JSON.stringify({ version: 1, accepted: Object.fromEntries(manifest.cases.map((row: unknown) => [digestOf(JSON.stringify(row)), "x"])) }));
        await satisfied(project);
        expect(readE2eReceipt(project.root, reduceE2eLedger(readE2eTxns(project.root)).get("orders/order-persists")!.lastReceipt!)?.inputs.map(row => row.path)).toContain(app);
        writeFileSync(app, "print('bad')\n");
        expect(codes(project.root)).toContain("STALE_GENERATION");
    }, TIMEOUT);
});
describe("R10 — mapping gaps reach the verdict", () => {
    it("an unmapped protected file makes check exit 1 with the gap listed, and the hook warned earlier", async () => {
        const project = fresh("py");
        editPolicy(project.root, raw => { ((raw.projects as Raw[])[0]!).protectedInputs = ["*.py"]; });
        await satisfied(project);
        writeFileSync(join(project.root, "unmapped.py"), "x = 1\n");
        const evaluation = evaluateE2e({ root: project.root, atMs: Date.now() });
        expect(evaluation.mappingGaps).toEqual([{ projectId: "orders", path: "unmapped.py" }]);
        expect(evaluation.verdicts[0]?.satisfied).toBe(true);
        expect(evaluation.exitCode).toBe(1);
    }, TIMEOUT);
});
describe("R12 — expectation binding is project-scoped", () => {
    it("two projects sharing a scenario id: proposing for one binds only that one and the policy still parses", () => {
        const project = fresh("py");
        editPolicy(project.root, raw => {
            const first = (raw.projects as Raw[])[0]!;
            mkdirSync(join(project.root, "second"), { recursive: true });
            (raw.projects as Raw[]).push({ ...structuredClone(first), id: "second", root: "second" });
        });
        proposeExpectationInStore(project.root, { id: "exp", projectId: "second", scenarioIds: ["order-persists"], statement: "s", origin: "agent-inference", sources: [], assumptions: [], questions: [], examples: { positive: [], negative: [] }, contractIds: ["orders.create"] }, 1);
        const loaded = loadE2ePolicy(project.root);
        expect(loaded.status).toBe("configured");
        if (loaded.status !== "configured") return;
        expect(loaded.policy.projects[0]?.scenarios[0]?.expectationIds).toBeUndefined();
        expect(loaded.policy.projects[1]?.scenarios[0]?.expectationIds).toEqual(["exp"]);
    });
});
describe("TypeScript fixture is a real build", () => {
    it("the fixture source is TypeScript and the build step emits JavaScript through type stripping", () => {
        const project = fresh("ts");
        expect(readFileSync(join(project.root, "src/cli.ts"), "utf8")).toMatch(/interface Order/);
        const build = spawnSync("node", ["build.mjs"], { cwd: project.root, encoding: "utf8" });
        expect(build.status).toBe(0);
        expect(readFileSync(join(project.root, "dist/cli.js"), "utf8")).not.toMatch(/interface Order/);
    });
});
