// Mutation-driven hardening of the supervised run (Campaign A). Each case states the behavior the
// supervisor must keep: environment isolation of owned processes, disposable-snapshot hygiene,
// drift detection, attempt status classification, diagnostic publication, request attribution,
// argument validation, admission and cancellation, structured test commands, service lifecycle
// and the proof-mode comparison lifecycle.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_MANIFEST } from "../contracts/paths.js";
import { acquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import { httpFixtureProject } from "./__tests__/fixture-http.js";
import { acceptAllContracts, fixtureProject, injectPersistenceDefect, type FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { readE2eTxns, reduceE2eLedger, type E2eTxn } from "./ledger.js";
import { E2E_POLICY_PATH, type E2eProof } from "./policy.js";
import { E2E_RUNS_DIRECTORY, type E2eReceipt } from "./receipt.js";
import { openRequest, openRequests } from "./requests.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
const scratch: string[] = [];
afterEach(() => {
    for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true });
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const TIMEOUT = 90_000;
const KEY = "orders/order-persists";

type PolicyJson = Record<string, unknown> & { projects: Array<Record<string, unknown> & { suites: Array<Record<string, unknown>>; scenarios: Array<Record<string, unknown>> }> };
function fresh(language: "ts" | "py", accept = true): FixtureProject { const project = fixtureProject(language, { accept }); projects.push(project); return project; }
function editPolicy(project: FixtureProject, edit: (policy: PolicyJson) => void): void {
    const path = join(project.root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(path, "utf8")) as PolicyJson; // SAFETY: fixture-authored
    edit(policy);
    writeFileSync(path, JSON.stringify(policy));
}
function receiptOf(project: FixtureProject, path: string): E2eReceipt { return JSON.parse(readFileSync(join(project.root, path), "utf8")) as E2eReceipt; } // SAFETY: the receipt this run wrote
function runDirectoryOf(project: FixtureProject, receipt: E2eReceipt): string { return join(project.root, E2E_RUNS_DIRECTORY, receipt.runId); }
function attempts(project: FixtureProject): Array<Extract<E2eTxn, { op: "attempt" }>> { return readE2eTxns(project.root).filter((row): row is Extract<E2eTxn, { op: "attempt" }> => row.op === "attempt"); }
function status(project: FixtureProject): string | undefined { return reduceE2eLedger(readE2eTxns(project.root)).get(KEY)?.status; }
function setPrepare(project: FixtureProject, ...steps: string[][]): void { editPolicy(project, policy => { policy.projects[0]!.suites[0]!.prepare = steps.map(argv => ({ argv })); }); }

/** A probe the owned preparation step runs: it reports its environment and the snapshot it was given (a file, so the policy never sees braces). */
const PROBE = `import fs from "node:fs";
const link = path => { try { return fs.lstatSync(path).isSymbolicLink(); } catch { return null; } };
console.log(JSON.stringify({
    home: process.env.HOME, lang: process.env.LANG, pyc: process.env.PYTHONDONTWRITEBYTECODE, tmp: process.env.TMPDIR, cwd: process.cwd(), args: process.argv.slice(2),
    cargo: process.env.CARGO_HOME, seed: process.env.INTERLINKED_E2E_SEED, cohort: process.env.INTERLINKED_E2E_COHORT, attempt: process.env.INTERLINKED_E2E_ATTEMPT,
    clock: process.env.INTERLINKED_E2E_CLOCK, v8: process.env.NODE_V8_COVERAGE,
    policyCopied: fs.existsSync(".interlinked/e2e-policy.json"), nestedGit: fs.existsSync("sub/.git/x"), link: link("link.txt"),
}));
`;
interface Probe { home: string; lang: string; pyc: string; tmp: string; cwd: string; args: string[]; cargo?: string; seed?: string; cohort?: string; attempt?: string; clock?: string; v8?: string; policyCopied: boolean; nestedGit: boolean; link: boolean | null; }
function probeProject(args: string[] = []): FixtureProject {
    const project = fresh("py");
    writeFileSync(join(project.root, "probe.mjs"), PROBE);
    mkdirSync(join(project.root, "sub/.git"), { recursive: true });
    writeFileSync(join(project.root, "sub/.git/x"), "x");
    symlinkSync("orders_cli.py", join(project.root, "link.txt"));
    setPrepare(project, ["node", "probe.mjs", ...args]);
    return project;
}
function probeOf(receipt: E2eReceipt): Probe { return JSON.parse(receipt.prepare[0]!.preview) as Probe; } // SAFETY: the probe printed this JSON

describe("owned preparation processes — positive (isolated, deterministic environment)", () => {
    it("P1: preparation runs in a disposable snapshot with a private HOME, the run directory as TMPDIR, a fixed locale, no bytecode writes, toolchain homes passed through and placeholders substituted", async () => {
        const project = probeProject(["{run-directory}", "{fixture-directory}"]);
        const previous = process.env.CARGO_HOME;
        process.env.CARGO_HOME = "/opt/e2e-cargo-probe";
        let result;
        try { result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT }); } finally { if (previous === undefined) delete process.env.CARGO_HOME; else process.env.CARGO_HOME = previous; }
        const receipt = receiptOf(project, result.receipts[0]!.path), probe = probeOf(receipt), directory = runDirectoryOf(project, receipt);
        expect(receipt.prepare[0]).toMatchObject({ ok: true, exitCode: 0 });
        expect(probe).toMatchObject({ home: join(directory, "home"), tmp: directory, lang: "C.UTF-8", pyc: "1", cargo: "/opt/e2e-cargo-probe" });
        expect(probe.args).toEqual([directory, join(directory, "fixture")]);
        expect(probe.cwd).toContain("interlinked-e2e-snapshot-");
        expect(probe.cwd.startsWith(realpathSync(project.root))).toBe(false);
        expect(probe.seed).toBeUndefined();
        expect(probe.v8).toBeUndefined();
    }, TIMEOUT);
    it("P2: the snapshot copies nested project files but never the ledger directory at the project root and never a symbolic link; it is removed when the run ends", async () => {
        const project = probeProject();
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const probe = probeOf(receiptOf(project, result.receipts[0]!.path));
        expect(probe.policyCopied).toBe(false);
        expect(probe.nestedGit).toBe(true);
        expect(probe.link).toBeNull();
        expect(existsSync(probe.cwd)).toBe(false);
    }, TIMEOUT);
    it("P3: a stability attempt exports its seed, cohort and attempt number to owned processes and the receipt; a real clock exports no clock and a frozen clock exports it", async () => {
        const project = probeProject();
        const frozen = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, stability: { cohortId: "cohort-1", attempt: 3, seed: "seed-x", clock: "2026-01-02T03:04:05Z" } });
        const frozenReceipt = receiptOf(project, frozen.receipts[0]!.path);
        expect(probeOf(frozenReceipt)).toMatchObject({ seed: "seed-x", cohort: "cohort-1", attempt: "3", clock: "2026-01-02T03:04:05Z" });
        expect(frozenReceipt.stability).toEqual({ cohortId: "cohort-1", attempt: 3, seed: "seed-x", clock: "2026-01-02T03:04:05Z" });
        const real = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, stability: { cohortId: "cohort-1", attempt: 4, seed: "seed-y", clock: "real" } });
        const realProbe = probeOf(receiptOf(project, real.receipts[0]!.path));
        expect(realProbe).toMatchObject({ seed: "seed-y", attempt: "4" });
        expect(realProbe.clock).toBeUndefined();
    }, TIMEOUT);
    it("P4: a run without a stability attempt exports no seed and records no stability block", async () => {
        const project = probeProject();
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(probeOf(receipt).seed).toBeUndefined();
        expect(receipt.stability).toBeUndefined();
    }, TIMEOUT);
    it("P5: runtime coverage is collected into the run only when the project declares a node profile", async () => {
        const off = fresh("ts");
        const offResult = await runProjectE2e({ root: off.root, timeoutMs: TIMEOUT });
        const offReceipt = receiptOf(off, offResult.receipts[0]!.path);
        expect(offReceipt.observations).toBeUndefined();
        expect(existsSync(join(runDirectoryOf(off, offReceipt), "coverage"))).toBe(false);
        const on = fresh("ts");
        editPolicy(on, policy => { policy.projects[0]!.observations = { runtimeCoverage: "node" }; });
        const onResult = await runProjectE2e({ root: on.root, timeoutMs: TIMEOUT });
        const onReceipt = receiptOf(on, onResult.receipts[0]!.path);
        expect(onReceipt.observations).toBeDefined();
        expect(existsSync(join(runDirectoryOf(on, onReceipt), "coverage"))).toBe(true);
    }, TIMEOUT);
});

