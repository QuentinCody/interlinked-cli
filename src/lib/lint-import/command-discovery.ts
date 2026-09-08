import { posix } from "node:path";
import { LINT_ADAPTERS } from "./adapters.js";
import { parseLintArgv, scopedLintPath, toolForExecutable } from "./argv.js";
import { lintShellCommands } from "./shell-words.js";
import type { LintInvocationCandidate, LintOrigin } from "./types.js";

export interface LintCommandSource {
    command: string;
    scope: string;
    origin: LintOrigin;
    reason?: string;
}

const LINT_WORD = /\b(?:eslint|oxlint|biome|ruff|mypy|pylint|flake8|clippy|golangci-lint|swiftlint|rubocop|standardrb|stylelint|shellcheck|hadolint|actionlint|phpcs|phpstan|psalm|sqlfluff|semgrep|prettier|clang-tidy|cppcheck|checkstyle|pmd|detekt|ktlint|dotnet)\b/;
const RUNNERS = new Set(["npm exec", "pnpm exec", "yarn exec", "bun exec", "uv run", "poetry run", "pipenv run", "bundle exec", "python -m", "python3 -m"]);

export function mentionsLint(command: string): boolean {
    return LINT_WORD.test(command) || /\b(?:npm|pnpm|yarn|bun|deno|composer)\s+(?:run|task)\s+[\w:-]*(?:lint|check|format)[\w:-]*/.test(command);
}

function unwrapRunner(words: string[]): string[] {
    const [first = "", second = ""] = words;
    if (["npx", "bunx"].includes(first)) return words.slice(["--no-install", "--yes", "-y"].includes(second) ? 2 : 1);
    if (RUNNERS.has(`${first} ${second}`)) return words.slice(words[2] === "--" ? 3 : 2);
    return words;
}

function candidateFor(source: LintCommandSource, words: string[], scope: string): LintInvocationCandidate {
    const candidate: LintInvocationCandidate = { ...source, scope };
    try {
        if (source.reason) throw new Error(source.reason);
        const argv = unwrapRunner(words);
        const tool = toolForExecutable(argv[0] ?? "", argv.slice(1));
        if (!tool) throw new Error("No direct analyzer adapter for this invocation; use a SARIF report");
        const entry = parseLintArgv(tool, argv.slice(1), scope);
        entry.sources = [...new Set([source.origin.file, ...entry.sources])];
        entry.evidence = [source.origin];
        entry.cadence = source.origin.kind === "ci" || LINT_ADAPTERS[tool]?.cadence === "audit" ? "audit" : "hook";
        if (entry.flags?.includes("--type-aware") || entry.flags?.includes("--type-check")) entry.cadence = "audit";
        candidate.entry = entry;
    } catch (error) { candidate.reason = error instanceof Error ? error.message : String(error); }
    return candidate;
}

/** Evidence retains unresolved semantics; unknown flags are never silently dropped. */
export function discoverLintCommand(source: LintCommandSource): LintInvocationCandidate[] {
    if (!mentionsLint(source.command)) return [];
    if (source.reason) return [{ ...source }];
    try {
        const commands = lintShellCommands(source.command);
        let scope = source.scope;
        const candidates: LintInvocationCandidate[] = [];
        let dependency: string | undefined;
        for (const words of commands) {
            if (words[0] === "cd" && words.length === 2) { scope = scopedLintPath(scope, words[1] ?? ""); continue; }
            if (!mentionsLint(words.join(" "))) { dependency = "Invocation depends on another command; inspect its setup requirements"; continue; }
            const context = dependency ? { ...source, reason: dependency } : source;
            candidates.push(candidateFor(context, words, posix.normalize(scope)));
        }
        return candidates;
    } catch (error) {
        return [{ ...source, reason: error instanceof Error ? error.message : String(error) }];
    }
}
