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

/** No loader, shell startup, or alternate Git repository/configuration injection. */
export function safeManagedPushEnvironment(env: NodeJS.ProcessEnv): boolean {
    if (Object.entries(env).some(([key, value]) => value && ((/^GIT_/.test(key) && key !== "GIT_PAGER") || ["NODE_PATH", "BASH_ENV", "ENV", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(key)))) return false;
    return !env.NODE_OPTIONS || /^\s*(?:--max-old-space-size(?:=|\s+)\d+\s*)+$/.test(env.NODE_OPTIONS);
}

export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