describe("preparation failure and drift — negative (no case may run on a tampered or failed snapshot)", () => {
    it("N1: a failed preparation step stops the later steps, keeps only the tail of long output, records an unavailable attempt and executes no case", async () => {
        const project = fresh("py");
        writeFileSync(join(project.root, "noisy.mjs"), "console.log('A'.repeat(3000) + 'TAIL'); process.exit(1);\n");
        setPrepare(project, ["node", "noisy.mjs"], ["node", "-e", "process.exit(0)"]);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.prepare).toHaveLength(1);
        expect(receipt.prepare[0]!.preview).toHaveLength(1024);
        expect(receipt.prepare[0]!.preview.endsWith("TAIL")).toBe(true);
        expect(receipt.cases).toEqual([]);
        expect(receipt.completion.reasons).toContain("preparation failed; no case executed");
        expect(status(project)).toBe("unavailable");
        expect(attempts(project)[0]!.reason).toMatch(/^unavailable: .*preparation failed; no case executed/);
    }, TIMEOUT);
    it("N2: a preparation step that edits a declared input in the snapshot leaves the run incomplete, names the input and runs no case", async () => {
        const project = fresh("py");
        setPrepare(project, ["node", "-e", "require('fs').appendFileSync('orders_cli.py', '# tampered')"]);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.completion.reasons).toEqual(expect.arrayContaining(["preparation modified declared input orders_cli.py", "preparation altered declared inputs; no case executed"]));
        expect(receipt.completion.complete).toBe(false);
        expect(receipt.cases).toEqual([]);
    }, TIMEOUT);
    it("N3: replacing a declared input with a directory is reported as removal of that input", async () => {
        const project = fresh("py");
        setPrepare(project, ["node", "-e", "const fs = require('fs'); fs.rmSync('orders_cli.py'); fs.mkdirSync('orders_cli.py')"]);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.completion.reasons).toContain("preparation removed declared input orders_cli.py");
        expect(receipt.cases).toEqual([]);
    }, TIMEOUT);
    it("N4: changing only the mode bits of a declared input counts as modifying it", async () => {
        const project = fresh("py");
        setPrepare(project, ["node", "-e", "require('fs').chmodSync('orders_cli.py', 0o755)"]);
        chmodSync(join(project.root, "orders_cli.py"), 0o644);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.completion.reasons).toContain("preparation modified declared input orders_cli.py");
        expect(receipt.cases).toEqual([]);
    }, TIMEOUT);
    it("N5: two scenarios sharing one declared input report its drift once", async () => {
        const project = fresh("py");
        setPrepare(project, ["node", "-e", "require('fs').appendFileSync('orders_cli.py', '# tampered')"]);
        editPolicy(project, policy => { policy.projects[0]!.scenarios.push({ ...policy.projects[0]!.scenarios[0]!, id: "second", contractIds: ["orders.create"] }); });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.completion.reasons.filter(reason => reason === "preparation modified declared input orders_cli.py")).toHaveLength(1);
    }, TIMEOUT);
    it("N6: a preparation step that plants an acceptance file the live tree never had does not accept the contracts", async () => {
        const project = fresh("py", false);
        const accepted = fresh("py", true);
        const planted = readFileSync(join(accepted.root, ".interlinked/contract-policy.json"), "utf8");
        writeFileSync(join(project.root, "plant.mjs"), `import fs from "node:fs";\nfs.mkdirSync(".interlinked", { recursive: true });\nfs.writeFileSync(".interlinked/contract-policy.json", ${JSON.stringify(planted)});\n`);
        // The accepted fixture and this one carry identical manifests, so the planted digests would match if honored.
        writeFileSync(join(project.root, CONTRACT_MANIFEST), readFileSync(join(accepted.root, CONTRACT_MANIFEST)));
        setPrepare(project, ["node", "plant.mjs"]);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.cases.map(row => row.authority)).not.toContain("accepted");
        expect(evaluateE2e({ root: project.root, atMs: 5 }).verdicts[0]!.status).toBe("review-required");
    }, TIMEOUT);
});

