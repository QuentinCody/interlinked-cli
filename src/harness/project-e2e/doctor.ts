import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
    CONTRACT_MANIFEST,
    CONTRACT_POLICY,
    contractDigest,
    readContractFile,
} from "../contracts/paths.js";
import { parseContractManifest, parseContractPolicy } from "../contracts/schema.js";
import type { ContractCase, ContractManifest } from "../contracts/types.js";
import { inspectPlaywright } from "./browser-stage.js";
import { inspectDoctorToolchain } from "./doctor-toolchain.js";
import { readE2eTxns, reduceE2eLedger, type E2eLedgerState } from "./ledger.js";
import { loadE2ePolicy, type E2eProject } from "./policy.js";
import { readE2eReceiptDetailed } from "./receipt.js";
import { projectMappingGaps } from "./reconcile.js";

export interface DoctorCheck {
    id: string;
    status: "ok" | "warn" | "fail";
    detail: string;
    /** Additive v1 fields: absence means evaluated. */
    evaluation?: "not-evaluated";
    prerequisites?: string[];
}
export interface DoctorReport {
    version: 1;
    root: string;
    status: "ok" | "warn" | "fail";
    checks: DoctorCheck[];
    exitCode: 0 | 1 | 2;
}
type LedgerObservation =
    | { state: "available"; rows: number; ledger: E2eLedgerState }
    | { state: "unavailable"; reason: string };
interface ContractReferences {
    resolved: ContractCase[];
    missing: string[];
}

function errorDetail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function notEvaluated(id: string, prerequisite: string, detail: string): DoctorCheck {
    return {
        id,
        status: "warn",
        evaluation: "not-evaluated",
        prerequisites: [prerequisite],
        detail,
    };
}

function observeLedger(root: string): LedgerObservation {
    try {
        const rows = readE2eTxns(root);
        return { state: "available", rows: rows.length, ledger: reduceE2eLedger(rows) };
    } catch (error) {
        return { state: "unavailable", reason: errorDetail(error) };
    }
}

function manifestCheck(
    project: E2eProject,
    projectRoot: string,
): {
    check: DoctorCheck;
    manifest: ContractManifest | null;
} {
    const id = `${project.id}:manifest`;
    const path = project.contractManifest ?? CONTRACT_MANIFEST;
    try {
        const manifest = parseContractManifest(readContractFile(projectRoot, path));
        return { check: { id, status: "ok", detail: `${path} parses` }, manifest };
    } catch (error) {
        const detail = `${path}: ${errorDetail(error)}; author it or run interlinked tests contracts import <doc>`;
        return { check: { id, status: "fail", detail }, manifest: null };
    }
}

function resolveReferences(project: E2eProject, manifest: ContractManifest): ContractReferences {
    const declared = new Map(manifest.cases.map((row) => [row.id, row]));
    const resolved = new Map<string, ContractCase>();
    const missing: string[] = [];
    for (const scenario of project.scenarios) {
        for (const id of scenario.contractIds) {
            const row = declared.get(id);
            if (row) {
                resolved.set(id, row);
            } else {
                missing.push(`${scenario.id} → ${id}`);
            }
        }
    }
    return { resolved: [...resolved.values()], missing };
}

function contractsCheck(project: E2eProject, references: ContractReferences | null): DoctorCheck {
    const id = `${project.id}:contracts`;
    if (!references) {
        return notEvaluated(
            id,
            `${project.id}:manifest`,
            "no manifest to resolve scenario contractIds against",
        );
    }
    if (references.missing.length) {
        return {
            id,
            status: "fail",
            detail: `scenario contractIds not declared in the manifest: ${references.missing.join(", ")}`,
        };
    }
    return {
        id,
        status: "ok",
        detail: `${project.scenarios.length} scenario(s) resolve to declared cases`,
    };
}

function acceptanceCheck(
    project: E2eProject,
    projectRoot: string,
    references: ContractReferences | null,
): DoctorCheck {
    const id = `${project.id}:acceptance`;
    if (!references || references.missing.length) {
        return notEvaluated(
            id,
            `${project.id}:contracts`,
            "acceptance not evaluated; resolve all required contract references first",
        );
    }
    let accepted: Record<string, string> = {};
    try {
        if (existsSync(join(projectRoot, CONTRACT_POLICY))) {
            accepted = parseContractPolicy(readContractFile(projectRoot, CONTRACT_POLICY)).accepted;
        }
    } catch (error) {
        return { id, status: "fail", detail: `${CONTRACT_POLICY}: ${errorDetail(error)}` };
    }
    const proposed = references.resolved.filter(
        (row) => !Object.hasOwn(accepted, contractDigest(row)),
    );
    if (proposed.length) {
        const ids = proposed.map((row) => row.id).join(", ");
        return {
            id,
            status: "warn",
            detail: `${proposed.length} required case(s) still proposed (unaccepted): ${ids}; a green run stays review-required until an expectation covering them is accepted`,
        };
    }
    return { id, status: "ok", detail: "every required case has configured acceptance" };
}

