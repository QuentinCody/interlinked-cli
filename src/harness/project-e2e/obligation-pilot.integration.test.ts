// Requirement: docs/plans/antithesis-evidence-integrity-20261004.md §E.
// Expected outcomes come from the pre-existing fixture REQUIREMENTS.md.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, it } from "vitest";
import { runProcessAsync } from "../check-engine/spawn-async.js";
import { CONTRACT_MANIFEST } from "../contracts/paths.js";
import type { ContractManifest } from "../contracts/types.js";
import { httpFixtureProject } from "./__tests__/fixture-http.js";
import { acceptAllContracts, fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { E2E_POLICY_PATH, type E2ePolicy, type E2eProof } from "./policy.js";
import { readE2eReceipt, type E2eReceipt } from "./receipt.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const CLI = resolve("src/index.ts");
const TSX = createRequire(import.meta.url).resolve("tsx");
async function cli(project: FixtureProject, action: string) {
    return runProcessAsync(process.execPath, ["--import", TSX, CLI, "tests", "e2e", action, "--cwd", project.root, "--json"],
        { cwd: project.root, timeout: 60000 });
}
function proof(project: FixtureProject, value: E2eProof): void {
    const file = join(project.root, E2E_POLICY_PATH);
    const policy: E2ePolicy = JSON.parse(readFileSync(file, "utf8")); // fixture-authored policy
    policy.projects[0]!.scenarios[0]!.proof = value;
    writeFileSync(file, JSON.stringify(policy));
}
function receipt(project: FixtureProject, stdout: string): E2eReceipt {
    const result = JSON.parse(stdout);
    const value = readE2eReceipt(project.root, result.receipts[0].path);
    if (!value) throw new Error("CLI did not retain a valid receipt");
    return value;
}
it("O1 stale evidence cannot authorize current acceptance through the real CLI", async () => {
    const project = fixtureProject("py", { accept: true }); projects.push(project);
    expect((await cli(project, "run")).code).toBe(0);
    expect((await cli(project, "check")).code).toBe(0); // acceptance prerequisite witnessed
    const file = join(project.root, project.sourceFile);
    writeFileSync(file, readFileSync(file, "utf8") + "\n# targeted input drift\n");
    const stale = await cli(project, "check");
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain("STALE_GENERATION");
}, 120000);
it("O2 rejection has no durable effect; a planted write still returning 400 fails the independent read witness", async () => {
    const project = httpFixtureProject(); projects.push(project);
    const file = join(project.root, CONTRACT_MANIFEST);
    const manifest: ContractManifest = JSON.parse(readFileSync(file, "utf8")); // fixture-authored
    const invalid = manifest.cases.find(row => row.id === "orders.invalid")!;
    manifest.cases.push({ ...invalid, id: "orders.after-reject", description: "rejected input created no second order",
        steps: [{ kind: "restart", service: "api" }],
        runner: { kind: "http", service: "api", path: "/orders/2", method: "GET" },
        expect: { status: 404, json: { error: "not found" } } });
    writeFileSync(file, JSON.stringify(manifest)); acceptAllContracts(project.root);
    const policyPath = join(project.root, E2E_POLICY_PATH);
    const policy: E2ePolicy = JSON.parse(readFileSync(policyPath, "utf8")); // fixture-authored
    policy.projects[0]!.scenarios[0]!.contractIds.push("orders.after-reject");
    writeFileSync(policyPath, JSON.stringify(policy));
    proof(project, { mode: "controlled-fault", fault: { id: "write-after-rejection", path: project.sourceFile,
        find: 'if (typeof name !== "string" || !name) { send(response, 400',
        replace: 'if (typeof name !== "string" || !name) { save([...load(), { id: 2, name: "forbidden" }]); send(response, 400',
        rationale: "REQUIREMENTS.md: invalid requests answer 400 and write nothing" },
        designated: [{ id: "orders.after-reject", action: ["orders.invalid"] }] });
    const run = await cli(project, "run");
    expect(run.code, run.stderr + run.stdout).toBe(0);
    const evidence = receipt(project, run.stdout).sensitivity?.["order-persists"];
    expect(evidence).toMatchObject({ verdict: "demonstrated", category: "designated-expectation-mismatch" });
    expect(evidence?.compared.find(row => row.id === "orders.invalid")?.state).toBe("passed");
    expect(evidence?.compared.find(row => row.id === "orders.after-reject")?.state).toBe("failed");
}, 120000);
function restartPilot(restart: boolean): FixtureProject {
    const project = httpFixtureProject(); projects.push(project);
    const source = join(project.root, project.sourceFile);
    const original = readFileSync(source, "utf8");
    // This service caches accepted state. Only a new process reloads its durable store.
    writeFileSync(source, original.replace("function save(orders", "const memoryOrders = load();\nfunction save(orders")
        .replace("const orders = load();", "const orders = memoryOrders;").replace("const order = load().find", "const order = memoryOrders.find"));
    if (!restart) {
        const path = join(project.root, CONTRACT_MANIFEST);
        const manifest: ContractManifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.cases.find(row => row.id === "orders.read-after-restart")!.steps = [];
        writeFileSync(path, JSON.stringify(manifest));
        acceptAllContracts(project.root);
    }
    proof(project, { mode: "controlled-fault", fault: { id: "drop-durable-save", path: project.sourceFile,
        find: "    save(orders);\n    send(response, 201", replace: "    /* planted: no persistence */\n    send(response, 201",
        rationale: "REQUIREMENTS.md: accepted orders survive service restart" },
        designated: [{ id: "orders.read-after-restart", action: ["orders.create"] }] });
    return project;
}
it("O3 accepted work survives owned-service restart; dropping save leaves acceptance intact and loses read-back", async () => {
    const project = restartPilot(true);
    const run = await cli(project, "run");
    expect(run.code, run.stderr + run.stdout).toBe(0);
    const stored = receipt(project, run.stdout);
    expect(stored.services?.[0]).toMatchObject({ restarts: 1, ready: { ok: true }, shutdown: { ok: true, portSilent: true } });
    const evidence = stored.sensitivity?.["order-persists"];
    expect(evidence).toMatchObject({ verdict: "demonstrated" });
    expect(evidence?.compared.find(row => row.id === "orders.create")?.state).toBe("passed");
    expect(evidence?.compared.find(row => row.id === "orders.read-after-restart")?.state).toBe("failed");
}, 120000);
it("O3 negative control: without restart the same in-memory-only fault is not detected", async () => {
    const project = restartPilot(false);
    const run = await cli(project, "run");
    const stored = receipt(project, run.stdout);
    expect(stored.services?.[0]?.restarts).toBe(0);
    const evidence = stored.sensitivity?.["order-persists"];
    expect(evidence?.verdict).not.toBe("demonstrated");
    expect(evidence?.compared.find(row => row.id === "orders.create")?.state).toBe("passed");
    expect(evidence?.compared.find(row => row.id === "orders.read-after-restart")?.state).toBe("passed");
}, 120000);
