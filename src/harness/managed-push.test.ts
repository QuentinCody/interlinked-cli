import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prepareManagedPush, prepareManagedPushHandoff } from "./managed-push.js";
import { digest, type ManagedPushTrust } from "./managed-push-snapshot.js";
import { shellSplit } from "./shell-structure.js";
import { traceManagedPushCommand } from "./managed-push-command.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// `prepareManagedPush` refuses any inherited GIT_* variable except GIT_PAGER (an IDE shell exports
// GIT_ASKPASS / GIT_EDITOR), so the suite must not depend on the parent shell; scrub and restore.
const scrubbed: Record<string, string> = {};
const originalNode = process.execPath;
let privateRuntime: string | undefined;
beforeAll(() => {
    // Hosted CI tool caches can make Node writable by others. Positive fixtures
    // need a real executable that satisfies the unchanged production boundary.
    if (statSync(originalNode).mode & 0o022) {
        privateRuntime = mkdtempSync(join(tmpdir(), "managed-push-node-"));
        const node = join(privateRuntime, "node");
        copyFileSync(originalNode, node);
        chmodSync(node, 0o500);
        process.execPath = node;
    }
    for (const [key, value] of Object.entries(process.env)) {
        if (/^GIT_/.test(key) && key !== "GIT_PAGER" && value !== undefined) { scrubbed[key] = value; delete process.env[key]; }
    }
});
afterAll(() => {
    Object.assign(process.env, scrubbed);
    process.execPath = originalNode;
    if (privateRuntime) rmSync(privateRuntime, { recursive: true, force: true });
});
function git(root: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
}
function fixture(): { root: string; remote: string; trust: ManagedPushTrust } {
    const parent = mkdtempSync(join(tmpdir(), "managed-push-test-")); roots.push(parent);
    const root = join(parent, "work"); const remote = join(parent, "remote.git");
    mkdirSync(root, { mode: 0o700 }); git(parent, "init", "--bare", remote); git(root, "init", "-b", "main");
    git(root, "config", "user.email", "fixture@example.invalid"); git(root, "config", "user.name", "Fixture");
    git(root, "remote", "add", "origin", remote);
    mkdirSync(join(root, "scripts/git-hooks"), { recursive: true });
    // This frozen gate consumes Git's actual update SHA, checks syntax and a coverage floor,
    // and records each invocation. A local bare receiver proves Git honors its verdict.
    const hook = "#!/bin/sh\nset -eu\nprintf 'gate\\n' >> gate-count\nprintf '%s\\n' \"${INTERLINKED_VERIFICATION_TRACE:-}\" > trace-seen\nwhile read local_ref sha remote_ref old; do\n git show \"$sha:module.js\" | node --check\n git show \"$sha:coverage.json\" | node -e 'let s=\"\";process.stdin.on(\"data\",x=>s+=x);process.stdin.on(\"end\",()=>{if(JSON.parse(s).lines<80)process.exitCode=1;});'\ndone\n";
    writeFileSync(join(root, "scripts/git-hooks/pre-push"), hook, { mode: 0o755 });
    git(root, "config", "core.hooksPath", "scripts/git-hooks");
    writeFileSync(join(root, "module.js"), "const value = 1;\n"); writeFileSync(join(root, "coverage.json"), '{"lines":90}\n');
    git(root, "add", "module.js", "coverage.json"); git(root, "commit", "-qm", "fixture");
    return { root, remote, trust: { files: { "scripts/git-hooks/pre-push": digest(Buffer.from(hook)) }, packages: [] } };
}
function execute(root: string, command: string, env: NodeJS.ProcessEnv = process.env): ReturnType<typeof spawnSync> {
    return spawnSync("/bin/sh", ["-c", command], { cwd: root, encoding: "utf8", timeout: 15_000, env });
}

async function waitForFile(path: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error("Owned hook did not start");
        await delay(20);
    }
}

function cancellationGate(root: string): ManagedPushTrust {
    const owner = `const fs=require("node:fs"),{spawn}=require("node:child_process");
const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});
fs.writeFileSync("hook-ready",String(child.pid));
process.on("SIGTERM",()=>{setTimeout(()=>{child.once("exit",()=>{fs.writeFileSync("child-reaped","yes");process.exit(75);});process.kill(-child.pid,"SIGTERM");},150);});
setInterval(()=>{},1000);\n`;
    const hook = '#!/bin/sh\nexec node "$(dirname "$0")/../owner.cjs"\n';
    writeFileSync(join(root, "scripts/owner.cjs"), owner);
    writeFileSync(join(root, "scripts/git-hooks/pre-push"), hook);
    return { files: { "scripts/git-hooks/pre-push": digest(Buffer.from(hook)), "scripts/owner.cjs": digest(Buffer.from(owner)) }, packages: [] };
}

