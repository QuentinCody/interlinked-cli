// ===========================================
// Git gate hooks — CHECK the exact target, never execute (Unit F4, plan §12)
// ===========================================
// `tests e2e gate install` writes a pre-commit hook (`check --gate commit
// --staged --base HEAD`) and a pre-push hook (one `check --gate ci --revision
// <sha> --base <remote sha>` per pushed ref). Both only CHECK qualifying
// evidence and print the exact recovery command; builds, browsers and repeated
// runs stay in the supervised execution lane. An existing hook is backed up
// and chained through an explicit wrapper (never replaced); a missing CLI is
// UNAVAILABLE (nonzero), never a manufactured pass. The first commit and a new
// ref are bootstraps (PE-38); a deleted ref is skipped (PE-36).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { E2eGates, E2eProject } from "./policy.js";
import { GATE_DEFAULTS } from "./policy-diff.js";
import { resolveCliEntry } from "./scheduler.js";

export const GATE_MARKER = "# interlinked-e2e-gate";
const ZERO_SHA = "0".repeat(40);
export type GateName = "commit" | "ci";
export interface GateDecision { enforced: boolean; /** Required-mode projects whose gate requires a verdict. */ projects: string[]; }
export interface HookInstall { installed: boolean; backedUp?: string; }
export interface HookRemoval { removed: boolean; restored?: string; }
export interface PushTarget { remoteRef: string; revision: string | null; base: string | null; kind: "update" | "new" | "delete"; }
type HookName = "pre-commit" | "pre-push";

