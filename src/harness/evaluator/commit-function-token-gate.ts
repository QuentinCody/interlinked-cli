import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { isCappableFile } from "../large-file-policy.js";
import {
    changedSetForCommit,
    defaultGitChangedFiles,
    type EvalMode,
    rebaseConstructedPaths,
} from "./commit-gate-changes.js";
import { gitShow, resolveRepoRoot } from "./commit-git-io.js";
import { parseGitCommit, type CommitParse } from "./commit-parse.js";
import {
    buildFunctionTokenBlock,
    compareFunctionTokens,
} from "./function-token-write-guard.js";

export interface CommitFunctionTokenDeps {
    resolveRepoRoot: (cwd: string) => string | null;
    changedFiles: typeof defaultGitChangedFiles;
    gitShow: typeof gitShow;
    readFile: (path: string) => string | null;
}

/** Exported (was module-private) so tests can exercise `readFile`'s
 *  exists/read/throw branches directly against a real temp file, instead of
 *  shelling out to real git for the other three fields just to reach it. */
export const DEFAULT_DEPS: CommitFunctionTokenDeps = {
    resolveRepoRoot,
    changedFiles: defaultGitChangedFiles,
    gitShow,
    readFile: (path) => {
        try {
            return existsSync(path) ? readFileSync(path, "utf8") : null;
        } catch {
            return null;
        }
    },
};

function evaluationMode(parse: CommitParse): EvalMode {
    if (parse.constructsContent) return "worktree";
    return parse.all ? "tracked" : "index";
}

function changedPaths(
    parse: CommitParse,
    commandCwd: string,
    repoRoot: string,
    deps: CommitFunctionTokenDeps,
): { mode: EvalMode; paths: string[] } | null {
    const mode = evaluationMode(parse);
    const all = deps.changedFiles(repoRoot, mode === "index", mode === "worktree");
    if (all === null) return null;
    const constructed = parse.constructedPaths
        ? rebaseConstructedPaths(parse.constructedPaths, commandCwd, repoRoot)
        : undefined;
    const paths = changedSetForCommit(
        all,
        {
            ...(constructed ? { constructedPaths: constructed } : {}),
            ...(parse.includesIndex ? { includesIndex: true } : {}),
        },
        mode,
        () => deps.changedFiles(repoRoot, true) ?? null,
    );
    return { mode, paths };
}

function afterContent(
    repoRoot: string,
    relPath: string,
    mode: EvalMode,
    deps: CommitFunctionTokenDeps,
): string | null {
    if (mode === "index") return deps.gitShow(repoRoot, `:${relPath}`);
    const path = isAbsolute(relPath) ? relPath : resolve(repoRoot, relPath);
    return deps.readFile(path);
}

function collectViolations(
    repoRoot: string,
    mode: EvalMode,
    paths: string[],
    deps: CommitFunctionTokenDeps,
): string[] {
    const violations: string[] = [];
    for (const relPath of paths) {
        const after = afterContent(repoRoot, relPath, mode, deps);
        if (after === null || !isCappableFile({ filePath: relPath, content: after, root: repoRoot })) {
            continue;
        }
        const before = deps.gitShow(repoRoot, `HEAD:${relPath}`) ?? "";
        const fileViolations = compareFunctionTokens(before, after, relPath, repoRoot);
        if (fileViolations === null) continue;
        for (const violation of fileViolations) violations.push(`${relPath}: ${violation}`);
    }
    return violations;
}

export function checkCommitFunctionTokenGate(
    event: HarnessEvent,
    deps: CommitFunctionTokenDeps = DEFAULT_DEPS,
): HarnessDecision | null {
    const command = typeof event.tool_input?.command === "string" ? event.tool_input.command : "";
    const parse = parseGitCommit(command);
    if (!parse?.isCommit) return null;
    const baseCwd = event.cwd || process.cwd();
    const commandCwd = parse.cwd ? resolve(baseCwd, parse.cwd) : baseCwd;
    const repoRoot = deps.resolveRepoRoot(commandCwd);
    if (!repoRoot) return null;
    const changed = changedPaths(parse, commandCwd, repoRoot, deps);
    if (!changed) return null;
    const violations = collectViolations(repoRoot, changed.mode, changed.paths, deps);
    if (violations.length === 0) return null;
    return {
        decision: "block",
        reason: buildFunctionTokenBlock(violations, repoRoot),
        rule_id: "commit-function-tokens-cap",
        severity: "medium",
        category: "function-size",
    };
}

export function runCommitFunctionTokenGate(
    event: HarnessEvent,
    preDecision: HarnessDecision,
    deps: CommitFunctionTokenDeps = DEFAULT_DEPS,
): HarnessDecision | null {
    if (preDecision.decision !== "allow" || event.tool_name !== "Bash") return null;
    const decision = checkCommitFunctionTokenGate(event, deps);
    if (!decision) return null;
    if (preDecision.warnings?.length) {
        decision.warnings = [...preDecision.warnings, ...(decision.warnings ?? [])];
    }
    return decision;
}
