// ===========================================
// Managed HTTP services — owned, ready, identified, stopped
// ===========================================
// Plan 31 §9.1 steps 6–7 and 10, §9.2 (Unit D1). The supervisor allocates a
// loopback port, refuses it if anything already answers there (a stale or
// unowned responder can never certify the current build — PE-19), spawns the
// declared argv in its OWN process group inside the disposable snapshot, and
// calls it ready only while that owned process is alive and its readiness
// endpoint answers the declared status. Stopping kills the owned group and
// then probes the port again: a port that still answers after the group is
// gone belonged to something else, so shutdown is NOT ok and the run cannot
// qualify (PE-26). Cleanup kills only owned processes, never a PID guessed
// from an occupied port.

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface ServiceReadiness { kind: "http"; path: string; status: number; }
export interface ServiceSpec { id: string; argv: string[]; env?: Record<string, string>; ready: ServiceReadiness; }
export interface ServiceReady { ok: boolean; status: number | null; attempts: number; durationMs: number; reason?: string; }
export interface ServiceShutdown { ok: boolean; exitCode: number | null; signal: string | null; timedOut: boolean; portSilent: boolean; reason?: string; }
/** What the receipt records per service: the owned handle's identity and every lifecycle outcome (§11 build/services group). */
export interface ServiceRecord { id: string; argv: string[]; port: number; pid: number | null; ready: ServiceReady; restarts: number; shutdown: ServiceShutdown | null; /** Every pid this service was spawned as (start + restarts): the expected-process inventory runtime observations reconcile against (review E3). */ pids: number[]; /** Which stage owned this lifetime (round 2 R1): a browser case's evidence belongs to the `browser` instance, an http case's to `contracts`; a receipt keeps every lifetime. */ stage: ServiceStage; }
export type ServiceStage = "browser" | "contracts";
export interface ServiceDeps { pollMs?: number; graceMs?: number; }
export interface OwnedService { spec: ServiceSpec; record: ServiceRecord; env: NodeJS.ProcessEnv; cwd: string; logDir: string; child: ChildProcess | null; failure: string | null; }
interface ServiceLaunch { argv: string[]; env: NodeJS.ProcessEnv; cwd: string; logDir: string; port: number; stage: ServiceStage; }

// interlinked-ignore: ubs_hardcoded_localhost — owned services are LOOPBACK by contract (plan §9.2: disposable local resources; the contract schema refuses any other host)
const LOOPBACK = "127.0.0.1";
const PROBE_TIMEOUT_MS = 500;
const DEFAULT_POLL_MS = 50;
const DEFAULT_GRACE_MS = 2_000;
const KILL_WAIT_MS = 1_000;
const GROUP_POLL_MS = 25;