describe("declared inputs — positive (legitimate rebuilds and absolute executables are not drift)", () => {
    it("P1: a build that rewrites an artifact-covered input whose live copy was stale is not drift; the run completes and qualifies", async () => {
        const project = fresh("ts");
        mkdirSync(join(project.root, "dist"), { recursive: true });
        writeFileSync(join(project.root, "dist/cli.js"), "// stale build output\n");
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.completion.reasons).toEqual([]);
        expect(receipt.completion.complete).toBe(true);
        expect(result.verdicts[0]!.satisfied).toBe(true);
    }, TIMEOUT);
    it("P2: a case that runs an executable by absolute path is judged without treating that outside path as a project input", async () => {
        const project = fresh("py", false);
        const python = execFileSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();
        const manifestPath = join(project.root, CONTRACT_MANIFEST);
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { cases: Array<{ runner: { argv: string[] } }> };
        for (const row of manifest.cases) row.runner.argv[0] = python;
        writeFileSync(manifestPath, JSON.stringify(manifest));
        acceptAllContracts(project.root);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.completion.reasons).toEqual([]);
        expect(receipt.cases.map(row => row.state)).toEqual(["passed", "passed"]);
    }, TIMEOUT);
});

describe("attempt classification — the ledger records what the run proved", () => {
    it("P1: a clean run records a passed attempt whose reason says the supervised run passed", async () => {
        const project = fresh("py");
        await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(attempts(project).map(row => [row.status, row.reason])).toEqual([["passed", "supervised run passed"]]);
    }, TIMEOUT);
    it("N1: a failing case records a failed attempt and its reason names the status", async () => {
        const project = fresh("py");
        injectPersistenceDefect(project);
        await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(status(project)).toBe("failed");
        expect(attempts(project)[0]!.reason).toMatch(/^failed: /);
    }, TIMEOUT);
    it("N2: a requirement document that changed since the contract was written records a stale attempt", async () => {
        const project = fresh("py");
        writeFileSync(join(project.root, "REQUIREMENTS.md"), `${readFileSync(join(project.root, "REQUIREMENTS.md"), "utf8")}\nA new paragraph changes the requirement bytes.\n`);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(receiptOf(project, result.receipts[0]!.path).cases.map(row => row.state)).toContain("stale");
        expect(status(project)).toBe("stale");
    }, TIMEOUT);
    it("N3: a requirement document that is missing leaves the cases unavailable, never passed", async () => {
        const project = fresh("py");
        rmSync(join(project.root, "REQUIREMENTS.md"));
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(receiptOf(project, result.receipts[0]!.path).cases.map(row => row.state)).not.toContain("passed");
        expect(status(project)).toBe("unavailable");
    }, TIMEOUT);
    it("N4: a project input edited while the run is in flight makes the attempt stale and the receipt records the change", async () => {
        const project = fresh("py");
        writeFileSync(join(project.root, "edit-live.mjs"), `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(join(project.root, "orders_cli.py"))}, "\\n# edited while the run was in flight\\n");\n`);
        setPrepare(project, ["node", "edit-live.mjs"]);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.completion.inputsChangedDuringRun).toBe(true);
        expect(receipt.completion.generationAfter).not.toBe(receipt.generation);
        expect(attempts(project).map(row => row.status)).toEqual(["stale"]);
        expect(attempts(project)[0]!.reason).toMatch(/^stale: /);
    }, TIMEOUT);
    it("P2: a run that changes nothing records inputsChangedDuringRun false", async () => {
        const project = fresh("py");
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(receiptOf(project, result.receipts[0]!.path).completion.inputsChangedDuringRun).toBe(false);
    }, TIMEOUT);
});

