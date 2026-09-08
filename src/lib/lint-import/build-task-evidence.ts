import { basename, dirname } from "node:path";
import { mentionsLint, type LintCommandSource } from "./command-discovery.js";

const BUILD_FILES = new Set(["pom.xml", "build.gradle", "build.gradle.kts", "CMakeLists.txt", "noxfile.py", ".lintstagedrc", ".lintstagedrc.json", "lint-staged.config.js", "lint-staged.config.mjs", "lint-staged.config.cjs"]);

export function isLintBuildFile(file: string): boolean { return BUILD_FILES.has(basename(file)); }

/** Build DSLs and generated staged-file lists retain evidence instead of guessed standalone commands. */
export function buildTaskLintCommands(file: string, content: string): LintCommandSource[] {
    return content.split(/\r?\n/).flatMap((command, index) => mentionsLint(command) ? [{
        command: command.trim(), scope: dirname(file),
        reason: "Build task or generated target list needs a declared adapter preserving its build context",
        origin: { file, line: index + 1, kind: "task" as const, label: "build task evidence" },
    }] : []);
}
