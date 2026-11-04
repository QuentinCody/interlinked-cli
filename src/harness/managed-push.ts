import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { parseManagedPush, safeManagedPushEnvironment, shellQuote } from "./managed-push-command.js";
import { MANAGED_PUSH_BOOTSTRAP, MANAGED_PUSH_LAUNCHER } from "./managed-push-launcher.js";
import { MANAGED_PUSH_TRUST } from "./managed-push-manifest.js";
import { createManagedPushSnapshot, digest, removeManagedPushSnapshot, sealManagedPushSnapshot, type ManagedPushSnapshot, type ManagedPushTrust } from "./managed-push-snapshot.js";

interface ExecutableIdentity { path: string; sha256: string; ino: number; dev: number; }
function executableIdentity(path: string): ExecutableIdentity {
    path = realpathSync(path);
    accessSync(path, constants.X_OK);
    const before = statSync(path);
    if (!before.isFile() || (before.mode & 0o022)) throw new Error("Unsafe managed push executable");
    const sha256 = digest(readFileSync(path));
    const after = statSync(path);
    if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("Managed push executable changed");
    return { path, sha256, ino: before.ino, dev: before.dev };
}

function gitIdentity(): ExecutableIdentity {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
        if (!directory || !directory.startsWith("/")) continue;
        const candidate = join(directory, "git");
        try { accessSync(candidate, constants.X_OK); } catch { continue; }
        return executableIdentity(candidate);
    }
    throw new Error("Cannot resolve canonical Git executable");
}

function gitOutput(git: string, root: string, args: string[]): string {
    const result = spawnSync(git, args, { cwd: root, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
    if (result.status !== 0) throw new Error("Cannot verify managed Git configuration");
    return result.stdout.trim();
}

function verifyRepository(root: string, git: string, remote: string, trust: ManagedPushTrust): void {
    if (realpathSync(gitOutput(git, root, ["rev-parse", "--show-toplevel"])) !== root) throw new Error("Managed push requires repository root cwd");
    const hook = resolve(root, gitOutput(git, root, ["rev-parse", "--git-path", "hooks/pre-push"]));
    if (hook !== join(root, "scripts/git-hooks/pre-push") || realpathSync(hook) !== hook || !lstatSync(hook).isFile()) throw new Error("Custom managed hook path");
    accessSync(hook, constants.X_OK);
    if (!trust.files["scripts/git-hooks/pre-push"] || digest(readFileSync(hook)) !== trust.files["scripts/git-hooks/pre-push"]) throw new Error("Unrecognized managed hook");
    gitOutput(git, root, ["remote", "get-url", "--push", remote]);
}

function nativeCommand(snapshot: ManagedPushSnapshot, repo: string, git: ExecutableIdentity, node: ExecutableIdentity, remote: string, refspec: string): string {
    mkdirSync(join(snapshot.root, "bin"), { mode: 0o700 });
    symlinkSync(git.path, join(snapshot.root, "bin/git"));
    symlinkSync(node.path, join(snapshot.root, "bin/node"));
    const stat = statSync(snapshot.root);
    const plan = { ...snapshot, repo, git, node, remote, refspec, ino: stat.ino, dev: stat.dev, launcher: MANAGED_PUSH_LAUNCHER };
    const bytes = Buffer.from(JSON.stringify(plan));
    const manifest = join(snapshot.root, "manifest.json");
    writeFileSync(manifest, bytes, { mode: 0o444, flag: "wx" });
    sealManagedPushSnapshot(snapshot.root);
    // Clear native Node loader options before startup; the captured launcher validates
    // and restores only the supported heap option for the authoritative Git hook.
    return ["/usr/bin/env", "-u", "NODE_OPTIONS", "-u", "NODE_PATH", node.path, "--input-type=module", "--eval", MANAGED_PUSH_BOOTSTRAP, manifest, digest(bytes)].map(shellQuote).join(" ") + ' "${NODE_OPTIONS-}" "${NODE_PATH-}"';
}

/** Null is a conservative fallback, never permission to skip legacy checks. */
export function prepareManagedPush(root: string, command: string, agentSource: string, trust: ManagedPushTrust = MANAGED_PUSH_TRUST): string | null {
    if (!["codex", "claude", "claude-code"].includes(agentSource) || process.platform === "win32" || !safeManagedPushEnvironment(process.env)) return null;
    const parsed = parseManagedPush(command);
    if (!parsed) return null;
    let snapshot: ManagedPushSnapshot | undefined;
    try {
        root = realpathSync(root);
        const git = gitIdentity();
        const node = executableIdentity(process.execPath);
        verifyRepository(root, git.path, parsed.remote, trust);
        snapshot = createManagedPushSnapshot(root, trust);
        return nativeCommand(snapshot, root, git, node, parsed.remote, parsed.refspec) + parsed.suffix;
    } catch {
        if (snapshot) removeManagedPushSnapshot(snapshot.root);
        return null;
    }
}