describe("diagnostic publication and request attribution", () => {
    it("P1: a diagnostic run keeps a receipt but appends no attempt, opens no obligation record and serves no request", async () => {
        const project = fresh("py");
        const first = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const generation = receiptOf(project, first.receipts[0]!.path).scenarioGenerations!["order-persists"]!;
        const id = openRequest(project.root, { key: KEY, generation, sessionId: "s1", atMs: 1 });
        const before = readE2eTxns(project.root).length;
        const diagnostic = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, publication: "diagnostic", requestIds: [id] });
        const receipt = receiptOf(project, diagnostic.receipts[0]!.path);
        expect(receipt.requestIds).toEqual([]);
        expect(readE2eTxns(project.root)).toHaveLength(before);
        expect(openRequests(project.root).has(id)).toBe(true);
        const record = JSON.parse(readFileSync(join(runDirectoryOf(project, receipt), "attempt.json"), "utf8")) as { keys: string[]; generations: Record<string, string> };
        expect(record).toMatchObject({ keys: [], generations: {} });
    }, TIMEOUT);
    it("P2: a published run records the keys and generations it set out to certify", async () => {
        const project = fresh("py");
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, sessionId: "s1" });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        const record = JSON.parse(readFileSync(join(runDirectoryOf(project, receipt), "attempt.json"), "utf8")) as { keys: string[]; generations: Record<string, string>; scenarioIds: string[] };
        expect(record.keys).toEqual([KEY]);
        expect(record.generations).toEqual({ [KEY]: receipt.scenarioGenerations!["order-persists"] });
        expect(record.scenarioIds).toEqual(["order-persists"]);
    }, TIMEOUT);
    it("P3: the receipt names every matching open request once, sorted, and the run serves exactly those", async () => {
        const project = fresh("py");
        const first = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const generation = receiptOf(project, first.receipts[0]!.path).scenarioGenerations!["order-persists"]!;
        const a = openRequest(project.root, { key: KEY, generation, sessionId: "s-a", atMs: 1 });
        const b = openRequest(project.root, { key: KEY, generation, sessionId: "s-b", atMs: 2 });
        const second = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, requestIds: [b, a, b] });
        const receipt = receiptOf(project, second.receipts[0]!.path);
        expect(receipt.requestIds).toEqual([a, b].sort());
        expect(openRequests(project.root).size).toBe(0);
    }, TIMEOUT);
});

