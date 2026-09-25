// Unit E2: the Playwright browser stage — toolchain inspection (unavailable is
// a named gap with guidance, PE-24), the forced serial JSON-reporter command,
// per-case request correlation through the supervisor's recording proxy, and
// the stage orchestration driven through injected run primitives.
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { correlateBrowserCases, defaultBrowsersPath, inspectPlaywright, playwrightCommand, runBrowserStage, structuredCase, type BrowserStageDeps } from "./browser-stage.js";
import type { ProxyRequest } from "./proxy.js";
import type { ReceiptCase } from "./receipt.js";
import type { OwnedService } from "./services.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function scratch(): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), "browser-stage-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function fakePlaywright(root: string, version = "1.99.0"): void {
    mkdirSync(join(root, "node_modules", "@playwright", "test"), { recursive: true });
    writeFileSync(join(root, "node_modules", "@playwright", "test", "package.json"), JSON.stringify({ name: "@playwright/test", version }));
}
function app(): Promise<{ port: number; hits: string[]; close: () => Promise<void> }> {
    const hits: string[] = [];
    // interlinked-ignore: ubs_hardcoded_localhost — the owned app under test is loopback by construction
    const server: Server = createServer((request, response) => { hits.push(`${request.method} ${request.url}`); response.writeHead(200, { "content-type": "text/plain" }); response.end("ok"); });
    const close = () => new Promise<void>(resolve => server.close(() => resolve()));
    cleanups.push(close);
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => { const address = server.address(); resolve({ port: typeof address === "object" && address ? address.port : 0, hits, close }); }));
}
const request = (atMs: number, path = "/orders"): ProxyRequest => ({ atMs, method: "GET", path, status: 200 });
const passing = (id: string, startedAt: string, durationMs: number) => ({ id, status: "passed" as const, startedAt, durationMs, attempts: 1 });