/** The base URL a contract case reaches an owned service at. */
export function serviceBaseUrl(port: number): string { return `http://${LOOPBACK}:${port}`; }
/** A free loopback port: bind 0, read the number, release it. The pre-start probe in `startService` closes the reuse race. */
export function allocatePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.once("error", reject);
        server.listen(0, LOOPBACK, () => {
            const address = server.address();
            const port = address && typeof address === "object" ? address.port : 0;
            server.close(() => (port ? resolve(port) : reject(new Error("could not allocate a loopback port"))));
        });
    });
}
/** The HTTP status the loopback port answers at `path`, or null when nothing answers within the timeout. */
export async function probeHttp(port: number, path: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<number | null> {
    try {
        const response = await fetch(`${serviceBaseUrl(port)}${path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
        await response.body?.cancel();
        return response.status;
    } catch { return null; }
}
export function createOwnedService(spec: ServiceSpec, launch: ServiceLaunch): OwnedService {
    return {
        spec, env: launch.env, cwd: launch.cwd, logDir: launch.logDir, child: null, failure: null,
        record: { id: spec.id, argv: launch.argv, port: launch.port, pid: null, ready: { ok: false, status: null, attempts: 0, durationMs: 0, reason: "not started" }, restarts: 0, shutdown: null, pids: [], stage: launch.stage },
    };
}
function exited(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null; }
function spawnService(owned: OwnedService): ChildProcess {
    mkdirSync(owned.logDir, { recursive: true });
    const out = openSync(join(owned.logDir, `${owned.spec.id}.stdout.log`), "a"), err = openSync(join(owned.logDir, `${owned.spec.id}.stderr.log`), "a");
    const argv = owned.record.argv;
    const child = spawn(argv[0]!, argv.slice(1), { cwd: owned.cwd, env: owned.env, detached: true, stdio: ["ignore", out, err] });
    child.once("error", error => { owned.failure = error.message; });
    closeSync(out);
    closeSync(err);
    return child;
}
async function awaitReady(owned: OwnedService, child: ChildProcess, deadline: number, pollMs: number): Promise<ServiceReady> {
    const { path, status: wanted } = owned.spec.ready;
    let attempts = 0, last: number | null = null;
    while (Date.now() < deadline) {
        if (owned.failure) return { ok: false, status: null, attempts, durationMs: 0, reason: `service could not be started: ${owned.failure}` };
        if (exited(child)) return { ok: false, status: null, attempts, durationMs: 0, reason: `service exited with code ${child.exitCode ?? child.signalCode} before answering readiness` };
        attempts += 1;
        last = await probeHttp(owned.record.port, path);
        if (last === wanted && !exited(child)) return { ok: true, status: last, attempts, durationMs: 0 };
        await delay(pollMs);
    }
    return { ok: false, status: last, attempts, durationMs: 0, reason: `service was not ready within the budget (${attempts} probe(s); last status ${last ?? "no answer"}, wanted ${wanted})` };
}
/**
 * Start the owned service. Refuses a port that already answers (PE-19), spawns the argv in its own process group, and
 * reports ready only when the OWNED child is alive and its readiness endpoint answers the declared status.
 */
export async function startService(owned: OwnedService, deadline: number, deps: ServiceDeps = {}): Promise<boolean> {
    const { record, spec } = owned, started = Date.now();
    const before = await probeHttp(record.port, spec.ready.path);
    if (before !== null) {
        record.ready = { ok: false, status: before, attempts: 0, durationMs: 0, reason: `port ${record.port} answered ${spec.ready.path} with ${before} BEFORE the service started; a stale or unowned responder cannot certify the current build` };
        return false;
    }
    const child = spawnService(owned);
    owned.child = child;
    record.pid = child.pid ?? null;
    if (child.pid !== undefined) record.pids.push(child.pid);
    record.ready = await awaitReady(owned, child, deadline, deps.pollMs ?? DEFAULT_POLL_MS);
    record.ready.durationMs = Date.now() - started;
    return record.ready.ok;
}
function errorCode(error: unknown): string | undefined {
    // SAFETY: process.kill throws an ErrnoException; any other shape carries no code.
    return (error as NodeJS.ErrnoException).code;
}
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (errorCode(error) !== "ESRCH") throw error; }
}
/** Any member of the OWNED process group still exists (the group outlives its leader while a worker lingers — review D5). */
function groupAlive(pid: number): boolean {
    try { process.kill(-pid, 0); return true; }
    catch (error) { return errorCode(error) === "EPERM"; }
}
async function waitGroupGone(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (groupAlive(pid)) {
        if (Date.now() >= deadline) return false;
        await delay(GROUP_POLL_MS);
    }
    return true;
}
function waitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (exited(child)) return Promise.resolve(true);
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        child.once("exit", () => { clearTimeout(timer); resolve(true); });
    });
}
/**
 * Stop the owned process GROUP: SIGTERM the group, wait for EVERY member (not only the leader) to go, escalate to SIGKILL
 * after the grace period while any owned member survives, then prove the port fell silent. Only owned processes are ever
 * signalled — never a PID guessed from an occupied port.
 */
export async function stopService(owned: OwnedService, deps: ServiceDeps = {}): Promise<ServiceShutdown> {
    const { child, record } = owned, pid = child?.pid;
    let timedOut = false;
    if (child && pid !== undefined && groupAlive(pid)) {
        signalGroup(child, "SIGTERM");
        if (!(await waitGroupGone(pid, deps.graceMs ?? DEFAULT_GRACE_MS))) { timedOut = true; signalGroup(child, "SIGKILL"); await waitGroupGone(pid, KILL_WAIT_MS); }
        await waitExit(child, KILL_WAIT_MS); // settle the leader's exit code for the record
    }
    const gone = !child || pid === undefined || !groupAlive(pid);
    const portSilent = (await probeHttp(record.port, owned.spec.ready.path)) === null;
    const shutdown: ServiceShutdown = { ok: gone && portSilent, exitCode: child?.exitCode ?? null, signal: child?.signalCode ?? null, timedOut, portSilent };
    if (!gone) shutdown.reason = `owned process group ${pid} still has live members after SIGKILL`;
    else if (!portSilent) shutdown.reason = `port ${record.port} still answers after the owned process group stopped: an unowned responder was on this port and the run cannot qualify`;
    record.shutdown = shutdown;
    owned.child = null;
    return shutdown;
}
/** A restart is a clean stop (port silent) followed by a fresh start on the SAME port; the record keeps the count and the latest identity. */
export async function restartService(owned: OwnedService, deadline: number, deps: ServiceDeps = {}): Promise<boolean> {
    const shutdown = await stopService(owned, deps);
    if (!shutdown.ok) return false;
    owned.record.restarts += 1;
    owned.record.shutdown = null;
    return startService(owned, deadline, deps);
}