describe("argument validation, configuration and admission", () => {
    it("N1: a timeout outside 1..600000 ms or not a whole number is refused; the bounds themselves are accepted", async () => {
        const project = fresh("py");
        rmSync(join(project.root, E2E_POLICY_PATH));
        for (const timeoutMs of [0, -5, 1.5, Number.NaN, 600_001]) await expect(runProjectE2e({ root: project.root, timeoutMs })).rejects.toThrow(/timeout must be 1–600000 ms/);
        for (const timeoutMs of [1, 600_000]) expect((await runProjectE2e({ root: project.root, timeoutMs })).status).toBe("unconfigured");
    });
    it("N2: an unconfigured root says so and runs nothing; an unparseable policy is reported as invalid", async () => {
        const project = fresh("py");
        writeFileSync(join(project.root, E2E_POLICY_PATH), "{ not json");
        const invalid = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(invalid.receipts).toEqual([]);
        expect(invalid.messages[0]).toMatch(/^policy invalid: /);
        rmSync(join(project.root, E2E_POLICY_PATH));
        const missing = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(missing.messages).toEqual(["UNCONFIGURED: no e2e policy; nothing was run"]);
    });
    it("N3: an automatic launch runs nothing while scheduling.autoRun is off", async () => {
        const project = fresh("py");
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, automatic: true });
        expect(result.receipts).toEqual([]);
        expect(result.messages).toEqual([expect.stringMatching(/automatic execution is off/)]);
    }, TIMEOUT);
    it("N4: a signal that is already aborted is refused before admission; no snapshot, receipt or attempt exists", async () => {
        const project = fresh("py");
        const controller = new AbortController();
        controller.abort();
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, signal: controller.signal });
        expect(result.receipts).toEqual([]);
        expect(result.messages).toEqual([expect.stringMatching(/cancelled before admission/)]);
        expect(attempts(project)).toEqual([]);
        expect(existsSync(join(project.root, E2E_RUNS_DIRECTORY))).toBe(false);
    }, TIMEOUT);
    it("N5: when another process holds the project's heavy-process lease past the budget, the suite is deferred and nothing runs", async () => {
        const project = fresh("py");
        const release = await acquireProjectHeavyProcessLease(project.root, Date.now() + 30_000, new AbortController().signal);
        expect(release).not.toBeNull();
        try {
            const outcome = await runProjectE2e({ root: project.root, timeoutMs: 700 }).then(result => ({ result }), (error: unknown) => ({ error }));
            if ("result" in outcome) {
                expect(outcome.result.receipts).toEqual([]);
                expect(outcome.result.messages).toEqual([expect.stringMatching(/deferred — project heavy-process lease unavailable within budget/)]);
            } else expect(String(outcome.error)).toMatch(/compiler admission aborted/); // the budget signal won the race against the lease deadline
            expect(attempts(project)).toEqual([]);
            expect(existsSync(join(project.root, E2E_RUNS_DIRECTORY))).toBe(false);
        } finally { release!(); }
    }, TIMEOUT);
    it("P1: a project reached through a symbolic link records its canonical root in the receipt", async () => {
        const project = fresh("py");
        const holder = mkdtempSync(join(tmpdir(), "e2e-link-"));
        scratch.push(holder);
        const link = join(holder, "project-link");
        symlinkSync(project.root, link);
        const result = await runProjectE2e({ root: link, timeoutMs: TIMEOUT });
        expect(readFileSync(join(link, result.receipts[0]!.path), "utf8")).toContain(`"canonicalRoot": ${JSON.stringify(realpathSync(project.root))}`);
    }, TIMEOUT);
});

