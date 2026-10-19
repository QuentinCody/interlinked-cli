import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { DEFAULT_QUALITY_CHECKS } from "../harness/rules/default-config-quality-checks.js";
import { createFixture } from "./fixture.js";

it("repairs malformed settings, reloads policy, and stays responsive through background maintenance", async () => {
    const fixture = await createFixture({ prepare(cwd) {
        mkdirSync(join(cwd, ".claude"));
        writeFileSync(join(cwd, ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["Read(*)"] }, fixture: true }));
    } });
    try {
        const settings = fixture.file(".claude/settings.local.json", JSON.stringify({ permissions: {
            allow: ["Read(*)", "Bash(echo *)", "Bash(echo *) )", " ", "echo *"], deny: ["Bash(rm -rf *)"], ask: [],
        }, fixture: true }));
        await vi.waitFor(() => expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: {
            allow: ["Read(*)", "Bash(echo *)"], deny: ["Bash(rm -rf *)"], ask: [],
        }, fixture: true }), { timeout: 5000 });
        expect(fixture.ledger("permission-rule-strips.jsonl")).toEqual(expect.arrayContaining([
            expect.objectContaining({ reason: "paren_imbalance", rule: "Bash(echo *) )" }),
            expect.objectContaining({ reason: "empty_rule", rule: " " }),
            expect.objectContaining({ reason: "missing_tool_prefix", rule: "echo *" }),
        ]));
        fixture.file(".interlinked/guard-rules.local.json", JSON.stringify({ file_reminders: [
            { glob: "README.md", operations: ["Read"], message: "Reloaded fixture policy." },
        ] }));
        await vi.waitFor(async () => {
            const read = await fixture.hook({ event: "PostToolUse", tool: "Read", input: { file_path: join(fixture.cwd, "README.md") },
                payload: { tool_response: "Fixture project" } });
            fixture.assertServed(read);
            expect(read.stdout + read.stderr).toContain("Reloaded fixture policy.");
        }, { timeout: 5000, interval: 250 });
        const snapshot = join(fixture.dataDir, "statusline.snapshot");
        const before = statSync(snapshot).mtimeMs;
        const pid = fixture.pid;
        // Cross the real 30-second memory interval as well as the status refresh interval.
        await delay(31_000);
        await vi.waitFor(() => expect(statSync(snapshot).mtimeMs).toBeGreaterThan(before), { timeout: 5000 });
        const healthy = await fixture.hook({ tool: "Read", input: { file_path: "README.md" } });
        fixture.assertServed(healthy);
        expect(fixture.pid).toBe(pid);
    } finally { await fixture.close(); }
});

it("rejects malformed permission writes with actionable repair details", async () => {
    const fixture = await createFixture();
    try {
        for (const rule of ["Bash(echo *", "Bash(echo *))", "echo *", " "]) {
            const result = await fixture.hook({ tool: "Write", input: { file_path: join(fixture.cwd, ".claude/settings.local.json"),
                content: JSON.stringify({ permissions: { allow: [rule] } }) } });
            fixture.assertServed(result);
            expect(result.stdout).toContain('"deny"');
            expect(result.stdout + result.stderr).toMatch(/permission|rule/i);
        }
    } finally { await fixture.close(); }
});

it("reports removed exports, accepts their repair, and evaluates the staged commit with metrics disabled", async () => {
    const quality_checks = Object.fromEntries(Object.entries(DEFAULT_QUALITY_CHECKS).map(([name, config]) => [name, { ...config, enabled: false }]));
    const fixture = await createFixture({ rules: { quality_checks, per_edit_coverage: { enabled: false },
        project_wide_checks: { enabled: false }, diff_aware: { enabled: true }, structural_checks: { enabled: true, test_first_mode: "warn" } },
        prepare(cwd) {
            mkdirSync(join(cwd, "src"));
            writeFileSync(join(cwd, "package.json"), '{"type":"module"}');
            writeFileSync(join(cwd, "tsconfig.json"), '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src"]}');
            writeFileSync(join(cwd, "src/value.ts"), "export const answer = 1;\n");
            writeFileSync(join(cwd, "src/use.ts"), 'import { answer } from "./value.js"; export const doubled = answer * 2;\n');
            writeFileSync(join(cwd, ".interlinked/decision-metrics.json"), '{"version":1,"enabled":false}');
        } });
    try {
        const sessionId = `${fixture.sessionPrefix}-repair`;
        for (const [before, after, broken] of [["answer", "renamed", true], ["renamed", "answer", false]] as const) {
            const input = { file_path: join(fixture.cwd, "src/value.ts"), old_string: before, new_string: after };
            const tool_use_id = `rename-${after}`;
            const pre = await fixture.hook({ sessionId, tool: "Edit", input, payload: { tool_use_id } });
            fixture.assertServed(pre);
            expect(pre.stdout, pre.stderr).not.toContain('"deny"');
            fixture.file("src/value.ts", `export const ${after} = 1;\n`);
            const post = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Edit", input, payload: { tool_use_id, tool_response: "success" } });
            fixture.assertServed(post);
            if (broken) expect(post.stdout + post.stderr).toContain("Removed export");
            else expect(post.stdout + post.stderr).not.toContain("Removed export");
            expect(post.stdout + post.stderr).not.toContain("[interlinked:decision-metrics]");
        }
        expect(existsSync(join(fixture.dataDir, "decision-metrics/runs"))).toBe(false);
        execFileSync("git", ["add", "src/value.ts", "src/use.ts"], { cwd: fixture.cwd });
        const commit = await fixture.hook({ sessionId, tool: "Bash", input: { command: 'git commit -m "feat: add fixture values"' } });
        fixture.assertServed(commit);
        expect(commit.stdout, commit.stderr).not.toContain('"deny"');
    } finally { await fixture.close(); }
});

it("records repeated allowed commands as proposals while retaining destructive-command enforcement", async () => {
    const fixture = await createFixture();
    try {
        let fifth = "";
        for (let index = 0; index < 5; index++) {
            const result = await fixture.hook({ sessionId: `${fixture.sessionPrefix}-${index}`, tool: "Bash", input: { command: "git status --short" } });
            fixture.assertServed(result);
            expect(result.stdout).not.toContain('"deny"');
            fifth = result.stdout + result.stderr;
        }
        expect(fifth).toContain("proposal only");
        expect(JSON.parse(readFileSync(join(fixture.dataDir, "learned-rules.json"), "utf8"))).toEqual(expect.arrayContaining([
            expect.objectContaining({ pattern: "Bash(git status *)", observation_count: 5 }),
        ]));
        const blocked = await fixture.hook({ tool: "Bash", input: { command: "rm -rf /" } });
        fixture.assertServed(blocked);
        expect(blocked.stdout).toContain('"deny"');
    } finally { await fixture.close(); }
});
