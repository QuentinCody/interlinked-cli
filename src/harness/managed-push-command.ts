import { shellSplit, splitSegments } from "./shell-structure.js";

export interface ManagedPushCommand { remote: string; refspec: string; suffix: string; }

/** Deliberately narrow shell grammar: unknown syntax keeps the legacy checks. */
export function parseManagedPush(command: string): ManagedPushCommand | null {
    if (/[\n\r$`\\;|#(){}]/.test(command) || splitSegments(command).length !== 1) return null;
    const redirect = command.indexOf(">");
    const head = redirect < 0 ? command : command.slice(0, redirect).trimEnd();
    const suffix = redirect < 0 ? "" : command.slice(head.length);
    if (suffix && !/^\s+>>?\s+(?:[A-Za-z0-9_./-]+|'[A-Za-z0-9_./ -]+')(?:\s+2>&1)?\s*$/.test(suffix)) return null;
    const argv = shellSplit(head);
    if (argv.length !== 4 || argv[0] !== "git" || argv[1] !== "push") return null;
    const remote = argv[2];
    const refspec = argv[3];
    if (!remote || !refspec || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) return null;
    if (!/^(?:[A-Za-z0-9][A-Za-z0-9._/-]*:)?(?:refs\/heads\/)?(?:main|master)$/.test(refspec)) return null;
    return { remote, refspec, suffix };
}

/**
 * `GIT_*` variables a push may inherit: prompting and editing helpers an IDE shell exports (VS Code sets
 * `GIT_ASKPASS` and `GIT_EDITOR` in every terminal). None selects a repository, a configuration source, a hook
 * path, an exec path, a transport command or a loader, and the legacy push runs under the same values. The
 * frozen launcher (`managed-push-launcher.ts`) carries the same list; its test pins the two together.
 */
export const MANAGED_PUSH_ALLOWED_GIT_VARIABLES: readonly string[] = ["GIT_PAGER", "GIT_ASKPASS", "GIT_EDITOR"];
const LOADER_OVERRIDE_VARIABLES: readonly string[] = ["NODE_PATH", "BASH_ENV", "ENV", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"];
const MAX_REPORTED_VARIABLES = 8;

/**
 * The names (never the values) of inherited variables that would inject a loader, a shell startup file or an
 * alternate Git repository/configuration into the push; empty when the environment is safe. Sorted and bounded
 * so a fallback reason stays short and private.
 */
export function unsafeManagedPushEnvironmentKeys(env: NodeJS.ProcessEnv): string[] {
    const keys = Object.entries(env)
        .filter(([key, value]) => value && ((/^GIT_/.test(key) && !MANAGED_PUSH_ALLOWED_GIT_VARIABLES.includes(key)) || LOADER_OVERRIDE_VARIABLES.includes(key)))
        .map(([key]) => key);
    if (env.NODE_OPTIONS && !/^\s*(?:--max-old-space-size(?:=|\s+)\d+\s*)+$/.test(env.NODE_OPTIONS)) keys.push("NODE_OPTIONS");
    return [...new Set(keys)].sort().slice(0, MAX_REPORTED_VARIABLES);
}

/** No loader, shell startup, or alternate Git repository/configuration injection. */
export function safeManagedPushEnvironment(env: NodeJS.ProcessEnv): boolean {
    return unsafeManagedPushEnvironmentKeys(env).length === 0;
}

export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Correlate a delivered fallback without changing its Git arguments, hooks, or inherited overrides. */
export function traceManagedPushCommand(command: string, trace: string): string | null {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(trace) || !parseManagedPush(command)) return null;
    return `INTERLINKED_VERIFICATION_TRACE=${shellQuote(trace)} ${command}`;
}
