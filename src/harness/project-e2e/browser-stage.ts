// ===========================================
// Browser stage — Playwright against an OWNED application (Unit E2, §10.2)
// ===========================================
// The supervisor owns the app (a declared service), fronts it with its own
// recording proxy, runs the project's Playwright command SERIALLY with the
// JSON reporter forced, normalizes the report (first attempt counts, PE-27)
// and credits each declared case exactly the requests the proxy saw inside
// that case's attempt window. A browser test that never reaches the app
// earns no boundary; a missing toolchain is a named gap with guidance
// (PE-24), never an install and never a pass. Run primitives (services,
// command, report) are injected so this module never imports the runner.

import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { digestOf, type ReportFormat } from "./policy.js";
import { startRecordingProxy, type ProxyRequest } from "./proxy.js";
import type { ReceiptCase } from "./receipt.js";
import type { OwnedService } from "./services.js";
import type { StructuredCase, StructuredReport, StructuredStatus } from "./structured-report.js";

const PLAYWRIGHT_PACKAGE = join("node_modules", "@playwright", "test", "package.json");
const REPORT_ENV = "PLAYWRIGHT_JSON_OUTPUT_NAME";
const BASE_URL_ENV = "INTERLINKED_E2E_BASE_URL";
/** Serial workers make each case's window its own; `--retries=0` makes the first attempt the ONLY attempt (PE-27), so a window never holds a retry's requests. */
const FORCED_ARGS = ["--reporter=json", "--workers=1", "--retries=0"];
const MAX_LISTED_REQUESTS = 8;
const MAX_OBSERVATIONS = 64;
export type PlaywrightInspection = { ok: true; version: string } | { ok: false; reason: string };
export interface BrowserStageDeps {
    snapshot: string; serviceId: string; declared: Set<string>; runArgv: string[]; reportPath: string;
    /** The receipt's completion reasons and case list (appended in place). */ reasons: string[]; cases: ReceiptCase[];
    startServices(): Promise<Map<string, OwnedService>>; stopServices(owned: Map<string, OwnedService>): Promise<boolean>;
    runCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<{ exitCode: number | null } | null>; readReport(): Promise<StructuredReport | null>;
}

const STRUCTURED_STATE: Record<StructuredStatus, ReceiptCase["state"]> = { passed: "passed", failed: "failed", error: "failed", skipped: "unavailable", todo: "unavailable" };
/** A native report case as receipt evidence: execution only, digest bound to the report format and id (C2). */
export function structuredCase(format: ReportFormat, row: StructuredCase): ReceiptCase {
    const details = row.message ? [row.message] : [];
    if (row.status === "skipped" || row.status === "todo") details.push(`${row.status}: not a required pass`);
    return { id: row.id, digest: digestOf(`${format}\0${row.id}`), authority: "configured", provenance: "matched", state: STRUCTURED_STATE[row.status], runnerKind: "structured", details };
}
/** PE-24: the toolchain is inspected in the snapshot, never installed; absence is a named gap the operator resolves. */
export function inspectPlaywright(snapshot: string): PlaywrightInspection {
    const path = join(snapshot, PLAYWRIGHT_PACKAGE);
    const guidance = "install @playwright/test in the project (allowlist-gated) and its browsers with `npx playwright install`, then rerun";
    if (!existsSync(path)) return { ok: false, reason: `@playwright/test is not installed in the project (no ${PLAYWRIGHT_PACKAGE}); ${guidance}` };
    try {
        const version = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version; // SAFETY: shape-checked below
        return typeof version === "string" ? { ok: true, version } : { ok: false, reason: `${PLAYWRIGHT_PACKAGE} declares no version; ${guidance}` };
    } catch (error) { return { ok: false, reason: `${PLAYWRIGHT_PACKAGE} unreadable: ${error instanceof Error ? error.message : String(error)}; ${guidance}` }; }
}
/** Playwright's default browser cache for a platform and the REAL home (the run's HOME is private, so the toolchain location must be passed explicitly, like CARGO_HOME). */
export function defaultBrowsersPath(platform: NodeJS.Platform, home: string, localAppData?: string): string {
    if (platform === "darwin") return join(home, "Library", "Caches", "ms-playwright");
    if (platform === "win32") return join(localAppData ?? join(home, "AppData", "Local"), "ms-playwright");
    return join(home, ".cache", "ms-playwright");
}
/** Explicit `PLAYWRIGHT_BROWSERS_PATH` wins; otherwise the cache under the ACCOUNT home (passwd, `userInfo().homedir`) — `HOME` may be a private sandbox (vitest's home-sandbox, the run's own HOME) and then `homedir()` points nowhere useful. */
function browsersPath(): string | undefined {
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
    const homes = [...new Set([accountHome(), homedir()])];
    return homes.map(home => defaultBrowsersPath(process.platform, home, process.env.LOCALAPPDATA)).find(path => existsSync(path));
}
function accountHome(): string { try { return userInfo().homedir; } catch { return homedir(); } }
export interface PlaywrightCommandOptions { reportPath: string; baseUrl: string; browsersPath?: string; }
/** The project's command with the reporter and serial workers FORCED (a user reporter cannot replace the evidence; parallel workers would blur the request windows). */
export function playwrightCommand(argv: string[], options: PlaywrightCommandOptions): { argv: string[]; env: NodeJS.ProcessEnv } {
    const env: NodeJS.ProcessEnv = { [REPORT_ENV]: options.reportPath, [BASE_URL_ENV]: options.baseUrl };
    if (options.browsersPath !== undefined) env.PLAYWRIGHT_BROWSERS_PATH = options.browsersPath;
    return { argv: [...argv, ...FORCED_ARGS], env };
}
interface Window { fromMs: number; toMs: number; }
/**
 * Each case's window runs from ITS reported start to the NEXT case's start (the last one to the end of the run). With serial
 * workers and no retries the next case cannot start before this one has fully finished, so the window holds exactly this
 * case's requests. Playwright's reported `duration` is the test's TIMEOUT-SLOT time, not wall time — it excludes fixture
 * setup (browser launch), so `[start, start + duration]` ended before the body did and, under load, before any request
 * (measured 2026-09-25: a window of +384ms whose requests arrived at +418…+629ms). Cases without a start get no window.
 */
