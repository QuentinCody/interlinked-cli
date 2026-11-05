import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { parseManagedPush, shellQuote, unsafeManagedPushEnvironmentKeys } from "./managed-push-command.js";
import { MANAGED_PUSH_BOOTSTRAP, MANAGED_PUSH_LAUNCHER } from "./managed-push-launcher.js";
import { MANAGED_PUSH_TRUST } from "./managed-push-manifest.js";
import { createManagedPushSnapshot, digest, ManagedPushTrustMismatch, removeManagedPushSnapshot, sealManagedPushSnapshot, type ManagedPushSnapshot, type ManagedPushTrust } from "./managed-push-snapshot.js";

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

/** Why a recognized push stayed on the legacy checks. Each value names one boundary the plan can act on. */
export type ManagedPushFallbackCause =
    | "unsupported-client"
    | "unsupported-platform"
    | "environment-override"
    | "unsupported-command"
    | "repository-mismatch"
    | "hook-mismatch"
    | "stale-trust-map"
    | "executable-identity"
    | "snapshot-failure";

export type ManagedPushPreparation =
    | { kind: "prepared"; command: string }
    /** `detail` is bounded and names variables or paths only, never their values. */
    | { kind: "fallback"; cause: ManagedPushFallbackCause; detail: string };

const DETAIL_MAX_CHARS = 200;

class ManagedPushRefusal extends Error {
    constructor(readonly fallbackCause: ManagedPushFallbackCause, message: string) { super(message); }
}

function fallback(cause: ManagedPushFallbackCause, detail: string): ManagedPushPreparation {
    return { kind: "fallback", cause, detail: detail.slice(0, DETAIL_MAX_CHARS) };
}

function refused(error: unknown, defaultCause: ManagedPushFallbackCause): ManagedPushPreparation {
    if (error instanceof ManagedPushRefusal) return fallback(error.fallbackCause, error.message);
    if (error instanceof ManagedPushTrustMismatch) return fallback("stale-trust-map", error.message);
    // Native/parser exceptions can echo source bytes. Report only a controlled diagnostic and phase.
    let diagnostic = error instanceof SyntaxError ? "invalid JSON" : "unavailable";
    if (error instanceof Error && "code" in error && typeof error.code === "string"
        && ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(error.code)) diagnostic = error.code;
    return fallback(defaultCause, `Managed push ${defaultCause} check failed (${diagnostic})`);
}

function verifyRepository(root: string, git: string, remote: string, trust: ManagedPushTrust): void {
    if (realpathSync(gitOutput(git, root, ["rev-parse", "--show-toplevel"])) !== root) throw new ManagedPushRefusal("repository-mismatch", "Managed push requires repository root cwd");
    const hook = resolve(root, gitOutput(git, root, ["rev-parse", "--git-path", "hooks/pre-push"]));
    if (hook !== join(root, "scripts/git-hooks/pre-push")) throw new ManagedPushRefusal("hook-mismatch", "Custom managed hook path");
    let regular = false;
    try { regular = lstatSync(hook).isFile() && realpathSync(hook) === hook; } catch { throw new ManagedPushRefusal("hook-mismatch", "Managed hook scripts/git-hooks/pre-push is missing"); }
    if (!regular) throw new ManagedPushRefusal("hook-mismatch", "Managed hook must be a regular file");
    try { accessSync(hook, constants.X_OK); } catch { throw new ManagedPushRefusal("hook-mismatch", "Managed hook is not executable"); }
    if (!trust.files["scripts/git-hooks/pre-push"] || digest(readFileSync(hook)) !== trust.files["scripts/git-hooks/pre-push"]) throw new ManagedPushRefusal("stale-trust-map", "Managed push trust map does not match scripts/git-hooks/pre-push");
    try { gitOutput(git, root, ["remote", "get-url", "--push", remote]); } catch { throw new ManagedPushRefusal("repository-mismatch", `Unknown push remote ${remote}`); }
}

/** Options for one preparation: the environment to judge (the daemon's by default) and the correlation id to hand the hook. */
export interface ManagedPushOptions { env?: NodeJS.ProcessEnv; trace?: string; }
const TRACE_SHAPE = /^[A-Za-z0-9-]{8,64}$/;

function nativeCommand(snapshot: ManagedPushSnapshot, repo: string, git: ExecutableIdentity, node: ExecutableIdentity, remote: string, refspec: string, trace: string | undefined): string {
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
    // and restores only the supported heap option for the authoritative Git hook. The
    // correlation id travels the same way so the hook's ledger rows join the daemon's.
    const correlation = trace && TRACE_SHAPE.test(trace) ? [`INTERLINKED_VERIFICATION_TRACE=${trace}`] : [];
    return ["/usr/bin/env", "-u", "NODE_OPTIONS", "-u", "NODE_PATH", ...correlation, node.path, "--input-type=module", "--eval", MANAGED_PUSH_BOOTSTRAP, manifest, digest(bytes)].map(shellQuote).join(" ") + ' "${NODE_OPTIONS-}" "${NODE_PATH-}"';
}

/**
 * Prepare the native handoff or explain why the legacy checks stay in charge. A fallback is conservative: it
 * is never permission to skip the legacy checks, and its cause is recorded so a real push can be explained.
 */
export function prepareManagedPushHandoff(root: string, command: string, agentSource: string, trust: ManagedPushTrust = MANAGED_PUSH_TRUST, options: ManagedPushOptions = {}): ManagedPushPreparation {
    if (!["codex", "claude", "claude-code"].includes(agentSource)) return fallback("unsupported-client", `Client ${agentSource} has no native command replacement`);
    if (process.platform === "win32") return fallback("unsupported-platform", "Native handoff is not supported on win32");
    const parsed = parseManagedPush(command);
    if (!parsed) return fallback("unsupported-command", "Only a plain `git push <remote> main|master` with optional file logging is recognized");
    const overrides = unsafeManagedPushEnvironmentKeys(options.env ?? process.env);
    if (overrides.length) return fallback("environment-override", `Inherited environment overrides: ${overrides.join(", ")}`);
    let git: ExecutableIdentity, node: ExecutableIdentity;
    try {
        root = realpathSync(root);
        git = gitIdentity();
        node = executableIdentity(process.execPath);
    } catch (error) { return refused(error, "executable-identity"); }
    try { verifyRepository(root, git.path, parsed.remote, trust); }
    catch (error) { return refused(error, "repository-mismatch"); }
    let snapshot: ManagedPushSnapshot | undefined;
    try {
        snapshot = createManagedPushSnapshot(root, trust);
        return { kind: "prepared", command: nativeCommand(snapshot, root, git, node, parsed.remote, parsed.refspec, options.trace) + parsed.suffix };
    } catch (error) {
        if (snapshot) removeManagedPushSnapshot(snapshot.root);
        return refused(error, "snapshot-failure");
    }
}

/** Null is a conservative fallback, never permission to skip legacy checks. */
export function prepareManagedPush(root: string, command: string, agentSource: string, trust: ManagedPushTrust = MANAGED_PUSH_TRUST): string | null {
    const prepared = prepareManagedPushHandoff(root, command, agentSource, trust);
    return prepared.kind === "prepared" ? prepared.command : null;
}
