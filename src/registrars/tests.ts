import { type Command, type OptionValues } from "commander";

function registerContracts(tests: Command): void {
    const contracts = tests.command("contracts").description("Inspect provenance or explicitly execute portable behavioral contracts");
    contracts.command("import <source>")
        .description("Print proposed cases from explicit json interlinked-contract fences; never execute")
        .option("--cwd <path>", "Project root").option("--json", "Machine-readable proposed manifest")
        .action(async (source: string, options: OptionValues) => {
            const { testsContractsCommand } = await import("../commands/tests-contracts.js");
            await testsContractsCommand("import", { ...options, source });
        });
    for (const action of ["inspect", "run"] as const) {
        contracts.command(action)
            .description(action === "run" ? "Execute declared runners and retain per-case receipts" : "Inspect provenance and configured acceptance without execution")
            .option("--cwd <path>", "Project root")
            .option("--file <path>", "Project-relative contract manifest", ".interlinked/behavioral-contracts.json")
            .option("--previous <path>", "Prior manifest whose cases also run against current implementation")
            .option("--timeout <ms>", "Total admission and execution budget", "60000")
            .option("--json", "Machine-readable contract evidence")
            .action(async (options: OptionValues) => {
                const { testsContractsCommand } = await import("../commands/tests-contracts.js");
                await testsContractsCommand(action, options);
            });
    }
}

