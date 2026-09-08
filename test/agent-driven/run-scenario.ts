#!/usr/bin/env npx tsx
// ===========================================
// Agent-Driven Test Runner
// ===========================================
// Executes a single test scenario and produces a JSON report.
// Designed to be invoked by AI agents or CI.
//
// Usage:
//   npx tsx cli/test/agent-driven/run-scenario.ts claude-code-solo
//   npx tsx cli/test/agent-driven/run-scenario.ts offline-resilience
//
// The "multi-agent-conflict" and "browser-dashboard" scenarios require
// manual agent coordination and cannot be fully automated here.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wireAbsentOptional, wireBoolean, wireNumber, wireObject, wireRecord, wireString, type WireValidator } from "../../src/lib/value-validation.js";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const CLI_DIR = join(SCRIPT_DIR, "../..");
const CLI = `npx tsx ${join(CLI_DIR, "src/index.ts")}`;
const REPORTS_DIR = join(SCRIPT_DIR, "reports");

interface TestResult {
    test: string;
    status: "pass" | "fail" | "skip";
    duration_ms: number;
    notes: string;
}

interface Report {
    scenario: string;
    agent: string;
    timestamp: string;
    results: TestResult[];
    summary: { passed: number; failed: number; skipped: number };
}

// ===========================================
// Helpers
// ===========================================

// Default timeout (ms) for a single shell command invoked via `run`.
// Long enough for `git clone`/`npm install` on cold CI caches but short
// enough that a hung subprocess won't stall the whole scenario.
const DEFAULT_RUN_TIMEOUT_MS = 30_000;

type RunResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
};

function run(cmd: string, cwd: string, timeout: number = DEFAULT_RUN_TIMEOUT_MS): RunResult {
    const result = spawnSync("bash", ["-c", cmd], {
        cwd,
        encoding: "utf-8",
        timeout,
        stdio: ["pipe", "pipe", "pipe"],
    });
    return {
        stdout: (result.stdout || "").trim(),
        stderr: (result.stderr || "").trim(),
        exitCode: result.status ?? 1,
    };
}

function parseJson<T>(text: string, validate: WireValidator<T>): T | null {
    try {
        const value: unknown = JSON.parse(text);
        return validate(value) ? value : null;
    } catch {
        return null;
    }
}

function createTempRepo(): string {
    const dir = join(
        process.env.TMPDIR || "/tmp",
        `interlinked-agent-test-${Date.now()}`,
    );
    mkdirSync(join(dir, "test-repo"), { recursive: true });
    const repo = join(dir, "test-repo");
    run("git init --initial-branch=main", repo);
    run('git config user.email "test@interlinked.dev"', repo);
    run('git config user.name "Test Runner"', repo);
    run("git commit --allow-empty -m 'init'", repo);
    mkdirSync(join(repo, ".interlinked"), { recursive: true });
    writeFileSync(
        join(repo, ".interlinked/config.json"),
        JSON.stringify({ version: 1, server_url: "http://localhost:8787" }),
    );
    writeFileSync(
        join(repo, ".interlinked/config.local.json"),
        JSON.stringify({ agent_name: "test-agent", guard_mode: "warn" }),
    );
    return repo;
}

function cleanupRepo(repo: string): void {
    try {
        const parent = join(repo, "..");
        rmSync(parent, { recursive: true, force: true });
    } catch (err) {
        // Best-effort cleanup: a leftover temp dir shouldn't fail the scenario.
        // Log at debug-ish level so it's still observable in CI if cleanup breaks.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[cleanup] failed to remove ${repo}: ${msg}`);
    }
}

function timed(fn: () => TestResult["status"]): { status: TestResult["status"]; duration_ms: number } {
    const start = Date.now();
    const status = fn();
    return { status, duration_ms: Date.now() - start };
}

// ===========================================
// Scenario: claude-code-solo (offline subset)
// ===========================================