/** A structured-runner suite whose test command is `script`; the scenario binds orders.create plus the native cases unit/a and unit/b. */
function structured(script: string, extraPrepare: string[][] = []): FixtureProject {
    const project = fresh("ts");
    writeFileSync(join(project.root, "run-tests.mjs"), script);
    editPolicy(project, policy => {
        const target = policy.projects[0]!, cli = target.suites[0]!, inputs = [...(target.protectedInputs as string[]), "run-tests.mjs"];
        target.suites.push({ id: "native", adapter: "structured-runner", prepare: [...(cli.prepare as unknown[]), ...extraPrepare.map(argv => ({ argv }))], artifacts: cli.artifacts, run: { argv: ["node", "run-tests.mjs"] }, report: { format: "json", path: "report.json" } });
        target.protectedInputs = inputs;
        target.scenarios = [{ id: "native-suite", suite: "native", affects: [...inputs], contractIds: ["orders.create"], caseIds: ["unit/a", "unit/b"], required: true }];
    });
    return project;
}
function reportScript(cases: Array<{ id: string; status: string }>, exitCode = 0): string {
    return `import { writeFileSync } from "node:fs";\nwriteFileSync("report.json", ${JSON.stringify(JSON.stringify({ version: 1, cases }))});\nprocess.exit(${exitCode});\n`;
}
const GREEN = [{ id: "unit/a", status: "passed" }, { id: "unit/b", status: "passed" }];
const NATIVE_KEY = "orders/native-suite";
async function runNative(project: FixtureProject, timeoutMs = TIMEOUT): Promise<E2eReceipt> {
    const result = await runProjectE2e({ root: project.root, timeoutMs });
    return receiptOf(project, result.receipts[0]!.path);
}

describe("structured test command — positive (selection follows the declaration)", () => {
    it("P1: the required and observed sets name exactly the declared contracts and native cases; undeclared report cases and unselected contracts are never recorded", async () => {
        const project = structured(reportScript([...GREEN, { id: "unit/extra", status: "passed" }]));
        const receipt = await runNative(project);
        expect(receipt.selection.required).toEqual(["orders.create", "unit/a", "unit/b"]);
        expect(receipt.cases.filter(row => row.runnerKind === "structured").map(row => row.id)).toEqual(["unit/a", "unit/b"]);
        expect(receipt.cases.filter(row => row.runnerKind === "process").map(row => row.id)).toEqual(["orders.create"]);
        expect(receipt.selection.observed).toEqual(["unit/a", "unit/b", "orders.create"]);
        expect(receipt.completion.complete).toBe(true);
    }, TIMEOUT);
    it("P2: a nonzero exit that the report explains with an error-status case is not an unexplained exit", async () => {
        const project = structured(reportScript([{ id: "unit/a", status: "passed" }, { id: "unit/b", status: "error" }], 1));
        const receipt = await runNative(project);
        expect(receipt.completion.reasons.join("\n")).not.toMatch(/unexplained/);
        expect(receipt.cases.find(row => row.id === "unit/b")?.state).toBe("failed");
        expect(receipt.completion.complete).toBe(true);
    }, TIMEOUT);
    it("P3: the execution record carries the real exit code and is not ok when the command exited nonzero", async () => {
        const project = structured(reportScript([{ id: "unit/a", status: "passed" }, { id: "unit/b", status: "failed" }], 1));
        const receipt = await runNative(project);
        expect(receipt.execution).toMatchObject({ argv: ["node", "run-tests.mjs"], exitCode: 1, ok: false });
        const clean = await runNative(structured(reportScript(GREEN)));
        expect(clean.execution).toMatchObject({ exitCode: 0, ok: true });
    }, TIMEOUT);
});

