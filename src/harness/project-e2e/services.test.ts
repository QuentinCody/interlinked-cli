// Unit D1: managed HTTP service lifecycle. A service is OWNED (spawned by the
// supervisor in its own process group), READY only when the owned process is
// alive and its readiness endpoint answers the declared status, and STOPPED
// only when the group is gone AND the port is silent afterwards — a port that
// still answers after the owned group died was never ours (plan §9.1 step 7,
// §9.2, PE-19, PE-26).
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { allocatePort, createOwnedService, probeHttp, restartService, startService, stopService, type OwnedService } from "./services.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const SERVER = `import { createServer } from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
let hits = 0;
createServer((request, response) => { hits += 1; response.writeHead(request.url === "/health" ? 200 : 404, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, hits, pid: process.pid })); }).listen(port, "127.0.0.1");
`;
function workspace(script: string): string {
    const root = mkdtempSync(join(tmpdir(), "e2e-services-"));
    roots.push(root);
    writeFileSync(join(root, "serve.mjs"), script);
    return root;
}
/** The supervisor substitutes `{port}` before launch (run.ts); this helper does the same so the fixture server binds the allocated port. */
async function owned(root: string, argv: string[], port?: number): Promise<OwnedService> {
    const bound = port ?? await allocatePort();
    const launched = argv.map(token => token.replaceAll("{port}", String(bound)));
    return createOwnedService({ id: "api", argv, ready: { kind: "http", path: "/health", status: 200 } }, { argv: launched, env: { PATH: process.env.PATH }, cwd: root, logDir: join(root, "logs"), port: bound, stage: "contracts" });
}
const deadline = () => Date.now() + 10_000;
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

describe("managed services — positive (an owned, ready, cleanly stopped service)", () => {
    it("P1: start answers readiness from the OWNED process, restart keeps the port and answers again, stop leaves the port silent", async () => {
        const root = workspace(SERVER);
        const service = await owned(root, ["node", "serve.mjs", "--port", "{port}"]);
        expect(await startService(service, deadline())).toBe(true);
        expect(service.record.ready).toMatchObject({ ok: true, status: 200 });
        expect(service.record.pid).toBeGreaterThan(0);
        const firstPid = service.record.pid;
        expect(await restartService(service, deadline())).toBe(true);
        expect(service.record.restarts).toBe(1);
        expect(service.record.pid).not.toBe(firstPid);
        expect(await probeHttp(service.record.port, "/health")).toBe(200);
        const shutdown = await stopService(service);
        expect(shutdown).toMatchObject({ ok: true, portSilent: true, timedOut: false });
        expect(await probeHttp(service.record.port, "/health")).toBeNull();
        expect(readFileSync(join(root, "logs", "api.stdout.log"), "utf8")).toBeDefined();
    }, 30_000);
});
describe("managed services — negative (never ready, never clean)", () => {
    it("N1 (PE-19): a port that already answers BEFORE the service starts is refused; nothing is spawned", async () => {
        const root = workspace(SERVER);
        const port = await allocatePort();
        const squatter = createServer((_request, response) => { response.writeHead(200); response.end("{}"); }).listen(port, "127.0.0.1");
        try {
            const service = await owned(root, ["node", "serve.mjs", "--port", "{port}"], port);
            expect(await startService(service, deadline())).toBe(false);
            expect(service.record.ready.reason).toMatch(/answered .* BEFORE the service started/);
            expect(service.record.pid).toBeNull();
        } finally { squatter.close(); }
    });
    it("N2 (PE-24): an absent executable and a process that exits before readiness are explicit failures, not timeouts", async () => {
        const root = workspace(SERVER);
        const absent = await owned(root, ["definitely-not-a-real-executable-xyz", "--port", "{port}"]);
        expect(await startService(absent, deadline())).toBe(false);
        expect(absent.record.ready.reason).toMatch(/could not be started|exited/);
        const early = await owned(root, ["node", "-e", "process.exit(3)"]);
        expect(await startService(early, deadline())).toBe(false);
        expect(early.record.ready.reason).toMatch(/exited with code 3 before/);
    }, 30_000);
    it("N3: a service that never answers the declared status is not ready when the budget ends", async () => {
        const root = workspace(SERVER.replace("request.url === \"/health\" ? 200 : 404", "503"));
        const service = await owned(root, ["node", "serve.mjs", "--port", "{port}"]);
        expect(await startService(service, Date.now() + 1_500)).toBe(false);
        expect(service.record.ready).toMatchObject({ ok: false, status: 503 });
        expect(service.record.ready.reason).toMatch(/not ready within the budget/);
        expect((await stopService(service)).portSilent).toBe(true);
    }, 30_000);
    it("N5 (review D5): a worker in the OWNED group that ignores SIGTERM is escalated to SIGKILL after the leader exits; shutdown is ok only once the whole group is gone", async () => {
        const root = workspace(`import { spawn } from "node:child_process";
import { createServer } from "node:http";
spawn(process.execPath, ["worker.mjs"], { stdio: "ignore" });
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
createServer((request, response) => { response.writeHead(200); response.end("{}"); }).listen(port, "127.0.0.1");
`);
        writeFileSync(join(root, "worker.mjs"), `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync("worker.pid", String(process.pid));
setInterval(() => {}, 1000);
`);
        const service = await owned(root, ["node", "serve.mjs", "--port", "{port}"]);
        expect(await startService(service, deadline())).toBe(true);
        const pidFile = join(root, "worker.pid"), until = deadline();
        while (!existsSync(pidFile) && Date.now() < until) await delay(25);
        const worker = Number(readFileSync(pidFile, "utf8"));
        expect(alive(worker)).toBe(true);
        try {
            const shutdown = await stopService(service, { graceMs: 200 });
            expect(shutdown).toMatchObject({ ok: true, timedOut: true, portSilent: true });
            expect(alive(worker)).toBe(false);
        } finally { if (alive(worker)) process.kill(worker, "SIGKILL"); }
    }, 30_000);
    it("N4 (PE-19/PE-26): a responder that outlives the owned process group makes shutdown NOT ok — the port is not silent", async () => {
        const root = workspace(`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const port = process.argv[process.argv.indexOf("--port") + 1];
const orphan = spawn(process.execPath, ["inner.mjs", "--port", port], { cwd: process.cwd(), detached: true, stdio: "ignore" });
orphan.unref();
writeFileSync("orphan.pid", String(orphan.pid));
setInterval(() => {}, 1000);
`);
        writeFileSync(join(root, "inner.mjs"), SERVER);
        const service = await owned(root, ["node", "serve.mjs", "--port", "{port}"]);
        try {
            expect(await startService(service, deadline())).toBe(true); // the orphan answers on the port while the owned parent is alive
            const shutdown = await stopService(service);
            expect(shutdown.ok).toBe(false);
            expect(shutdown.portSilent).toBe(false);
            expect(shutdown.reason).toMatch(/still answers after the owned process group stopped/);
        } finally { process.kill(Number(readFileSync(join(root, "orphan.pid"), "utf8")), "SIGKILL"); }
    }, 30_000);
});
