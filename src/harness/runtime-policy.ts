// Optional, packaged local-only policy. No external preload, log or config file.
// This is an application policy, not a security sandbox for arbitrary child code.
import { createRequire } from "node:module";

/** The cold fallback serializes this installer together with its policy helpers. */
function runtimePolicyCore(require: NodeRequire, install: boolean) {
    const { privateConfigPath, restrictedCommand } = runtimePolicyRules(require);
    const agentToolDecision = (event: Parameters<typeof runtimeAgentToolDecision>[2], enabled: boolean) => runtimeAgentToolDecision(require, privateConfigPath, event, enabled);
    const rules = { privateConfigPath, restrictedCommand, agentToolDecision };
    if (!install) return rules;
    const { syncBuiltinESMExports } = require("node:module") as typeof import("node:module");
    // Built-in CJS export objects are mutable; synchronize their ESM bindings below.
    type Methods = Record<string, (...args: any[]) => any>;
    const cp = require("node:child_process") as Methods;
    for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
        const original = cp[name]!.bind(cp);
        cp[name] = (command, args, ...rest) => {
            if (restrictedCommand(command, args)) {
                const error = new Error("Local runtime policy: external command unavailable");
                if (name === "spawnSync") return { error, status: null, signal: null, pid: 0, stdout: "", stderr: "", output: [null, "", ""] };
                throw error;
            }
            return original(command, args, ...rest);
        };
    }
    const denyNetwork = (): never => { throw new Error("Local runtime policy: network unavailable"); };
    globalThis.fetch = async () => denyNetwork();
    for (const module of ["node:http", "node:https"]) {
        const methods = require(module) as Methods;
        methods.request = denyNetwork; methods.get = denyNetwork;
    }
    const net = require("node:net") as typeof import("node:net");
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (this: import("node:net").Socket, ...args: any[]) {
        const target = Array.isArray(args[0]) ? args[0][0] : args[0];
        const unix = typeof target === "string" && target.startsWith("/")
            || target && typeof target === "object" && typeof target.path === "string";
        if (!unix) denyNetwork();
        return Reflect.apply(connect, this, args);
    } as typeof connect;
    syncBuiltinESMExports();
    return rules;
}

const predicates = runtimePolicyCore(createRequire(import.meta.url), false);
export const privateConfigPath = predicates.privateConfigPath;
export const restrictedCommand = predicates.restrictedCommand;
export function localAgentToolDecision(event: Parameters<typeof predicates.agentToolDecision>[0]) {
    return predicates.agentToolDecision(event, process.env.INTERLINKED_RUNTIME_POLICY === "local-restricted");
}
let installed = false;
/** A used named import keeps this module in builds with package sideEffects=false. */
export function ensureLocalRuntimePolicy(): void {
    if (!installed && process.env.INTERLINKED_RUNTIME_POLICY === "local-restricted") {
        runtimePolicyCore(createRequire(import.meta.url), true); installed = true;
    }
}
ensureLocalRuntimePolicy();

/** No external paths or preloads: one serialized, self-contained implementation. */
export function localRuntimePolicyChunk(): string {
    return `import { createRequire as createLocalPolicyRequire } from "node:module";
${runtimePolicyRules.toString()}
${runtimeAgentToolDecision.toString()}
const localRuntimePolicy = (${runtimePolicyCore.toString()})(createLocalPolicyRequire(import.meta.url), process.env.INTERLINKED_RUNTIME_POLICY === "local-restricted");
`;
}

function runtimePolicyRules(require: NodeRequire) {
    const { resolve, basename } = require("node:path") as typeof import("node:path");
    function privateConfigPath(value: unknown): boolean {
        if (typeof value !== "string" && !(value instanceof URL)) return false;
        return resolve(value instanceof URL ? value.pathname : value).replaceAll("\\", "/")
            .endsWith("/.interlinked/config.local.json");
    }
    function restrictedCommand(command: unknown, args: unknown): boolean {
        // The daemon's offline, redacted scanner is deterministic local work.
        // Keep shell invocations, history scans and arbitrary scanner options denied.
        if (basename(String(command)) === "gitleaks") {
            const allowed = [
                ["version"],
                ["detect", "--no-git", "--no-banner", "--redact", "--report-format", "json", "--report-path", "/dev/stdout", "--source", "."],
            ];
            return !Array.isArray(args) || !allowed.some(expected => expected.length === args.length && expected.every((value, i) => args[i] === value));
        }
        const text = [command, ...(Array.isArray(args) ? args : [])].join(" ");
        return /(?:^|[\s/])(git|gitleaks|claude|codex|ollama|curl|wget)(?:\s|$)/.test(text)
            || ["gitleaks", "semgrep", "snyk"].includes(basename(String(command)));
    }
    return { privateConfigPath, restrictedCommand };
}

// Scope file confidentiality to agent requests. Internal configuration readers
// (including coverage reconciliation) must retain ordinary filesystem semantics.
function runtimeAgentToolDecision(require: NodeRequire, privateConfigPath: (value: unknown) => boolean, event: { hook_event?: string | undefined; tool_input?: Record<string, unknown> | null | undefined; cwd?: string | null | undefined }, enabled: boolean) {
    const { resolve, basename } = require("node:path") as typeof import("node:path");
    if (!enabled || !["PreToolUse", "BeforeTool", "PermissionRequest"].includes(event.hook_event ?? "")) return null;
    const input = event.tool_input ?? {};
    const paths = [input.file_path, input.path];
    const command = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
    // Literal shell path operands, including quoted paths. This opt-in policy
    // is not a sandbox for computed filenames or arbitrary program execution.
    const words = command.match(/"[^"\n]*"|'[^'\n]*'|[;|&\n]|[^\s;|&<>]+/g) ?? [];
    let atCommand = true, readsFiles = false;
    for (const word of words) {
        if (/^[;|&\n]$/.test(word)) { atCommand = true; readsFiles = false; continue; }
        const value = word.replace(/^["']|["']$/g, "");
        if (atCommand) {
            readsFiles = ["cat", "head", "tail", "less", "more", "sed", "awk", "grep", "rg", "jq"].includes(basename(value));
            atCommand = false;
        } else if (readsFiles) paths.push(value);
    }
    if (!paths.some(path => privateConfigPath(typeof path === "string" ? resolve(event.cwd ?? process.cwd(), path) : path))) return null;
    return { decision: "block" as const, rule: "local_private_config", reason: "Local runtime policy: agent access to private configuration is unavailable" };
}
