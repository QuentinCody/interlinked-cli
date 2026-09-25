// ===========================================
// Suite parsing — managed-contracts, structured-runner, playwright
// ===========================================
// Extracted from policy.ts (line cap). A suite declares how a scenario's
// cases are EXECUTED: portable contracts through owned services, an arbitrary
// test command that writes a JSON/JUnit report, or (Unit E2, plan §10.2
// "Playwright + managed application") Playwright driving a browser against
// an application the supervisor OWNS — the adapter forces the JSON reporter
// and serial workers so every case's requests can be attributed.

import type { E2eArgvStep, E2eService, E2eSuite, ReportFormat } from "./policy.js";
import { argvStep, checkPlaceholders, fail, globList, id, oneOf, onlyKeys, record, relativePath, SERVICE_PLACEHOLDERS, stringList, unique } from "./policy-primitives.js";

const MAX_SERVICES = 4;
const READY_STATUS = [100, 599] as const;
const PLAYWRIGHT_RUN: E2eArgvStep = { argv: ["npx", "playwright", "test"] };
const PLAYWRIGHT_REPORT = { format: "playwright" as const, path: "playwright-report.json" };

function reportSpec(value: unknown, where: string, formats: readonly ReportFormat[]): { format: ReportFormat; path: string } {
    const row = record(value, where);
    onlyKeys(row, ["format", "path"], where);
    return { format: oneOf(row.format, formats, `${where}.format`), path: relativePath(row.path, `${where}.path`) };
}
/** structured-runner (Unit C): the test command and the report it writes are both mandatory; nothing is inferred from the tree. */
function structuredSuite(row: Record<string, unknown>, where: string, result: E2eSuite): void {
    if (row.run === undefined) fail(`${where}.run (the test command argv) is required for a structured-runner suite`);
    if (row.report === undefined) fail(`${where}.report ({format: json|junit, path}) is required for a structured-runner suite`);
    result.run = argvStep(row.run, `${where}.run`);
    result.report = reportSpec(row.report, `${where}.report`, ["json", "junit"]);
}
/** playwright (Unit E2): `npx playwright test` by default; the report is always Playwright's own JSON (the adapter forces `--reporter=json`). */
function playwrightSuite(row: Record<string, unknown>, where: string, result: E2eSuite): void {
    result.run = row.run === undefined ? { argv: [...PLAYWRIGHT_RUN.argv] } : argvStep(row.run, `${where}.run`);
    result.report = row.report === undefined ? { ...PLAYWRIGHT_REPORT } : reportSpec(row.report, `${where}.report`, ["playwright"]);
}
function serviceEnv(value: unknown, where: string): Record<string, string> {
    const row = record(value, where);
    const env: Record<string, string> = {};
    for (const [key, item] of Object.entries(row)) {
        if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key)) fail(`${where}.${key} is not an environment variable name`);
        if (typeof item !== "string" || item.includes("\0")) fail(`${where}.${key} must be a string`);
        checkPlaceholders(item, `${where}.${key}`, SERVICE_PLACEHOLDERS);
        env[key] = item;
    }
    return env;
}
function service(value: unknown, where: string): E2eService {
    const row = record(value, where);
    onlyKeys(row, ["id", "argv", "env", "ready"], where);
    const argv = stringList(row.argv, `${where}.argv`, 128);
    if (!argv.length) fail(`${where}.argv must not be empty`);
    for (const token of argv) checkPlaceholders(token, `${where}.argv`, SERVICE_PLACEHOLDERS);
    const ready = record(row.ready, `${where}.ready`);
    onlyKeys(ready, ["kind", "path", "status"], `${where}.ready`);
    if (typeof ready.path !== "string" || !ready.path.startsWith("/") || ready.path.includes("\0")) fail(`${where}.ready.path must be an absolute HTTP path`);
    if (typeof ready.status !== "number" || !Number.isInteger(ready.status) || ready.status < READY_STATUS[0] || ready.status > READY_STATUS[1]) fail(`${where}.ready.status must be an HTTP status from ${READY_STATUS[0]} to ${READY_STATUS[1]}`);
    const result: E2eService = { id: id(row.id, where), argv, ready: { kind: oneOf(ready.kind, ["http"], `${where}.ready.kind`), path: ready.path, status: ready.status } };
    if (row.env !== undefined) result.env = serviceEnv(row.env, `${where}.env`);
    return result;
}
function services(value: unknown, where: string): E2eService[] {
    if (!Array.isArray(value) || !value.length || value.length > MAX_SERVICES) fail(`${where} must be a list of 1 to ${MAX_SERVICES} owned services`);
    const result = value.map((item, index) => service(item, `${where}[${index}]`));
    unique(result.map(item => item.id), where);
    return result;
}
function adapterFields(row: Record<string, unknown>, where: string, result: E2eSuite): void {
    if (result.adapter === "structured-runner") structuredSuite(row, where, result);
    else if (result.adapter === "playwright") playwrightSuite(row, where, result);
    else if (row.run !== undefined || row.report !== undefined) fail(`${where}: run/report belong to a structured-runner or playwright suite`);
}
export function parseSuite(value: unknown, where: string): E2eSuite {
    const row = record(value, where);
    onlyKeys(row, ["id", "adapter", "prepare", "artifacts", "run", "report", "services"], where);
    const result: E2eSuite = { id: id(row.id, where), adapter: oneOf(row.adapter, ["managed-contracts", "structured-runner", "playwright"], `${where}.adapter`) };
    if (row.prepare !== undefined) {
        if (!Array.isArray(row.prepare) || row.prepare.length > 16) fail(`${where}.prepare must be at most 16 argv steps`);
        result.prepare = row.prepare.map((step, index) => argvStep(step, `${where}.prepare[${index}]`));
    }
    if (row.artifacts !== undefined) result.artifacts = globList(row.artifacts, `${where}.artifacts`);
    adapterFields(row, where, result);
    if (row.services !== undefined) {
        if (result.adapter === "structured-runner") fail(`${where}.services: owned services are driven by portable contracts or a browser; a structured-runner suite cannot bind them (declare a managed-contracts or playwright suite for boundary evidence)`);
        result.services = services(row.services, `${where}.services`);
    }
    if (result.adapter === "playwright" && !result.services) fail(`${where}.services: a playwright suite must OWN the application its browser drives; declare the app as a service (argv with {port}, an HTTP readiness path)`);
    return result;
}