describe("managed native push handoff", () => {
    it("retains the legacy path for a group-writable Node executable", () => {
        const { root, trust } = fixture();
        const node = join(root, "writable-node");
        copyFileSync(process.execPath, node);
        chmodSync(node, 0o720);
        const previous = process.execPath;
        try {
            process.execPath = node;
            expect(prepareManagedPush(root, "git push origin main", "codex", trust)).toBeNull();
            expect(prepareManagedPushHandoff(root, "git push origin main", "codex", trust)).toMatchObject({ kind: "fallback", cause: "executable-identity" });
        } finally { process.execPath = previous; }
    });
    it.each([
        { label: "0022", mask: 0o022 },
        { label: "0002", mask: 0o002 },
    ])("executes one frozen gate, preserves logging, and updates the receiver under umask $label", ({ mask }) => {
        const previous = process.umask(mask);
        let prepared: ReturnType<typeof fixture>;
        try { prepared = fixture(); } finally { process.umask(previous); }
        const { root, remote, trust } = prepared;
        const command = prepareManagedPush(root, "git push origin main > push.log 2>&1", "codex", trust);
        expect(command).not.toBeNull();
        if (!command) throw new Error("Expected native rewrite");
        // Ordinary edits after preparation cannot replace the gate that Git executes.
        writeFileSync(join(root, "scripts/git-hooks/pre-push"), "#!/bin/sh\nexit 99\n");
        git(root, "config", "core.hooksPath", "/dev/null");
        const result = execute(root, command);
        expect(result.status).toBe(0);
        expect(git(remote, "rev-parse", "refs/heads/main")).toBe(git(root, "rev-parse", "HEAD"));
        expect(readFileSync(join(root, "gate-count"), "utf8")).toBe("gate\n");
        expect(readFileSync(join(root, "push.log"), "utf8")).toContain("main -> main");
    });
    it.each(["syntax", "coverage"])("refuses the actual pushed revision when %s fails", failure => {
        const { root, remote, trust } = fixture();
        const command = prepareManagedPush(root, "git push origin main", "claude", trust);
        expect(command).not.toBeNull();
        if (!command) throw new Error("Expected native rewrite");
        // Change HEAD after preparation: Git's stdin revision, not an earlier receipt, is checked.
        writeFileSync(join(root, failure === "syntax" ? "module.js" : "coverage.json"), failure === "syntax" ? "const = broken;\n" : '{"lines":79}\n');
        git(root, "add", "module.js", "coverage.json"); git(root, "commit", "-qm", "regression");
        const result = execute(root, command);
        expect(result.status).not.toBe(0);
        expect(spawnSync("git", ["rev-parse", "--verify", "refs/heads/main"], { cwd: remote }).status).not.toBe(0);
        expect(readFileSync(join(root, "gate-count"), "utf8")).toBe("gate\n");
    });
    it("keeps custom, missing, modified, bypassed and unsupported-client pushes on the legacy path", () => {
        const { root, trust } = fixture();
        expect(prepareManagedPush(root, "git push --no-verify origin main", "codex", trust)).toBeNull();
        expect(prepareManagedPush(root, "git push origin main", "unknown", trust)).toBeNull();
        writeFileSync(join(root, "scripts/git-hooks/pre-push"), "#!/bin/sh\nexit 0\n");
        expect(prepareManagedPush(root, "git push origin main", "codex", trust)).toBeNull();
        rmSync(join(root, "scripts/git-hooks/pre-push"));
        expect(prepareManagedPush(root, "git push origin main", "codex", trust)).toBeNull();
        mkdirSync(join(root, "custom")); writeFileSync(join(root, "custom/pre-push"), "#!/bin/sh\nexit 0\n"); chmodSync(join(root, "custom/pre-push"), 0o755);
        git(root, "config", "core.hooksPath", "custom");
        expect(prepareManagedPush(root, "git push origin main", "codex", trust)).toBeNull();
        expect(existsSync(join(root, "gate-count"))).toBe(false);
    });

    // test-contract: public-api — every fallback names one boundary (client, command, environment, repository, hook, trust map, executable) and no environment value
    it("P1: explains each fallback with a typed cause and a value-free detail", () => {
        const { root, trust } = fixture();
        const hookPath = join(root, "scripts/git-hooks/pre-push");
        expect(prepareManagedPushHandoff(root, "git push origin main", "unknown", trust)).toEqual({ kind: "fallback", cause: "unsupported-client", detail: expect.stringContaining("unknown") });
        expect(prepareManagedPushHandoff(root, "git push --no-verify origin main", "codex", trust)).toMatchObject({ kind: "fallback", cause: "unsupported-command" });
        expect(prepareManagedPushHandoff(root, "git push origin main && echo done", "codex", trust, { env: { GIT_CONFIG_COUNT: "1" } })).toMatchObject({ kind: "fallback", cause: "unsupported-command" });
        const overridden = prepareManagedPushHandoff(root, "git push origin main", "codex", trust, { env: { PATH: process.env.PATH, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "private-value-marker" } });
        expect(overridden).toMatchObject({ kind: "fallback", cause: "environment-override" });
        if (overridden.kind !== "fallback") throw new Error("Expected fallback");
        expect(overridden.detail).toContain("GIT_CONFIG_COUNT");
        expect(overridden.detail).toContain("GIT_CONFIG_KEY_0");
        expect(overridden.detail).not.toContain("private-value-marker");
        expect(prepareManagedPushHandoff(root, "git push nowhere main", "codex", trust)).toMatchObject({ kind: "fallback", cause: "repository-mismatch" });
        expect(prepareManagedPushHandoff(root, "git push origin main", "codex", { ...trust, files: { ...trust.files, "module.js": "0".repeat(64) } }))
            .toMatchObject({ kind: "fallback", cause: "stale-trust-map", detail: expect.stringContaining("module.js") });
        writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
        expect(prepareManagedPushHandoff(root, "git push origin main", "codex", trust)).toMatchObject({ kind: "fallback", cause: "stale-trust-map", detail: expect.stringContaining("scripts/git-hooks/pre-push") });
        rmSync(hookPath);
        expect(prepareManagedPushHandoff(root, "git push origin main", "codex", trust)).toMatchObject({ kind: "fallback", cause: "hook-mismatch", detail: expect.stringContaining("missing") });
        mkdirSync(join(root, "custom")); writeFileSync(join(root, "custom/pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        git(root, "config", "core.hooksPath", "custom");
        expect(prepareManagedPushHandoff(root, "git push origin main", "codex", trust)).toMatchObject({ kind: "fallback", cause: "hook-mismatch" });
        expect(existsSync(join(root, "gate-count"))).toBe(false);
    });

    it("reports a filesystem refusal by operation and code without repeating the raw exception", () => {
        const { root, trust } = fixture();
        const result = prepareManagedPushHandoff(join(root, "missing-private-path"), "git push origin main", "codex", trust);
        expect(result).toEqual({ kind: "fallback", cause: "executable-identity", detail: "Managed push executable-identity check failed (ENOENT)" });
    });

    it.each(["private-value-marker", "trust map private-value-marker"])("reports malformed package metadata without echoing input: %s", content => {
        const { root, trust } = fixture();
        const packageRoot = join(root, "node_modules/private-fixture");
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(join(packageRoot, "package.json"), content);
        const result = prepareManagedPushHandoff(root, "git push origin main", "codex", { ...trust, packages: ["private-fixture"] });
        expect(result).toMatchObject({ kind: "fallback", cause: "snapshot-failure" });
        if (result.kind !== "fallback") throw new Error("Expected fallback");
        expect(result.detail).toContain("invalid JSON");
        expect(result.detail).not.toContain("private-value");
        expect(result.detail).not.toContain("trust map");
    });

    it("carries fallback trace metadata through the original hook while retaining its rejection", () => {
        const { root, remote, trust } = fixture();
        const trace = "fallback-12345678";
        const fallback = prepareManagedPushHandoff(root, "git push origin main", "codex", { ...trust, files: { ...trust.files, "scripts/git-hooks/pre-push": "0".repeat(64) } });
        expect(fallback).toMatchObject({ kind: "fallback", cause: "stale-trust-map" });
        const command = traceManagedPushCommand("git push origin main > push.log 2>&1", trace);
        if (!command) throw new Error("Expected trace-only replacement");
        writeFileSync(join(root, "coverage.json"), '{"lines":20}\n');
        git(root, "add", "coverage.json"); git(root, "commit", "-qm", "red coverage");
        expect(execute(root, command).status).not.toBe(0);
        expect(readFileSync(join(root, "trace-seen"), "utf8").trim()).toBe(trace);
        expect(git(remote, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("");
        // A timed-out client that never receives the replacement runs the original command:
        // its hook has no daemon correlation id, while its verification still rejects the push.
        const coldEnvironment = { ...process.env };
        delete coldEnvironment.INTERLINKED_VERIFICATION_TRACE;
        expect(execute(root, "git push origin main", coldEnvironment).status).not.toBe(0);
        expect(readFileSync(join(root, "trace-seen"), "utf8").trim()).toBe("");
        expect(readFileSync(join(root, "gate-count"), "utf8").trim().split("\n")).toHaveLength(2);
    });

    // test-contract: public-api — an IDE shell's GIT_ASKPASS/GIT_EDITOR neither refuse preparation nor execution, and the daemon's trace reaches the hook
    it("P2: pushes under IDE prompt helpers and hands the correlation id to the pinned hook", () => {
        const { root, remote, trust } = fixture();
        const trace = "3f2a9c1e-7b4d-4e8a-9c21-0d5e6f7a8b9c";
        const helpers = { GIT_ASKPASS: "/Applications/Visual Studio Code.app/askpass.sh", GIT_EDITOR: "code --wait" };
        const prepared = prepareManagedPushHandoff(root, "git push origin main", "claude-code", trust, { env: { ...process.env, ...helpers }, trace });
        expect(prepared.kind).toBe("prepared");
        if (prepared.kind !== "prepared") throw new Error("Expected native rewrite");
        expect(prepared.command).toContain(`INTERLINKED_VERIFICATION_TRACE=${trace}`);
        const result = execute(root, prepared.command, { ...process.env, ...helpers });
        expect(result.status).toBe(0);
        expect(git(remote, "rev-parse", "refs/heads/main")).toBe(git(root, "rev-parse", "HEAD"));
        expect(readFileSync(join(root, "trace-seen"), "utf8")).toBe(`${trace}\n`);
        // A malformed trace is dropped rather than quoted into the command; the hook then sees none.
        const unlabeled = prepareManagedPushHandoff(root, "git push origin main", "codex", trust, { trace: "not a trace" });
        if (unlabeled.kind !== "prepared") throw new Error("Expected native rewrite");
        expect(unlabeled.command).not.toContain("INTERLINKED_VERIFICATION_TRACE");
        expect(execute(root, unlabeled.command).status).toBe(0);
        expect(readFileSync(join(root, "trace-seen"), "utf8")).toBe("\n");
    });

    it("waits for the owned hook controller to reap its detached child after interruption", async () => {
        const { root, remote } = fixture();
        const command = prepareManagedPush(root, "git push origin main", "codex", cancellationGate(root));
        if (!command) throw new Error("Expected native rewrite");
        const child = spawn("/bin/sh", ["-c", "exec " + command], { cwd: root, stdio: "ignore" });
        const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        try {
            await waitForFile(join(root, "hook-ready"));
            child.kill("SIGTERM");
            expect(await closed).not.toBe(0);
            expect(readFileSync(join(root, "child-reaped"), "utf8")).toBe("yes");
            const pid = Number(readFileSync(join(root, "hook-ready"), "utf8"));
            expect(() => process.kill(pid, 0)).toThrow();
            expect(spawnSync("git", ["rev-parse", "--verify", "refs/heads/main"], { cwd: remote }).status).not.toBe(0);
        } finally { if (child.exitCode === null) child.kill("SIGTERM"); await closed; }
    });

    it.each(["runtime", "git-environment", "node-loader"])("refuses a changed %s at execution and cleans its original snapshot", kind => {
        const { root, trust } = fixture();
        const command = prepareManagedPush(root, "git push origin main", "codex", trust);
        if (!command) throw new Error("Expected native rewrite");
        const manifest = shellSplit(command).find(word => word.endsWith("/manifest.json"));
        if (!manifest) throw new Error("Missing native manifest argument");
        const snapshot = dirname(manifest);
        const env = { ...process.env };
        if (kind === "runtime") {
            const hook = join(snapshot, "scripts/git-hooks/pre-push");
            chmodSync(hook, 0o755); writeFileSync(hook, "#!/bin/sh\nexit 0\n"); chmodSync(hook, 0o555);
        } else if (kind === "git-environment") {
            Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null" });
        } else {
            const preload = join(root, "preload.cjs");
            writeFileSync(preload, 'require("node:fs").writeFileSync("unsafe-loader", "ran");\n');
            env.NODE_OPTIONS = "--require " + preload;
        }
        expect(execute(root, command, env).status).not.toBe(0);
        expect(existsSync(snapshot)).toBe(false);
        expect(existsSync(join(root, "gate-count"))).toBe(false);
        expect(existsSync(join(root, "unsafe-loader"))).toBe(false);
    });
});