function withSelection(command: Command): Command {
    return command.option("--cwd <path>", "Repository root").option("--project <id>", "Limit to one declared project")
        .option("--scenario <id>", "Limit to a scenario (repeatable)", (value: string, previous: string[] = []) => [...previous, value])
        .option("--json", "Machine-readable verdicts with reason codes");
}
const repeatable = (value: string, previous: string[] = []) => [...previous, value];
/** Adoption workflow (plan 31 §5.1): inspect → propose → show gaps → write only what was selected. */
/** §13 reviewed policy changes (Unit F3): the replacement record that discharges a weakening between a trusted base and the current policy. */
function registerE2ePolicy(e2e: Command): void {
    const policy = e2e.command("policy").description("Reviewed policy changes (plan §13): record the replacement that discharges a weakening between a trusted base and the current policy");
    policy.command("replace").description("Record a reviewed requirement change binding the exact base and head policy digests (exit 0; 2 refused)")
        .option("--cwd <path>", "Repository root").option("--base <rev>", "Trusted base revision").option("--project <id>", "Project the change belongs to")
        .option("--scenario <id>", "Scenario replaced or removed; absent ⇒ the whole project", (value: string, previous: string[] = []) => [...previous, value])
        .option("--rationale <text>", "Why the requirement changed").option("--json", "Machine-readable record")
        .action(async (options: OptionValues) => { const { testsE2ePolicyCommand } = await import("../commands/tests-e2e.js"); await testsE2ePolicyCommand("replace", options); });
}
/** §12 git gates (Unit F4): explicitly installed hooks that CHECK the exact target; they never run a suite. */
function registerE2eGate(e2e: Command): void {
    const gate = e2e.command("gate").description("Git hooks that CHECK qualifying e2e evidence for the exact staged bytes (pre-commit) and each pushed revision (pre-push); explicit install, chained with existing hooks, never a run");
    gate.command("install").description("Install the pre-commit and pre-push checks (an existing hook is backed up and chained; exit 0; 2 refused)")
        .option("--cwd <path>", "Repository root").option("--no-commit", "Skip the pre-commit hook").option("--no-push", "Skip the pre-push hook").option("--json", "Machine-readable result")
        .action(async (options: OptionValues) => { const { testsE2eGateCommand } = await import("../commands/tests-e2e.js"); await testsE2eGateCommand("install", options); });
    for (const action of ["status", "uninstall"] as const) {
        gate.command(action).description(action === "status" ? "Report which gate hooks are installed" : "Remove the gate hooks and restore any chained originals")
            .option("--cwd <path>", "Repository root").option("--json", "Machine-readable result")
            .action(async (options: OptionValues) => { const { testsE2eGateCommand } = await import("../commands/tests-e2e.js"); await testsE2eGateCommand(action, options); });
    }
}
function registerE2eAdoption(e2e: Command): void {
    const adoption = (name: string, description: string) => e2e.command(name).description(description).option("--cwd <path>", "Repository root").option("--json", "Machine-readable output");
    adoption("discover", "Inspect the repository read-only: projects, build/test commands, executables, contract cases, proposed scenarios and gaps (exit 0)")
        .option("--out <file>", "Write the full report; the input to `tests e2e adopt --from`")
        .action(async (options: OptionValues) => { const { testsE2eAdoptionCommand } = await import("../commands/tests-e2e-adopt.js"); await testsE2eAdoptionCommand("discover", options); });
    adoption("surfaces", "Inventory addressable entry points (bins, scripts, OpenAPI JSON operations) and map them to scenario surfaceIds (exit 0; 2 unconfigured)")
        .option("--write", "Persist the inventory to .interlinked/test-runs/e2e/discovery/surfaces.json")
        .action(async (options: OptionValues) => { const { testsE2eAdoptionCommand } = await import("../commands/tests-e2e-adopt.js"); await testsE2eAdoptionCommand("surfaces", options); });
    adoption("adopt", "Write .interlinked/e2e-policy.json from a reviewed report: selected projects/scenarios only, advisory unless --mode required, expectations never adopted (exit 0; 1 refused; 2 usage)")
        .option("--from <file>", "Discovery report (tests e2e discover --out) or policy document")
        .option("--project <id>", "Adopt only this project (repeatable)", repeatable)
        .option("--scenario <id>", "Adopt only this scenario (repeatable)", repeatable)
        .option("--mode <mode>", "advisory (default) or required — required must be explicit")
        .option("--replace", "Overwrite an existing policy (discarded, not merged)")
        .action(async (options: OptionValues) => { const { testsE2eAdoptionCommand } = await import("../commands/tests-e2e-adopt.js"); await testsE2eAdoptionCommand("adopt", options); });
    adoption("doctor", "Diagnose policy, contracts, acceptance, toolchain, mapping, ledger and receipt prerequisites without running anything (exit 0 ok/warn; 1 fail; 2 invalid policy)")
        .option("--project <id>", "Limit to one declared project", repeatable)
        .action(async (options: OptionValues) => { const { testsE2eAdoptionCommand } = await import("../commands/tests-e2e-adopt.js"); await testsE2eAdoptionCommand("doctor", options); });
}
function registerE2e(tests: Command): void {
    const e2e = tests.command("e2e").description("Project-aware end-to-end scenarios: declared policy, supervised runs, receipts and one qualification verdict");
    const descriptions = {
        status: "Show scenario obligations and observed results (inspection; exit 0)",
        plan: "Explain required scenarios, their generation and the next command (inspection; exit 0)",
        run: "Supervised execution of pending/selected scenarios; writes receipts (exit 0/1/2)",
        check: "Validate qualifying evidence for the current working tree without running a suite (exit 0 satisfied, 1 open, 2 unconfigured/unavailable)",
        qualify: "Run one scenario's stability cohort: independent supervised attempts, every attempt published; mixed results quarantine the generation (exit 0 qualified, 1 mixed/failed/quarantined, 2 deferred/unavailable)",
    } as const;
    for (const action of ["status", "plan", "run", "check", "qualify"] as const) {
        const command = withSelection(e2e.command(action).description(descriptions[action]));
        if (action === "run" || action === "qualify") command.option("--timeout <ms>", "Total admission, preparation and execution budget", "120000");
        if (action === "qualify") command.option("--runs <n>", "Independent attempts when the scenario declares no stability profile (1–5)");
        if (action === "check") command.option("--staged", "Judge the exact staged bytes (index), not the working tree; an unstaged fix does not count").option("--revision <rev>", "Judge an exact commit's bytes (pre-push / CI); refs resolve in this repository").option("--base <rev>", "Trusted base whose policy the judged policy is compared with; a weakening without a reviewed replacement exits 1 (never proof.revision)").option("--gate <name>", "commit|ci: honour the project's gates.<name> — warn/off report without failing");
        command.action(async (options: OptionValues) => {
            const { testsE2eCommand } = await import("../commands/tests-e2e.js");
            await testsE2eCommand(action, options);
        });
    }
    e2e.command("scaffold <name>").description("Propose one scenario with an explicit-assumption test skeleton (deliberate failure, never a pass); prints the policy snippet, writes files only with --write, never the policy")
        .option("--cwd <path>", "Repository root").option("--project <id>", "Project when the policy declares several").option("--suite <id>", "Suite when the project declares several").option("--write", "Create the skeleton files (refuses to overwrite)").option("--json", "Machine-readable output")
        .action(async (name: string, options: OptionValues) => { const { testsE2eScaffoldCommand } = await import("../commands/tests-e2e.js"); await testsE2eScaffoldCommand(name, options); });
    registerE2eAdoption(e2e);
    registerE2ePolicy(e2e);
    registerE2eGate(e2e);
    withSelection(e2e.command("ci").description("CI lane: a FRESH supervised run of the selected scenarios, then the same check against the CI event's base (GitHub/GitLab) or --base; receipts this job did not produce are never evidence (exit 0 satisfied, 1 open/weakened, 2 unconfigured/unavailable)"))
        .option("--base <rev>", "Trusted base revision; overrides the CI event").option("--revision <rev>", "Candidate commit to export and run (default: the CI event's sha, else HEAD); the working tree is never the candidate").option("--timeout <ms>", "Total admission, preparation and execution budget", "120000")
        .action(async (options: OptionValues) => { const { testsE2eCiCommand } = await import("../commands/tests-e2e.js"); await testsE2eCiCommand(options); });
    const expectations = e2e.command("expectations").description("Draft, review, accept, replace or dispute behavioral expectations (configured decisions, not human approval)");
    for (const action of ["propose", "review", "accept", "replace", "dispute"] as const) {
        const command = expectations.command(action).description(action === "review" ? "List live expectations with questions, source provenance and replacement diffs" : `${action} an expectation from a validated interchange file`)
            .option("--cwd <path>", "Repository root").option("--json", "Machine-readable records");
        if (action !== "review") command.option("--from <file>", "Interchange JSON: a draft (propose) or a decision bound to an exact revision");
        command.action(async (options: OptionValues) => {
            const { testsE2eExpectationsCommand } = await import("../commands/tests-e2e.js");
            await testsE2eExpectationsCommand(action, options);
        });
    }
}