/** The slice of a project a gate decision reads (an `E2eProject` or the evaluation's `ProjectEnforcement` row). */
export interface GateProject { id: string; mode: E2eProject["mode"]; gates?: E2eGates; }
/** Absent on a required-mode project ⇒ `require`; advisory projects never enforce; `warn` / `off` report only. */
export function gateDecision(policy: { projects: readonly GateProject[] }, gate: GateName): GateDecision {
    const projects = policy.projects.filter(project => project.mode === "required" && (project.gates?.[gate] ?? GATE_DEFAULTS[gate]) === "require").map(project => project.id);
    return { enforced: projects.length > 0, projects };
}
/** git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. */
export function pushTargets(stdin: string): PushTarget[] {
    return stdin.split("\n").map(line => line.trim()).filter(Boolean).flatMap((line): PushTarget[] => {
        const [, localSha, remoteRef, remoteSha] = line.split(/\s+/);
        if (!localSha || !remoteRef || !remoteSha) return [];
        if (localSha === ZERO_SHA) return [{ remoteRef, revision: null, base: remoteSha, kind: "delete" }];
        return [{ remoteRef, revision: localSha, base: remoteSha === ZERO_SHA ? null : remoteSha, kind: remoteSha === ZERO_SHA ? "new" : "update" }];
    });
}
/** Honours `core.hooksPath` (an unset key exits 1 with no output, which is the default directory). */
function hooksDir(gitRoot: string): string {
    const probe = spawnSync("git", ["config", "core.hooksPath"], { cwd: gitRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const configured = probe.status === 0 ? probe.stdout.trim() : "";
    if (configured) return isAbsolute(configured) ? configured : join(gitRoot, configured);
    return join(gitRoot, ".git", "hooks");
}
/** A hook outlives the session, so only a BUILT entry is baked in (a `tsx` source entry resolves from the hook's cwd and breaks). */
function builtCliFile(): string | null {
    const entry = resolveCliEntry();
    if (!entry) return null;
    if (entry.file.endsWith(".js")) return entry.file;
    const dist = resolve(dirname(entry.file), "..", "dist", "index.js");
    return existsSync(dist) ? dist : null;
}
/** The CLI the hook runs: the built entry resolved at install time, else `interlinked` on PATH; neither ⇒ UNAVAILABLE, exit 2. */
function cliPreamble(): string {
    const file = builtCliFile() ?? "";
    const baked = file ? `"${process.execPath}" "${file}"` : "false";
    return `if [ -n "${file}" ] && [ -f "${file}" ]; then interlinked_cli() { ${baked} "$@"; }
elif command -v interlinked >/dev/null 2>&1; then interlinked_cli() { interlinked "$@"; }
else
    echo "[interlinked e2e] the Interlinked CLI is not available, so no qualifying verdict exists (UNAVAILABLE). Install it, or remove this gate with: interlinked tests e2e gate uninstall" >&2
    exit 2
fi`;
}
function preCommitScript(): string {
    return `#!/bin/sh
${GATE_MARKER}
# Interlinked project e2e gate (plan 31 §12): CHECKS the staged bytes' qualifying evidence; never runs a suite.
${cliPreamble()}
BASE_ARGS=""
if git rev-parse --verify --quiet HEAD >/dev/null 2>&1; then BASE_ARGS="--base HEAD"; else echo "[interlinked e2e] first commit: no trusted base, policy comparison is a bootstrap" >&2; fi
interlinked_cli tests e2e check --gate commit --staged $BASE_ARGS >&2
exit $?
`;
}
function prePushScript(): string {
    return `#!/bin/sh
${GATE_MARKER}
# Interlinked project e2e gate (plan 31 §12): CHECKS each pushed revision against its remote base; never runs a suite.
${cliPreamble()}
STATUS=0
while read -r LOCAL_REF LOCAL_SHA REMOTE_REF REMOTE_SHA; do
    [ -z "$LOCAL_REF" ] && continue
    if [ "$LOCAL_SHA" = "${ZERO_SHA}" ]; then echo "[interlinked e2e] $REMOTE_REF: deletion, nothing to check" >&2; continue; fi
    BASE_ARGS=""
    if [ "$REMOTE_SHA" = "${ZERO_SHA}" ]; then echo "[interlinked e2e] $REMOTE_REF: new ref on the remote, no trusted base — policy comparison is a bootstrap" >&2; else BASE_ARGS="--base $REMOTE_SHA"; fi
    echo "[interlinked e2e] $REMOTE_REF ← $LOCAL_SHA" >&2
    interlinked_cli tests e2e check --gate ci --revision "$LOCAL_SHA" $BASE_ARGS >&2 || STATUS=$?
done
exit $STATUS
`;
}
/**
 * Explicit chaining: the original hook runs FIRST and its failure wins; the wrapper captures git's stdin once and feeds the
 * SAME bytes to both. The gate program lives in its own file (`<hook>.interlinked-e2e-gate`), never in a heredoc on the
 * gate's stdin — a heredoc replaced the pipe and the pre-push loop read script text instead of git's ref rows (review F-R1).
 */
function chainedWrapper(backup: string, gateScript: string): string {
    return `#!/bin/sh\n${GATE_MARKER}-wrapper\nINPUT="$(cat)"\nif [ -x "${backup}" ]; then printf '%s\\n' "$INPUT" | "${backup}" "$@" || exit $?; fi\nprintf '%s\\n' "$INPUT" | "${gateScript}" "$@"\n`;
}
function installHook(gitRoot: string, name: HookName, script: string): HookInstall {
    const dir = hooksDir(gitRoot);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name), backup = join(dir, `${name}.interlinked-e2e-orig`), gateScript = join(dir, `${name}.interlinked-e2e-gate`);
    if (existsSync(path) && readFileSync(path, "utf8").includes(GATE_MARKER)) return { installed: false };
    if (!existsSync(path)) { writeFileSync(path, script); chmodSync(path, 0o755); return { installed: true }; }
    renameSync(path, backup);
    writeFileSync(gateScript, script);
    chmodSync(gateScript, 0o755);
    writeFileSync(path, chainedWrapper(backup, gateScript));
    chmodSync(path, 0o755);
    return { installed: true, backedUp: backup };
}
function removeHook(gitRoot: string, name: HookName): HookRemoval {
    const dir = hooksDir(gitRoot), path = join(dir, name), backup = join(dir, `${name}.interlinked-e2e-orig`);
    if (!existsSync(path) || !readFileSync(path, "utf8").includes(GATE_MARKER)) return { removed: false };
    unlinkSync(path);
    rmSync(join(dir, `${name}.interlinked-e2e-gate`), { force: true });
    if (!existsSync(backup)) return { removed: true };
    renameSync(backup, path);
    return { removed: true, restored: path };
}
export function installGateHooks(gitRoot: string, which: { commit: boolean; push: boolean }): { preCommit: HookInstall; prePush: HookInstall } {
    return { preCommit: which.commit ? installHook(gitRoot, "pre-commit", preCommitScript()) : { installed: false }, prePush: which.push ? installHook(gitRoot, "pre-push", prePushScript()) : { installed: false } };
}
export function uninstallGateHooks(gitRoot: string): { preCommit: HookRemoval; prePush: HookRemoval } {
    return { preCommit: removeHook(gitRoot, "pre-commit"), prePush: removeHook(gitRoot, "pre-push") };
}
export function gateHookStatus(gitRoot: string): { preCommit: boolean; prePush: boolean } {
    const has = (name: string): boolean => { const path = join(hooksDir(gitRoot), name); return existsSync(path) && readFileSync(path, "utf8").includes(GATE_MARKER); };
    return { preCommit: has("pre-commit"), prePush: has("pre-push") };
}
