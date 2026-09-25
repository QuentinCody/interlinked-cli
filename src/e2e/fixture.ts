import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { callHookDaemon } from "../hook-entry-transport.js";
import { buildHookScript } from "../lib/hooks-template.js";
import type { HookTransportReceipt } from "../lib/hook-transport-receipt.js";
import { isJsonObject } from "../lib/json-types.js";
import { sourceFiles } from "../harness/e2e-inventory.js";
import { isProductSource } from "../harness/e2e-boundary.js";
import { readRecentLines } from "../lib/local-activity-collection.js";

export type Protocol = "raw" | "framed";
export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function fixtureEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "NODE_V8_COVERAGE"]) {
        if (source[key] !== undefined) env[key] = source[key];
    }
    return env;
}

export function socketPaths(cwd: string): Record<Protocol, string> {
    const paths = { raw: join(cwd, ".interlinked/harness.sock"), framed: join(cwd, ".interlinked/harness-default.sock") };
    assert(Buffer.byteLength(paths.framed) <= 100, "Fixture path/.interlinked/harness-default.sock must fit within 100 bytes");
    return paths;
}

export interface HookCall {
    protocol?: Protocol;
    runtime?: "entry" | "generated";
    event?: string;
    tool?: string;
    input?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    cold?: boolean;
    sessionId?: string;
}

export interface HookResult {
    code: number | null;
    stdout: string;
    stderr: string;
    pid: number;
    sessionId: string;
    receipt: HookTransportReceipt;
    fellBack: boolean;
}

function readLedger(path: string): unknown[] {
    if (!existsSync(path)) return [];
    return readRecentLines(path, 1_000).reverse().filter(Boolean).map((line) => JSON.parse(line));
}

function parseReceipt(row: unknown): HookTransportReceipt {
    assert(isJsonObject(row), "Missing transport receipt");
    assert.equal(row.schema, 1);
    assert(typeof row.event_id === "string" && typeof row.session_id === "string" && typeof row.native_event === "string");
    assert(typeof row.hook_pid === "number" && (row.socket_path === null || typeof row.socket_path === "string"));
    assert(row.protocol === "raw" || row.protocol === "framed");
    assert(row.outcome === "daemon" || row.outcome === "cold" || row.outcome === "suppressed");
    return { schema: 1, event_id: row.event_id, session_id: row.session_id, native_event: row.native_event,
        hook_pid: row.hook_pid, socket_path: row.socket_path, protocol: row.protocol, outcome: row.outcome };
}

