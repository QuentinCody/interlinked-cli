import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { matchesAnyGlob } from "../../lib/path-glob.js";
import type { ContractManifest } from "../contracts/types.js";
import type { DoctorCheck } from "./doctor.js";
import type { E2eProject, E2eSuite } from "./policy.js";

interface CommandRequirement {
    token: string;
    suite: E2eSuite;
    phase: "prepare" | "contract" | "run" | "service";
    origin: string;
    path: string;
}
interface CommandObservation {
    state: "available" | "missing" | "expected" | "unavailable";
    detail: string;
}
export interface DoctorContractInput {
    manifest: ContractManifest | null;
    referencesResolved: boolean;
}

function preparationRequirements(suite: E2eSuite): CommandRequirement[] {
    const requirements: CommandRequirement[] = [];
    for (const [index, step] of (suite.prepare ?? []).entries()) {
        const token = step.argv[0];
        if (token) {
            requirements.push({
                token,
                suite,
                phase: "prepare",
                origin: `${suite.id} prepare[${index}]`,
                path: process.env.PATH ?? "/usr/bin:/bin",
            });
        }
    }
    return requirements;
}

function suiteRequirements(suite: E2eSuite): CommandRequirement[] {
    const requirements = preparationRequirements(suite);
    const runToken = suite.run?.argv[0];
    if (runToken) {
        requirements.push({
            token: runToken,
            suite,
            phase: "run",
            origin: `${suite.id} run`,
            path: process.env.PATH ?? "/usr/bin:/bin",
        });
    }
    for (const service of suite.services ?? []) {
        const token = service.argv[0];
        if (token) {
            requirements.push({
                token,
                suite,
                phase: "service",
                origin: `${suite.id} service ${service.id}`,
                path: service.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin",
            });
        }
    }
    return requirements;
}

function commandRequirements(
    project: E2eProject,
    manifest: ContractManifest | null,
): CommandRequirement[] {
    const requirements: CommandRequirement[] = [];
    const suites = new Map(project.suites.map((suite) => [suite.id, suite]));
    const cases = new Map(manifest?.cases.map((row) => [row.id, row]));
    for (const suite of project.suites) {
        requirements.push(...suiteRequirements(suite));
    }
    for (const scenario of project.scenarios) {
        const suite = suites.get(scenario.suite);
        if (!suite) {
            continue;
        }
        for (const id of scenario.contractIds) {
            const row = cases.get(id);
            if (row?.runner.kind !== "process") {
                continue;
            }
            const token = row.runner.argv[0];
            if (token) {
                requirements.push({
                    token,
                    suite,
                    phase: "contract",
                    origin: `${suite.id}/${scenario.id}/${id}`,
                    path: process.env.PATH ?? "/usr/bin:/bin",
                });
            }
        }
    }
    return requirements;
}

function executableFile(path: string): boolean {
    try {
        if (!statSync(path).isFile()) {
            return false;
        }
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function commandCandidates(projectRoot: string, requirement: CommandRequirement): string[] {
    if (isAbsolute(requirement.token) || requirement.token.includes("/")) {
        return [resolve(projectRoot, requirement.token)];
    }
    return requirement.path
        .split(delimiter)
        .map((directory) => resolve(projectRoot, directory, requirement.token));
}

function expectedArtifact(projectRoot: string, requirement: CommandRequirement): boolean {
    if (requirement.phase === "prepare" || !requirement.suite.prepare?.length) {
        return false;
    }
    // Bare commands use PATH; a project artifact does not establish that lookup.
    if (!isAbsolute(requirement.token) && !requirement.token.includes("/")) {
        return false;
    }
    const local = relative(projectRoot, resolve(projectRoot, requirement.token)).replaceAll(
        "\\",
        "/",
    );
    if (local.startsWith("../") || isAbsolute(local)) {
        return false;
    }
    return matchesAnyGlob(local, requirement.suite.artifacts ?? []);
}

function inspectCommand(projectRoot: string, requirement: CommandRequirement): CommandObservation {
    const label = `${requirement.origin}: ${requirement.token}`;
    if (process.platform === "win32" || /\{[^}]+\}/.test(requirement.token + requirement.path)) {
        return {
            state: "unavailable",
            detail: `${label} needs runtime/platform-specific command resolution`,
        };
    }
    if (commandCandidates(projectRoot, requirement).some(executableFile)) {
        return { state: "available", detail: `${label} executable at inspection time` };
    }
    if (
        !existsSync(resolve(projectRoot, requirement.token)) &&
        expectedArtifact(projectRoot, requirement)
    ) {
        return {
            state: "expected",
            detail: `${label} absent; declared artifact expected after ${requirement.suite.id} preparation, not verified`,
        };
    }
    return {
        state: "missing",
        detail: `${label} not an executable file under the runner's PATH/cwd; install it or fix the argv`,
    };
}

/** Keep each command's originating suite and execution phase through validation. */
export function inspectDoctorToolchain(
    project: E2eProject,
    projectRoot: string,
    contracts: DoctorContractInput,
): DoctorCheck {
    const observations = commandRequirements(project, contracts.manifest).map((requirement) =>
        inspectCommand(projectRoot, requirement),
    );
    const missing = observations.filter((observation) => observation.state === "missing");
    const pending = observations.filter(
        (observation) => observation.state === "expected" || observation.state === "unavailable",
    );
    const id = `${project.id}:toolchain`;
    if (missing.length) {
        return {
            id,
            status: "fail",
            detail: missing.map((observation) => observation.detail).join("; "),
        };
    }
    if (!contracts.referencesResolved) {
        const prerequisite = contracts.manifest ? "contracts" : "manifest";
        return {
            id,
            status: "warn",
            evaluation: "not-evaluated",
            prerequisites: [`${project.id}:${prerequisite}`],
            detail: "contract commands not fully evaluated; resolve the manifest and all required references",
        };
    }
    if (pending.length) {
        return {
            id,
            status: "warn",
            detail: pending.map((observation) => observation.detail).join("; "),
        };
    }
    return {
        id,
        status: "ok",
        detail: `${observations.length} command requirement(s) executable at inspection time; execution rechecks availability`,
    };
}