describe("structured test command — negative (no report, no trust)", () => {
    it("N1: a report that omits a declared case leaves that case not-run and the attempt unavailable, never passed", async () => {
        const project = structured(reportScript([{ id: "unit/a", status: "passed" }]));
        const receipt = await runNative(project);
        expect(receipt.cases.map(row => row.id)).not.toContain("unit/b");
        expect(attempts(project).map(row => row.status)).toEqual(["unavailable"]);
        expect(reduceE2eLedger(readE2eTxns(project.root)).get(NATIVE_KEY)?.status).toBe("unavailable");
    }, TIMEOUT);
    it("N2: a pre-existing report in the project is removed before the run and never substituted for the report the command writes", async () => {
        const project = structured("process.exit(0);\n");
        writeFileSync(join(project.root, "report.json"), JSON.stringify({ version: 1, cases: GREEN }));
        const receipt = await runNative(project);
        expect(receipt.completion.reasons).toEqual(expect.arrayContaining(["pre-existing report report.json removed before the run; only a report this run writes counts", "structured report report.json was not produced by the run"]));
        expect(receipt.report).toBeUndefined();
        expect(receipt.cases.filter(row => row.runnerKind === "structured")).toEqual([]);
        expect(receipt.completion.complete).toBe(false);
    }, TIMEOUT);
    it("N3: a directory at the report path is not a report; the run is incomplete instead of crashing", async () => {
        const project = structured("import { mkdirSync } from \"node:fs\";\nmkdirSync(\"report.json\");\n");
        const receipt = await runNative(project);
        expect(receipt.completion.reasons).toContain("structured report report.json was not produced by the run");
        expect(receipt.completion.complete).toBe(false);
    }, TIMEOUT);
    it("N4: an unparseable report names the file and the parser's reason in the completion reasons", async () => {
        const project = structured("import { writeFileSync } from \"node:fs\";\nwriteFileSync(\"report.json\", \"{ truncated\");\n");
        const receipt = await runNative(project);
        expect(receipt.completion.reasons.join("\n")).toMatch(/structured report report\.json unreadable: report is not valid JSON/);
        expect(receipt.completion.complete).toBe(false);
    }, TIMEOUT);
    it("N5: an all-green report under a failing command is an unexplained exit and the run is incomplete", async () => {
        const project = structured(reportScript(GREEN, 3));
        const receipt = await runNative(project);
        expect(receipt.completion.reasons.join("\n")).toMatch(/test command exited 3 but its report records no failure; the exit is unexplained/);
        expect(receipt.completion.complete).toBe(false);
    }, TIMEOUT);
    it("N6: a test command that outlives the budget is interrupted even when it exits 0 on the kill; no report is trusted", async () => {
        const project = structured("process.on(\"SIGTERM\", () => process.exit(0));\nsetInterval(() => {}, 1000);\n");
        const receipt = await runNative(project, 7000);
        expect(receipt.completion.reasons.join("\n")).toMatch(/test command node run-tests\.mjs was interrupted \(timeout\/kill\); no report is trusted/);
        expect(receipt.execution?.ok).toBe(false);
        expect(receipt.report).toBeUndefined();
        expect(receipt.completion.complete).toBe(false);
    }, TIMEOUT);
    it("N7: when preparation altered a declared input the test command never runs at all", async () => {
        const project = structured(reportScript(GREEN), [["node", "-e", "require('fs').appendFileSync('package.json', ' ')"]]);
        const receipt = await runNative(project);
        expect(receipt.completion.reasons).toContain("preparation modified declared input package.json");
        expect(receipt.execution).toBeUndefined();
        expect(receipt.report).toBeUndefined();
        expect(receipt.cases).toEqual([]);
    }, TIMEOUT);
    it("N8: an artifact gap that persists across stages is reported once", async () => {
        const project = structured(reportScript(GREEN), [["node", "-e", "require('fs').symlinkSync('cli.js', 'dist/link.js')"]]);
        const receipt = await runNative(project);
        const gaps = receipt.completion.reasons.filter(reason => reason.startsWith("input dist/link.js not captured"));
        expect(gaps).toEqual(["input dist/link.js not captured: symbolic link"]);
        expect(receipt.completion.complete).toBe(false);
    }, TIMEOUT);
});

describe("cancellation and services — negative", () => {
    it("N1: cancelling during a preparation step marks the step cancelled in its preview, not ok, and the attempt unavailable", async () => {
        const project = fresh("py");
        writeFileSync(join(project.root, "slow.mjs"), "console.log('started');\nsetInterval(() => {}, 1000);\n");
        setPrepare(project, ["node", "slow.mjs"]);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 1500);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, signal: controller.signal });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.prepare[0]).toMatchObject({ ok: false });
        expect(receipt.prepare[0]!.preview.startsWith("cancelled: ")).toBe(true);
        expect(receipt.cases).toEqual([]);
        expect(status(project)).toBe("unavailable");
    }, TIMEOUT);
    it("N2: cancelling while a contract case runs leaves the run incomplete with the no-trust reason", async () => {
        const project = fresh("py", false);
        const path = join(project.root, "orders_cli.py");
        writeFileSync(path, `import time\ntime.sleep(30)\n${readFileSync(path, "utf8")}`);
        acceptAllContracts(project.root);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 2500);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, signal: controller.signal });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.completion.reasons).toContain("cancelled during contract execution; no case result is trusted");
        expect(receipt.completion.complete).toBe(false);
    }, TIMEOUT);
    it("N3: a service that never becomes ready makes the run incomplete and no case executes", async () => {
        const project = httpFixtureProject();
        projects.push(project);
        editPolicy(project, policy => { (policy.projects[0]!.suites[0]!.services as Array<{ argv: string[] }>)[0]!.argv = ["node", "-e", "process.exit(1)"]; });
        const receipt = await runNative(project);
        expect(receipt.completion.reasons.join("\n")).toMatch(/service api not ready: .*; no case executed/);
        expect(receipt.completion.complete).toBe(false);
        expect(receipt.cases).toEqual([]);
    }, TIMEOUT);
    it("N4: a service that rewrites the contract acceptance while a case runs makes the gap visible in the completion reasons", async () => {
        const project = httpFixtureProject();
        projects.push(project);
        writeFileSync(join(project.root, "svc.mjs"), `import http from "node:http";\nimport fs from "node:fs";\nhttp.createServer((request, response) => {\n    if (request.url === "/health") { response.writeHead(200); response.end("ok"); return; }\n    fs.writeFileSync(".interlinked/contract-policy.json", JSON.stringify({ version: 1, accepted: {} }));\n    response.writeHead(400, { "content-type": "application/json" });\n    response.end(JSON.stringify({ error: "name required" }));\n}).listen(Number(process.argv[2]), "127.0.0.1");\n`);
        editPolicy(project, policy => {
            const target = policy.projects[0]!, inputs = [...(target.protectedInputs as string[]), "svc.mjs"];
            (target.suites[0]!.services as Array<{ argv: string[] }>)[0]!.argv = ["node", "svc.mjs", "{port}"];
            target.protectedInputs = inputs;
            target.scenarios[0]!.affects = inputs;
            target.scenarios[0]!.contractIds = ["orders.invalid"];
        });
        const receipt = await runNative(project);
        expect(receipt.completion.reasons).toContain("Contract definitions or acceptance changed during execution");
        expect(receipt.cases.map(row => row.state)).toEqual(["stale"]);
    }, TIMEOUT);
});