function runClaudeCodeSoloOffline(): Report {
    const results: TestResult[] = [];
    const repo = createTempRepo();

    try {
        // Test 1: Guard Install
        {
            const { status, duration_ms } = timed(() => {
                const r = run(`${CLI} guard install --json`, repo);
                const data = parseJson(r.stdout, wireObject({ mode: wireAbsentOptional(wireString), pre_commit: wireAbsentOptional(wireObject({ installed: wireAbsentOptional(wireBoolean) })) }));
                if (!data) return "fail";
                if (data.mode !== "warn") return "fail";
                if (!data.pre_commit?.installed) return "fail";
                if (!existsSync(join(repo, ".git/hooks/pre-commit"))) return "fail";
                return "pass";
            });
            results.push({ test: "guard_install", status, duration_ms, notes: "" });
        }

        // Test 2: Guard Install Idempotent
        {
            const { status, duration_ms } = timed(() => {
                const r = run(`${CLI} guard install --json`, repo);
                const data = parseJson(r.stdout, wireObject({ pre_commit: wireAbsentOptional(wireObject({ installed: wireAbsentOptional(wireBoolean) })) }));
                if (!data) return "fail";
                if (data.pre_commit?.installed !== false) return "fail";
                return "pass";
            });
            results.push({ test: "guard_install_idempotent", status, duration_ms, notes: "" });
        }

        // Test 3: Guard Status
        {
            const { status, duration_ms } = timed(() => {
                const r = run(`${CLI} guard status --json`, repo);
                const data = parseJson(r.stdout, wireObject({ mode: wireAbsentOptional(wireString), hooks: wireAbsentOptional(wireObject({ pre_commit: wireAbsentOptional(wireBoolean) })), git_repo: wireAbsentOptional(wireBoolean) }));
                if (!data) return "fail";
                if (data.mode !== "warn") return "fail";
                if (!data.hooks?.pre_commit) return "fail";
                if (!data.git_repo) return "fail";
                return "pass";
            });
            results.push({ test: "guard_status", status, duration_ms, notes: "" });
        }

        // Test 4: Git Context (local only)
        {
            const { status, duration_ms } = timed(() => {
                const r = run(`${CLI} git context --json`, repo);
                const data = parseJson(r.stdout, wireObject({ branch: wireAbsentOptional(wireString), head: wireAbsentOptional(wireString) }));
                if (!data) return "fail";
                if (data.branch !== "main") return "fail";
                if (!data.head) return "fail";
                return "pass";
            });
            results.push({ test: "git_context_local", status, duration_ms, notes: "" });
        }

        // Test 5: Git Context with Trailers
        {
            const { status, duration_ms } = timed(() => {
                run("echo 'test' > trailertest.ts", repo);
                run("git add trailertest.ts", repo);
                run(`git commit -m "Test commit

Interlinked-Checkpoint: 42
Interlinked-Agent: Worker-Alpha"`, repo);

                const r = run(`${CLI} git context --json`, repo);
                const data = parseJson(r.stdout, wireObject({ trailers: wireAbsentOptional(wireRecord(wireString)) }));
                if (!data?.trailers) return "fail";
                if (data.trailers["Interlinked-Checkpoint"] !== "42") return "fail";
                if (data.trailers["Interlinked-Agent"] !== "Worker-Alpha") return "fail";
                return "pass";
            });
            results.push({ test: "git_context_trailers", status, duration_ms, notes: "" });
        }

        // Test 6: Guard Check (no server, no cache — clean pass)
        {
            const { status, duration_ms } = timed(() => {
                const r = run(`${CLI} guard check --files src/auth/login.ts --json`, repo);
                const data = parseJson(r.stdout, wireObject({ clean: wireAbsentOptional(wireBoolean), files_checked: wireAbsentOptional(wireNumber) }));
                if (!data) return "fail";
                if (!data.clean) return "fail";
                return "pass";
            });
            results.push({ test: "guard_check_offline_clean", status, duration_ms, notes: "" });
        }

        // Test 7: Guard Check with Staged Files
        {
            const { status, duration_ms } = timed(() => {
                run("mkdir -p src/auth && echo 'code' > src/auth/login.ts", repo);
                run("git add src/auth/login.ts", repo);

                const r = run(`${CLI} guard check --json`, repo);
                const data = parseJson(r.stdout, wireObject({ files_checked: wireAbsentOptional(wireNumber), clean: wireAbsentOptional(wireBoolean) }));
                if (!data) return "fail";
                if (data.files_checked !== 1) return "fail";
                return "pass";
            });
            results.push({ test: "guard_check_staged_files", status, duration_ms, notes: "" });
        }

        // Test 8: Git Commit with Guard Hook
        {
            const { status, duration_ms } = timed(() => {
                run("echo 'hooktest' > hooktest.ts && git add hooktest.ts", repo);
                const r = run("git commit -m 'Test with guard hook'", repo);
                if (r.exitCode !== 0) return "fail";
                // Verify commit was created
                const log = run("git log -1 --format=%s", repo);
                if (!log.stdout.includes("Test with guard hook")) return "fail";
                return "pass";
            });
            results.push({ test: "commit_with_guard_hook", status, duration_ms, notes: "" });
        }

        // Test 9: Block Mode Install
        {
            const { status, duration_ms } = timed(() => {
                const r = run(`${CLI} guard install --mode block --json`, repo);
                const data = parseJson(r.stdout, wireObject({ mode: wireAbsentOptional(wireString) }));
                if (!data) return "fail";
                if (data.mode !== "block") return "fail";
                return "pass";
            });
            results.push({ test: "guard_block_mode", status, duration_ms, notes: "" });
        }

        // Test 10: Guard Uninstall
        {
            const { status, duration_ms } = timed(() => {
                const r = run(`${CLI} guard uninstall --json`, repo);
                const data = parseJson(r.stdout, wireObject({ pre_commit: wireAbsentOptional(wireObject({ removed: wireAbsentOptional(wireBoolean) })), mode: wireAbsentOptional(wireString) }));
                if (!data) return "fail";
                if (!data.pre_commit?.removed) return "fail";
                if (data.mode !== "off") return "fail";
                if (existsSync(join(repo, ".git/hooks/pre-commit"))) return "fail";
                return "pass";
            });
            results.push({ test: "guard_uninstall", status, duration_ms, notes: "" });
        }

        // Test 11: Attach --auto
        {
            const { status, duration_ms } = timed(() => {
                run("git remote add origin https://github.com/user/my-cool-project.git", repo);
                const r = run(`${CLI} attach --auto --json`, repo);
                const data = parseJson(r.stdout, wireObject({ default_workspace_key: wireAbsentOptional(wireString) }));
                if (!data) return "fail";
                if (data.default_workspace_key !== "my-cool-project") return "fail";
                return "pass";
            });
            results.push({ test: "attach_auto", status, duration_ms, notes: "" });
        }

        // Test 12: Not a Git Repo Error
        {
            const { status, duration_ms } = timed(() => {
                const noGitDir = join(repo, "..", "not-a-repo");
                mkdirSync(noGitDir, { recursive: true });
                mkdirSync(join(noGitDir, ".interlinked"), { recursive: true });
                writeFileSync(
                    join(noGitDir, ".interlinked/config.json"),
                    '{"version":1,"server_url":"http://localhost:8787"}',
                );
                writeFileSync(join(noGitDir, ".interlinked/config.local.json"), "{}");

                const r = run(`${CLI} git context --json`, noGitDir);
                const combined = `${r.stdout} ${r.stderr}`.toLowerCase();
                if (r.exitCode !== 0 && combined.includes("not a git")) return "pass";
                return "fail";
            });
            results.push({ test: "not_git_repo_error", status, duration_ms, notes: "" });
        }
    } finally {
        cleanupRepo(repo);
    }

    const summary = {
        passed: results.filter((r) => r.status === "pass").length,
        failed: results.filter((r) => r.status === "fail").length,
        skipped: results.filter((r) => r.status === "skip").length,
    };

    return {
        scenario: "claude-code-solo-offline",
        agent: "automated-runner",
        timestamp: new Date().toISOString(),
        results,
        summary,
    };
}