function receiptsCheck(
    root: string,
    project: E2eProject,
    observation: LedgerObservation,
): DoctorCheck {
    const id = `${project.id}:receipts`;
    if (observation.state === "unavailable") {
        return notEvaluated(
            id,
            "ledger",
            "receipt validation not evaluated; ledger observation unavailable",
        );
    }
    const issues: string[] = [];
    let seen = 0;
    for (const state of observation.ledger.values()) {
        if (!state.key.startsWith(`${project.id}/`) || !state.lastReceipt) {
            continue;
        }
        seen += 1;
        const read = readE2eReceiptDetailed(root, state.lastReceipt);
        if (read.issue !== undefined) {
            issues.push(
                `${state.key}: ${state.lastReceipt} could not be validated (${read.issue})`,
            );
        }
    }
    if (issues.length) {
        return { id, status: "fail", detail: issues.join("; ") };
    }
    return { id, status: "ok", detail: `${seen} latest receipt(s) parse strictly` };
}

function mappingCheck(root: string, project: E2eProject): DoctorCheck {
    const id = `${project.id}:mapping`;
    const gaps = projectMappingGaps(root, project);
    if (gaps.length) {
        const paths = gaps.map((gap) => gap.issue ?? gap.path).join(", ");
        return {
            id,
            status: "warn",
            detail: `${gaps.length} protected input(s) unmapped or uncaptured: ${paths}`,
        };
    }
    return { id, status: "ok", detail: "every protected input maps to a scenario" };
}

function browserChecks(project: E2eProject, projectRoot: string): DoctorCheck[] {
    const suites = project.suites.filter((suite) => suite.adapter === "playwright");
    if (!suites.length) {
        return [];
    }
    const inspected = inspectPlaywright(projectRoot);
    const status = inspected.ok ? "ok" : "fail";
    const detail = inspected.ok
        ? `@playwright/test ${inspected.version} resolvable from the project`
        : inspected.reason;
    return suites.map((suite) => ({ id: `${project.id}:${suite.id}:playwright`, status, detail }));
}

function projectChecks(
    root: string,
    project: E2eProject,
    ledger: LedgerObservation,
): DoctorCheck[] {
    const projectRoot = project.root === "." ? root : join(root, project.root);
    if (!existsSync(projectRoot) || !lstatSync(projectRoot).isDirectory()) {
        return [
            {
                id: `${project.id}:root`,
                status: "fail",
                detail: `project root ${project.root} does not exist under ${root}`,
            },
        ];
    }
    const { check, manifest } = manifestCheck(project, projectRoot);
    const references = manifest ? resolveReferences(project, manifest) : null;
    const checks: DoctorCheck[] = [
        { id: `${project.id}:root`, status: "ok", detail: projectRoot },
        check,
    ];
    checks.push(
        contractsCheck(project, references),
        acceptanceCheck(project, projectRoot, references),
    );
    checks.push(
        inspectDoctorToolchain(project, projectRoot, {
            manifest,
            referencesResolved: references !== null && references.missing.length === 0,
        }),
    );
    checks.push(...browserChecks(project, projectRoot), mappingCheck(root, project));
    checks.push(receiptsCheck(root, project, ledger));
    return checks;
}

function ledgerCheck(observation: LedgerObservation): DoctorCheck {
    if (observation.state === "unavailable") {
        return { id: "ledger", status: "fail", detail: observation.reason };
    }
    return { id: "ledger", status: "ok", detail: `${observation.rows} ledger row(s) readable` };
}

function reportStatus(checks: DoctorCheck[]): DoctorReport["status"] {
    if (checks.some((check) => check.status === "fail")) {
        return "fail";
    }
    if (checks.some((check) => check.status === "warn")) {
        return "warn";
    }
    return "ok";
}

/** Diagnose from shared observations; never runs a suite. */
export function doctorE2e(root: string, options: { projectId?: string } = {}): DoctorReport {
    const loaded = loadE2ePolicy(root);
    if (loaded.status !== "configured") {
        const detail =
            loaded.status === "unconfigured"
                ? "no .interlinked/e2e-policy.json; run interlinked tests e2e discover, review the proposal, then tests e2e adopt --from <report.json>"
                : `policy invalid: ${loaded.reason}`;
        return {
            version: 1,
            root,
            status: "fail",
            checks: [{ id: "policy", status: "fail", detail }],
            exitCode: 2,
        };
    }
    const projects = options.projectId
        ? loaded.policy.projects.filter((project) => project.id === options.projectId)
        : loaded.policy.projects;
    if (options.projectId && !projects.length) {
        throw new Error(`e2e doctor: unknown project ${options.projectId}`);
    }
    const ledger = observeLedger(root);
    const detail = `${loaded.policy.projects.length} project(s), digest ${loaded.digest.slice(0, 12)}`;
    const checks: DoctorCheck[] = [{ id: "policy", status: "ok", detail }, ledgerCheck(ledger)];
    for (const project of projects) {
        checks.push(...projectChecks(root, project, ledger));
    }
    const status = reportStatus(checks);
    return { version: 1, root, status, checks, exitCode: status === "fail" ? 1 : 0 };
}

export function formatDoctor(report: DoctorReport): string[] {
    const lines = report.checks.map(
        (check) => `[${check.evaluation ?? check.status}] ${check.id} — ${check.detail}`,
    );
    lines.push(
        `e2e doctor: ${report.status}. Next: interlinked tests e2e check (verdict) or interlinked tests e2e run (supervised execution). exit ${report.exitCode}`,
    );
    return lines;
}
