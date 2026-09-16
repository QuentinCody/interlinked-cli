import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PythonTestInvocationOptions {
    /** Explicit project configuration wins over environment discovery. */
    pythonExecutable?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    /** Omit to preserve pytest's configured testpaths and discovery rules. */
    selectedTests?: readonly string[];
}

/** Identifies an environment layout for staging; never a source-check exemption. */
export function isPythonVirtualEnvironment(path: string): boolean {
    return existsSync(join(path, "pyvenv.cfg")) &&
        (existsSync(join(path, "bin", "python")) || existsSync(join(path, "Scripts", "python.exe")));
}

function environmentPython(environment: string, platform: NodeJS.Platform): string {
    const unix = join(environment, "bin", "python");
    const windows = join(environment, "Scripts", "python.exe");
    const candidates = platform === "win32" ? [windows, unix] : [unix, windows];
    // A selected but incomplete environment must fail visibly, not silently
    // run tests against a different interpreter or dependency population.
    return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!;
}

function pythonExecutable(root: string, options: PythonTestInvocationOptions): string {
    if (options.pythonExecutable) return options.pythonExecutable;
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    if (env.VIRTUAL_ENV) return environmentPython(resolve(root, env.VIRTUAL_ENV), platform);
    for (const name of [".venv", "venv"]) {
        const environment = join(root, name);
        if (existsSync(environment)) return environmentPython(environment, platform);
    }
    return platform === "win32" ? "python" : "python3";
}

/** Shared interpreter selection for behavioral suites, coverage and staged edits.
 * The caller owns cwd; overlays should resolve the interpreter from the original
 * project root while executing tests in the staged workspace. No tools install. */
export function resolvePythonTestInvocation(
    root: string,
    options: PythonTestInvocationOptions = {},
): { command: string; args: string[] } {
    return {
        command: pythonExecutable(root, options),
        args: ["-B", "-m", "pytest", ...(options.selectedTests ?? []), "--tb=short", "-q"],
    };
}
