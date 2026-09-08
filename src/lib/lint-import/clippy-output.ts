import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { runProcessAsync, type RunProcessOptions, type RunProcessResult } from "../../harness/check-engine/spawn-async.js";

/** Cargo output is not source. Redirect it rather than excluding a project
 * target directory that may also contain inputs selected by the crate. */
export async function runClippyWithIsolatedOutput(root: string, command: string, args: string[], options: RunProcessOptions): Promise<RunProcessResult> {
    const temporaryRoot = realpathSync(tmpdir());
    const rel = relative(realpathSync(root), temporaryRoot);
    if (!isAbsolute(rel) && !/^\.\.(?:[\\/]|$)/.test(rel)) {
        throw new Error("Clippy requires a temporary directory outside the project; no verdict");
    }
    const output = mkdtempSync(join(temporaryRoot, "interlinked-clippy-"));
    try {
        // Cargo flags must precede the rustc `--`. The command-line build-dir
        // setting also overrides independently configured intermediate output.
        const cargoArgs = [...args.slice(0, 1), "--target-dir", output, "--config", `build.build-dir=${JSON.stringify(output)}`, ...args.slice(1)];
        return await runProcessAsync(command, cargoArgs, {
            ...options,
            env: { ...options.env, CARGO_TARGET_DIR: output, CARGO_BUILD_TARGET_DIR: output, CARGO_BUILD_BUILD_DIR: output },
        });
    } finally {
        // The process runner settles killed jobs only after their process group
        // is reaped. This directory is outside every later source recheck too.
        rmSync(output, { recursive: true, force: true });
    }
}