export function registerTestsCommands(program: Command): void {
    const tests = program.command("tests").description("Explain and run affected tests with bounded scheduling and snapshot validation");
    registerContracts(tests);
    registerE2e(tests);
    tests.command("review [paths...]")
        .description("Review changed source, behavioral obligations and bounded simplification candidates without running tests")
        .option("--cwd <path>", "Project root")
        .option("--base <ref>", "Revision for automatic changed-file discovery", "HEAD")
        .option("--json", "Machine-readable review scope and missing evidence")
        .action(async (paths: string[], options: OptionValues) => {
            const { testsReviewCommand } = await import("../commands/tests-review.js");
            testsReviewCommand(paths, options);
        });
    tests.command("readiness <language>")
        .description("Inspect test prerequisites without installing; Python also reports approved provisioning argv")
        .option("--cwd <path>", "Project root")
        .option("--json", "Machine-readable readiness and missing prerequisites")
        .action(async (language: string, options: OptionValues) => {
            const { testsReadinessCommand } = await import("../commands/tests-readiness.js");
            await testsReadinessCommand(language, options);
        });
    tests.command("suite <language>")
        .description("Run a bounded project suite: typescript, javascript, python, rust or go")
        .option("--cwd <path>", "Project root")
        .option("--timeout <ms>", "Total admission and execution budget", "60000")
        .option("--json", "Machine-readable execution evidence")
        .action(async (language: string, options: OptionValues) => {
            const { testsSuiteCommand } = await import("../commands/tests-suite.js");
            await testsSuiteCommand(language, options);
        });
    const descriptions = { plan: "Explain the union of affected tests without running assertions",
        run: "Run pending and affected tests; retain newer edits for another run", status: "Show pending requests and the last observed test job" };
    for (const kind of ["plan", "run", "status"] as const) {
        tests.command(`${kind} [paths...]`)
            .description(descriptions[kind])
            .option("--cwd <path>", "Project root")
            .option("--base <ref>", "Compare tracked changes against this revision", "HEAD")
            .option("--all", "Run the full suite for reconciliation")
            .option("--timeout <ms>", "Total planning, admission and execution budget", "60000")
            .option("--workers <count>", "Maximum workers, also bounded by available memory", "2")
            .option("--json", "Machine-readable test plan or execution")
            .action(async (paths: string[], options: OptionValues) => {
                const { testsCommand } = await import("../commands/tests.js");
                await testsCommand(kind, paths, options);
            });
    }
}