function orderedWindows(cases: readonly StructuredCase[]): Map<string, Window> {
    const starts = cases.flatMap(row => { const fromMs = row.startedAt === undefined ? Number.NaN : Date.parse(row.startedAt); return Number.isFinite(fromMs) ? [{ id: row.id, fromMs }] : []; }).sort((a, b) => a.fromMs - b.fromMs);
    const windows = new Map<string, Window>();
    starts.forEach((row, index) => windows.set(row.id, { fromMs: row.fromMs, toMs: starts[index + 1]?.fromMs ?? Number.POSITIVE_INFINITY }));
    return windows;
}
/** The window and every proxy request as an offset from its start — the evidence a reviewer needs when a request was NOT credited. */
function windowDiagnostic(window: Window, requests: ProxyRequest[]): string {
    const log = requests.slice(0, MAX_OBSERVATIONS).map(item => `${item.method} ${item.path} @+${item.atMs - window.fromMs}ms`).join(", ");
    const span = Number.isFinite(window.toMs) ? `+${window.toMs - window.fromMs}ms` : "to the end of the run";
    return `case window ${new Date(window.fromMs).toISOString()} ${span}; proxy log (${requests.length}): ${log || "none"}`;
}
function browserCase(row: StructuredCase, window: Window | undefined, requests: ProxyRequest[], serviceId: string): ReceiptCase {
    const result: ReceiptCase = { ...structuredCase("playwright", row), runnerKind: "browser", service: serviceId, boundaryRequests: 0 };
    if (!window) { result.details.push("no attempt window recorded; no request can be attributed to this case"); return result; }
    const seen = requests.filter(item => item.atMs >= window.fromMs && item.atMs <= window.toMs);
    result.boundaryRequests = seen.length;
    result.boundaryObservations = seen.slice(0, MAX_OBSERVATIONS).map(item => ({ method: item.method, path: item.path, status: item.status }));
    result.details.push(windowDiagnostic(window, requests));
    if (!seen.length) { result.details.push("no request observed through the owned application during this case"); return result; }
    const listed = seen.slice(0, MAX_LISTED_REQUESTS).map(item => `${item.method} ${item.path}`).join(", ");
    result.details.push(`${seen.length} request(s) observed through the owned application: ${listed}${seen.length > MAX_LISTED_REQUESTS ? ", …" : ""}`);
    return result;
}
/** Each DECLARED case is credited the requests the SUPERVISOR's proxy recorded inside its window; every report case (declared or not) bounds the windows, since undeclared cases occupy time too. */
export function correlateBrowserCases(cases: StructuredCase[], requests: ProxyRequest[], serviceId: string, declared?: ReadonlySet<string>): ReceiptCase[] {
    const windows = orderedWindows(cases);
    return cases.filter(row => declared === undefined || declared.has(row.id)).map(row => browserCase(row, windows.get(row.id), requests, serviceId));
}
function unavailableCases(ids: Iterable<string>, serviceId: string, reason: string): ReceiptCase[] {
    return [...ids].map(id => ({ id, digest: digestOf(`playwright\0${id}`), authority: "configured" as const, provenance: "unavailable" as const, state: "unavailable" as const, runnerKind: "browser" as const, service: serviceId, boundaryRequests: 0, details: [reason] }));
}
async function driveBrowser(deps: BrowserStageDeps, service: OwnedService): Promise<boolean> {
    const proxy = await startRecordingProxy(service.record.port);
    try {
        const browsers = browsersPath();
        const command = playwrightCommand(deps.runArgv, { reportPath: deps.reportPath, baseUrl: proxy.baseUrl, ...(browsers !== undefined ? { browsersPath: browsers } : {}) });
        const run = await deps.runCommand(command.argv, command.env);
        if (!run) return false;
        const parsed = await deps.readReport();
        if (!parsed) return false;
        deps.cases.push(...correlateBrowserCases(parsed.cases, proxy.requests, service.spec.id, deps.declared));
        if (run.exitCode !== 0 && !parsed.cases.some(row => row.status === "failed" || row.status === "error")) { deps.reasons.push(`browser test command exited ${run.exitCode} but its report records no failure; the exit is unexplained and no case result certifies completion`); return false; }
        return true;
    } finally { await proxy.close(); }
}
/** Inspect → own the app → proxy → run → correlate → stop. False leaves the run incomplete; the reasons say why. */
export async function runBrowserStage(deps: BrowserStageDeps): Promise<boolean> {
    const inspected = inspectPlaywright(deps.snapshot);
    if (!inspected.ok) { deps.reasons.push(inspected.reason); deps.cases.push(...unavailableCases(deps.declared, deps.serviceId, inspected.reason)); return false; }
    const owned = await deps.startServices();
    const service = owned.get(deps.serviceId);
    let ok = false;
    try {
        if (service && service.record.ready.ok && [...owned.values()].every(item => item.record.ready.ok)) ok = await driveBrowser(deps, service);
        else if (!service) deps.reasons.push(`browser service ${deps.serviceId} was not started; no browser case executed`);
    } finally { if (!(await deps.stopServices(owned))) ok = false; }
    return ok;
}