function childCompletion(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        const timer = timeoutMs > 0 ? setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Child ${child.pid} timed out; coverage is incomplete: ${stderr}`)); }, timeoutMs) : undefined;
        child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
        child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("close", (code) => {
            clearTimeout(timer);
            const directory = process.env.INTERLINKED_E2E_V8_DIR;
            if (directory) appendFileSync(join(directory, "../children.jsonl"), `${JSON.stringify({ pid: child.pid, clean: code !== null })}\n`);
            resolve({ code, stdout, stderr });
        });
    });
}

export class E2eFixture {
    readonly paths: Record<Protocol, string>;
    readonly dataDir: string;
    readonly sessionPrefix = `e2e-${randomUUID()}`;
    private readonly env: NodeJS.ProcessEnv;
    private readonly daemon: ChildProcess;
    private readonly daemonExit: Promise<{ code: number | null; stdout: string; stderr: string }>;
    private closed = false;

    constructor(readonly cwd: string, readonly protocol: Protocol | "dual", rules: Record<string, unknown> = {}) {
        this.paths = socketPaths(cwd);
        this.dataDir = join(cwd, ".interlinked");
        mkdirSync(this.dataDir);
        mkdirSync(join(cwd, "sentinel"));
        this.env = fixtureEnvironment({ ...process.env, INTERLINKED_DATA_DIR: join(cwd, "sentinel"), NODE_V8_COVERAGE: process.env.INTERLINKED_E2E_V8_DIR ?? process.env.NODE_V8_COVERAGE });
        const { graph_prediction, ...guardRules } = rules;
        writeFileSync(join(this.dataDir, "config.json"), JSON.stringify({ version: 1, sync_mode: "local", harness: { graph_prediction } }));
        writeFileSync(join(this.dataDir, "guard-rules.local.json"), JSON.stringify(guardRules));
        if (graph_prediction) this.graphSource("seed");
        writeFileSync(join(cwd, "README.md"), "Fixture project\n");
        writeFileSync(join(cwd, ".gitignore"), ".interlinked/\nnode_modules/\n");
        execFileSync("git", ["init", "--quiet", cwd], { env: this.env });
        execFileSync("git", ["add", "README.md", ".gitignore"], { cwd, env: this.env });
        execFileSync("git", ["-c", "user.name=E2E Fixture", "-c", "user.email=e2e@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "-m", "fixture"], { cwd, env: this.env });
        this.daemon = spawn(process.execPath, [join(PROJECT_ROOT, "dist/harness/server.js"), "--cwd", cwd,
            "--protocol", protocol, "--session-id", "default", "--idle-timeout", "0"], { cwd, env: this.env, stdio: ["ignore", "pipe", "pipe"] });
        this.daemonExit = childCompletion(this.daemon, 0);
        // Register rejection immediately; close() still observes and propagates it.
        void this.daemonExit.catch(() => undefined);
    }

    get pid(): number { assert(this.daemon.pid); return this.daemon.pid; }

    assertOwner(protocol: Protocol): void {
        assert.equal(this.daemon.exitCode, null, "Fixture daemon exited");
        process.kill(this.pid, 0);
        const pidPath = this.paths[protocol].replace(/\.sock$/, ".pid");
        assert.equal(Number(readFileSync(pidPath, "utf8").trim()), this.pid, "Socket belongs to a different daemon");
    }

    async ready(): Promise<void> {
        const protocols: Protocol[] = this.protocol === "dual" ? ["raw", "framed"] : [this.protocol];
        for (const protocol of protocols) await this.waitForProtocol(protocol);
    }

    private async waitForProtocol(protocol: Protocol): Promise<void> {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
            if (this.daemon.exitCode !== null) throw new Error(`Daemon startup failed: ${(await this.daemonExit).stderr}`);
            if (existsSync(this.paths[protocol])) {
                const result = await callHookDaemon({ socketPath: this.paths[protocol], method: "hook.pre_tool_use", timeoutMs: 500,
                    env: { INTERLINKED_HOOK_PROTOCOL: protocol }, event: {
                        schema_version: "1", event_id: randomUUID(), session_id: `${this.sessionPrefix}-ready`,
                        ts: new Date().toISOString(), runner: "claude-code", runner_native_event: "PreToolUse", phase: "pre-tool",
                        action: { kind: "tool_call", tool_name: "Read", tool_class: "read", tool_input: { file_path: "README.md" }, tool_input_redacted: {} },
                        context: { cwd: this.cwd }, raw: {},
                    } });
                if (result.ok) { this.assertOwner(protocol); return; }
            }
            await delay(50);
        }
        throw new Error(`Fixture ${protocol} socket never answered`);
    }

    ledger(name: string): unknown[] { return readLedger(join(this.dataDir, name)); }

    async cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
        const child = spawn(process.execPath, [join(PROJECT_ROOT, "dist/index.js"), ...args], { cwd: this.cwd, env: this.env });
        child.stdin?.end();
        return childCompletion(child, 60_000);
    }

    async readOverSocket(sessionId: string, protocol: Protocol): Promise<void> {
        this.assertOwner(protocol);
        const result = await callHookDaemon({ socketPath: this.paths[protocol], method: "hook.pre_tool_use", timeoutMs: 5_000,
            env: { INTERLINKED_HOOK_PROTOCOL: protocol }, event: {
                schema_version: "1", event_id: randomUUID(), session_id: sessionId,
                ts: new Date().toISOString(), runner: "claude-code", runner_native_event: "PreToolUse", phase: "pre-tool",
                action: { kind: "tool_call", tool_name: "Read", tool_class: "read", tool_input: { file_path: "README.md" }, tool_input_redacted: {} },
                context: { cwd: this.cwd }, raw: {},
            } });
        assert(result.ok, "Fixture socket failed to serve the event");
        this.assertOwner(protocol);
    }

    file(path: string, content: string): string {
        const absolute = resolve(this.cwd, path);
        assert(absolute.startsWith(`${this.cwd}/`), "Fixture writes must stay inside their cwd");
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, content);
        return absolute;
    }

    graphSource(name: string, fresh = true): string {
        const source = this.file(`src/${name}.ts`, "export const SENTINEL_OLD = 1;\n");
        const shard = this.file(`src/${name}.graph.ts`, "// @generated supermodel-sidecar\n// [deps]\n// imports     node:fs\n// imported-by src/a.ts\n// [calls]\n// run ← main    src/x.ts:10\n// [impact]\n// risk        MEDIUM\n// domains     X · Y\n// direct      1\n// transitive  2\n// affects     src/a.ts\n");
        const timestamp = Date.now() / 1000 - 10;
        utimesSync(source, timestamp, timestamp);
        utimesSync(shard, timestamp, fresh ? timestamp : timestamp - 100);
        return source;
    }

    async hook(call: HookCall): Promise<HookResult> {
        const protocol = call.protocol ?? (this.protocol === "framed" ? "framed" : "raw");
        if (!call.cold) this.assertOwner(protocol);
        const sessionId = call.sessionId ?? `${this.sessionPrefix}-${randomUUID()}`;
        const event = call.event ?? "PreToolUse";
        const socket = call.cold && call.runtime !== "generated" ? join(this.dataDir, "absent.sock") : this.paths[protocol];
        const args = this.hookArgs(call, socket, event);
        const receiptPath = join(this.dataDir, "hook-transport.jsonl");
        const offset = existsSync(receiptPath) ? statSync(receiptPath).size : 0;
        const child = spawn(process.execPath, args, { cwd: this.cwd, env: { ...this.env,
            INTERLINKED_HOOK_PROTOCOL: protocol, INTERLINKED_CLIENT: "claude", INTERLINKED_NO_SELF_HEAL: "1" } });
        const completion = childCompletion(child, 60_000);
        child.stdin?.end(JSON.stringify({ ...call.payload, hook_event_name: event, session_id: sessionId,
            cwd: this.cwd, tool_name: call.tool, tool_input: call.input }));
        const output = await completion;
        assert(child.pid);
        const rows = readFileSync(receiptPath).subarray(offset).toString("utf8").trim().split("\n").filter(Boolean).map((line) => parseReceipt(JSON.parse(line))).filter((row) => row.hook_pid === child.pid);
        assert.equal(rows.length, 1, `Expected one fresh receipt: ${output.stderr}`);
        const receipt = rows[0];
        assert(receipt);
        assert.equal(receipt.session_id, sessionId);
        assert.equal(receipt.native_event, event);
        assert.equal(receipt.socket_path, socket);
        assert.equal(receipt.protocol, protocol);
        if (!call.cold) this.assertOwner(protocol);
        return { ...output, pid: child.pid, sessionId, receipt, fellBack: receipt.outcome === "cold" };
    }

    private hookArgs(call: HookCall, socket: string, event: string): string[] {
        if (call.runtime === "generated") {
            assert(call.protocol !== "framed" && this.protocol !== "framed", "Generated hook uses its discovered raw socket");
            const path = join(this.dataDir, "activity.mjs");
            writeFileSync(path, buildHookScript("e2e"));
            return [path];
        }
        return [join(PROJECT_ROOT, "dist/hook-entry.js"), "--runner", "claude-code", "--event", event, "--socket", socket];
    }

    assertServed(result: HookResult): void {
        assert.equal(result.fellBack, false);
        assert.equal(result.receipt.outcome, "daemon");
        assert.equal(result.receipt.hook_pid, result.pid);
        assert(result.receipt.event_id.length > 0);
        this.assertOwner(result.receipt.protocol);
    }

    async stopDaemon(): Promise<void> {
        this.daemon.kill("SIGTERM");
        const timeout = setTimeout(() => this.daemon.kill("SIGKILL"), 10_000);
        try {
            const result = await this.daemonExit;
            assert.equal(result.code, 0, `Daemon did not shut down cleanly: ${result.stderr}`);
        } finally { clearTimeout(timeout); }
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.stopDaemon();
        assert.deepEqual(readdirSync(join(this.cwd, "sentinel")), [], "Fixture leaked to its parent environment's data directory");
        for (const root of [PROJECT_ROOT, this.env.HOME].filter((root): root is string => Boolean(root))) {
            for (const name of ["activity.jsonl", "collection.jsonl", "check-results.jsonl", "hook-transport.jsonl"]) {
                assert(!JSON.stringify(readLedger(join(root, ".interlinked", name))).includes(this.sessionPrefix), `Fixture session leaked to ${root}/${name}`);
            }
        }
        rmSync(this.cwd, { recursive: true, force: true });
    }
}

export async function createFixture(options: { protocol?: Protocol | "dual"; rules?: Record<string, unknown> } = {}): Promise<E2eFixture> {
    assert(existsSync(join(PROJECT_ROOT, "dist/harness/server.js")), "Run npm run build before test:e2e");
    const built = Math.min(statSync(join(PROJECT_ROOT, "dist/harness/server.js")).mtimeMs, statSync(join(PROJECT_ROOT, "dist/hook-entry.js")).mtimeMs);
    const stale = sourceFiles(PROJECT_ROOT).filter(isProductSource).find((path) => statSync(join(PROJECT_ROOT, path)).mtimeMs > built);
    assert(!stale, `Stale dist (${stale}); run npm run build before test:e2e`);
    const fixtureTempDir = process.platform === "darwin" ? "/tmp" : tmpdir();
    const fixture = new E2eFixture(realpathSync(mkdtempSync(join(fixtureTempDir, "e2e-"))), options.protocol ?? "dual", options.rules);
    try { await fixture.ready(); return fixture; }
    catch (error) { await fixture.close(); throw error; }
}
