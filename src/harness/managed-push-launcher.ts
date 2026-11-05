/** Captured in updatedInput: verifies bytes before importing, so no mutable launcher is trusted. */
export const MANAGED_PUSH_BOOTSTRAP = String.raw`
import { readFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
try {
    const file = process.argv[1];
    const stat = lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o222) || (process.getuid && stat.uid !== process.getuid())) throw new Error("managed push manifest permissions changed");
    const bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== process.argv[2]) throw new Error("managed push manifest changed");
    const plan = JSON.parse(bytes.toString("utf8"));
    const runtime = await import("data:text/javascript;base64," + Buffer.from(plan.launcher).toString("base64"));
    await runtime.launch(plan, process.argv[3], process.argv[4]);
} catch (error) { console.error("[managed-push] " + error.message); process.exitCode = 1; }
`;

/** Only Node builtins: the native invocation executes these exact captured bytes. */
export const MANAGED_PUSH_LAUNCHER = String.raw`
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function hash(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function checkExecutable(identity) {
    const stat = lstatSync(identity.path);
    if (!stat.isFile() || realpathSync(identity.path) !== identity.path || stat.dev !== identity.dev || stat.ino !== identity.ino || hash(identity.path) !== identity.sha256) throw new Error("managed push executable changed");
}
function checkEnvironment(nodeOptions, nodePath) {
    if (nodePath || (nodeOptions && !/^\s*(?:--max-old-space-size(?:=|\s+)\d+\s*)+$/.test(nodeOptions))) throw new Error("managed push loader override is unsupported");
    for (const [key, value] of Object.entries(process.env)) {
        if (value && ((/^GIT_/.test(key) && !["GIT_PAGER", "GIT_ASKPASS", "GIT_EDITOR"].includes(key)) || ["NODE_PATH", "BASH_ENV", "ENV", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(key))) throw new Error("managed push environment override is unsupported: " + key);
    }
}
function checkSnapshot(plan) {
    const root = lstatSync(plan.root);
    if (!root.isDirectory() || realpathSync(plan.root) !== plan.root || root.ino !== plan.ino || root.dev !== plan.dev || root.uid !== process.getuid() || (root.mode & 0o222)) throw new Error("managed push snapshot identity changed");
    for (const file of plan.files) {
        const path = join(plan.root, file.path);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.uid !== root.uid || stat.size !== file.size || (stat.mode & 0o777) !== file.mode || realpathSync(path) !== path || hash(path) !== file.sha256) throw new Error("managed push runtime changed: " + file.path);
    }
    for (const name of ["git", "node"]) if (realpathSync(join(plan.root, "bin", name)) !== plan[name].path) throw new Error("managed push executable link changed");
}
function cleanup(plan) {
    const stat = lstatSync(plan.root);
    if (!stat.isDirectory() || stat.ino !== plan.ino || stat.dev !== plan.dev || stat.uid !== process.getuid()) return;
    function unlock(path) {
        chmodSync(path, 0o700);
        for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) unlock(join(path, entry.name));
    }
    unlock(plan.root);
    rmSync(plan.root, { recursive: true });
}
async function push(plan, nodeOptions) {
    const env = { ...process.env, PATH: join(plan.root, "bin") + ":" + (process.env.PATH || ""), NODE_OPTIONS: nodeOptions };
    const child = spawn(plan.git.path, ["-c", "core.hooksPath=" + join(plan.root, "scripts/git-hooks"), "push", plan.remote, plan.refspec], { cwd: plan.repo, env, stdio: "inherit", detached: true });
    let interrupted = false;
    const forward = signal => { interrupted = true; if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } } };
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    try {
        await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { process.exitCode = code === null ? (signal === "SIGINT" ? 130 : 143) : code; resolve(); }); });
        if (interrupted && child.pid && !await drainOwnedGroup(child.pid)) throw Object.assign(new Error("managed push interrupted; hook controller did not drain, runtime snapshot retained"), { retainSnapshot: true });
    } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); }
}
async function drainOwnedGroup(pid) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        try { process.kill(-pid, 0); }
        catch (error) { return error.code === "ESRCH"; }
        await delay(25);
    }
    return false;
}
export async function launch(plan, nodeOptions, nodePath) {
    let retainSnapshot = false;
    try {
        checkEnvironment(nodeOptions, nodePath);
        checkExecutable(plan.node); checkExecutable(plan.git);
        if (realpathSync(process.execPath) !== plan.node.path || realpathSync(process.cwd()) !== plan.repo) throw new Error("managed push execution context changed");
        checkSnapshot(plan);
        await push(plan, nodeOptions);
    } catch (error) { retainSnapshot = error.retainSnapshot === true; throw error; }
    finally { if (!retainSnapshot) cleanup(plan); }
}
`;