describe("browser stage — positive", () => {
    it("P1: the command forces Playwright's JSON reporter and serial workers and hands the report path, the proxy base URL and the browser cache over as env", () => {
        const command = playwrightCommand(["npx", "playwright", "test", "tests/orders.spec.ts"], { reportPath: "/snap/playwright-report.json", baseUrl: "http://127.0.0.1:4321" });
        expect(command.argv).toEqual(["npx", "playwright", "test", "tests/orders.spec.ts", "--reporter=json", "--workers=1", "--retries=0"]);
        expect(command.env).toEqual({ PLAYWRIGHT_JSON_OUTPUT_NAME: "/snap/playwright-report.json", INTERLINKED_E2E_BASE_URL: "http://127.0.0.1:4321" });
        expect(playwrightCommand([], { reportPath: "/r.json", baseUrl: "http://127.0.0.1:1", browsersPath: "/cache/ms-playwright" }).env.PLAYWRIGHT_BROWSERS_PATH).toBe("/cache/ms-playwright");
        expect(defaultBrowsersPath("darwin", "/Users/me")).toBe("/Users/me/Library/Caches/ms-playwright");
        expect(defaultBrowsersPath("linux", "/home/me")).toBe("/home/me/.cache/ms-playwright");
        expect(defaultBrowsersPath("win32", "C:\\Users\\me", "C:\\Users\\me\\AppData\\Local")).toBe(join("C:\\Users\\me\\AppData\\Local", "ms-playwright"));
    });
    it("P2: a case is credited exactly the requests the proxy saw from its start to the next case's start, and carries the owned service", () => {
        const cases = correlateBrowserCases([passing("a.spec.ts › creates [chromium]", "2026-01-01T00:00:10.000Z", 2000), passing("a.spec.ts › lists [chromium]", "2026-01-01T00:00:13.000Z", 1000)], [request(Date.parse("2026-01-01T00:00:10.500Z")), request(Date.parse("2026-01-01T00:00:11.900Z"), "/orders/1"), request(Date.parse("2026-01-01T00:00:13.200Z"))], "web");
        expect(cases.map(row => [row.id, row.state, row.runnerKind, row.service, row.boundaryRequests])).toEqual([["a.spec.ts › creates [chromium]", "passed", "browser", "web", 2], ["a.spec.ts › lists [chromium]", "passed", "browser", "web", 1]]);
        expect(cases[0]!.details).toContain("2 request(s) observed through the owned application: GET /orders, GET /orders/1");
        expect(cases[0]!.digest).toBe(structuredCase("playwright", { id: "a.spec.ts › creates [chromium]", status: "passed" }).digest);
    });
    it("P2b (the full-suite-load flake, measured 2026-09-25): a request AFTER start + reported duration is still this case's — Playwright's duration is timeout-slot time, not wall time — and an UNDECLARED later case bounds the window; a request before the case started is nobody's", () => {
        const start = Date.parse("2026-01-01T00:00:10.000Z");
        const report = [passing("a.spec.ts › creates [chromium]", "2026-01-01T00:00:10.000Z", 384), passing("a.spec.ts › undeclared warm-up [chromium]", "2026-01-01T00:00:12.000Z", 100)];
        const requests = [request(start - 50, "/health"), request(start + 418, "/"), request(start + 515, "/orders"), request(start + 629, "/orders/1"), request(start + 2100, "/late")];
        const cases = correlateBrowserCases(report, requests, "web", new Set(["a.spec.ts › creates [chromium]"]));
        expect(cases.map(row => row.id)).toEqual(["a.spec.ts › creates [chromium]"]);
        expect(cases[0]!.boundaryObservations?.map(row => row.path)).toEqual(["/", "/orders", "/orders/1"]);
        expect(cases[0]!.details.join("\n")).toMatch(/case window 2026-01-01T00:00:10\.000Z \+2000ms; proxy log \(5\): GET \/health @\+-50ms/);
    });
    it("P3: inspection finds @playwright/test resolvable from the snapshot and reports its version", () => {
        const root = scratch();
        fakePlaywright(root, "1.55.1");
        expect(inspectPlaywright(root)).toEqual({ ok: true, version: "1.55.1" });
    });
    it("P4: the stage owns the service, fronts it with the proxy, runs the command against the proxy URL, correlates the report and stops everything", async () => {
        const root = scratch(), upstream = await app();
        fakePlaywright(root);
        const reportPath = join(root, "playwright-report.json"), stopped: string[] = [], commands: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = [];
        const owned = { spec: { id: "web" }, record: { id: "web", port: upstream.port, ready: { ok: true } } } as unknown as OwnedService;
        const deps: BrowserStageDeps = {
            snapshot: root, serviceId: "web", declared: new Set(["a.spec.ts › creates [chromium]"]), runArgv: ["fake-playwright"], reportPath, reasons: [], cases: [],
            startServices: async () => new Map([["web", owned]]),
            stopServices: async () => { stopped.push("web"); return true; },
            runCommand: async (argv, env) => {
                commands.push({ argv, env });
                const startTime = new Date().toISOString();
                await fetch(`${env.INTERLINKED_E2E_BASE_URL}/orders`);
                const laterStart = new Date(Date.now() + 10_000).toISOString(); // the undeclared case ran AFTER (serial workers never share a start)
                writeFileSync(reportPath, JSON.stringify({ suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs: [{ title: "creates", tests: [{ projectName: "chromium", status: "expected", results: [{ status: "passed", retry: 0, startTime, duration: 5000 }] }] }, { title: "undeclared", tests: [{ projectName: "chromium", status: "expected", results: [{ status: "passed", retry: 0, startTime: laterStart, duration: 5000 }] }] }] }] }));
                return { exitCode: 0 };
            },
            readReport: async () => { const { parsePlaywrightJson } = await import("./playwright-report.js"); return parsePlaywrightJson(readFileSync(reportPath, "utf8")); },
        };
        expect(await runBrowserStage(deps)).toBe(true);
        expect(commands[0]!.argv).toEqual(["fake-playwright", "--reporter=json", "--workers=1", "--retries=0"]);
        expect(commands[0]!.env.PLAYWRIGHT_JSON_OUTPUT_NAME).toBe(reportPath);
        expect(upstream.hits).toEqual(["GET /orders"]);
        expect(deps.cases.map(row => [row.id, row.state, row.runnerKind, row.service, row.boundaryRequests])).toEqual([["a.spec.ts › creates [chromium]", "passed", "browser", "web", 1]]);
        expect(stopped).toEqual(["web"]);
        expect(deps.reasons).toEqual([]);
    });
});
describe("browser stage — negative", () => {
    it("N1 (PE-24): without @playwright/test the stage never starts a service; every declared case is unavailable with install guidance", async () => {
        const root = scratch();
        expect(inspectPlaywright(root)).toMatchObject({ ok: false, reason: expect.stringMatching(/@playwright\/test/) });
        let started = 0;
        const deps: BrowserStageDeps = {
            snapshot: root, serviceId: "web", declared: new Set(["a.spec.ts › creates [chromium]"]), runArgv: ["npx", "playwright", "test"], reportPath: join(root, "r.json"), reasons: [], cases: [],
            startServices: async () => { started += 1; return new Map(); }, stopServices: async () => true, runCommand: async () => { throw new Error("must not run"); }, readReport: async () => null,
        };
        expect(await runBrowserStage(deps)).toBe(false);
        expect(started).toBe(0);
        expect(deps.cases).toEqual([expect.objectContaining({ id: "a.spec.ts › creates [chromium]", state: "unavailable", runnerKind: "browser" })]);
        expect(deps.reasons[0]).toMatch(/npx playwright install/);
    });
    it("N2: a case with no attempt window, or whose window saw no request, is credited zero requests and says so", () => {
        const cases = correlateBrowserCases([{ id: "x", status: "passed", attempts: 1 }, passing("y", "2026-01-01T00:00:10.000Z", 100)], [request(Date.parse("2026-01-01T00:00:09.000Z"))], "web"); // the only request precedes y's start
        expect(cases.map(row => row.boundaryRequests)).toEqual([0, 0]);
        expect(cases[0]!.details.join(" ")).toMatch(/no attempt window/);
        expect(cases[1]!.details.join(" ")).toMatch(/no request observed/);
    });
    it("N3: a non-zero test-command exit that the report does not explain leaves the stage incomplete (C2 carried over); a failing report case explains it", async () => {
        const root = scratch(), upstream = await app();
        fakePlaywright(root);
        const owned = { spec: { id: "web" }, record: { id: "web", port: upstream.port, ready: { ok: true } } } as unknown as OwnedService;
        const report = (status: string) => ({ suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs: [{ title: "creates", tests: [{ projectName: "chromium", status: "unexpected", results: [{ status, retry: 0, startTime: new Date().toISOString(), duration: 10 }] }] }] }] });
        const stage = async (status: string): Promise<{ ok: boolean; cases: ReceiptCase[]; reasons: string[] }> => {
            const reportPath = join(root, `${status}.json`);
            const deps: BrowserStageDeps = {
                snapshot: root, serviceId: "web", declared: new Set(["a.spec.ts › creates [chromium]"]), runArgv: ["fake"], reportPath, reasons: [], cases: [],
                startServices: async () => new Map([["web", owned]]), stopServices: async () => true,
                runCommand: async () => { writeFileSync(reportPath, JSON.stringify(report(status))); return { exitCode: 1 }; },
                readReport: async () => { const { parsePlaywrightJson } = await import("./playwright-report.js"); return parsePlaywrightJson(readFileSync(reportPath, "utf8")); },
            };
            return { ok: await runBrowserStage(deps), cases: deps.cases, reasons: deps.reasons };
        };
        const unexplained = await stage("passed");
        expect(unexplained.ok).toBe(false);
        expect(unexplained.reasons.join(" ")).toMatch(/exited 1 but its report records no failure/);
        const explained = await stage("failed");
        expect(explained.ok).toBe(true);
        expect(explained.cases[0]!.state).toBe("failed");
    });
});