// ===========================================
// Main
// ===========================================

const scenario = process.argv[2] || "claude-code-solo";

let report: Report;

switch (scenario) {
    case "claude-code-solo":
    case "claude-code-solo-offline":
        report = runClaudeCodeSoloOffline();
        break;
    case "multi-agent-conflict":
        console.error("Multi-agent conflict requires manual coordination. See multi-agent-conflict.md");
        process.exit(1);
        break; // unreachable but satisfies TS
    case "browser-dashboard":
        console.error("Browser dashboard requires Playwright agent. See browser-dashboard.md");
        process.exit(1);
        break; // unreachable but satisfies TS
    case "offline-resilience":
        console.error("Offline resilience requires server control. See offline-resilience.md");
        process.exit(1);
        break; // unreachable but satisfies TS
    default:
        console.error(`Unknown scenario: ${scenario}`);
        console.error("Available: claude-code-solo, multi-agent-conflict, browser-dashboard, offline-resilience");
        process.exit(1);
}

// Save report
mkdirSync(REPORTS_DIR, { recursive: true });
const reportFile = join(REPORTS_DIR, `${report.scenario}-${Date.now()}.json`);
writeFileSync(reportFile, JSON.stringify(report, null, 2));

// Output
console.log(JSON.stringify(report, null, 2));
console.log("");
console.log(
    `Results: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped`,
);
console.log(`Report saved: ${reportFile}`);

if (report.summary.failed > 0) {
    process.exit(1);
}