describe("proof modes — the comparison side honors the run", () => {
    const FAULT = { id: "drop-save", path: "orders_cli.py", find: "        json.dump(orders, handle, separators=(\",\", \":\"))", replace: "        pass  # controlled fault", rationale: "persistence is the accepted requirement" };
    function git(root: string, ...args: string[]): void { execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdio: "ignore" }); }
    function repo(): FixtureProject {
        const project = fresh("py");
        git(project.root, "init", "--quiet");
        git(project.root, "add", ".");
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "good");
        return project;
    }
    function setProof(project: FixtureProject, proof: E2eProof): void { editPolicy(project, policy => { policy.projects[0]!.scenarios[0]!.proof = proof; }); }
    it("P1: the comparison snapshot carries the candidate's frozen manifest and acceptance, so a recorded fault is demonstrated against it", async () => {
        const project = repo();
        setProof(project, { mode: "controlled-fault", fault: FAULT, designated: [{ id: "orders.create", outcome: ["files"] }] });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const sensitivity = receiptOf(project, result.receipts[0]!.path).sensitivity?.["order-persists"];
        expect(sensitivity).toMatchObject({ verdict: "demonstrated" });
        expect(sensitivity?.compared.find(row => row.id === "orders.create")?.state).toBe("failed");
    }, TIMEOUT);
    it("P2: the comparison's own preparation already sees the frozen manifest and acceptance, exactly as the candidate's preparation did", async () => {
        const project = repo();
        writeFileSync(join(project.root, "needs-controls.mjs"), `import fs from "node:fs";\nfor (const path of [${JSON.stringify(CONTRACT_MANIFEST)}, ".interlinked/contract-policy.json"]) if (!fs.existsSync(path)) { console.error("missing " + path); process.exit(1); }\n`);
        setPrepare(project, ["node", "needs-controls.mjs"]);
        git(project.root, "add", ".");
        git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "prepare");
        setProof(project, { mode: "controlled-fault", fault: FAULT, designated: [{ id: "orders.create", outcome: ["files"] }] });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.prepare[0]).toMatchObject({ ok: true });
        expect(receipt.sensitivity?.["order-persists"]).toMatchObject({ verdict: "demonstrated" });
    }, TIMEOUT);
    it("N1: a both-pass old-new comparison is not demonstrated, so the attempt is unavailable and the obligation stays open", async () => {
        const project = repo();
        setProof(project, { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["files"] }] });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(receiptOf(project, result.receipts[0]!.path).sensitivity?.["order-persists"]).toMatchObject({ verdict: "not-demonstrated" });
        expect(attempts(project).map(row => row.status)).toEqual(["unavailable"]);
        expect(status(project)).toBe("unavailable");
    }, TIMEOUT);
    it("N2: when the candidate itself fails the designated case no comparison is built", async () => {
        const project = repo();
        injectPersistenceDefect(project);
        setProof(project, { mode: "controlled-fault", fault: FAULT, designated: [{ id: "orders.create", outcome: ["files"] }] });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const sensitivity = receiptOf(project, result.receipts[0]!.path).sensitivity?.["order-persists"];
        expect(sensitivity?.comparison).toMatchObject({ identity: "not-built", description: "the candidate did not pass; no comparison was built" });
        expect(sensitivity?.compared).toEqual([]);
    }, TIMEOUT);
});
